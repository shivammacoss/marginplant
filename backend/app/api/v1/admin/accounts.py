"""Accounts Dashboard — per-admin/per-broker/per-sub-broker financial summary.

Scope parameter controls grouping:
  all_users    → grand total only (one card, fastest)
  admins       → per-admin breakdown (super-admin only)
  brokers      → per-broker breakdown
  sub_brokers  → per-sub-broker breakdown

All calculations verified per spec — see docstring at module top.
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

TRADING_ROLES = [UserRole.CLIENT.value, UserRole.DEALER.value, UserRole.MASTER.value]


def _to_utc(dt_ist: datetime) -> datetime:
    if dt_ist.tzinfo is None:
        dt_ist = dt_ist.replace(tzinfo=IST)
    return dt_ist.astimezone(timezone.utc)


def _d(val: Any) -> float:
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
    if not user_ids:
        return _empty()

    is_lifetime = start_utc is None and end_utc is None

    wallets = await Wallet.find({"user_id": {"$in": user_ids}}).to_list()

    total_balance = sum(_d(w.available_balance) + _d(w.used_margin) for w in wallets)
    total_used_margin = sum(_d(w.used_margin) for w in wallets)

    open_positions = await Position.find(
        {"user_id": {"$in": user_ids}, "status": PositionStatus.OPEN.value}
    ).to_list()
    total_unrealized = sum(_d(p.unrealized_pnl) for p in open_positions)
    open_count = len(open_positions)
    total_equity = total_balance + total_unrealized
    total_settlement = sum(_d(w.settlement_outstanding) for w in wallets)

    if is_lifetime:
        deposits = sum(_d(w.total_deposits) for w in wallets)
        withdrawals = sum(_d(w.total_withdrawals) for w in wallets)
        realized_pnl = sum(_d(w.realized_pnl) for w in wallets)

        # Brokerage: wallet.total_brokerage is often 0 because brokerage
        # is tracked per-trade (Trade.brokerage) not as a separate wallet
        # transaction. Always sum from trades for accuracy.
        all_trades = await Trade.find({
            "user_id": {"$in": user_ids},
        }).to_list()
        brokerage = sum(_d(t.brokerage) for t in all_trades)
        volume = sum(_d(t.value) for t in all_trades)

        all_closing_trades = [t for t in all_trades if t.pnl_inr is not None]
        total_trades = len(all_closing_trades)
        profit_trades = sum(1 for t in all_closing_trades if _d(t.pnl_inr) > 0)
        loss_trades = sum(1 for t in all_closing_trades if _d(t.pnl_inr) < 0)
    else:
        date_filter = {}
        if start_utc:
            date_filter["$gte"] = start_utc
        if end_utc:
            date_filter["$lte"] = end_utc

        dep_txns = await WalletTransaction.find({
            "user_id": {"$in": user_ids},
            "transaction_type": TransactionType.DEPOSIT.value,
            "created_at": date_filter,
        }).to_list()
        deposits = sum(_d(t.amount) for t in dep_txns)

        wd_txns = await WalletTransaction.find({
            "user_id": {"$in": user_ids},
            "transaction_type": TransactionType.WITHDRAWAL.value,
            "created_at": date_filter,
        }).to_list()
        withdrawals = sum(abs(_d(t.amount)) for t in wd_txns)

        closed_positions = await Position.find({
            "user_id": {"$in": user_ids},
            "status": PositionStatus.CLOSED.value,
            "closed_at": date_filter,
        }).to_list()
        realized_pnl = sum(_d(p.realized_pnl) for p in closed_positions)

        closing_trades = await Trade.find({
            "user_id": {"$in": user_ids},
            "pnl_inr": {"$ne": None},
            "executed_at": date_filter,
        }).to_list()
        total_trades = len(closing_trades)
        profit_trades = sum(1 for t in closing_trades if _d(t.pnl_inr) > 0)
        loss_trades = sum(1 for t in closing_trades if _d(t.pnl_inr) < 0)

        all_trades = await Trade.find({
            "user_id": {"$in": user_ids},
            "executed_at": date_filter,
        }).to_list()
        brokerage = sum(_d(t.brokerage) for t in all_trades)
        volume = sum(_d(t.value) for t in all_trades)

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


def _empty() -> dict[str, Any]:
    return {
        "deposits": 0, "withdrawals": 0, "net_deposit": 0,
        "realized_pnl": 0, "unrealized_pnl": 0, "net_pnl": 0,
        "brokerage": 0, "total_trades": 0, "profit_trades": 0,
        "loss_trades": 0, "win_rate": 0, "volume": 0,
        "balance": 0, "equity": 0, "open_positions": 0,
        "settlement_outstanding": 0, "user_count": 0,
    }


async def _make_entity(
    entity_user: User,
    pool_ids: list[PydanticObjectId],
    role_label: str,
    start_utc: datetime | None,
    end_utc: datetime | None,
    **extra: Any,
) -> dict[str, Any]:
    agg = await _aggregate_for_users(pool_ids, start_utc=start_utc, end_utc=end_utc)
    return {
        "id": str(entity_user.id),
        "name": entity_user.full_name or entity_user.user_code or role_label,
        "user_code": entity_user.user_code,
        "role": role_label,
        **extra,
        **agg,
    }


@router.get("/summary")
async def accounts_summary(
    admin: CurrentAdmin,
    scope: str = Query(default="all_users", description="all_users|admins|brokers|sub_brokers"),
    from_date: str | None = Query(default=None),
    to_date: str | None = Query(default=None),
    preset: str | None = Query(default=None),
    _: None = Depends(require_perm("users", "read")),
) -> APIResponse:
    now_ist = datetime.now(IST)

    start_utc: datetime | None = None
    end_utc: datetime | None = None
    if preset and preset in _WEEK_PRESETS:
        s, e = _WEEK_PRESETS[preset](now_ist)
        start_utc = _to_utc(s)
        end_utc = _to_utc(e)
    elif from_date or to_date:
        try:
            if from_date:
                start_utc = _to_utc(datetime.strptime(from_date, "%Y-%m-%d").replace(tzinfo=IST))
            if to_date:
                end_utc = _to_utc(datetime.strptime(to_date, "%Y-%m-%d").replace(hour=23, minute=59, second=59, tzinfo=IST))
        except ValueError:
            pass

    entities: list[dict[str, Any]] = []
    admin_scope = scoped_admin_filter(admin)

    # Collect ALL user ids in scope for grand total
    all_scope_query: dict[str, Any] = {
        "role": {"$in": TRADING_ROLES},
        "status": {"$ne": UserStatus.CLOSED.value},
    }
    if admin.role == UserRole.SUPER_ADMIN:
        all_users = await User.find(all_scope_query).to_list()
    else:
        all_users = await User.find({**all_scope_query, **admin_scope}).to_list()

    all_ids = [u.id for u in all_users]
    grand_total = await _aggregate_for_users(all_ids, start_utc=start_utc, end_utc=end_utc)

    if scope == "all_users":
        # Per-user breakdown for every trading user in scope
        async def _do_user(u: User) -> dict[str, Any]:
            agg = await _aggregate_for_users([u.id], start_utc=start_utc, end_utc=end_utc)
            owner_label = ""
            if u.assigned_broker_id:
                broker = await User.get(u.assigned_broker_id)
                owner_label = (broker.full_name or broker.user_code or "Broker") if broker else ""
            elif u.assigned_admin_id:
                adm = await User.get(u.assigned_admin_id)
                owner_label = (adm.full_name or adm.user_code or "Admin") if adm else ""
            return {
                "id": str(u.id),
                "name": u.full_name or u.user_code or "User",
                "user_code": u.user_code,
                "role": u.role.value if hasattr(u.role, "value") else str(u.role),
                "owner": owner_label,
                **agg,
            }

        results = await asyncio.gather(*[_do_user(u) for u in all_users], return_exceptions=True)
        entities.extend(r for r in results if isinstance(r, dict))

    elif scope == "admins" and admin.role == UserRole.SUPER_ADMIN:
        # Super-admin's direct users
        direct = [u for u in all_users if u.assigned_admin_id is None]
        if direct:
            agg = await _aggregate_for_users([u.id for u in direct], start_utc=start_utc, end_utc=end_utc)
            entities.append({"id": str(admin.id), "name": "Direct Users", "role": "DIRECT", **agg})

        # Per admin
        admins = await User.find({
            "role": UserRole.ADMIN.value,
            "status": {"$ne": UserStatus.CLOSED.value},
        }).to_list()

        async def _do_admin(adm: User) -> dict[str, Any]:
            pool = [u.id for u in all_users if u.assigned_admin_id == adm.id]
            broker_count = sum(1 for u in await User.find({"assigned_admin_id": adm.id, "role": UserRole.BROKER.value}).to_list())
            return await _make_entity(adm, pool, "ADMIN", start_utc, end_utc, broker_count=broker_count)

        results = await asyncio.gather(*[_do_admin(a) for a in admins], return_exceptions=True)
        entities.extend(r for r in results if isinstance(r, dict))

    elif scope == "brokers":
        # Per-broker (works for both super-admin and admin)
        broker_query: dict[str, Any] = {
            "role": UserRole.BROKER.value,
            "status": {"$ne": UserStatus.CLOSED.value},
        }
        if admin.role != UserRole.SUPER_ADMIN:
            broker_query.update(admin_scope)
        brokers = await User.find(broker_query).to_list()

        # Direct users (no broker)
        direct = [u for u in all_users if u.assigned_broker_id is None]
        if direct:
            agg = await _aggregate_for_users([u.id for u in direct], start_utc=start_utc, end_utc=end_utc)
            entities.append({"id": "direct", "name": "Direct Users (No Broker)", "role": "DIRECT", **agg})

        async def _do_broker(b: User) -> dict[str, Any]:
            pool = [u.id for u in all_users if u.assigned_broker_id == b.id]
            return await _make_entity(b, pool, "BROKER", start_utc, end_utc)

        results = await asyncio.gather(*[_do_broker(b) for b in brokers], return_exceptions=True)
        entities.extend(r for r in results if isinstance(r, dict))

    elif scope == "sub_brokers":
        # Sub-brokers = BROKER users who themselves have a parent broker
        sub_query: dict[str, Any] = {
            "role": UserRole.BROKER.value,
            "status": {"$ne": UserStatus.CLOSED.value},
            "assigned_broker_id": {"$ne": None},
        }
        if admin.role != UserRole.SUPER_ADMIN:
            sub_query.update(admin_scope)
        sub_brokers = await User.find(sub_query).to_list()

        async def _do_sub(sb: User) -> dict[str, Any]:
            pool = [u.id for u in all_users if u.assigned_broker_id == sb.id]
            return await _make_entity(sb, pool, "SUB_BROKER", start_utc, end_utc)

        results = await asyncio.gather(*[_do_sub(sb) for sb in sub_brokers], return_exceptions=True)
        entities.extend(r for r in results if isinstance(r, dict))

    return APIResponse(data={
        "entities": entities,
        "grand_total": grand_total,
        "scope": scope,
        "filter": {
            "from_date": from_date,
            "to_date": to_date,
            "preset": preset,
            "is_lifetime": start_utc is None,
        },
    })
