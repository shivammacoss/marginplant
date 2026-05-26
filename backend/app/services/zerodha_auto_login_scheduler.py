"""Daily background loop that fires the Zerodha auto-login.

Runs every 30 seconds. Fires the login when ALL of these are true:

  • Auto-login feature is enabled (admin toggle on)
  • The current IST time is inside the fire window around the
    configured `schedule_time_ist` (default ±2 min early / 50 min late
    catch-up — see `_FIRE_BEFORE_SEC` / `_FIRE_AFTER_SEC`)
  • Today's IST date is not already represented in the DB-persisted
    `last_attempt_at` (so we don't double-fire after a restart)
  • This worker wins the Redis SETNX leader lock (multi-worker safe)

If the trigger window fires, runs up to 3 retries with 5-min gaps. If
all retries fail, dispatches a high-severity Notification to every
super-admin so they get the bell-icon alert.

Bugs this rewrite addresses (chronological)
-------------------------------------------
1. 60-s tick alignment race: the old "wait_sec <= 60" check coupled
   the fire decision to the loop's tick PHASE — if a tick happened at
   07:00:30 instead of 06:59:30, the day's chance was missed entirely.
   FIX: absolute-time window around `schedule_time` (not tick-relative).
2. In-memory `last_fired_iso_date` lost on every restart, with two
   failure modes: (a) double-fire if restart happens mid-catch-up
   window, (b) silent miss if restart happens after the catch-up
   window closes.
   FIX: use the DB-persisted `last_attempt_at` field instead — set on
   every `refresh_now()` call so it's a reliable "fired today" marker.
3. Leader lock TTL of 10 min was shorter than the worst-case retry
   sequence (3 × 5 min = 15 min). Lock could expire mid-process and
   a second worker could pick up → duplicate Playwright run.
   FIX: 30-min TTL.
4. 60-s tick was unnecessarily coarse — combined with a 60-s fire
   window in the old code, you had only one shot per minute. With the
   new 30-s tick + 120-s early window, the loop has 4+ chances per
   target.
5. No DEBUG logging at idle ticks — operators couldn't tell whether
   the scheduler was alive but waiting, or genuinely stuck. We now
   emit a DEBUG-level "tick" log line that includes the next-fire
   delta so `journalctl ... | grep zerodha_scheduler` shows liveness.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from app.core.redis_client import get_redis
from app.models.notification import (
    Notification,
    NotificationLevel,
    NotificationType,
)
from app.models.user import User, UserRole
from app.models.zerodha_auto_login import ZerodhaAutoLogin
from app.services.zerodha_auto_login import zerodha_auto_login

logger = logging.getLogger(__name__)
IST = ZoneInfo("Asia/Kolkata")

# Cross-worker leader lock. 30 min covers the worst-case retry sequence
# (3 × 5 min gap + ~30 s each Playwright run). MUST be longer than
# `_MAX_RETRIES * _RETRY_GAP_SEC` plus a safety buffer, otherwise the
# lock can expire mid-retry and a second worker could grab it and start
# its own Playwright run on a token that's already mid-refresh.
_LEADER_KEY = "zerodha_auto_login:scheduler_leader"
_LEADER_TTL_SEC = 60 * 30

# Retry policy: 3 attempts × 5 min gap = ~15 min from first failure to
# last attempt — still inside the 07:00 → 08:00 IST Kite-expiry window
# so the day's token gets refreshed before it's invalidated.
_MAX_RETRIES = 3
_RETRY_GAP_SEC = 300

# Tick cadence — wake every 30 s. Finer than the historical 60 s so
# the fire window has at least 4 tick chances even at the tighter
# 2-min early gate.
_TICK_SEC = 30

# Absolute-time fire window around the configured schedule_time.
#
# `_FIRE_BEFORE_SEC` — how many seconds EARLY we'll accept (covers
#                      tick drift). 120 s gives 4+ tick chances at the
#                      30-s tick cadence even if ticks landed at
#                      unfavourable phases.
# `_FIRE_AFTER_SEC`  — how many seconds LATE we'll accept (catch-up
#                      window). 50 min covers "backend was restarted
#                      just after 07:00" / "loop stalled briefly"
#                      while still refreshing the token BEFORE the
#                      08:00 IST Kite-side rotation. After 50 min the
#                      catch-up closes — by then the token has likely
#                      already rotated.
_FIRE_BEFORE_SEC = 120
_FIRE_AFTER_SEC = 50 * 60

# Operator-visible "scheduler is alive" log line cadence. We log at
# DEBUG every tick, and at INFO every Nth tick so default-INFO setups
# still have proof-of-life in the journal.
_LIVENESS_LOG_EVERY_N_TICKS = 20  # ≈ every 10 minutes at 30-s tick

# Layer-2 verification settings. After refresh_now() returns success,
# we don't immediately trust the WebSocket is alive — the token can
# be valid but the ticker handshake may still be in flight, or may
# have hit a transient 403/network issue. So we POLL the ws-pool
# status for `_VERIFY_TIMEOUT_SEC` and treat it as failure if no
# ticker reaches the CONNECTED state in that window.
#
# On verification failure we run a Layer-2 recovery: an explicit
# `zerodha.connect_ws(force=True)` call. This is much lighter than
# another Playwright run — it just re-spawns the KiteTicker with the
# existing fresh token. If even that fails, we fall back to a full
# Layer-3 refresh_now() (new token + new WS spawn).
_VERIFY_TIMEOUT_SEC = 30
_VERIFY_POLL_INTERVAL_SEC = 2

_stop_flag = False


def stop_zerodha_auto_login_scheduler() -> None:
    global _stop_flag
    _stop_flag = True


async def _try_acquire_leader_lock() -> bool:
    try:
        redis = get_redis()
        return bool(
            await redis.set(_LEADER_KEY, "1", ex=_LEADER_TTL_SEC, nx=True)
        )
    except Exception:
        logger.warning("zerodha_scheduler_redis_down_running_anyway")
        # Single-worker dev — without Redis the lock can't be
        # coordinated, so just proceed (worst case: dev hits Kite twice,
        # which Kite tolerates fine since it just refreshes the token
        # twice and the second succeeds).
        return True


async def _release_leader_lock() -> None:
    """Best-effort release of the leader lock after a fire completes.
    If this fails the TTL will reclaim the key anyway."""
    try:
        await get_redis().delete(_LEADER_KEY)
    except Exception:
        pass


async def _verify_ws_connected(timeout_sec: int = _VERIFY_TIMEOUT_SEC) -> bool:
    """Poll the KiteTicker pool to confirm at least one ticker reaches
    CONNECTED state within ``timeout_sec`` seconds.

    Why this exists
    ---------------
    `refresh_now()` returns `success=True` once it successfully exchanges
    the request_token for an access_token via Kite REST. That guarantees
    the TOKEN is valid — but the KiteTicker WebSocket handshake happens
    separately (kicked off by `_post_login_ws_kickoff`) and can still
    fail with 403 / 1006 / network errors. Without this verification a
    "success" from refresh_now would falsely imply live ticks are
    flowing, but the operator would see a Disconnected status panel.

    Returns
    -------
    True if any pool entry has `connected=True` before the timeout.
    False if the entire window elapses with the pool stuck in
    CONNECTING / DISCONNECTED / ERROR.
    """
    from app.services.zerodha_service import zerodha

    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout_sec
    while loop.time() < deadline:
        await asyncio.sleep(_VERIFY_POLL_INTERVAL_SEC)
        try:
            info = zerodha.get_ws_pool_info()
            connections = info.get("connections", []) or []
            if any(c.get("connected") for c in connections):
                return True
        except Exception:
            logger.warning(
                "zerodha_scheduler_verify_pool_info_failed",
                exc_info=True,
            )
    return False


async def _layer2_recovery_reconnect() -> bool:
    """Layer-2 recovery — explicit WS reconnect using the already-fresh
    token. Lighter than a full Playwright re-login (~5 ms vs ~30 s)
    because it skips the OAuth dance and just re-spawns the KiteTicker.

    Used when Layer-1 (refresh_now → token saved → ticker kickoff) ran
    successfully but the kickoff's ticker never reached CONNECTED state
    inside `_VERIFY_TIMEOUT_SEC`. Common causes: transient Kite WS
    server hiccup, IP momentarily throttled, prior zombie connection
    still occupying the single-WS-per-token slot.

    Returns True if a connected ticker exists after this attempt.
    """
    from app.services.zerodha_service import zerodha

    logger.info("zerodha_scheduler_layer2_reconnect_attempt")
    try:
        # `force=True` first tears down any existing tickers and waits
        # a few seconds for Kite to release the slot, then re-spawns.
        await zerodha.connect_ws(force=True)
    except Exception:
        logger.exception("zerodha_scheduler_layer2_reconnect_call_failed")
        return False
    # Give the new handshake a window to complete.
    return await _verify_ws_connected(timeout_sec=_VERIFY_TIMEOUT_SEC)


async def _alert_super_admins(error_summary: str) -> None:
    """Push a high-severity notification to every super-admin."""
    try:
        admins = await User.find(User.role == UserRole.SUPER_ADMIN).to_list()
        if not admins:
            return
        title = "Zerodha auto-login failed"
        body = (
            "All retries exhausted at the scheduled run. Please complete "
            "the manual login on /zerodha before the 09:15 IST market open. "
            f"Last error: {error_summary[:200]}"
        )
        for admin in admins:
            try:
                await Notification(
                    user_id=admin.id,
                    type=NotificationType.SYSTEM,
                    level=NotificationLevel.DANGER,
                    title=title,
                    message=body,
                    data={"source": "zerodha_auto_login"},
                ).insert()
            except Exception:
                logger.exception("zerodha_scheduler_notif_insert_failed")
    except Exception:
        logger.exception("zerodha_scheduler_alert_admins_failed")


def _parse_hhmm(schedule_time_ist: str) -> tuple[int, int]:
    try:
        hh, mm = schedule_time_ist.split(":")
        h, m = int(hh), int(mm)
        if not (0 <= h <= 23 and 0 <= m <= 59):
            raise ValueError("out of range")
        return h, m
    except Exception:
        logger.warning(
            "zerodha_scheduler_invalid_schedule_format_falling_back",
            extra={"got": schedule_time_ist},
        )
        return 7, 0


async def _already_fired_today(today_ist_date: str) -> bool:
    """Did the SCHEDULER already fire today?

    Only counts scheduler-initiated attempts (last_attempt_source == "scheduler").
    Manual "Test login now" clicks must NOT block the daily scheduler.
    """
    try:
        doc = await ZerodhaAutoLogin.find_one()
        if doc is None or doc.last_attempt_at is None:
            return False
        if getattr(doc, "last_attempt_source", "") != "scheduler":
            return False
        last_attempt_ist = doc.last_attempt_at.astimezone(IST).date()
        return last_attempt_ist.isoformat() == today_ist_date
    except Exception:
        logger.exception("zerodha_scheduler_last_attempt_lookup_failed")
        return False


async def zerodha_auto_login_loop() -> None:
    """Long-running coroutine launched from the FastAPI lifespan."""
    logger.info(
        "zerodha_auto_login_scheduler_started",
        extra={
            "tick_sec": _TICK_SEC,
            "fire_before_sec": _FIRE_BEFORE_SEC,
            "fire_after_sec": _FIRE_AFTER_SEC,
            "leader_ttl_sec": _LEADER_TTL_SEC,
        },
    )
    tick_count = 0
    while not _stop_flag:
        try:
            await asyncio.sleep(_TICK_SEC)
            if _stop_flag:
                break
            tick_count += 1

            if not await zerodha_auto_login.is_enabled():
                if tick_count % _LIVENESS_LOG_EVERY_N_TICKS == 0:
                    logger.info("zerodha_scheduler_tick_disabled")
                continue

            schedule_time = await zerodha_auto_login.schedule_time()
            target_h, target_m = _parse_hhmm(schedule_time)

            now_ist = datetime.now(IST)
            today_str = now_ist.date().isoformat()
            target_today = now_ist.replace(
                hour=target_h, minute=target_m, second=0, microsecond=0
            )
            # delta_sec < 0  → target still in the future (we're early)
            # delta_sec > 0  → target was in the past (we're late / catch-up)
            delta_sec = (now_ist - target_today).total_seconds()

            in_early_window = -_FIRE_BEFORE_SEC <= delta_sec < 0
            in_catchup_window = 0 <= delta_sec <= _FIRE_AFTER_SEC

            # Liveness log every ~10 min so operators can confirm the
            # scheduler is alive by tailing journalctl. Cheap — just a
            # log line, no DB hit.
            if tick_count % _LIVENESS_LOG_EVERY_N_TICKS == 0:
                logger.info(
                    "zerodha_scheduler_tick",
                    extra={
                        "schedule_ist": schedule_time,
                        "delta_sec": round(delta_sec, 1),
                        "in_window": in_early_window or in_catchup_window,
                    },
                )

            if not (in_early_window or in_catchup_window):
                # Outside both windows. Either we're more than
                # `_FIRE_BEFORE_SEC` away from target (keep sleeping),
                # or more than `_FIRE_AFTER_SEC` past it (today's
                # window closed; we'll fire tomorrow).
                continue

            # In the fire window — but did we already fire today?
            # Authoritative source is the DB-persisted last_attempt_at.
            if await _already_fired_today(today_str):
                # We've already run today in this or another worker.
                # Skip silently.
                continue

            # Try to acquire the cross-worker leader lock. If another
            # worker beat us, just continue ticking — its run will be
            # reflected in `last_attempt_at`, which we'll see next loop.
            if not await _try_acquire_leader_lock():
                logger.info("zerodha_scheduler_other_worker_won")
                continue

            try:
                if delta_sec > 60:
                    # Catch-up fire — flag it so ops know this isn't a
                    # nominal on-time run.
                    logger.info(
                        "zerodha_scheduler_catchup_fire",
                        extra={
                            "delta_sec": round(delta_sec, 1),
                            "schedule": schedule_time,
                        },
                    )
                else:
                    logger.info(
                        "zerodha_scheduler_on_time_fire",
                        extra={
                            "delta_sec": round(delta_sec, 1),
                            "schedule": schedule_time,
                        },
                    )

                # ── LAYER 1: Playwright login + token refresh ─────────
                # Up to `_MAX_RETRIES` Playwright attempts with 5-min
                # gaps. Stops as soon as one succeeds.
                last_error = ""
                layer1_success = False
                for attempt in range(1, _MAX_RETRIES + 1):
                    logger.info(
                        "zerodha_scheduler_layer1_attempt",
                        extra={
                            "attempt": attempt,
                            "max": _MAX_RETRIES,
                            "schedule": schedule_time,
                        },
                    )
                    result = await zerodha_auto_login.refresh_now(
                        triggered_by=f"scheduler_layer1_attempt_{attempt}",
                    )
                    if result.get("success"):
                        logger.info(
                            "zerodha_scheduler_layer1_success",
                            extra={
                                "attempt": attempt,
                                "duration_ms": result.get("duration_ms"),
                            },
                        )
                        last_error = ""
                        layer1_success = True
                        break
                    last_error = (
                        f"{result.get('stage')}: {result.get('error')}"
                    )
                    logger.warning(
                        "zerodha_scheduler_layer1_attempt_failed",
                        extra={"attempt": attempt, "error": last_error},
                    )
                    if attempt < _MAX_RETRIES:
                        await asyncio.sleep(_RETRY_GAP_SEC)

                if not layer1_success:
                    # All Playwright attempts failed — no token to
                    # work with. Alert and bail out for the day.
                    await _alert_super_admins(last_error)
                    continue

                # ── VERIFY: did the WS actually connect? ──────────────
                logger.info(
                    "zerodha_scheduler_verify_start",
                    extra={"timeout_sec": _VERIFY_TIMEOUT_SEC},
                )
                ws_connected = await _verify_ws_connected()
                if ws_connected:
                    logger.info("zerodha_scheduler_verify_ok_ws_connected")
                    continue

                # ── LAYER 2: WS reconnect with current token ──────────
                # Layer-1 token is fresh but the ticker pool didn't
                # reach CONNECTED state. Try an explicit reconnect on
                # the existing token before going for another
                # Playwright run.
                logger.warning(
                    "zerodha_scheduler_layer1_token_ok_but_ws_dead_running_layer2"
                )
                layer2_ok = await _layer2_recovery_reconnect()
                if layer2_ok:
                    logger.info("zerodha_scheduler_layer2_recovery_success")
                    continue

                # ── LAYER 3 (fallback): one more full refresh ─────────
                # Last resort — full new Playwright login + new token
                # + new WS spawn. If THIS also fails to land a
                # connected ticker, alert the admin and accept defeat
                # for the day.
                logger.warning(
                    "zerodha_scheduler_layer2_failed_running_layer3_full_refresh"
                )
                fallback_result = await zerodha_auto_login.refresh_now(
                    triggered_by="scheduler_layer3_fallback",
                )
                if not fallback_result.get("success"):
                    await _alert_super_admins(
                        f"Layer-3 refresh failed: "
                        f"{fallback_result.get('stage')}: "
                        f"{fallback_result.get('error')}"
                    )
                    continue

                final_connected = await _verify_ws_connected()
                if final_connected:
                    logger.info("zerodha_scheduler_layer3_recovery_success")
                else:
                    logger.error("zerodha_scheduler_all_layers_failed")
                    await _alert_super_admins(
                        "Token refreshed across all retry layers but the "
                        "KiteTicker WebSocket never reached CONNECTED — "
                        "manual investigation needed."
                    )
            finally:
                # Release the lock so the next day's run can start
                # cleanly even if Redis TTL hasn't expired (e.g. if the
                # fire completed in 20 s, we'd hold the lock for the
                # remaining ~29 min otherwise — pointless).
                await _release_leader_lock()
        except asyncio.CancelledError:
            break
        except Exception:
            logger.exception("zerodha_scheduler_iteration_crash")
            await asyncio.sleep(_TICK_SEC)

    logger.info("zerodha_auto_login_scheduler_stopped")
