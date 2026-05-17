"""User wallet endpoints — balance, transactions, deposit/withdrawal requests."""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path

from beanie import PydanticObjectId
from fastapi import APIRouter, File, HTTPException, UploadFile

from app.core.dependencies import CurrentUser
from app.models.bank_account import CompanyBankAccount, UserBankAccount
from app.models.transaction import (
    DepositRequest,
    DepositStatus,
    PaymentMode,
    WithdrawalRequest,
    WithdrawalStatus,
    BankSnapshot,
)
from app.schemas.common import APIResponse
from app.schemas.trading import DepositCreate, WalletSummary, WithdrawalCreate
from app.services import wallet_service
from app.utils.decimal_utils import to_decimal128

router = APIRouter(prefix="/wallet", tags=["user-wallet"])

# Screenshot uploads — saved to ./uploads/screenshots/<user_id>/<uuid>.<ext>
# and served back via the static mount at /uploads (configured in main.py).
UPLOAD_ROOT = Path("uploads") / "screenshots"
ALLOWED_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
# Server-side ceiling. The user-side compresses to ~300-500 KB before sending,
# so this is just a safety cap for clients that bypass compression.
MAX_BYTES = 10 * 1024 * 1024


@router.post("/upload-screenshot", response_model=APIResponse[dict])
async def upload_screenshot(user: CurrentUser, file: UploadFile = File(...)):
    """Accepts a single image file. Returns `{ url }` to embed in the deposit request."""
    ext = (Path(file.filename or "").suffix or "").lower()
    if ext not in ALLOWED_EXTS:
        raise HTTPException(status_code=400, detail=f"Unsupported file type. Allowed: {sorted(ALLOWED_EXTS)}")

    contents = await file.read()
    if len(contents) > MAX_BYTES:
        raise HTTPException(status_code=413, detail=f"File too large (max {MAX_BYTES // (1024*1024)} MB)")
    if len(contents) == 0:
        raise HTTPException(status_code=400, detail="Empty file")

    user_dir = UPLOAD_ROOT / str(user.id)
    user_dir.mkdir(parents=True, exist_ok=True)
    fname = f"{uuid.uuid4().hex}{ext}"
    out_path = user_dir / fname
    # write_bytes blocks the event loop; offload so concurrent uploads from
    # other users aren't serialized behind a single big disk write.
    await asyncio.to_thread(out_path.write_bytes, contents)

    # Public URL (served by StaticFiles mount in main.py)
    url = f"/uploads/screenshots/{user.id}/{fname}"
    return APIResponse(data={"url": url, "size": len(contents)})


@router.get("/summary", response_model=APIResponse[WalletSummary])
async def summary(user: CurrentUser):
    return APIResponse(data=WalletSummary(**(await wallet_service.summary(user.id))))


@router.get("/transactions", response_model=APIResponse[list])
async def transactions(user: CurrentUser, limit: int = 100, skip: int = 0):
    txns = await wallet_service.list_transactions(user.id, limit=limit, skip=skip)
    return APIResponse(
        data=[
            {
                "id": str(t.id),
                "transaction_type": t.transaction_type.value,
                "amount": str(t.amount),
                "balance_before": str(t.balance_before),
                "balance_after": str(t.balance_after),
                "narration": t.narration,
                "status": t.status.value,
                "reference_type": t.reference_type,
                "reference_id": t.reference_id,
                "created_at": t.created_at,
            }
            for t in txns
        ]
    )


_COMPANY_BANKS_CACHE_PREFIX = "wallet:company-banks:"
_COMPANY_BANKS_CACHE_TTL = 3600  # 1 h — admin edits invalidate; otherwise rare


@router.get("/company-banks", response_model=APIResponse[list])
async def company_banks(user: CurrentUser):
    # Cascade owner resolution: broker > admin > platform default.
    # Try the most-specific pool the user belongs to first; if that pool
    # has no active banks, fall back to the next-up pool so the user
    # always sees something to pay into. Cache key reflects which pool
    # the answer actually came from, so admin/broker edits invalidate
    # only the relevant key.
    from app.core.redis_client import cache_get, cache_set

    cascade: list[tuple[str, dict]] = []
    if user.assigned_broker_id is not None:
        cascade.append(
            (f"broker:{user.assigned_broker_id}", {"owner_broker_id": user.assigned_broker_id})
        )
    if user.assigned_admin_id is not None:
        cascade.append(
            (
                f"admin:{user.assigned_admin_id}",
                {"owner_admin_id": user.assigned_admin_id, "owner_broker_id": None},
            )
        )
    cascade.append(("default", {"owner_admin_id": None, "owner_broker_id": None}))

    for pool_key, owner_filter in cascade:
        cache_key = f"{_COMPANY_BANKS_CACHE_PREFIX}{pool_key}"
        cached = await cache_get(cache_key)
        if cached is not None:
            if cached:
                return APIResponse(data=cached)
            continue

        rows = await CompanyBankAccount.find(
            {"is_active": True, **owner_filter}
        ).sort("-is_default").to_list()
        data = [
            {
                "id": str(r.id),
                "bank_name": r.bank_name,
                "account_holder": r.account_holder,
                "account_number": r.account_number,
                "ifsc_code": r.ifsc_code,
                "upi_id": r.upi_id,
                "qr_code_url": r.qr_code_url,
                "is_default": r.is_default,
            }
            for r in rows
        ]
        await cache_set(cache_key, data, ttl_sec=_COMPANY_BANKS_CACHE_TTL)
        if data:
            return APIResponse(data=data)

    return APIResponse(data=[])


@router.post("/deposits", response_model=APIResponse[dict])
async def create_deposit(payload: DepositCreate, user: CurrentUser):
    # `deposit_requests` has a unique index on `idempotency_key`; passing
    # null on every request collides on the 2nd insert. Always generate a
    # UUID so multiple deposits per user work, and the field still acts
    # as an idempotency token if the client ever wants to send its own.
    idem = getattr(payload, "idempotency_key", None) or uuid.uuid4().hex
    req = DepositRequest(
        user_id=user.id,
        amount=to_decimal128(payload.amount),
        payment_mode=PaymentMode(payload.payment_mode),
        utr_number=payload.utr_number,
        screenshot_url=payload.screenshot_url,
        user_remark=payload.user_remark,
        bank_account_id=PydanticObjectId(payload.bank_account_id) if payload.bank_account_id else None,
        status=DepositStatus.PENDING,
        idempotency_key=idem,
    )
    await req.insert()
    # Fan out to admin dashboards so the Deposits inbox shows the new
    # request immediately — no F5. One-line publish, swallows errors.
    try:
        from app.services.admin_events import publish_admin_event

        await publish_admin_event(
            "deposit_update",
            {"event": "submitted", "user_id": str(user.id), "deposit_id": str(req.id)},
        )
    except Exception:  # pragma: no cover
        pass
    return APIResponse(data={"id": str(req.id), "status": req.status.value})


@router.get("/deposits", response_model=APIResponse[list])
async def my_deposits(user: CurrentUser):
    rows = await DepositRequest.find(DepositRequest.user_id == user.id).sort("-created_at").limit(100).to_list()
    return APIResponse(
        data=[
            {
                "id": str(r.id),
                "amount": str(r.amount),
                "payment_mode": r.payment_mode.value,
                "utr_number": r.utr_number,
                "screenshot_url": r.screenshot_url,
                "status": r.status.value,
                "user_remark": r.user_remark,
                "admin_remark": r.admin_remark,
                "created_at": r.created_at,
                "processed_at": r.processed_at,
            }
            for r in rows
        ]
    )


@router.post("/withdrawals", response_model=APIResponse[dict])
async def create_withdrawal(payload: WithdrawalCreate, user: CurrentUser):
    b = payload.bank or {}
    upi_id = (b.get("upi_id") or "").strip()
    account_number = (b.get("account_number") or "").strip()

    # Require ONE of: a valid bank set (account+ifsc) OR a UPI ID. We do
    # not require the user to save the destination — every withdrawal
    # carries its own snapshot so they can pay to a different account
    # any time without managing a saved-banks list.
    if not upi_id and not (account_number and (b.get("ifsc") or "").strip()):
        raise HTTPException(
            status_code=400,
            detail="Provide either a UPI ID or full bank details (account number + IFSC).",
        )

    snap = BankSnapshot(
        name=(b.get("name") or "").strip() or None,
        account_number=account_number or None,
        ifsc=(b.get("ifsc") or "").strip().upper() or None,
        holder=(b.get("holder") or "").strip() or (user.full_name if account_number else None),
        branch=(b.get("branch") or "").strip() or None,
        account_type=(b.get("account_type") or "").strip() or None,
        upi_id=upi_id or None,
        qr_url=(b.get("qr_url") or "").strip() or None,
    )
    # Same trick as deposits — the unique sparse index on `idempotency_key`
    # rejects a second insert with explicit null, so always stamp a UUID
    # unless the client provided its own token.
    idem = getattr(payload, "idempotency_key", None) or uuid.uuid4().hex
    req = WithdrawalRequest(
        user_id=user.id,
        amount=to_decimal128(payload.amount),
        bank=snap,
        remarks=payload.remarks,
        status=WithdrawalStatus.PENDING,
        idempotency_key=idem,
    )
    await req.insert()
    # Notify admin dashboards (Withdrawals inbox).
    try:
        from app.services.admin_events import publish_admin_event

        await publish_admin_event(
            "withdrawal_update",
            {"event": "submitted", "user_id": str(user.id), "withdrawal_id": str(req.id)},
        )
    except Exception:  # pragma: no cover
        pass
    return APIResponse(data={"id": str(req.id), "status": req.status.value})


@router.get("/withdrawals", response_model=APIResponse[list])
async def my_withdrawals(user: CurrentUser):
    rows = await WithdrawalRequest.find(WithdrawalRequest.user_id == user.id).sort("-created_at").limit(100).to_list()
    return APIResponse(
        data=[
            {
                "id": str(r.id),
                "amount": str(r.amount),
                "bank": r.bank.model_dump(),
                "status": r.status.value,
                "remarks": r.remarks,
                "utr_number": r.utr_number,
                "rejection_reason": r.rejection_reason,
                "created_at": r.created_at,
                "processed_at": r.processed_at,
            }
            for r in rows
        ]
    )


@router.get("/bank-accounts", response_model=APIResponse[list])
async def my_bank_accounts(user: CurrentUser):
    rows = await UserBankAccount.find(UserBankAccount.user_id == user.id).to_list()
    return APIResponse(
        data=[
            {
                "id": str(r.id),
                "bank_name": r.bank_name,
                "account_holder": r.account_holder,
                "account_number": r.account_number,
                "ifsc_code": r.ifsc_code,
                "is_default": r.is_default,
                "is_verified": r.is_verified,
                "nickname": r.nickname,
            }
            for r in rows
        ]
    )


@router.post("/bank-accounts", response_model=APIResponse[dict])
async def add_bank_account(payload: dict, user: CurrentUser):
    row = UserBankAccount(
        user_id=user.id,
        bank_name=payload.get("bank_name", ""),
        account_holder=payload.get("account_holder", user.full_name),
        account_number=payload.get("account_number", ""),
        ifsc_code=payload.get("ifsc_code", ""),
        nickname=payload.get("nickname"),
        is_default=bool(payload.get("is_default") or False),
    )
    await row.insert()
    return APIResponse(data={"id": str(row.id)})
