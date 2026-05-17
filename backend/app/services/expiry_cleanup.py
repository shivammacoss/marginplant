"""Daily instrument-expiry cleanup.

Background loop that runs every hour and applies the same rule the user
asked for:

    Expiry day  → instrument still shows / trades normally
    Day after   → instrument is removed from every user's watchlist,
                  unsubscribed from Zerodha, and marked inactive in the
                  Instrument collection so search stops returning it.

Idempotent — running twice in a row is a no-op once everything has been
swept. The loop exists so admins don't have to remember to nuke yesterday's
expired option chain manually.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from app.models.instrument import Instrument
from app.models.watchlist import WatchlistItem

logger = logging.getLogger(__name__)

IST = timezone(timedelta(hours=5, minutes=30))

_running = False


def _ist_today_date():
    """Indian trading-day boundary. We compare against IST midnight, not
    UTC, so a contract expiring on Thursday 'survives' through to Friday
    morning 00:00 IST regardless of the host machine's timezone."""
    return datetime.now(IST).date()


async def cleanup_expired_once() -> dict[str, int]:
    """Single sweep. Returns counts so the caller can log what changed.

    Strategy:
      • cutoff_date = today_IST - 1 day. Anything with `expiry < today_IST`
        is "yesterday or earlier" → cleanup target.
      • For each expired Instrument:
          - delete every WatchlistItem that references its token (across all
            users — there's no per-user opt-out for an expired contract)
          - unsubscribe the token from the Zerodha live ticker (skipped for
            non-Kite tokens)
          - mark the Instrument is_active=False so /instruments/search stops
            returning it. We DON'T hard-delete — historical orders / trades
            still reference these tokens.
    """
    today = _ist_today_date()
    expired = await Instrument.find(
        {"expiry": {"$ne": None, "$lt": today}, "is_active": True}
    ).to_list()
    if not expired:
        return {"instruments": 0, "watchlist_items": 0, "unsubscribed": 0}

    expired_tokens = [str(i.token) for i in expired]
    # 1) Yank from every user's watchlist
    wl_result = await WatchlistItem.find(
        {"instrument_token": {"$in": expired_tokens}}
    ).delete()
    wl_removed = getattr(wl_result, "deleted_count", 0) or 0

    # 2) Unsubscribe from Zerodha — only for numeric Kite tokens
    int_tokens: list[int] = []
    for t in expired_tokens:
        try:
            int_tokens.append(int(t))
        except (TypeError, ValueError):
            pass
    unsubbed = 0
    if int_tokens:
        try:
            from app.services.zerodha_service import zerodha
            unsubbed = await zerodha.unsubscribe_tokens_on_demand(int_tokens)
        except Exception:
            logger.exception("expiry_cleanup_zerodha_unsubscribe_failed")

    # 3) Mark inactive so search stops returning them
    for inst in expired:
        try:
            inst.is_active = False
            inst.is_tradable = False
            await inst.save()
        except Exception:
            logger.exception(
                "expiry_cleanup_instrument_save_failed", extra={"token": inst.token}
            )

    logger.info(
        "expiry_cleanup_swept",
        extra={
            "instruments": len(expired),
            "watchlist_items_removed": wl_removed,
            "tokens_unsubscribed": unsubbed,
            "cutoff_date": str(today),
        },
    )
    return {
        "instruments": len(expired),
        "watchlist_items": wl_removed,
        "unsubscribed": unsubbed,
    }


async def expiry_cleanup_loop(interval_sec: float = 3600.0) -> None:
    """Hourly sweep. An hourly cadence is enough because expiry happens at
    instrument granularity (date), not minute — but it's frequent enough
    that users never see day-old contracts after the boundary. Idempotent
    — second call returns immediately."""
    global _running
    if _running:
        return
    _running = True
    logger.info("expiry_cleanup_loop_started", extra={"interval_sec": interval_sec})
    try:
        # First sweep happens immediately on boot — picks up anything that
        # expired while the server was down.
        try:
            await cleanup_expired_once()
        except Exception:
            logger.exception("expiry_cleanup_initial_sweep_failed")
        while _running:
            await asyncio.sleep(interval_sec)
            try:
                await cleanup_expired_once()
            except Exception:
                logger.exception("expiry_cleanup_tick_failed")
    finally:
        _running = False
        logger.info("expiry_cleanup_loop_stopped")


def stop_expiry_cleanup() -> None:
    global _running
    _running = False
