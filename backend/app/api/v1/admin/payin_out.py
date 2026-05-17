"""Admin payin-out — deposit + withdrawal approvals + bank accounts + W/D rules."""

from __future__ import annotations

import asyncio
from typing import Any

from beanie import PydanticObjectId
from fastapi import APIRouter, Depends, HTTPException

from app.api.v1.admin._owner import build_owner_map, owner_fields
from app.core.dependencies import (
    CurrentAdmin,
    SuperAdmin,
    assert_user_in_scope,
    require_perm,
    scoped_user_ids,
)
from app.models.audit_log import AuditAction
from app.models.user import UserRole
from app.models.bank_account import CompanyBankAccount
from app.models.transaction import (
    DepositRequest,
    DepositStatus,
    TransactionType,
    WdRule,
    WithdrawalRequest,
    WithdrawalStatus,
)
from app.schemas.admin.common import (
    ApproveDepositRequest,
    ApproveWithdrawalRequest,
    RejectDepositRequest,
    RejectWithdrawalRequest,
)
from app.schemas.common import APIResponse
from app.services import wallet_service
from app.services.audit_service import log_event
from app.utils.decimal_utils import to_decimal
from app.utils.time_utils import now_utc

router = APIRouter(tags=["admin-payin-out"])


# ── Deposits ────────────────────────────────────────────────────────
@router.get("/deposits", response_model=APIResponse[list])
async def list_deposits(
    admin: CurrentAdmin,
    status: str | None = "PENDING",
    limit: int = 200,
    _: None = Depends(require_perm("deposits", "read")),
):
    q: dict[str, Any] = {}
    if status:
        q["status"] = status
    scope = await scoped_user_ids(admin)
    if scope is not None:
        if not scope:
            return APIResponse(data=[])
        q["user_id"] = {"$in": scope}
    rows = await DepositRequest.find(q).sort("-created_at").limit(limit).to_list()
    owner_map = await build_owner_map([r.user_id for r in rows])
    return APIResponse(
        data=[
            {
                "id": str(r.id),
                "user_id": str(r.user_id),
                "amount": str(r.amount),
                "payment_mode": r.payment_mode.value,
                "utr_number": r.utr_number,
                "screenshot_url": r.screenshot_url,
                "status": r.status.value,
                "user_remark": r.user_remark,
                "admin_remark": r.admin_remark,
                "created_at": r.created_at,
                "processed_at": r.processed_at,
                **owner_fields(owner_map.get(str(r.user_id))),
            }
            for r in rows
        ]
    )


@router.post("/deposits/{deposit_id}/approve", response_model=APIResponse[dict])
async def approve_deposit(
    deposit_id: str,
    payload: ApproveDepositRequest,
    admin: CurrentAdmin,
    _: None = Depends(require_perm("deposits", "write")),
):
    r = await DepositRequest.get(PydanticObjectId(deposit_id))
    if r is None:
        raise HTTPException(status_code=404, detail="Deposit not found")
    await assert_user_in_scope(admin, r.user_id)
    if r.status != DepositStatus.PENDING:
        raise HTTPException(status_code=400, detail="Already processed")

    amount = to_decimal(r.amount)
    await wallet_service.adjust(
        r.user_id,
        amount,
        transaction_type=TransactionType.DEPOSIT,
        narration=f"Deposit approved (ref {r.utr_number or r.id})",
        reference_type="DEPOSIT",
        reference_id=str(r.id),
        actor_id=admin.id,
    )

    r.status = DepositStatus.APPROVED
    r.processed_by = admin.id
    r.processed_at = now_utc()
    r.admin_remark = payload.admin_remark
    # r.save() and log_event() are independent writes — fire in parallel to
    # cut the admin click→toast round-trip by one RTT.
    await asyncio.gather(
        r.save(),
        log_event(
            action=AuditAction.APPROVE,
            entity_type="DepositRequest",
            entity_id=r.id,
            actor_id=admin.id,
            target_user_id=r.user_id,
            metadata={"amount": str(amount)},
        ),
    )
    # Notify every other admin dashboard so a colleague watching the same
    # Deposits inbox sees the row move from PENDING → APPROVED without F5.
    try:
        from app.services.admin_events import publish_admin_event

        await publish_admin_event(
            "deposit_update",
            {"event": "approved", "user_id": str(r.user_id), "deposit_id": str(r.id)},
        )
    except Exception:  # pragma: no cover
        pass
    return APIResponse(data={"id": str(r.id), "status": r.status.value})


@router.post("/deposits/{deposit_id}/reject", response_model=APIResponse[dict])
async def reject_deposit(
    deposit_id: str,
    payload: RejectDepositRequest,
    admin: CurrentAdmin,
    _: None = Depends(require_perm("deposits", "write")),
):
    r = await DepositRequest.get(PydanticObjectId(deposit_id))
    if r is None:
        raise HTTPException(status_code=404, detail="Deposit not found")
    await assert_user_in_scope(admin, r.user_id)
    if r.status != DepositStatus.PENDING:
        raise HTTPException(status_code=400, detail="Already processed")
    r.status = DepositStatus.REJECTED
    r.admin_remark = payload.admin_remark
    r.processed_by = admin.id
    r.processed_at = now_utc()
    await asyncio.gather(
        r.save(),
        log_event(
            action=AuditAction.REJECT,
            entity_type="DepositRequest",
            entity_id=r.id,
            actor_id=admin.id,
            target_user_id=r.user_id,
        ),
    )
    try:
        from app.services.admin_events import publish_admin_event

        await publish_admin_event(
            "deposit_update",
            {"event": "rejected", "user_id": str(r.user_id), "deposit_id": str(r.id)},
        )
    except Exception:  # pragma: no cover
        pass
    return APIResponse(data={"id": str(r.id), "status": r.status.value})


# ── Withdrawals ─────────────────────────────────────────────────────
@router.get("/withdrawals", response_model=APIResponse[list])
async def list_withdrawals(
    admin: CurrentAdmin,
    status: str | None = "PENDING",
    limit: int = 200,
    _: None = Depends(require_perm("withdrawals", "read")),
):
    q: dict[str, Any] = {}
    if status:
        q["status"] = status
    scope = await scoped_user_ids(admin)
    if scope is not None:
        if not scope:
            return APIResponse(data=[])
        q["user_id"] = {"$in": scope}
    rows = await WithdrawalRequest.find(q).sort("-created_at").limit(limit).to_list()
    owner_map = await build_owner_map([r.user_id for r in rows])
    return APIResponse(
        data=[
            {
                "id": str(r.id),
                "user_id": str(r.user_id),
                "amount": str(r.amount),
                "bank": r.bank.model_dump(),
                "status": r.status.value,
                "remarks": r.remarks,
                "utr_number": r.utr_number,
                "rejection_reason": r.rejection_reason,
                "created_at": r.created_at,
                "processed_at": r.processed_at,
                **owner_fields(owner_map.get(str(r.user_id))),
            }
            for r in rows
        ]
    )


@router.post("/withdrawals/{withdrawal_id}/approve", response_model=APIResponse[dict])
async def approve_withdrawal(
    withdrawal_id: str,
    payload: ApproveWithdrawalRequest,
    admin: CurrentAdmin,
    _: None = Depends(require_perm("withdrawals", "write")),
):
    r = await WithdrawalRequest.get(PydanticObjectId(withdrawal_id))
    if r is None:
        raise HTTPException(status_code=404, detail="Withdrawal not found")
    await assert_user_in_scope(admin, r.user_id)
    if r.status != WithdrawalStatus.PENDING:
        raise HTTPException(status_code=400, detail="Already processed")

    # Debit user wallet
    amount = to_decimal(r.amount)
    await wallet_service.adjust(
        r.user_id,
        -amount,
        transaction_type=TransactionType.WITHDRAWAL,
        narration=f"Withdrawal approved (UTR {payload.utr_number or 'pending'})",
        reference_type="WITHDRAWAL",
        reference_id=str(r.id),
        actor_id=admin.id,
    )

    r.status = WithdrawalStatus.COMPLETED
    r.utr_number = payload.utr_number
    r.processed_by = admin.id
    r.processed_at = now_utc()
    await r.save()

    await log_event(
        action=AuditAction.APPROVE,
        entity_type="WithdrawalRequest",
        entity_id=r.id,
        actor_id=admin.id,
        target_user_id=r.user_id,
    )
    try:
        from app.services.admin_events import publish_admin_event

        await publish_admin_event(
            "withdrawal_update",
            {"event": "approved", "user_id": str(r.user_id), "withdrawal_id": str(r.id)},
        )
    except Exception:  # pragma: no cover
        pass
    return APIResponse(data={"id": str(r.id), "status": r.status.value})


@router.post("/withdrawals/{withdrawal_id}/reject", response_model=APIResponse[dict])
async def reject_withdrawal(
    withdrawal_id: str,
    payload: RejectWithdrawalRequest,
    admin: CurrentAdmin,
    _: None = Depends(require_perm("withdrawals", "write")),
):
    r = await WithdrawalRequest.get(PydanticObjectId(withdrawal_id))
    if r is None:
        raise HTTPException(status_code=404, detail="Withdrawal not found")
    await assert_user_in_scope(admin, r.user_id)
    if r.status != WithdrawalStatus.PENDING:
        raise HTTPException(status_code=400, detail="Already processed")
    r.status = WithdrawalStatus.REJECTED
    r.rejection_reason = payload.rejection_reason
    r.processed_by = admin.id
    r.processed_at = now_utc()
    await r.save()
    await log_event(
        action=AuditAction.REJECT,
        entity_type="WithdrawalRequest",
        entity_id=r.id,
        actor_id=admin.id,
        target_user_id=r.user_id,
    )
    try:
        from app.services.admin_events import publish_admin_event

        await publish_admin_event(
            "withdrawal_update",
            {"event": "rejected", "user_id": str(r.user_id), "withdrawal_id": str(r.id)},
        )
    except Exception:  # pragma: no cover
        pass
    return APIResponse(data={"id": str(r.id), "status": r.status.value})


# ── Company bank accounts ───────────────────────────────────────────
# Scoped by ownership tier:
#   • super-admin owns the platform-default pool (both owner_* IS NULL)
#   • each sub-admin owns their pool (owner_admin_id == sub_admin.id,
#     owner_broker_id IS NULL)
#   • each broker owns their pool (owner_broker_id == broker.id,
#     owner_admin_id may or may not be set — broker is the
#     most-specific owner)
# A user sees only their pool's banks on the deposit form — that filter
# is wired in user-side `/wallet/company-banks` using the cascade
# broker > admin > platform.
def _owner_filter(admin) -> dict:
    if admin.role == UserRole.SUPER_ADMIN:
        return {"owner_admin_id": None, "owner_broker_id": None}
    if admin.role == UserRole.BROKER:
        return {"owner_broker_id": admin.id}
    # ADMIN
    return {"owner_admin_id": admin.id, "owner_broker_id": None}


def _ser_bank(r: CompanyBankAccount, *, editable: bool = True) -> dict:
    """Serialise a bank row. `editable` lets the caller mark inherited rows
    (e.g. parent admin's banks shown to a broker as fallback) so the
    frontend renders them read-only with a clear 'Inherited' badge."""
    return {
        "id": str(r.id),
        "bank_name": r.bank_name,
        "account_holder": r.account_holder,
        "account_number": r.account_number,
        "ifsc_code": r.ifsc_code,
        "upi_id": r.upi_id,
        "qr_code_url": r.qr_code_url,
        "is_active": r.is_active,
        "is_default": r.is_default,
        "owner_admin_id": str(r.owner_admin_id) if r.owner_admin_id else None,
        "owner_broker_id": str(r.owner_broker_id) if r.owner_broker_id else None,
        "editable": editable,
    }


async def _invalidate_company_banks_cache(
    owner_admin_id, owner_broker_id=None
) -> None:
    """Wipe the user-side deposit-form bank cache for the pool that owns
    this row. Keys are namespaced per pool so edits in one pool don't
    flush another. Cache key shape mirrors the cascade in
    /wallet/company-banks: broker:<id> > admin:<id> > default."""
    from app.core.redis_client import cache_delete_pattern

    if owner_broker_id is not None:
        suffix = f"broker:{owner_broker_id}"
    elif owner_admin_id is not None:
        suffix = f"admin:{owner_admin_id}"
    else:
        suffix = "default"
    await cache_delete_pattern(f"wallet:company-banks:{suffix}")


@router.get("/bank-accounts", response_model=APIResponse[list])
async def list_bank_accounts(
    admin: CurrentAdmin, _: None = Depends(require_perm("banks", "read"))
):
    # Broker view: own pool (editable) + parent admin's pool (inherited,
    # read-only). The frontend renders an "Inherited" badge on rows where
    # editable is False so the broker knows those came from their admin
    # and can't be modified from here. If broker has no own banks, the
    # admin's banks still show as fallback so the broker can see what
    # their users see on the deposit form.
    own_rows = await CompanyBankAccount.find(_owner_filter(admin)).to_list()
    items = [_ser_bank(r, editable=True) for r in own_rows]

    if admin.role == UserRole.BROKER and admin.assigned_admin_id is not None:
        inherited = await CompanyBankAccount.find(
            {
                "owner_admin_id": admin.assigned_admin_id,
                "owner_broker_id": None,
            }
        ).to_list()
        items.extend(_ser_bank(r, editable=False) for r in inherited)

    return APIResponse(data=items)


@router.post("/bank-accounts", response_model=APIResponse[dict])
async def create_bank(
    payload: dict,
    admin: CurrentAdmin,
    _: None = Depends(require_perm("banks", "write")),
):
    # Owner stamps follow caller role: super-admin → both None;
    # sub-admin → owner_admin_id only; broker → owner_broker_id only.
    owner_admin_id = None
    owner_broker_id = None
    if admin.role == UserRole.ADMIN:
        owner_admin_id = admin.id
    elif admin.role == UserRole.BROKER:
        owner_broker_id = admin.id
    row = CompanyBankAccount(
        bank_name=payload.get("bank_name", ""),
        account_holder=payload.get("account_holder", ""),
        account_number=payload.get("account_number", ""),
        ifsc_code=payload.get("ifsc_code", ""),
        upi_id=payload.get("upi_id"),
        qr_code_url=payload.get("qr_code_url"),
        is_active=bool(payload.get("is_active", True)),
        is_default=bool(payload.get("is_default", False)),
        owner_admin_id=owner_admin_id,
        owner_broker_id=owner_broker_id,
    )
    await row.insert()
    await _invalidate_company_banks_cache(owner_admin_id, owner_broker_id)
    return APIResponse(data={"id": str(row.id)})


def _assert_bank_in_scope(r: CompanyBankAccount, admin) -> None:
    """Rejects an admin operating on a bank outside their pool.

    Ownership rules:
      - super-admin owns platform-default rows (both owner_* IS NULL)
      - admin owns rows where owner_admin_id == self.id AND
        owner_broker_id IS NULL (broker pools are independent)
      - broker owns rows where owner_broker_id == self.id
    """
    if admin.role == UserRole.SUPER_ADMIN:
        if r.owner_admin_id is not None or r.owner_broker_id is not None:
            raise HTTPException(
                status_code=403,
                detail="Bank belongs to a sub-admin's or broker's pool",
            )
        return
    if admin.role == UserRole.BROKER:
        if r.owner_broker_id != admin.id:
            raise HTTPException(
                status_code=403, detail="Bank not in your scope"
            )
        return
    # ADMIN
    if r.owner_admin_id != admin.id or r.owner_broker_id is not None:
        raise HTTPException(
            status_code=403, detail="Bank not in your scope"
        )


@router.put("/bank-accounts/{bank_id}", response_model=APIResponse[dict])
async def update_bank(
    bank_id: str,
    payload: dict,
    admin: CurrentAdmin,
    _: None = Depends(require_perm("banks", "write")),
):
    r = await CompanyBankAccount.get(PydanticObjectId(bank_id))
    if r is None:
        raise HTTPException(status_code=404, detail="Bank account not found")
    _assert_bank_in_scope(r, admin)
    for k in (
        "bank_name",
        "account_holder",
        "account_number",
        "ifsc_code",
        "upi_id",
        "qr_code_url",
        "is_active",
        "is_default",
    ):
        if k in payload:
            setattr(r, k, payload[k])
    await r.save()
    await _invalidate_company_banks_cache(r.owner_admin_id, r.owner_broker_id)
    return APIResponse(data={"id": str(r.id)})


@router.delete("/bank-accounts/{bank_id}", response_model=APIResponse[dict])
async def delete_bank(
    bank_id: str,
    admin: CurrentAdmin,
    _: None = Depends(require_perm("banks", "write")),
):
    r = await CompanyBankAccount.get(PydanticObjectId(bank_id))
    if r is None:
        raise HTTPException(status_code=404, detail="Bank account not found")
    _assert_bank_in_scope(r, admin)
    owner_admin_id = r.owner_admin_id
    owner_broker_id = r.owner_broker_id
    await r.delete()
    await _invalidate_company_banks_cache(owner_admin_id, owner_broker_id)
    return APIResponse(data={"ok": True})


# ── W/D rules ───────────────────────────────────────────────────────
@router.get("/wd-rules", response_model=APIResponse[list])
async def list_wd_rules(admin: CurrentAdmin):
    rows = await WdRule.find_all().to_list()
    return APIResponse(
        data=[
            {
                "id": str(r.id),
                "rule_type": r.rule_type,
                "min_amount": str(r.min_amount),
                "max_amount": str(r.max_amount),
                "daily_limit": str(r.daily_limit),
                "allowed_times": [w.model_dump() for w in r.allowed_times],
                "charges_flat": str(r.charges_flat),
                "charges_percent": r.charges_percent,
                "auto_approve_under": str(r.auto_approve_under),
                "mandatory_remark": r.mandatory_remark,
            }
            for r in rows
        ]
    )


@router.put("/wd-rules/{rule_type}", response_model=APIResponse[dict])
async def update_wd_rule(rule_type: str, payload: dict, admin: SuperAdmin):
    r = await WdRule.find_one(WdRule.rule_type == rule_type)
    if r is None:
        raise HTTPException(status_code=404, detail="Rule not found")
    from bson import Decimal128

    if "min_amount" in payload:
        r.min_amount = Decimal128(str(payload["min_amount"]))
    if "max_amount" in payload:
        r.max_amount = Decimal128(str(payload["max_amount"]))
    if "daily_limit" in payload:
        r.daily_limit = Decimal128(str(payload["daily_limit"]))
    if "charges_flat" in payload:
        r.charges_flat = Decimal128(str(payload["charges_flat"]))
    if "charges_percent" in payload:
        r.charges_percent = float(payload["charges_percent"])
    if "auto_approve_under" in payload:
        r.auto_approve_under = Decimal128(str(payload["auto_approve_under"]))
    if "mandatory_remark" in payload:
        r.mandatory_remark = bool(payload["mandatory_remark"])
    await r.save()
    return APIResponse(data={"ok": True})
