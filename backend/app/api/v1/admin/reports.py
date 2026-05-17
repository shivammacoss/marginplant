"""Admin reports — users, financial, trades, tax, compliance."""

from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends

from app.core.dependencies import CurrentAdmin, require_perm, scoped_user_ids
from app.models.trade import Trade
from app.models.transaction import (
    DepositRequest,
    DepositStatus,
    WithdrawalRequest,
    WithdrawalStatus,
)
from app.models.user import User, UserRole, UserStatus
from app.models.wallet import Wallet
from app.schemas.common import APIResponse
from app.utils.time_utils import now_utc

router = APIRouter(prefix="/reports", tags=["admin-reports"])


@router.get("/users", response_model=APIResponse[dict])
async def users_report(
    admin: CurrentAdmin,
    _: None = Depends(require_perm("reports", "read")),
):
    scope = await scoped_user_ids(admin)
    if not scope:
        return APIResponse(
            data={"total": 0, "active": 0, "blocked": 0, "by_role": {}, "last_24h_signups": 0}
        )
    base = {"_id": {"$in": scope}}
    total = await User.find(base).count()
    active = await User.find({**base, "status": UserStatus.ACTIVE.value}).count()
    blocked = await User.find({**base, "status": UserStatus.BLOCKED.value}).count()
    by_role: dict[str, int] = {}
    for r in UserRole:
        by_role[r.value] = await User.find({**base, "role": r.value}).count()
    yesterday = now_utc() - timedelta(days=1)
    last_24h_signups = await User.find({**base, "created_at": {"$gte": yesterday}}).count()
    return APIResponse(
        data={"total": total, "active": active, "blocked": blocked, "by_role": by_role, "last_24h_signups": last_24h_signups}
    )


@router.get("/financial", response_model=APIResponse[dict])
async def financial_report(
    admin: CurrentAdmin,
    _: None = Depends(require_perm("reports", "read")),
):
    scope = await scoped_user_ids(admin)
    if not scope:
        return APIResponse(
            data={
                "wallet_balance": 0.0,
                "margin_used": 0.0,
                "credit_limit": 0.0,
                "total_deposits": 0.0,
                "total_withdrawals": 0.0,
                "total_brokerage": 0.0,
                "pending_deposits": 0,
                "pending_withdrawals": 0,
            }
        )
    user_q = {"user_id": {"$in": scope}}
    wallets = await Wallet.find(user_q).to_list()
    total_balance = sum(float(str(w.available_balance)) for w in wallets)
    total_used = sum(float(str(w.used_margin)) for w in wallets)
    total_credit = sum(float(str(w.credit_limit)) for w in wallets)
    total_deposits = sum(float(str(w.total_deposits)) for w in wallets)
    total_withdrawals = sum(float(str(w.total_withdrawals)) for w in wallets)
    total_brokerage = sum(float(str(w.total_brokerage)) for w in wallets)

    pending_dep = await DepositRequest.find(
        {"status": DepositStatus.PENDING.value, **user_q}
    ).count()
    pending_wd = await WithdrawalRequest.find(
        {"status": WithdrawalStatus.PENDING.value, **user_q}
    ).count()

    return APIResponse(
        data={
            "wallet_balance": round(total_balance, 2),
            "margin_used": round(total_used, 2),
            "credit_limit": round(total_credit, 2),
            "total_deposits": round(total_deposits, 2),
            "total_withdrawals": round(total_withdrawals, 2),
            "total_brokerage": round(total_brokerage, 2),
            "pending_deposits": pending_dep,
            "pending_withdrawals": pending_wd,
        }
    )


@router.get("/trades", response_model=APIResponse[dict])
async def trades_report(
    admin: CurrentAdmin,
    _: None = Depends(require_perm("reports", "read")),
):
    today = now_utc() - timedelta(hours=24)
    week = now_utc() - timedelta(days=7)
    scope = await scoped_user_ids(admin)
    if not scope:
        empty = {"count": 0, "volume": 0.0, "brokerage": 0.0, "charges": 0.0}
        return APIResponse(data={"today": empty, "week": empty})
    base = {"user_id": {"$in": scope}}
    today_trades = await Trade.find({**base, "executed_at": {"$gte": today}}).to_list()
    week_trades = await Trade.find({**base, "executed_at": {"$gte": week}}).to_list()

    def _agg(rows):
        return {
            "count": len(rows),
            "volume": round(sum(float(str(t.value)) for t in rows), 2),
            "brokerage": round(sum(float(str(t.brokerage)) for t in rows), 2),
            "charges": round(sum(float(str(t.total_charges)) for t in rows), 2),
        }

    return APIResponse(data={"today": _agg(today_trades), "week": _agg(week_trades)})


@router.get("/compliance", response_model=APIResponse[dict])
async def compliance_report(
    admin: CurrentAdmin,
    _: None = Depends(require_perm("reports", "read")),
):
    scope = await scoped_user_ids(admin)
    if not scope:
        return APIResponse(data={"kyc_verified": 0, "kyc_pending": 0})
    base = {"_id": {"$in": scope}}
    kyc_done = await User.find({**base, "kyc.is_verified": True}).count()
    kyc_pending = await User.find({**base, "kyc.is_verified": False}).count()
    return APIResponse(data={"kyc_verified": kyc_done, "kyc_pending": kyc_pending})
