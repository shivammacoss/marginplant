"""Tests for the auto-settle scheduler."""

from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
import pytest_asyncio
from bson import Decimal128

from app.models.pnl_sharing import (
    AgreementStatus,
    PnlSharingAgreement,
    PnlSharingSettlement,
    SettlementCadence,
    SettlementMode,
    SharingSettlementStatus,
)
from app.services import pnl_sharing_service as svc


@pytest_asyncio.fixture
async def auto_monthly_agreement(db, admin_user, broker_user) -> PnlSharingAgreement:
    a = PnlSharingAgreement(
        admin_id=admin_user.id,
        broker_id=broker_user.id,
        share_pct=Decimal128("30"),
        settlement_mode=SettlementMode.AUTO,
        settlement_cadence=SettlementCadence.MONTHLY,
        status=AgreementStatus.ACTIVE,
        effective_from=datetime(2026, 3, 1, tzinfo=timezone.utc),
        created_by=admin_user.id,
        last_modified_by=admin_user.id,
    )
    await a.insert()
    return a


@pytest_asyncio.fixture
async def auto_daily_agreement(db, admin_user, broker_user) -> PnlSharingAgreement:
    a = PnlSharingAgreement(
        admin_id=admin_user.id,
        broker_id=broker_user.id,
        share_pct=Decimal128("30"),
        settlement_mode=SettlementMode.AUTO,
        settlement_cadence=SettlementCadence.DAILY,
        status=AgreementStatus.ACTIVE,
        effective_from=datetime(2026, 1, 1, tzinfo=timezone.utc),
        created_by=admin_user.id,
        last_modified_by=admin_user.id,
    )
    await a.insert()
    return a


@pytest.mark.asyncio
async def test_find_due_includes_active_auto_monthly(db, auto_monthly_agreement):
    """Mid-May → April is the just-closed monthly period for AUTO+MONTHLY agreement."""
    now = datetime(2026, 5, 15, 10, 0, tzinfo=timezone.utc)
    due = await svc.find_due_settlements(now=now)
    assert len(due) == 1
    agreement, period_start, period_end = due[0]
    assert agreement.id == auto_monthly_agreement.id
    # period_end must be before now (period has closed)
    assert period_end < now


@pytest.mark.asyncio
async def test_find_due_skips_paused(db, admin_user, broker_user):
    a = PnlSharingAgreement(
        admin_id=admin_user.id, broker_id=broker_user.id,
        share_pct=Decimal128("30"), settlement_mode=SettlementMode.AUTO,
        settlement_cadence=SettlementCadence.DAILY,
        status=AgreementStatus.PAUSED,
        effective_from=datetime(2026, 1, 1, tzinfo=timezone.utc),
        created_by=admin_user.id, last_modified_by=admin_user.id,
    )
    await a.insert()
    now = datetime(2026, 5, 15, 10, 0, tzinfo=timezone.utc)
    due = await svc.find_due_settlements(now=now)
    assert due == []


@pytest.mark.asyncio
async def test_find_due_skips_ended(db, admin_user, broker_user):
    a = PnlSharingAgreement(
        admin_id=admin_user.id, broker_id=broker_user.id,
        share_pct=Decimal128("30"), settlement_mode=SettlementMode.AUTO,
        settlement_cadence=SettlementCadence.DAILY,
        status=AgreementStatus.ENDED,
        effective_from=datetime(2026, 1, 1, tzinfo=timezone.utc),
        effective_until=datetime(2026, 4, 1, tzinfo=timezone.utc),
        created_by=admin_user.id, last_modified_by=admin_user.id,
    )
    await a.insert()
    now = datetime(2026, 5, 15, 10, 0, tzinfo=timezone.utc)
    due = await svc.find_due_settlements(now=now)
    assert due == []


@pytest.mark.asyncio
async def test_find_due_skips_manual_mode(db, admin_user, broker_user):
    a = PnlSharingAgreement(
        admin_id=admin_user.id, broker_id=broker_user.id,
        share_pct=Decimal128("30"), settlement_mode=SettlementMode.MANUAL,
        settlement_cadence=None, status=AgreementStatus.ACTIVE,
        effective_from=datetime(2026, 1, 1, tzinfo=timezone.utc),
        created_by=admin_user.id, last_modified_by=admin_user.id,
    )
    await a.insert()
    now = datetime(2026, 5, 15, 10, 0, tzinfo=timezone.utc)
    due = await svc.find_due_settlements(now=now)
    assert due == []


@pytest.mark.asyncio
async def test_find_due_skips_when_effective_from_after_period(db, admin_user, broker_user):
    """Agreement created mid-period — should NOT auto-settle that partial period."""
    a = PnlSharingAgreement(
        admin_id=admin_user.id, broker_id=broker_user.id,
        share_pct=Decimal128("30"), settlement_mode=SettlementMode.AUTO,
        settlement_cadence=SettlementCadence.MONTHLY,
        status=AgreementStatus.ACTIVE,
        effective_from=datetime(2026, 4, 15, tzinfo=timezone.utc),  # mid-April
        created_by=admin_user.id, last_modified_by=admin_user.id,
    )
    await a.insert()
    # "Now" = mid-May → April is the just-closed month, but agreement was
    # only active for half of April → skip
    now = datetime(2026, 5, 15, 10, 0, tzinfo=timezone.utc)
    due = await svc.find_due_settlements(now=now)
    assert due == []


@pytest.mark.asyncio
async def test_find_due_skips_already_settled(db, auto_monthly_agreement):
    """If a SETTLED row already exists for the period, don't re-yield."""
    now = datetime(2026, 5, 15, 10, 0, tzinfo=timezone.utc)
    # Compute April's bounds the same way find_due_settlements does
    ref = now - timedelta(days=32)
    period_start, period_end = svc.compute_period_bounds(SettlementCadence.MONTHLY, ref)

    existing = PnlSharingSettlement(
        agreement_id=auto_monthly_agreement.id,
        admin_id=auto_monthly_agreement.admin_id,
        broker_id=auto_monthly_agreement.broker_id,
        period_start=period_start,
        period_end=period_end,
        cadence=SettlementCadence.MONTHLY,
        status=SharingSettlementStatus.SETTLED,
    )
    await existing.insert()

    due = await svc.find_due_settlements(now=now)
    assert due == []


@pytest.mark.asyncio
async def test_find_due_yields_when_failed_row_exists(db, auto_monthly_agreement):
    """A FAILED row from previous attempt should re-fire (so wallet top-up can resolve)."""
    now = datetime(2026, 5, 15, 10, 0, tzinfo=timezone.utc)
    ref = now - timedelta(days=32)
    period_start, period_end = svc.compute_period_bounds(SettlementCadence.MONTHLY, ref)

    existing = PnlSharingSettlement(
        agreement_id=auto_monthly_agreement.id,
        admin_id=auto_monthly_agreement.admin_id,
        broker_id=auto_monthly_agreement.broker_id,
        period_start=period_start,
        period_end=period_end,
        cadence=SettlementCadence.MONTHLY,
        status=SharingSettlementStatus.FAILED,
        failure_reason="insufficient funds",
    )
    await existing.insert()

    due = await svc.find_due_settlements(now=now)
    assert len(due) == 1
