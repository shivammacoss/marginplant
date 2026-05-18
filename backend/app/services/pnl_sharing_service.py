"""P&L Sharing — compute, CRUD, and settlement service.

Pure compute functions are at the top (no DB writes — easy to test).
CRUD and settle helpers will be appended in later tasks.
"""

from __future__ import annotations

import calendar
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from app.models.pnl_sharing import SettlementCadence

IST = ZoneInfo("Asia/Kolkata")
UTC = ZoneInfo("UTC")


def _as_ist(dt: datetime) -> datetime:
    """Treat naive datetimes as IST; convert tz-aware to IST."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=IST)
    return dt.astimezone(IST)


def compute_period_bounds(
    cadence: SettlementCadence, ref_dt: datetime
) -> tuple[datetime, datetime]:
    """Return (start_utc, end_utc) for the period containing ref_dt.

    Bounds are IST-anchored. End is inclusive of last millisecond
    (23:59:59.999000 in IST).
    """
    ref_ist = _as_ist(ref_dt)

    if cadence == SettlementCadence.DAILY:
        start_ist = ref_ist.replace(hour=0, minute=0, second=0, microsecond=0)
        end_ist = start_ist.replace(hour=23, minute=59, second=59, microsecond=999_000)
    elif cadence == SettlementCadence.WEEKLY:
        days_since_monday = ref_ist.weekday()  # Mon=0
        monday_ist = (ref_ist - timedelta(days=days_since_monday)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        start_ist = monday_ist
        end_ist = (monday_ist + timedelta(days=6)).replace(
            hour=23, minute=59, second=59, microsecond=999_000
        )
    elif cadence == SettlementCadence.MONTHLY:
        start_ist = ref_ist.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        last_day = calendar.monthrange(ref_ist.year, ref_ist.month)[1]
        end_ist = start_ist.replace(
            day=last_day, hour=23, minute=59, second=59, microsecond=999_000
        )
    else:
        raise ValueError(f"Unknown cadence: {cadence}")

    return start_ist.astimezone(UTC), end_ist.astimezone(UTC)
