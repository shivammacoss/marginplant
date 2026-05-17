"""IST-aware time helpers and market-hours predicates."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from app.core.config import settings

IST: ZoneInfo = ZoneInfo(settings.DEFAULT_TIMEZONE)
UTC: timezone = timezone.utc


def now_utc() -> datetime:
    return datetime.now(UTC)


def now_ist() -> datetime:
    return datetime.now(IST)


def to_ist(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(IST)


def to_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=IST)
    return dt.astimezone(UTC)


def parse_hhmm(value: str) -> time:
    h, m = value.split(":", 1)
    return time(int(h), int(m))


def market_open_time() -> time:
    return parse_hhmm(settings.MARKET_OPEN_TIME)


def market_close_time() -> time:
    return parse_hhmm(settings.MARKET_CLOSE_TIME)


def is_weekend(d: date) -> bool:
    return d.weekday() >= 5  # Sat=5, Sun=6


def is_market_open(at: datetime | None = None) -> bool:
    """Naive check — does NOT consider holidays. The HolidayService overlays that."""
    now = to_ist(at or now_ist())
    if is_weekend(now.date()):
        return False
    return market_open_time() <= now.time() <= market_close_time()


def start_of_day_ist(d: date | None = None) -> datetime:
    d = d or now_ist().date()
    return datetime.combine(d, time.min, tzinfo=IST)


def end_of_day_ist(d: date | None = None) -> datetime:
    d = d or now_ist().date()
    return datetime.combine(d, time.max, tzinfo=IST)


def add_business_days(d: date, n: int) -> date:
    """Naive — does not consider holidays. For T+1/T+2 settlement."""
    out = d
    added = 0
    while added < n:
        out += timedelta(days=1)
        if not is_weekend(out):
            added += 1
    return out


# ── Segment-aware market-close helpers ───────────────────────────────
# Used by the auto MIS→NRML rollover loop. Indian equity + F&O close at
# 15:30 IST; MCX runs until 23:55 IST; forex (CDS) is 24/5 and crypto is
# 24/7 — those segments have no daily rollover, so they're explicitly
# excluded from the loop instead of carrying a sentinel close time.
NSE_BSE_CLOSE: time = time(15, 30)
MCX_CLOSE: time = time(23, 55)

INDIAN_EQUITY_FNO_SEGMENTS: frozenset[str] = frozenset({
    "NSE_EQUITY",
    "NSE_FUTURE", "NSE_INDEX_FUTURE",
    "NSE_STOCK_OPTION_BUY", "NSE_STOCK_OPTION_SELL",
    "NSE_INDEX_OPTION_BUY", "NSE_INDEX_OPTION_SELL",
    "BSE_EQUITY",
    "BSE_FUTURE", "BSE_INDEX_FUTURE",
    "BSE_OPTION_BUY", "BSE_OPTION_SELL",
})
MCX_SEGMENTS: frozenset[str] = frozenset({
    "MCX_FUTURE", "MCX_OPTION_BUY", "MCX_OPTION_SELL",
})
ROLLOVER_EXEMPT_SEGMENTS: frozenset[str] = frozenset({
    # Forex: 24/5 — no intraday close, MIS stays MIS across days until weekend.
    "CDS_FUTURE", "CDS_OPTION_BUY", "CDS_OPTION_SELL",
    # Crypto: 24/7 — never converts.
    "CRYPTO_SPOT", "CRYPTO_FUTURE", "CRYPTO_PERPETUAL",
})


def market_close_time_for_segment(segment: str | None) -> time | None:
    """IST close time for the segment's exchange group, or None when the
    segment doesn't have a daily close (forex / crypto)."""
    if not segment:
        return None
    if segment in INDIAN_EQUITY_FNO_SEGMENTS:
        return NSE_BSE_CLOSE
    if segment in MCX_SEGMENTS:
        return MCX_CLOSE
    return None  # ROLLOVER_EXEMPT_SEGMENTS or anything unknown


def is_after_close(segment: str, at: datetime | None = None) -> bool:
    """True if the given IST instant is at or past the segment's close.
    Returns False for rollover-exempt segments (forex / crypto)."""
    close_t = market_close_time_for_segment(segment)
    if close_t is None:
        return False
    now = to_ist(at) if at else now_ist()
    return now.time() >= close_t
