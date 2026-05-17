"""User ledger — wallet transactions formatted as a running ledger."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Query

from app.core.dependencies import CurrentUser
from app.models.transaction import WalletTransaction
from app.schemas.common import APIResponse

router = APIRouter(prefix="/ledger", tags=["user-ledger"])


@router.get("", response_model=APIResponse[dict])
async def ledger(
    user: CurrentUser,
    from_date: datetime | None = None,
    to_date: datetime | None = None,
    limit: int = Query(default=200, le=1000),
):
    q: dict[str, Any] = {"user_id": user.id}
    if from_date or to_date:
        q["created_at"] = {}
        if from_date:
            q["created_at"]["$gte"] = from_date
        if to_date:
            q["created_at"]["$lte"] = to_date
    rows = await WalletTransaction.find(q).sort("+created_at").limit(limit).to_list()

    out = []
    opening = None
    closing = None
    for t in rows:
        d = float(str(t.amount))
        if opening is None:
            opening = float(str(t.balance_before))
        closing = float(str(t.balance_after))
        out.append(
            {
                "id": str(t.id),
                "date": t.created_at,
                "particulars": f"[{t.transaction_type.value}] {t.narration}",
                "debit": -d if d < 0 else 0.0,
                "credit": d if d > 0 else 0.0,
                "balance": float(str(t.balance_after)),
                "reference_type": t.reference_type,
                "reference_id": t.reference_id,
            }
        )
    return APIResponse(
        data={
            "rows": out,
            "opening_balance": opening or 0.0,
            "closing_balance": closing or 0.0,
            "count": len(out),
        }
    )
