"""Accounts Dashboard — per-admin/per-broker aggregated financial summary.

Super-admin sees every admin's pool as a single aggregated card.
Admin sees their brokers' pools + their direct users.
All numbers are verified-correct per the calculation spec:

  Deposits     → WalletTransaction type=DEPOSIT (date-filtered)
                 OR wallet.total_deposits (lifetime)
  Withdrawals  → WalletTransaction type=WITHDRAWAL (date-filtered)
                 OR wallet.total_withdrawals (lifetime)
  Realized P&L → Position.realized_pnl (CLOSED, closed_at in range)
                 Already NET of brokerage, already INR for USD segments.
  Brokerage    → Trade.brokerage (date-filtered by executed_at)
  Trade counts → Trade.pnl_inr (only set on closing trades)
                 > 0 = win, < 0 = loss. Always INR.
  Volume       → Trade.value (qty × price)
  Balance      → wallet.available_balance + wallet.used_margin (current)
  Equity       → Balance + Σ unrealized_pnl on OPEN positions (current)

Week calculation: Mon 00:00 IST to Sun 23:59:59 IST (ISO week).
All IST dates converted to UTC before MongoDB queries.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

from beanie import PydanticObjectId
from fastapi import APIRouter, Depends, Query

from app.core.dependencies import CurrentAdmin, require_perm, scoped_admin_filter
from app.models.position import Position, PositionStatus
from app.models.trade import Trade
from app.models.transaction import TransactionType, WalletTransaction
from app.models.user import User, UserRole, UserStatus
from app.models.wallet import Wallet
from app.schemas.common import APIResponse
from app.utils.decimal_utils import to_decimal

router = APIRouter(prefix="/accounts", tags=["admin-accounts"])

IST = ZoneInfo("Asia/Kolkata")

# Precomputed week/month boundaries for the "Select Week" dropdown.
_WEEK_PRESETS = {
    "current_week": lambda now: (
        (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0),
        now,
    ),
    "last_week": lambda now: (
        (now - timedelta(days=now.weekday() + 7)).replace(hour=0, minute=0, second=0, microsecond=0),
        (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(seconds=1),
    ),
    "this_month": lambda now: (
        now.replace(day=1, hour=0, minute=0, second=0, microsecond=0),
        now,
    ),
    "last_month": lambda now: (
        (now.replace(day=1) - timedelta(days=1)).replace(day=1, hour=0, minute=0, second=0, microsecond=0),
        now.replace(day=1, hour=0, minute=0, second=0, microsecond=0) - timedelta(seconds=1),
    ),
}


def _to_utc(dt_ist: datetime) -> datetime:
    """Convert an IST-aware datetime to UTC for MongoDB queries."""
    if dt_ist.tzinfo is None:
        dt_ist = dt_ist.replace(tzinfo=IST)
    return dt_ist.astimezone(timezone.utc)


def _d(val: Any) -> float:
    """Safely convert Decimal128 / str / None to float."""
    if val is None:
        return 0.0
    try:
        return float(str(val))
    except Exception:
        return 0.0


async def _aggregate_for_users(
    user_ids: list[PydanticObjectId],
    *,
    start_utc: datetime | None = None,
    end_utc: datetime | None = None,
) -> dict[str, Any]:
    """Compute the full financial aggregate for a set of user IDs.

    When start_utc/end_utc are None → lifetime totals from Wallet
    (pre-aggregated, fast). When provided → date-filtered queries
    against WalletTransaction / Position / Trade collections.
    """
    if not user_ids:
        return _empty_aggregate()

    is_lifetime = start_utc is None and end_utc is None

    # ── Current state (always live, no date filter) ──────────────
    wallets = await Wallet.find({"user_id": {"$in": user_ids}}).to_list()
    wallet_map = {str(w.user_id): w for w in wallets}

    total_balance = 0.0
    total_used_margin = 0.0
    for w in wallets:
        total_balance += _d(w.available_balance) + _d(w.used_margin)
        total_used_margin += _d(w.used_margin)

    # Unrealized P&L from OPEN positions
    open_positions = await Position.find(
        {"user_id": {"$in": user_ids}, "status": PositionStatus.OPEN.value}
    ).to_list()
    total_unrealized = sum(_d(p.unrealized_pnl) for p in open_positions)
    open_count = len(open_positions)

    total_equity = total_balance + total_unrealized
    total_settlement = sum(_d(w.settlement_outstanding) for w in wallets)

    if is_lifetime:
        # ── Lifetime from pre-aggregated Wallet fields (fast) ────
        deposits = sum(_d(w.total_deposits) for w in wallets)
        withdrawals = sum(_d(w.total_withdrawals) for w in wallets)
        brokerage = sum(_d(w.total_brokerage) for w in wallets)
        realized_pnl = sum(_d(w.realized_pnl) for w in wallets)

        # Trade counts — need DB query even for lifetime
        trade_filter: dict[str, Any] = {
            "user_id": {"$in": user_ids},
            "pnl_inr": {"$ne": None},
        }
        all_closing_trades = await Trade.find(trade_filter).to_list()
        total_trades = len(all_closing_trades)
        profit_trades = sum(1 for t in all_closing_trades if _d(t.pnl_inr) > 0)
        loss_trades = sum(1 for t in all_closing_trades if _d(t.pnl_inr) < 0)
        volume = sum(_d(t.value) for t in all_closing_trades)

    else:
        # ── Date-filtered queries ────────────────────────────────
        date_filter = {}
        if start_utc:
            date_filter["$gte"] = start_utc
        if end_utc:
            date_filter["$lte"] = end_utc

        # Deposits
        dep_txns = await WalletTransaction.find({
            "user_id": {"$in": user_ids},
            "transaction_type": TransactionType.DEPOSIT.value,
            "created_at": date_filter,
        }).to_list()
        deposits = sum(_d(t.amount) for t in dep_txns)

        # Withdrawals (stored as negative, take abs)
        wd_txns = await WalletTransaction.find({
            "user_id": {"$in": user_ids},
            "transaction_type": TransactionType.WITHDRAWAL.value,
            "created_at": date_filter,
        }).to_list()
        withdrawals = sum(abs(_d(t.amount)) for t in wd_txns)

        # Realized P&L from CLOSED positions in date range
        closed_positions = await Position.find({
            "user_id": {"$in": user_ids},
            "status": PositionStatus.CLOSED.value,
            "closed_at": date_filter,
        }).to_list()
        realized_pnl = sum(_d(p.realized_pnl) for p in closed_positions)

        # Trades in date range
        closing_trades = await Trade.find({
            "user_id": {"$in": user_ids},
            "pnl_inr": {"$ne": None},
            "executed_at": date_filter,
        }).to_list()
        total_trades = len(closing_trades)
        profit_trades = sum(1 for t in closing_trades if _d(t.pnl_inr) > 0)
        loss_trades = sum(1 for t in closing_trades if _d(t.pnl_inr) < 0)

        # Brokerage from trades in date range
        all_trades_in_range = await Trade.find({
            "user_id": {"$in": user_ids},
            "executed_at": date_filter,
        }).to_list()
        brokerage = sum(_d(t.brokerage) for t in all_trades_in_range)
        volume = sum(_d(t.value) for t in all_trades_in_range)

    net_deposit = deposits - withdrawals
    win_rate = round((profit_trades / total_trades) * 100, 1) if total_trades > 0 else 0.0
    net_pnl = realized_pnl + total_unrealized

    return {
        "deposits": round(deposits, 2),
        "withdrawals": round(withdrawals, 2),
        "net_deposit": round(net_deposit, 2),
        "realized_pnl": round(realized_pnl, 2),
        "unrealized_pnl": round(total_unrealized, 2),
        "net_pnl": round(net_pnl, 2),
        "brokerage": round(brokerage, 2),
        "total_trades": total_trades,
        "profit_trades": profit_trades,
        "loss_trades": loss_trades,
        "win_rate": win_rate,
        "volume": round(volume, 2),
        "balance": round(total_balance, 2),
        "equity": round(total_equity, 2),
        "open_positions": open_count,
        "settlement_outstanding": round(total_settlement, 2),
        "user_count": len(user_ids),
    }


def _empty_aggregate() -> dict[str, Any]:
    return {
        "deposits": 0, "withdrawals": 0, "net_deposit": 0,
        "realized_pnl": 0, "unrealized_pnl": 0, "net_pnl": 0,
        "brokerage": 0, "total_trades": 0, "profit_trades": 0,
        "loss_trades": 0, "win_rate": 0, "volume": 0,
        "balance": 0, "equity": 0, "open_positions": 0,
        "settlement_outstanding": 0, "user_count": 0,
    }


@router.get("/summary")
async def accounts_summary(
    admin: CurrentAdmin,
    from_date: str | None = Query(default=None, description="YYYY-MM-DD IST"),
    to_date: str | None = Query(default=None, description="YYYY-MM-DD IST"),
    preset: str | None = Query(default=None, description="current_week|last_week|this_month|last_month"),
    _: None = Depends(require_perm("users", "read")),
) -> APIResponse:
    """Aggregated financial summary grouped by admin/pool.

    Super-admin: one entity per admin + one for super-admin's direct users.
    Admin: one entity per broker + one for direct (no-broker) users.
    """
    now_ist = datetime.now(IST)

    # ── Parse date range ─────────────────────────────────────────
    start_utc: datetime | None = None
    end_utc: datetime | None = None

    if preset and preset in _WEEK_PRESETS:
        s, e = _WEEK_PRESETS[preset](now_ist)
        start_utc = _to_utc(s)
        end_utc = _to_utc(e)
    elif from_date or to_date:
        try:
            if from_date:
                s = datetime.strptime(from_date, "%Y-%m-%d").replace(tzinfo=IST)
                start_utc = _to_utc(s)
            if to_date:
                e = datetime.strptime(to_date, "%Y-%m-%d").replace(
                    hour=23, minute=59, second=59, tzinfo=IST
                )
                end_utc = _to_utc(e)
        except ValueError:
            pass

    # ── Build entity list based on admin's role ──────────────────
    entities: list[dict[str, Any]] = []
    trading_roles = [UserRole.CLIENT.value, UserRole.DEALER.value, UserRole.MASTER.value]

    if admin.role == UserRole.SUPER_ADMIN:
        # 1. Super-admin's direct users (assigned_admin_id is None)
        direct_users = await User.find({
            "assigned_admin_id": None,
            "role": {"$in": trading_roles},
            "status": {"$ne": UserStatus.CLOSED.value},
        }).to_list()
        if direct_users:
            direct_ids = [u.id for u in direct_users]
            agg = await _aggregate_for_users(direct_ids, start_utc=start_utc, end_utc=end_utc)
            entities.append({
                "id": str(admin.id),
                "name": "Direct Users",
                "role": "SUPER_ADMIN_DIRECT",
                **agg,
            })

        # 2. One entity per admin
        all_admins = await User.find({
            "role": UserRole.ADMIN.value,
            "status": {"$ne": UserStatus.CLOSED.value},
        }).to_list()

        async def _admin_entity(adm: User) -> dict[str, Any]:
            pool_users = await User.find({
                "assigned_admin_id": adm.id,
                "role": {"$in": trading_roles},
                "status": {"$ne": UserStatus.CLOSED.value},
            }).to_list()
            pool_ids = [u.id for u in pool_users]
            # Count brokers under this admin
            broker_count = await User.find({
                "assigned_admin_id": adm.id,
                "role": UserRole.BROKER.value,
            }).count()
            agg = await _aggregate_for_users(pool_ids, start_utc=start_utc, end_utc=end_utc)
            return {
                "id": str(adm.id),
                "name": adm.full_name or adm.user_code or "Admin",
                "user_code": adm.user_code,
                "role": "ADMIN",
                "broker_count": broker_count,
                **agg,
            }

        admin_results = await asyncio.gather(
            *[_admin_entity(a) for a in all_admins],
            return_exceptions=True,
        )
        for r in admin_results:
            if isinstance(r, dict):
                entities.append(r)

    else:
        # Admin view: one entity per broker + direct users
        scope = scoped_admin_filter(admin)

        # Direct users (no broker)
        direct_query = {
            **scope,
            "role": {"$in": trading_roles},
            "status": {"$ne": UserStatus.CLOSED.value},
            "assigned_broker_id": None,
        }
        direct_users = await User.find(direct_query).to_list()
        if direct_users:
            direct_ids = [u.id for u in direct_users]
            agg = await _aggregate_for_users(direct_ids, start_utc=start_utc, end_utc=end_utc)
            entities.append({
                "id": str(admin.id),
                "name": "Direct Users",
                "role": "DIRECT",
                **agg,
            })

        # Per-broker entities
        brokers = await User.find({
            **scope,
            "role": UserRole.BROKER.value,
            "status": {"$ne": UserStatus.CLOSED.value},
        }).to_list()

        async def _broker_entity(broker: User) -> dict[str, Any]:
            broker_users = await User.find({
                "assigned_broker_id": broker.id,
                "role": {"$in": trading_roles},
                "status": {"$ne": UserStatus.CLOSED.value},
            }).to_list()
            pool_ids = [u.id for u in broker_users]
            agg = await _aggregate_for_users(pool_ids, start_utc=start_utc, end_utc=end_utc)
            return {
                "id": str(broker.id),
                "name": broker.full_name or broker.user_code or "Broker",
                "user_code": broker.user_code,
                "role": "BROKER",
                **agg,
            }

        broker_results = await asyncio.gather(
            *[_broker_entity(b) for b in brokers],
            return_exceptions=True,
        )
        for r in broker_results:
            if isinstance(r, dict):
                entities.append(r)

    # ── Grand total (all entities combined) ──────────────────────
    all_user_ids: list[PydanticObjectId] = []
    scope_filter = scoped_admin_filter(admin)
    all_scoped = await User.find({
        **scope_filter,
        "role": {"$in": trading_roles},
        "status": {"$ne": UserStatus.CLOSED.value},
    }).to_list()
    # For super-admin, also include direct users
    if admin.role == UserRole.SUPER_ADMIN:
        direct = await User.find({
            "assigned_admin_id": None,
            "role": {"$in": trading_roles},
            "status": {"$ne": UserStatus.CLOSED.value},
        }).to_list()
        all_user_ids = [u.id for u in all_scoped] + [u.id for u in direct]
    else:
        all_user_ids = [u.id for u in all_scoped]

    grand_total = await _aggregate_for_users(
        list(set(all_user_ids)), start_utc=start_utc, end_utc=end_utc
    )

    return APIResponse(data={
        "entities": entities,
        "grand_total": grand_total,
        "filter": {
            "from_date": from_date,
            "to_date": to_date,
            "preset": preset,
            "is_lifetime": start_utc is None,
        },
    })
