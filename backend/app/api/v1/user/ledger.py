"""User ledger — wallet transactions formatted as a running ledger.

Each row carries:
  • `type` — machine-readable transaction_type (DEPOSIT, CHARGES,
    PNL, SETTLEMENT_OUTSTANDING_BOOKED, …) for the UI to colour-code
  • `is_settlement` — fast flag so the row stands out in the table
  • `label` — human-readable category (e.g. "Brokerage", "Trade loss",
    "Settlement booked") that the user reads at a glance
  • `particulars` — long-form description with the underlying narration
  • `debit` / `credit` — split signed amount into the two columns
  • `balance` — available_balance after this txn (continuous across rows)

The aggregate fields the dashboard cards lean on:
  • `opening_balance` — first row's balance_before
  • `closing_balance` — last row's balance_after
  • `total_settlement_booked` — sum of magnitudes of every
    SETTLEMENT_OUTSTANDING_BOOKED row in this window, so the user
    sees the SETTLEMENT total prominently even if the ledger spans
    multiple trades.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Query

from app.core.dependencies import CurrentUser
from app.models.transaction import TransactionType, WalletTransaction
from app.schemas.common import APIResponse

router = APIRouter(prefix="/ledger", tags=["user-ledger"])


# Human-readable label for each transaction type. Kept locally so the
# wording can iterate without a frontend deploy.
_LABELS: dict[TransactionType, str] = {
    TransactionType.DEPOSIT: "Deposit",
    TransactionType.WITHDRAWAL: "Withdrawal",
    TransactionType.TRADE: "Trade",
    TransactionType.BROKERAGE: "Brokerage",
    TransactionType.CHARGES: "Brokerage / charges",
    TransactionType.PNL: "Realised P&L",
    TransactionType.ADJUSTMENT: "Admin adjustment",
    TransactionType.BONUS: "Bonus credit",
    TransactionType.PENALTY: "Penalty debit",
    TransactionType.PROMO: "Promo credit",
    TransactionType.INTER_USER: "Inter-user transfer",
    TransactionType.REVERSAL: "Reversal",
    TransactionType.PNL_SHARING_PAYOUT: "P&L sharing payout",
    TransactionType.PNL_SHARING_RECEIPT: "P&L sharing receipt",
    TransactionType.SETTLEMENT_OUTSTANDING_BOOKED: "Settlement booked",
    TransactionType.SETTLEMENT_OUTSTANDING_RECOVERY: "Settlement recovered",
}


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
    total_settlement_booked = 0.0
    for t in rows:
        d = float(str(t.amount))
        if opening is None:
            opening = float(str(t.balance_before))
        closing = float(str(t.balance_after))

        is_settlement = (
            t.transaction_type == TransactionType.SETTLEMENT_OUTSTANDING_BOOKED
        )
        if is_settlement:
            # Magnitude of the booking — d is always negative on
            # SETTLEMENT_OUTSTANDING_BOOKED rows, so abs() picks up
            # the right number for the summary card.
            total_settlement_booked += abs(d)

        label = _LABELS.get(t.transaction_type, t.transaction_type.value)

        out.append(
            {
                "id": str(t.id),
                "date": t.created_at,
                "type": t.transaction_type.value,
                "label": label,
                "is_settlement": is_settlement,
                "particulars": t.narration,
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
            "total_settlement_booked": total_settlement_booked,
            "count": len(out),
        }
    )
