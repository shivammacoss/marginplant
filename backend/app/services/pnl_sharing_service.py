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
from bson import Decimal128

from app.models.pnl_sharing import (
    AgreementStatus,
    PnlSharingAgreement,
    SettlementCadence,
    SettlementMode,
)
from app.models.position import Position, PositionStatus
from app.models.transaction import TransactionType, WalletTransaction
from app.models.user import User, UserRole
from app.services import market_data_service
from app.services.admin_settlement_service import _realised_inr
from app.utils.decimal_utils import quantize_money, to_decimal
from app.utils.time_utils import now_utc

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


# ── Agreement CRUD ───────────────────────────────────────────────────
class AgreementValidationError(ValueError):
    """Validation failure on agreement create/update."""


class AgreementConflict(Exception):
    """An ACTIVE/PAUSED agreement for (admin, broker) already exists."""


async def create_agreement(
    *,
    actor: User,
    admin_id: PydanticObjectId,
    broker_id: PydanticObjectId,
    share_pct: Decimal,
    settlement_mode: SettlementMode,
    settlement_cadence: SettlementCadence | None,
) -> PnlSharingAgreement:
    if not (Decimal("0") <= share_pct <= Decimal("100")):
        raise AgreementValidationError("share_pct must be in [0, 100]")
    if settlement_mode == SettlementMode.AUTO and settlement_cadence is None:
        raise AgreementValidationError("AUTO mode requires cadence")
    if settlement_mode == SettlementMode.MANUAL and settlement_cadence is not None:
        raise AgreementValidationError("MANUAL mode must not set cadence")

    admin = await User.get(admin_id)
    if admin is None or admin.role != UserRole.ADMIN:
        raise AgreementValidationError("admin_id is not a valid admin user")

    broker = await User.get(broker_id)
    if (
        broker is None
        or broker.role != UserRole.BROKER
        or broker.assigned_admin_id != admin_id
    ):
        raise AgreementValidationError("broker_id is not a broker under admin_id")

    existing = await PnlSharingAgreement.find_one(
        PnlSharingAgreement.admin_id == admin_id,
        PnlSharingAgreement.broker_id == broker_id,
        PnlSharingAgreement.status != AgreementStatus.ENDED,
    )
    if existing is not None:
        raise AgreementConflict(f"Active agreement already exists: {existing.id}")

    a = PnlSharingAgreement(
        admin_id=admin_id,
        broker_id=broker_id,
        share_pct=Decimal128(str(share_pct)),
        settlement_mode=settlement_mode,
        settlement_cadence=settlement_cadence,
        status=AgreementStatus.ACTIVE,
        effective_from=now_utc(),
        created_by=actor.id,
        last_modified_by=actor.id,
    )
    await a.insert()
    return a


async def update_agreement(
    *,
    actor: User,
    agreement_id: PydanticObjectId,
    share_pct: Decimal | None = None,
    settlement_mode: SettlementMode | None = None,
    settlement_cadence: SettlementCadence | None = None,
) -> PnlSharingAgreement:
    a = await PnlSharingAgreement.get(agreement_id)
    if a is None:
        raise AgreementValidationError("agreement not found")
    if a.status == AgreementStatus.ENDED:
        raise AgreementValidationError("cannot edit ENDED agreement")

    if share_pct is not None:
        if not (Decimal("0") <= share_pct <= Decimal("100")):
            raise AgreementValidationError("share_pct must be in [0, 100]")
        a.share_pct = Decimal128(str(share_pct))

    if settlement_mode is not None:
        a.settlement_mode = settlement_mode
        if settlement_mode == SettlementMode.MANUAL:
            a.settlement_cadence = None
    if settlement_cadence is not None:
        a.settlement_cadence = settlement_cadence

    if a.settlement_mode == SettlementMode.AUTO and a.settlement_cadence is None:
        raise AgreementValidationError("AUTO mode requires cadence")

    a.last_modified_by = actor.id
    await a.save()
    return a


async def pause_agreement(
    *, actor: User, agreement_id: PydanticObjectId
) -> PnlSharingAgreement:
    a = await PnlSharingAgreement.get(agreement_id)
    if a is None:
        raise AgreementValidationError("agreement not found")
    if a.status != AgreementStatus.ACTIVE:
        raise AgreementValidationError(f"cannot pause from status {a.status}")
    a.status = AgreementStatus.PAUSED
    a.last_modified_by = actor.id
    await a.save()
    return a


async def resume_agreement(
    *, actor: User, agreement_id: PydanticObjectId
) -> PnlSharingAgreement:
    a = await PnlSharingAgreement.get(agreement_id)
    if a is None:
        raise AgreementValidationError("agreement not found")
    if a.status != AgreementStatus.PAUSED:
        raise AgreementValidationError(f"cannot resume from status {a.status}")
    a.status = AgreementStatus.ACTIVE
    a.last_modified_by = actor.id
    await a.save()
    return a


async def end_agreement(
    *, actor: User, agreement_id: PydanticObjectId
) -> PnlSharingAgreement:
    a = await PnlSharingAgreement.get(agreement_id)
    if a is None:
        raise AgreementValidationError("agreement not found")
    if a.status == AgreementStatus.ENDED:
        raise AgreementValidationError("already ended")
    a.status = AgreementStatus.ENDED
    a.effective_until = now_utc()
    a.last_modified_by = actor.id
    await a.save()
    return a


async def list_agreements_for_actor(
    *,
    actor: User,
    status: AgreementStatus | None = None,
    admin_id: PydanticObjectId | None = None,
    broker_id: PydanticObjectId | None = None,
    skip: int = 0,
    limit: int = 50,
) -> list[PnlSharingAgreement]:
    q = PnlSharingAgreement.find()
    if actor.role == UserRole.ADMIN:
        q = q.find(PnlSharingAgreement.admin_id == actor.id)
    elif actor.role == UserRole.BROKER:
        q = q.find(PnlSharingAgreement.broker_id == actor.id)
    if status is not None:
        q = q.find(PnlSharingAgreement.status == status)
    if admin_id is not None:
        q = q.find(PnlSharingAgreement.admin_id == admin_id)
    if broker_id is not None:
        q = q.find(PnlSharingAgreement.broker_id == broker_id)
    return await q.skip(skip).limit(limit).to_list()
