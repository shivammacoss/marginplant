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

    # Start mock market data tick loop
    import asyncio as _asyncio

    from app.services import market_data_service

    # 250 ms tick fanout — matches what the web frontend's `useMarketStream`
    # comment refers to ("WS pump now runs at 250 ms"). The previous 1 s
    # default made mobile prices feel laggy compared to web because the
    # tick_loop is what bridges the fast Zerodha/Infoway WS overlays into
    # the per-token Redis channels that `/ws/marketdata` clients subscribe
    # to. At 1 Hz, even when the upstream feed delivered ticks at 100 ms,
    # the user saw a refresh only every second. 4×-faster pump = sub-second
    # bid/ask movement on the APK and web, matching what the user expects.
    market_tick_task: _asyncio.Task = _asyncio.create_task(market_data_service.tick_loop(interval_sec=0.25))
    # Keep reference on the app so it isn't GC'd and can be cancelled cleanly on shutdown
    setattr(app, "_market_tick_task", market_tick_task)

    # Pending-order poller: walks LIMIT / SL-M orders every 1.5 s and fires
    # any whose trigger condition is met. Without this they'd park forever.
    from app.services.matching_engine import pending_order_poller
    pending_task: _asyncio.Task = _asyncio.create_task(pending_order_poller(interval_sec=1.5))
    setattr(app, "_pending_order_task", pending_task)

    # Risk enforcer: every 5 s checks every user with open positions for
    # margin-call / stop-out / ledger-balance breaches and acts on them
    # (notify or auto-squareoff). Without this, the Risk Management
    # settings on the admin page do nothing automatically.
    from app.services.risk_enforcer import risk_enforcer_loop
    risk_task: _asyncio.Task = _asyncio.create_task(risk_enforcer_loop(interval_sec=5.0))
    setattr(app, "_risk_enforcer_task", risk_task)

    # Expiry cleanup: hourly sweep that removes day-after-expiry instruments
    # from every user's watchlist, unsubscribes them from the Zerodha ticker
    # and marks them inactive in the Instrument collection. The first sweep
    # runs immediately so anything that expired overnight is cleaned at boot.
    from app.services.expiry_cleanup import expiry_cleanup_loop
    expiry_task: _asyncio.Task = _asyncio.create_task(expiry_cleanup_loop(interval_sec=3600.0))

    # Intraday→carryforward auto-rollover: at each segment's exchange-close
    # minute, flip all open MIS positions to NRML. Recomputes the overnight
    # margin via the segment-settings resolver and auto-squareoff's any
    # position whose user can't cover the new requirement. Forex (24/5)
    # and crypto (24/7) are exempt — no daily close means no rollover.
    from app.services.position_service import intraday_to_carry_loop
    rollover_task: _asyncio.Task = _asyncio.create_task(intraday_to_carry_loop(interval_sec=60.0))
    setattr(app, "_intraday_to_carry_task", rollover_task)
    setattr(app, "_expiry_cleanup_task", expiry_task)

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

    # Stop Infoway WebSocket cleanly
    try:
        from app.services.infoway_service import infoway

        await infoway.stop()
    except Exception:
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

# ── Middleware (order matters: outer-first below) ─────────────────────
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


# ── Static uploads (deposit screenshots etc.) ────────────────────────
_uploads_dir = Path("uploads")
_uploads_dir.mkdir(parents=True, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=str(_uploads_dir)), name="uploads")

# ── Routers ──────────────────────────────────────────────────────────
app.include_router(user_router, prefix="/api/v1")
app.include_router(admin_router, prefix="/api/v1")
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


@app.get("/health/redis", tags=["meta"])
async def health_redis():
    return APIResponse(data={"redis": await redis_health()})
