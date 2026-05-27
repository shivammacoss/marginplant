"""FastAPI app entry — middleware, routers, lifespan.

Phase 1 mounts only auth + profile routers. Subsequent phases add more
routers under /api/v1/user and /api/v1/admin.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

import sentry_sdk
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from prometheus_fastapi_instrumentator import Instrumentator

from app import __version__
from app.api.v1 import branding as branding_public
from app.api.v1.admin import router as admin_router
from app.api.v1.user import router as user_router
from app.api.ws import router as ws_router
from app.core.config import settings
from app.core.database import close_database, healthcheck as db_health, init_database
from app.core.exceptions import register_exception_handlers
from app.core.logging_config import configure_logging
from app.core.redis_client import (
    close_redis,
    healthcheck as redis_health,
    init_redis,
)
from app.schemas.common import APIResponse, HealthResponse

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    configure_logging()

    if settings.SENTRY_DSN:
        sentry_sdk.init(
            dsn=settings.SENTRY_DSN,
            traces_sample_rate=0.05 if settings.is_production else 1.0,
            environment=settings.APP_ENV,
            release=__version__,
        )
        logger.info("sentry_initialized")

    await init_database()
    try:
        await init_redis()
    except Exception:
        logger.warning("redis_unavailable_starting_without_cache")

    # Start the process-wide WebSocket hubs. Each hub holds a single
    # shared Redis pub/sub connection and fans messages out to all
    # attached sockets in-process — replaces the previous design where
    # every connected WS opened its own pub/sub. Idempotent and tolerant
    # of Redis being unavailable (handlers will retry start() on connect).
    try:
        from app.core.ws_hub import start_all_hubs

        await start_all_hubs()
    except Exception:
        logger.warning("ws_hubs_startup_failed_continuing")

    if settings.RUN_SEED_ON_STARTUP:
        from app.seed.instruments import seed_instruments
        from app.seed.seed_data import run_seed

        try:
            await run_seed()
            await seed_instruments()
        except Exception:
            logger.exception("seed_failed_continuing_anyway")

    # Always run the index-lot backfill — even when seeding is off the DB
    # may still hold rows from earlier runs with the wrong lot_size (NIFTY 50,
    # auto-created rows stuck at 1, etc). Idempotent: no-op once everything
    # already matches the canonical values.
    try:
        from app.seed.instruments import backfill_index_lot_sizes

        await backfill_index_lot_sizes()
    except Exception:
        logger.exception("backfill_index_lots_failed_continuing")

    # Heal legacy `marginCalcMode = "percent"` rows on every boot. Old seed
    # default locked freshly-seeded NSE_FUT / NSE_OPT / MCX_OPT etc. into
    # percent mode with intradayMargin = 100, so the user-side panel showed
    # "100.00% · ₹{notional}/lot" until the admin explicitly clicked the
    # Mode dropdown. This heal resets seed-default rows to NULL so the
    # resolver's defensive inference picks the right mode automatically.
    # Idempotent — no-op once those rows are cleaned up or customised.
    try:
        from app.services.netting_service import heal_legacy_percent_seeds

        healed = await heal_legacy_percent_seeds()
        if healed:
            logger.info("startup_healed_legacy_percent_seeds count=%d", healed)
    except Exception:
        logger.exception("heal_legacy_percent_seeds_failed_continuing")

    # Backfill agreement_type on legacy P&L sharing agreements and drop the
    # old (admin_id, broker_id) unique index — replaced by the per-type
    # index so the same pair can hold both PNL_AND_BROKERAGE and
    # BROKERAGE_ONLY agreements simultaneously. Idempotent — no-op after
    # the first successful boot post-deploy.
    try:
        from app.services.pnl_sharing_service import (
            heal_pnl_sharing_agreement_type,
        )

        healed_pnl = await heal_pnl_sharing_agreement_type()
        if healed_pnl:
            logger.info(
                "startup_healed_pnl_sharing_agreement_type count=%d", healed_pnl
            )
    except Exception:
        logger.exception("heal_pnl_sharing_agreement_type_failed_continuing")

    # ── Historical wallet migrations: DISABLED 21-May per operator ───
    # Operator decision (after seeing MEHUL/CL62477932 state):
    #     "esse pehle vale logic galat tha settlement aaj se start
    #      karo, ab se next trade se pehle ka rehne do"
    # i.e. leave any existing wallet state — available_balance,
    # used_margin, settlement_outstanding, realized_pnl — exactly as
    # it is right now. The new floor-at-0 / route-to-settlement rule
    # in `wallet_service.adjust()` applies ONLY to new debits from
    # this point forward. No retroactive clamping, no retroactive
    # PnL backfill that could re-rewrite tracker fields.
    #
    # The helpers themselves stay in `wallet_service` so an operator
    # can run them manually later if they ever want to bulk-repair —
    # but the boot hooks are gone so a redeploy never silently
    # mutates user balances. Functions to call manually if needed:
    #   • wallet_service.clamp_negative_balances_to_settlement()
    #   • wallet_service.recompute_realized_pnl_for_all()

    # White-label branding: drop the obsolete `custom_domain_unique_sparse`
    # index left over from the very first Phase-1 deploy. The original
    # design used `sparse=True`, but MongoDB sparse indexes only skip
    # MISSING fields — they STILL index `null` values, and Beanie always
    # serializes the optional `custom_domain: None` default into the
    # document, so the unique constraint collapsed to "at most one user
    # row with custom_domain=null" → every second user insert hit
    # E11000 → 500 on /admin/management/sub-admins, /auth/register, etc.
    # The replacement `custom_domain_unique_partial` index uses
    # `partialFilterExpression={custom_domain: {$type: "string"}}` which
    # correctly indexes only rows that have a real string value.
    # Beanie creates the new index but never drops the old one — this
    # heal handles the swap. Idempotent: NamespaceNotFound (collection
    # missing) and IndexNotFound (already dropped) are both no-ops.
    try:
        from app.core.database import get_db

        _coll = get_db()["users"]
        try:
            await _coll.drop_index("custom_domain_unique_sparse")
            logger.info("startup_dropped_obsolete_sparse_index name=custom_domain_unique_sparse")
        except Exception as _exc:
            # `IndexNotFound` (code 27) and `NamespaceNotFound` (code 26)
            # both mean "nothing to clean up" — expected on every boot
            # after the first one. Anything else is logged but never
            # halts startup (worst case: the next sub-admin create
            # fails with E11000 and the operator runs the manual
            # `db.users.dropIndex` from DEPLOY_BRANDING.md).
            msg = str(_exc).lower()
            if "indexnotfound" not in msg and "ns not found" not in msg and "index not found" not in msg:
                logger.warning("startup_drop_obsolete_sparse_index_failed err=%s", _exc)
    except Exception:
        logger.exception("startup_branding_index_cleanup_failed_continuing")

    # Settings snapshot backfill: walks every existing ADMIN and BROKER
    # and ensures their tier-specific override table has one row per
    # segment, seeded from the creator's effective settings
    # (admin ← super-admin, broker ← admin/super, sub-broker ← parent
    # broker). Brings legacy tiers in line with the new copy-on-create
    # policy without forcing the operator to recreate each account.
    # Idempotent — per-segment upserts skip rows that already exist.
    #
    # `repair_null_seed_rows` runs FIRST to delete rows written by the
    # buggy 21-May boot (NettingSegment.segment_name → name) so the
    # subsequent backfill regenerates them with the seed values.
    try:
        from app.services.settings_snapshot import (
            backfill_missing_snapshots,
            repair_null_seed_rows,
        )

        repair = await repair_null_seed_rows()
        if repair.get("admin_deleted") or repair.get("broker_deleted"):
            logger.info(
                "startup_repaired_null_seed_rows admin=%d broker=%d",
                repair.get("admin_deleted", 0),
                repair.get("broker_deleted", 0),
            )

        bf_result = await backfill_missing_snapshots()
        if bf_result.get("admins_filled") or bf_result.get("brokers_filled"):
            logger.info(
                "startup_backfilled_settings_snapshots admins=%d brokers=%d",
                bf_result.get("admins_filled", 0),
                bf_result.get("brokers_filled", 0),
            )
    except Exception:
        logger.exception("settings_snapshot_backfill_failed_continuing")

    # Start mock market data tick loop
    import asyncio as _asyncio
    from functools import partial as _partial

    from app.core.leader_lock import leader_elected as _leader_elected
    from app.core.loop_supervisor import supervise as _supervise
    from app.services import market_data_service

    def _leader_only(loop_name: str, fn, /, **kwargs):
        """Wrap a loop factory so it only runs on the cluster leader.

        The leader lock is keyed by ``leader:{loop_name}`` in Redis and
        held with a 30 s TTL renewed every ~10 s. If the leader dies,
        a standby worker picks up within `poll_sec` (5 s default).
        """
        return _partial(
            _leader_elected,
            loop_name,
            _partial(fn, **kwargs),
            lock_key=f"leader:{loop_name}",
        )

    # 250 ms tick fanout — matches what the web frontend's `useMarketStream`
    # comment refers to ("WS pump now runs at 250 ms"). The previous 1 s
    # default made mobile prices feel laggy compared to web because the
    # tick_loop is what bridges the fast Zerodha/Infoway WS overlays into
    # the per-token Redis channels that `/ws/marketdata` clients subscribe
    # to. At 1 Hz, even when the upstream feed delivered ticks at 100 ms,
    # the user saw a refresh only every second. 4×-faster pump = sub-second
    # bid/ask movement on the APK and web, matching what the user expects.
    #
    # Every background loop below is wrapped in `supervise()` so an
    # uncaught exception escaping the loop's own try/except cannot
    # silently kill it for the rest of the process lifetime — the
    # supervisor logs the crash, backs off, and restarts the loop.
    # Loop internals, intervals and shutdown semantics are unchanged.
    market_tick_task: _asyncio.Task = _asyncio.create_task(
        _supervise(
            "market_tick",
            _partial(market_data_service.tick_loop, interval_sec=0.1),
        )
    )
    # Keep reference on the app so it isn't GC'd and can be cancelled cleanly on shutdown
    setattr(app, "_market_tick_task", market_tick_task)

    # The next six loops are wrapped in BOTH `_supervise` (auto-restart on
    # crash) AND `_leader_only` (single-leader across the cluster). Without
    # the leader gate, every uvicorn worker / instance would re-run the
    # same scan every tick — the existing cross-worker dedup (Mongo claims,
    # idempotency keys) keeps that *correct*, but the duplicated read load
    # is pure waste at multi-worker / multi-instance scale.

    # Pending-order poller: walks LIMIT / SL-M orders every 1.5 s and fires
    # any whose trigger condition is met. Without this they'd park forever.
    from app.services.matching_engine import pending_order_poller
    pending_task: _asyncio.Task = _asyncio.create_task(
        _supervise(
            "pending_order_poller",
            _leader_only("pending_order_poller", pending_order_poller, interval_sec=1.5),
        )
    )
    setattr(app, "_pending_order_task", pending_task)

    # Risk enforcer: every 250 ms checks every user with open positions
    # for margin-call / stop-out / ledger-balance breaches and acts on
    # them (notify or auto-squareoff). 4 sweeps/sec means an SL/TP
    # bracket or a stop-out threshold breach is acted on within a
    # quarter-second of the price crossing — vs the previous 5-s gap
    # that let live LTP drift several ticks past the trigger before
    # the close booked. The loop itself is drift-corrected (sleeps
    # for the remainder of the interval, not a fixed slice) and
    # logs `risk_enforcer_tick_overrun` if a tick can't finish in
    # 250 ms — that's the operator signal to scale workers or bump
    # the interval. Without this loop the Risk Management settings on
    # the admin page do nothing automatically.
    from app.services.risk_enforcer import risk_enforcer_loop
    risk_task: _asyncio.Task = _asyncio.create_task(
        _supervise(
            "risk_enforcer",
            _leader_only("risk_enforcer", risk_enforcer_loop, interval_sec=0.25),
        )
    )
    setattr(app, "_risk_enforcer_task", risk_task)

    # Expiry cleanup: hourly sweep that removes day-after-expiry instruments
    # from every user's watchlist, unsubscribes them from the Zerodha ticker
    # and marks them inactive in the Instrument collection. The first sweep
    # runs immediately so anything that expired overnight is cleaned at boot.
    from app.services.expiry_cleanup import expiry_cleanup_loop
    expiry_task: _asyncio.Task = _asyncio.create_task(
        _supervise(
            "expiry_cleanup",
            _leader_only("expiry_cleanup", expiry_cleanup_loop, interval_sec=3600.0),
        )
    )

    # Intraday→carryforward auto-rollover: at each segment's exchange-close
    # minute, flip all open MIS positions to NRML. Recomputes the overnight
    # margin via the segment-settings resolver and auto-squareoff's any
    # position whose user can't cover the new requirement. Forex (24/5)
    # and crypto (24/7) are exempt — no daily close means no rollover.
    from app.services.position_service import intraday_to_carry_loop
    rollover_task: _asyncio.Task = _asyncio.create_task(
        _supervise(
            "intraday_to_carry",
            _leader_only("intraday_to_carry", intraday_to_carry_loop, interval_sec=60.0),
        )
    )
    setattr(app, "_intraday_to_carry_task", rollover_task)
    setattr(app, "_expiry_cleanup_task", expiry_task)

    # Tracker self-heal: every 15 min, walk every UserPositionTracker row
    # and recompute it from the live Position docs. Catches any drift
    # introduced by an unexpected restart / fill retry / partial flow,
    # so users never get stuck with stale holding_lots blocking their
    # next order (root-cause fix for the BTCUSD holding_lots=47
    # incident on 2026-05-19).
    from app.services.position_service import tracker_reconcile_loop
    tracker_heal_task: _asyncio.Task = _asyncio.create_task(
        _supervise(
            "tracker_reconcile",
            _leader_only("tracker_reconcile", tracker_reconcile_loop, interval_sec=900.0),
        )
    )
    setattr(app, "_tracker_reconcile_task", tracker_heal_task)

    # P&L sharing auto-settle scheduler: every 5 min, scan ACTIVE+AUTO agreements
    # and settle the most recently closed period. Idempotent via unique
    # (agreement_id, period_start) index — duplicate fires are no-ops.
    from app.services.pnl_sharing_service import pnl_sharing_scheduler_loop
    pnl_sharing_task: _asyncio.Task = _asyncio.create_task(
        _supervise(
            "pnl_sharing_scheduler",
            _leader_only("pnl_sharing_scheduler", pnl_sharing_scheduler_loop, interval_sec=300.0),
        )
    )
    setattr(app, "_pnl_sharing_scheduler_task", pnl_sharing_task)

    # Infoway (forex + crypto + metals + energy) — auto-start if API key +
    # auto-connect both set.
    if settings.INFOWAY_AUTO_CONNECT and settings.INFOWAY_API_KEY.get_secret_value():
        try:
            from app.services.infoway_service import (
                default_symbols,
                infoway,
                mirror_subscribed_to_instruments,
            )

            await infoway.start()
            await infoway.subscribe(default_symbols())
            # Mirror every Infoway-subscribed code into the local Instrument
            # collection so /instruments/search finds forex / crypto / metals
            # symbols alongside Indian equities. Idempotent.
            mirrored = await mirror_subscribed_to_instruments()
            logger.info(
                "infoway_auto_started",
                extra={"symbols": len(default_symbols()), "mirrored": mirrored},
            )
        except Exception:
            logger.exception("infoway_auto_start_failed")

    # Zerodha — fire-and-forget background task so HTTP server starts
    # immediately. Cache warming + WS pool connect run concurrently.
    async def _zerodha_boot():
        try:
            from app.services.zerodha_service import zerodha as _zerodha

            # Capture the event loop early so on_ticks / on_connect
            # callbacks can publish to Redis from the Twisted thread.
            try:
                _zerodha._main_loop = asyncio.get_running_loop()
            except RuntimeError:
                pass

            z_status = await _zerodha.get_status()
            if not z_status.get("isConnected"):
                return
            for ex in ("NSE", "NFO", "MCX"):
                try:
                    instruments = await _zerodha.fetch_instruments(ex)
                    logger.info("zerodha_cache_warmed", extra={"exchange": ex, "count": len(instruments)})
                except Exception:
                    logger.warning(f"zerodha_cache_warm_{ex}_failed")
            try:
                await _zerodha.connect_ws()
                logger.info("zerodha_ws_pool_started_on_boot")
            except Exception:
                logger.exception("zerodha_ws_pool_start_failed")
        except Exception:
            logger.exception("zerodha_startup_init_failed")

    asyncio.create_task(_zerodha_boot())

    # Zerodha WS self-heal loop — periodically reconnects the ticker if
    # it falls into ERROR state (typical after the daily 08:00 IST token
    # rotation, after a process restart while Kite still holds the
    # previous slot, or on transient network blips). Runs forever; the
    # check is dirt-cheap when WS is healthy (just a status read).
    from app.services.zerodha_service import zerodha as _zerodha_heal

    zerodha_heal_task: _asyncio.Task = _asyncio.create_task(
        _supervise(
            "zerodha_ws_self_heal",
            _partial(_zerodha_heal.ws_self_heal_loop, interval_sec=30.0),
        )
    )
    setattr(app, "_zerodha_self_heal_task", zerodha_heal_task)

    # Zerodha auto-login daily scheduler — fires once per IST day at the
    # configured schedule_time_ist when the admin has both saved
    # credentials and toggled the feature ON. Skips weekends + Indian
    # trading holidays. Multi-worker safe via Redis SETNX leader lock.
    from app.services.zerodha_auto_login_scheduler import (
        zerodha_auto_login_loop,
    )

    zerodha_auto_login_task: _asyncio.Task = _asyncio.create_task(
        _supervise("zerodha_auto_login_scheduler", zerodha_auto_login_loop)
    )
    setattr(app, "_zerodha_auto_login_task", zerodha_auto_login_task)

    logger.info(
        "app_started",
        extra={
            "version": __version__,
            "env": settings.APP_ENV,
            "debug": settings.APP_DEBUG,
        },
    )

    yield

    # Shutdown
    from app.services import market_data_service as _mds

    _mds.stop_tick_loop()
    task = getattr(app, "_market_tick_task", None)
    if task is not None:
        task.cancel()
        try:
            await task
        except Exception:
            pass

    # Stop risk enforcer cleanly
    try:
        from app.services.risk_enforcer import stop_risk_enforcer
        stop_risk_enforcer()
        rtask = getattr(app, "_risk_enforcer_task", None)
        if rtask is not None:
            rtask.cancel()
            try:
                await rtask
            except Exception:
                pass
    except Exception:
        pass

    # Stop expiry-cleanup loop cleanly
    try:
        from app.services.expiry_cleanup import stop_expiry_cleanup
        stop_expiry_cleanup()
        etask = getattr(app, "_expiry_cleanup_task", None)
        if etask is not None:
            etask.cancel()
            try:
                await etask
            except Exception:
                pass
    except Exception:
        pass

    # Stop intraday→carry rollover loop cleanly
    try:
        from app.services.position_service import stop_intraday_to_carry_loop
        stop_intraday_to_carry_loop()
        itask = getattr(app, "_intraday_to_carry_task", None)
        if itask is not None:
            itask.cancel()
            try:
                await itask
            except Exception:
                pass
    except Exception:
        pass

    # Stop tracker self-heal loop cleanly
    try:
        from app.services.position_service import stop_tracker_reconcile_loop
        stop_tracker_reconcile_loop()
        ttask = getattr(app, "_tracker_reconcile_task", None)
        if ttask is not None:
            ttask.cancel()
            try:
                await ttask
            except Exception:
                pass
    except Exception:
        pass

    # Stop P&L sharing scheduler cleanly
    try:
        from app.services.pnl_sharing_service import stop_pnl_sharing_scheduler
        stop_pnl_sharing_scheduler()
        ptask = getattr(app, "_pnl_sharing_scheduler_task", None)
        if ptask is not None:
            ptask.cancel()
            try:
                await ptask
            except Exception:
                pass
    except Exception:
        pass

    # Stop pending-order poller cleanly
    try:
        from app.services.matching_engine import stop_pending_order_poller
        stop_pending_order_poller()
        ptask = getattr(app, "_pending_order_task", None)
        if ptask is not None:
            ptask.cancel()
            try:
                await ptask
            except Exception:
                pass
    except Exception:
        pass

    # Stop Zerodha auto-login scheduler cleanly
    try:
        from app.services.zerodha_auto_login_scheduler import (
            stop_zerodha_auto_login_scheduler,
        )

        stop_zerodha_auto_login_scheduler()
        ztask = getattr(app, "_zerodha_auto_login_task", None)
        if ztask is not None:
            ztask.cancel()
            try:
                await ztask
            except Exception:
                pass
    except Exception:
        pass

    # Stop Infoway WebSocket cleanly
    try:
        from app.services.infoway_service import infoway

        await infoway.stop()
    except Exception:
        pass

    # Stop the WS hubs before closing Redis so the shared pub/sub
    # connections get a chance to unsubscribe cleanly.
    try:
        from app.core.ws_hub import stop_all_hubs

        await stop_all_hubs()
    except Exception:  # pragma: no cover
        pass

    await close_redis()
    await close_database()
    logger.info("app_stopped")


app = FastAPI(
    title=settings.APP_NAME,
    version=__version__,
    docs_url="/docs" if not settings.is_production else None,
    redoc_url="/redoc" if not settings.is_production else None,
    openapi_url="/openapi.json" if not settings.is_production else None,
    lifespan=lifespan,
)

# ── Middleware ────────────────────────────────────────────────────────
# IMPORTANT: Starlette `add_middleware` PREPENDS to the stack — the
# LAST one registered runs FIRST on the incoming request. So everything
# below is in "innermost-first" order: CORSMiddleware/GZip/TrustedHost
# are registered first (they end up as inner layers), then the dynamic
# branding CORS middleware is registered LAST so it becomes the
# OUTERMOST layer and intercepts the OPTIONS preflight before the
# static CORSMiddleware (which only knows our own origins) can 400 it.
# Before this swap, tenant custom domains (e.g. stockcafe.live) hit
# CORSMiddleware first, got rejected without ACAO, and never reached
# the branding lookup — so every branded login page failed with a
# CORS preflight error and fell back to the platform default.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Request-Id"],
    max_age=3600,
)
app.add_middleware(GZipMiddleware, minimum_size=1024)

if settings.is_production:
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["*"])  # tighten via env in prod


# Branding CORS middleware: lets requests from active admin
# custom_domain origins through (the regular CORSMiddleware above
# can't see DB rows, so it would 403 a request from broker_a.com
# even when broker_a.com is a legitimate, READY-status tenant).
# Cached in-process for 60 s — refreshed lazily on the first request
# after the TTL expires. Idempotent and tolerant of DB outages
# (falls back to "no extra origins" when the lookup fails).
# MUST be registered AFTER CORSMiddleware so it ends up outermost.
@app.middleware("http")
async def branding_cors_middleware(request: Request, call_next):
    origin = request.headers.get("origin")
    if not origin:
        return await call_next(request)
    # Only act when the origin is NOT already in the static allow-list.
    if origin in settings.cors_allowed_origins:
        return await call_next(request)
    if not settings.BRANDING_ENABLED:
        return await call_next(request)

    try:
        from app.services.branding_service import all_active_custom_domains
    except Exception:  # pragma: no cover
        return await call_next(request)

    # Tiny in-process cache so we don't hit Mongo on every request.
    now = asyncio.get_event_loop().time()
    cache = getattr(app.state, "_branding_cors_cache", None)
    if cache is None or (now - cache["at"]) > 60.0:
        try:
            domains = await all_active_custom_domains()
        except Exception:  # pragma: no cover
            domains = []
        # Each admin's domain is allowed via both apex and www, http+https.
        allowed_set: set[str] = set()
        for d in domains:
            allowed_set.add(f"https://{d}")
            allowed_set.add(f"https://www.{d}")
            allowed_set.add(f"http://{d}")
            allowed_set.add(f"http://www.{d}")
        cache = {"at": now, "set": allowed_set}
        app.state._branding_cors_cache = cache

    if origin not in cache["set"]:
        return await call_next(request)

    # Preflight: respond directly so we control headers and method.
    # We answer here (instead of forwarding to CORSMiddleware) because
    # CORSMiddleware only knows the static allow-list and would reject
    # this origin — we already validated it against the live DB above.
    if request.method == "OPTIONS":
        from starlette.responses import Response as _R

        resp = _R(status_code=204)
    else:
        resp = await call_next(request)
    resp.headers["Access-Control-Allow-Origin"] = origin
    resp.headers["Access-Control-Allow-Credentials"] = "true"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = (
        request.headers.get("access-control-request-headers")
        or "Authorization, Content-Type, X-Request-Id, X-Admin-Api-Key"
    )
    resp.headers["Access-Control-Expose-Headers"] = "X-Request-Id"
    resp.headers["Access-Control-Max-Age"] = "3600"
    resp.headers["Vary"] = "Origin"
    return resp


@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    import uuid

    request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    request.state.request_id = request_id
    response = await call_next(request)
    response.headers["X-Request-Id"] = request_id
    return response


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault(
        "Permissions-Policy", "geolocation=(), camera=(), microphone=()"
    )
    if settings.is_production:
        response.headers.setdefault(
            "Strict-Transport-Security", "max-age=31536000; includeSubDomains"
        )
    return response


# ── Exception handlers ────────────────────────────────────────────────
register_exception_handlers(app)

# ── Metrics ──────────────────────────────────────────────────────────
Instrumentator().instrument(app).expose(app, endpoint="/metrics", include_in_schema=False)


# ── Static uploads (deposit screenshots etc., admin logos) ───────────
_uploads_dir = Path("uploads")
_uploads_dir.mkdir(parents=True, exist_ok=True)
(_uploads_dir / "logos").mkdir(parents=True, exist_ok=True)


# CORS for static files: custom-domain PWA installs fetch logo from
# api.marginplant.com → stockcafe.live origin. Without ACAO header
# Chrome blocks the image and PWA gets the default platform icon.
@app.middleware("http")
async def uploads_cors_middleware(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/uploads/"):
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS"
        response.headers["Cache-Control"] = "public, max-age=86400"
    return response


app.mount("/uploads", StaticFiles(directory=str(_uploads_dir)), name="uploads")

# ── Routers ──────────────────────────────────────────────────────────
app.include_router(user_router, prefix="/api/v1")
app.include_router(admin_router, prefix="/api/v1")
# Public (no-auth) branding lookups live alongside /user and /admin
# at the v1 root so the path is /api/v1/branding/by-code/...
app.include_router(branding_public.router, prefix="/api/v1")
app.include_router(ws_router)


# ── Health & meta ────────────────────────────────────────────────────
@app.get("/", include_in_schema=False)
async def root():
    return APIResponse(
        data={
            "service": settings.APP_NAME,
            "version": __version__,
            "env": settings.APP_ENV,
            "docs": "/docs",
        },
    )


@app.get("/health", response_model=APIResponse[HealthResponse], tags=["meta"])
async def health():
    db_ok = await db_health()
    redis_ok = await redis_health()
    overall = "ok" if (db_ok and redis_ok) else "degraded"
    return APIResponse(
        data=HealthResponse(status=overall, version=__version__, db=db_ok, redis=redis_ok),
    )


@app.get("/health/db", tags=["meta"])
async def health_db():
    return APIResponse(data={"db": await db_health()})


@app.get("/health/deep", tags=["meta"])
async def health_deep():
    """Liveness signal that surfaces the resilience plumbing's state.

    Goes beyond the basic ``/health`` (which only pings DB+Redis) to
    include the WS hub status and the Redis publish-queue depth so an
    operator (or k8s readiness probe) can detect a worker whose
    plumbing has degraded even though the underlying datastores are
    still responding.
    """
    db_ok = await db_health()
    redis_ok = await redis_health()

    hub_status: dict = {}
    try:
        from app.core.ws_hub import (
            admin_event_hub,
            market_tick_hub,
            user_channel_hub,
        )

        for hub in (market_tick_hub, user_channel_hub, admin_event_hub):
            hub_status[hub.name] = {
                "running": hub._started,  # noqa: SLF001 — read-only diagnostic
                "subscriber_count": hub.subscriber_count(),
            }
    except Exception:  # pragma: no cover
        pass

    publish_queue: dict = {}
    try:
        from app.core import redis_client as _rc

        publish_queue = {
            "queue_size": _rc._publish_queue.qsize() if _rc._publish_queue is not None else None,  # noqa: SLF001
            "max": _rc._PUBLISH_QUEUE_MAX,  # noqa: SLF001
            "drainer_running": _rc._drain_task is not None and not _rc._drain_task.done(),  # noqa: SLF001
        }
    except Exception:  # pragma: no cover
        pass

    overall = "ok" if (db_ok and redis_ok) else "degraded"
    return APIResponse(
        data={
            "status": overall,
            "db": db_ok,
            "redis": redis_ok,
            "ws_hubs": hub_status,
            "publish_queue": publish_queue,
        }
    )


@app.get("/health/redis", tags=["meta"])
async def health_redis():
    return APIResponse(data={"redis": await redis_health()})
