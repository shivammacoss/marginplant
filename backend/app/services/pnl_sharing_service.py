"""P&L Sharing — compute, CRUD, and settlement service.

Pure compute functions are at the top (no DB writes — easy to test).
CRUD and settle helpers will be appended in later tasks.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from beanie import PydanticObjectId

from app.models.pnl_sharing import PnlSharingAgreement, SettlementCadence
from app.models.position import Position, PositionStatus
from app.models.transaction import TransactionType, WalletTransaction
from app.models.user import User
from app.services import market_data_service
from app.services.admin_settlement_service import _realised_inr
from app.utils.decimal_utils import quantize_money, to_decimal

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
        end_ist = start_ist.replace(hour=23, minute=59, second=59, microsecond=999999)
    elif cadence == SettlementCadence.WEEKLY:
        # Same Mon-Sun IST week as admin_settlement_service.ist_week_bounds —
        # kept inline here so DAILY/WEEKLY/MONTHLY share one switch.
        days_since_monday = ref_ist.weekday()  # Mon=0
        monday_ist = (ref_ist - timedelta(days=days_since_monday)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        start_ist = monday_ist
        end_ist = (monday_ist + timedelta(days=6)).replace(
            hour=23, minute=59, second=59, microsecond=999999
        )
    elif cadence == SettlementCadence.MONTHLY:
        start_ist = ref_ist.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        last_day = calendar.monthrange(ref_ist.year, ref_ist.month)[1]
        end_ist = start_ist.replace(
            day=last_day, hour=23, minute=59, second=59, microsecond=999999
        )
    else:
        raise ValueError(f"Unknown cadence: {cadence}")

    return start_ist.astimezone(UTC), end_ist.astimezone(UTC)


# ── Snapshot aggregation ─────────────────────────────────────────────
@dataclass(frozen=True)
class SharingSnapshot:
    """One period's aggregated view of a broker's clients' P&L and brokerage.

    Sign convention (locked):
      - ``net_client_pnl_inr`` is CLIENT-view: positive means clients profited,
        negative means clients lost (= broker won that side).
      - ``net_client_bkg_inr`` is the absolute total brokerage collected; ≥ 0.
      - ``total_of_both_inr`` is BROKER-view = -(net_client_pnl) + net_client_bkg.
        Positive means the broker gained (clients lost + brokerage); negative
        means the broker lost.
      - ``actual_pnl_inr`` is the broker's net economic position for the period.
        In Phase A there is no prior-settlement deduction, so it equals
        ``total_of_both_inr``.
      - ``sharing_pnl_inr`` is the admin's share of the broker's PnL component:
        ``share_pct% × (-(net_client_pnl))``.
      - ``sharing_bkg_inr`` is the admin's share of the brokerage component:
        ``share_pct% × net_client_bkg``.
      - ``sharing_total_inr`` is ``sharing_pnl_inr + sharing_bkg_inr``.
    """

    net_client_pnl_inr: Decimal
    net_client_bkg_inr: Decimal
    total_of_both_inr: Decimal
    actual_pnl_inr: Decimal
    sharing_pnl_inr: Decimal
    sharing_bkg_inr: Decimal
    sharing_total_inr: Decimal


async def _broker_client_ids(
    broker_id: PydanticObjectId,
) -> list[PydanticObjectId]:
    """User ids of direct clients under this broker (``assigned_broker_id``)."""
    coll = User.get_motor_collection()
    cursor = coll.find({"assigned_broker_id": broker_id}, {"_id": 1})
    return [doc["_id"] async for doc in cursor]


async def compute_sharing_snapshot(
    agreement: PnlSharingAgreement,
    period_start: datetime,
    period_end: datetime,
) -> SharingSnapshot:
    """Aggregate the broker's clients' realized P&L + brokerage in window
    and apply the agreement's share %.

    Pure-ish: reads from Mongo (Position / WalletTransaction / User) but
    writes nothing. The result is a frozen ``SharingSnapshot`` dataclass.

    Mirrors ``admin_settlement_service.compute_settlement`` at broker-level
    via ``assigned_broker_id`` instead of admin-level via ``assigned_admin_id``.
    """
    user_ids = await _broker_client_ids(agreement.broker_id)

    net_client_pnl = Decimal("0")
    net_client_bkg = Decimal("0")

    if user_ids:
        fallback_usd_inr = to_decimal(market_data_service.get_usd_inr_rate())

        positions = await Position.find(
            {
                "user_id": {"$in": user_ids},
                "status": PositionStatus.CLOSED.value,
                "closed_at": {"$gte": period_start, "$lte": period_end},
            }
        ).to_list()
        for p in positions:
            net_client_pnl += _realised_inr(p, fallback_usd_inr)

        bkg_txns = await WalletTransaction.find(
            {
                "user_id": {"$in": user_ids},
                "transaction_type": TransactionType.BROKERAGE.value,
                "created_at": {"$gte": period_start, "$lte": period_end},
            }
        ).to_list()
        for t in bkg_txns:
            net_client_bkg += abs(to_decimal(t.amount))

    share_frac = to_decimal(agreement.share_pct) / Decimal("100")
    broker_view_pnl = -net_client_pnl
    total_of_both = broker_view_pnl + net_client_bkg

    sharing_pnl = quantize_money(broker_view_pnl * share_frac)
    sharing_bkg = quantize_money(net_client_bkg * share_frac)

    return SharingSnapshot(
        net_client_pnl_inr=quantize_money(net_client_pnl),
        net_client_bkg_inr=quantize_money(net_client_bkg),
        total_of_both_inr=quantize_money(total_of_both),
        actual_pnl_inr=quantize_money(total_of_both),
        sharing_pnl_inr=sharing_pnl,
        sharing_bkg_inr=sharing_bkg,
        sharing_total_inr=sharing_pnl + sharing_bkg,
    )
