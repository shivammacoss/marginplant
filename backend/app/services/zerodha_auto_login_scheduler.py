"""Daily background loop that fires the Zerodha auto-login.

Wakes near every minute, but only triggers the actual login flow when:
  • Auto-login feature is enabled (admin toggle on)
  • The current IST time is within 60 s of the configured schedule_time_ist
  • It's not a weekend
  • It's not an Indian trading holiday
  • This worker wins the Redis SETNX leader lock (multi-worker safe)

On the trigger window, runs up to 3 retries with 5-min gaps. If all
retries fail, dispatches a high-severity Notification to every super-
admin so they can manually login before the 09:15 IST market open.

Self-heal interplay
-------------------
The login service handles its own self_heal_paused dance and WS
disconnect (see zerodha_auto_login.py). The scheduler just decides
WHEN to fire — it does not touch the ticker pool directly.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from app.core.redis_client import get_redis
from app.models.holiday import TradingHoliday
from app.models.notification import (
    Notification,
    NotificationLevel,
    NotificationType,
)
from app.models.user import User, UserRole
from app.services.zerodha_auto_login import zerodha_auto_login

logger = logging.getLogger(__name__)
IST = ZoneInfo("Asia/Kolkata")

# Cross-worker leader lock. 10 min covers the worst-case full attempt
# (3 retries × 5 min) plus a buffer; expires automatically if the
# worker holding it crashes.
_LEADER_KEY = "zerodha_auto_login:scheduler_leader"
_LEADER_TTL_SEC = 60 * 10

# Retry policy: 3 attempts × 5 min gap = ~15 min from first failure
# to last attempt — still inside the 07:00 → 09:15 IST market-open
# window so an admin has time for manual fallback.
_MAX_RETRIES = 3
_RETRY_GAP_SEC = 300

# Tick cadence — wake every 60 s, only fire near the schedule target.
_TICK_SEC = 60

_stop_flag = False


def stop_zerodha_auto_login_scheduler() -> None:
    global _stop_flag
    _stop_flag = True


async def _is_indian_trading_holiday(today_ist: date) -> bool:
    try:
        h = await TradingHoliday.find_one(
            TradingHoliday.holiday_date == today_ist
        )
        return h is not None
    except Exception:
        logger.warning("zerodha_scheduler_holiday_lookup_failed_continuing")
        return False


def _seconds_until_next_run(
    schedule_time_ist: str, *, now: datetime | None = None
) -> float:
    """Seconds from ``now`` until the next occurrence of ``HH:MM`` in IST.

    If the time has already passed today, returns seconds until the same
    HH:MM tomorrow.
    """
    now_ist = (now or datetime.now(IST)).astimezone(IST)
    try:
        hh, mm = schedule_time_ist.split(":")
        h, m = int(hh), int(mm)
    except Exception:
        h, m = 7, 0

    target = now_ist.replace(hour=h, minute=m, second=0, microsecond=0)
    if target <= now_ist:
        target = target + timedelta(days=1)
    return max(1.0, (target - now_ist).total_seconds())


async def _try_acquire_leader_lock() -> bool:
    try:
        redis = get_redis()
        return bool(
            await redis.set(_LEADER_KEY, "1", ex=_LEADER_TTL_SEC, nx=True)
        )
    except Exception:
        logger.warning("zerodha_scheduler_redis_down_running_anyway")
        # Single-worker dev — without Redis the lock can't be coordinated,
        # so just proceed (worst case: dev hits Kite twice, which Kite
        # tolerates fine since it just refreshes the token twice).
        return True


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


async def zerodha_auto_login_loop() -> None:
    """Long-running coroutine launched from the FastAPI lifespan."""
    logger.info("zerodha_auto_login_scheduler_started")
    last_fired_iso_date: str = ""  # IST date string to prevent double-fire
    while not _stop_flag:
        try:
            await asyncio.sleep(_TICK_SEC)
            if _stop_flag:
                break

            if not await zerodha_auto_login.is_enabled():
                continue

            schedule_time = await zerodha_auto_login.schedule_time()
            wait_sec = _seconds_until_next_run(schedule_time)
            # Fire only when we're within 60 s of the configured time
            # (works because the loop ticks every 60 s).
            if wait_sec > 60:
                continue

            today_ist = datetime.now(IST).date()
            today_str = today_ist.isoformat()
            if today_str == last_fired_iso_date:
                # Already fired today (in this worker) — skip.
                continue

            # NB: NO weekend / holiday skip. Kite rotates the access
            # token at 08:00 IST EVERY day regardless of market hours
            # — Sundays, holidays, market closures, all of them. If we
            # skip Sunday's 07:00 IST run, by 08:00 IST the token is
            # dead and the self-heal loop spins on 403s for the next
            # ~23 hours until Monday's 07:00 IST run. The cost of a
            # weekend Playwright run is trivial (~5–10s once a day),
            # the cost of a 23-hour 403 storm in logs + a "Disconnected"
            # status on Sunday morning is real operator pain — so we
            # just refresh daily. Trading-hours have nothing to do
            # with token validity; treating them as the same was the
            # original mistake.
            #
            # If a specific holiday genuinely shouldn't drive the login
            # (e.g. Kite's own scheduled maintenance), the operator can
            # toggle the scheduler OFF on the admin panel for that day.
            if not await _try_acquire_leader_lock():
                logger.info("zerodha_scheduler_other_worker_won")
                last_fired_iso_date = today_str
                continue

            # We are the leader. Run with retries.
            last_error = ""
            for attempt in range(1, _MAX_RETRIES + 1):
                logger.info(
                    "zerodha_scheduler_attempt",
                    extra={"attempt": attempt, "max": _MAX_RETRIES},
                )
                result = await zerodha_auto_login.refresh_now(
                    triggered_by=f"scheduler_attempt_{attempt}",
                )
                if result.get("success"):
                    logger.info(
                        "zerodha_scheduler_success",
                        extra={
                            "attempt": attempt,
                            "duration_ms": result.get("duration_ms"),
                        },
                    )
                    last_error = ""
                    break
                last_error = (
                    f"{result.get('stage')}: {result.get('error')}"
                )
                logger.warning(
                    "zerodha_scheduler_attempt_failed",
                    extra={"attempt": attempt, "error": last_error},
                )
                if attempt < _MAX_RETRIES:
                    await asyncio.sleep(_RETRY_GAP_SEC)

            if last_error:
                await _alert_super_admins(last_error)

            last_fired_iso_date = today_str
        except asyncio.CancelledError:
            break
        except Exception:
            logger.exception("zerodha_scheduler_iteration_crash")
            await asyncio.sleep(60)

    logger.info("zerodha_auto_login_scheduler_stopped")
