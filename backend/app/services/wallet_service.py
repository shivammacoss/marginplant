"""Wallet operations — get/init wallet, credit/debit, block/release margin.

All money mutations go through here. Each call writes a `WalletTransaction`
ledger entry alongside updating the `Wallet` document.

Note: For Phase 2 we operate without MongoDB transactions (default standalone
mongod). Once a replica set is wired in, wrap the two writes in a session.
"""

from __future__ import annotations

import asyncio
import logging
from decimal import Decimal
from typing import Any

from beanie import PydanticObjectId
from bson import Decimal128

from app.core.exceptions import InsufficientFundsError, NotFoundError
from app.core.redis_client import publish
from app.models.transaction import (
    TransactionStatus,
    TransactionType,
    WalletTransaction,
)
from app.models.wallet import Wallet
from app.utils.decimal_utils import (
    ZERO,
    add,
    quantize_money,
    sub,
    to_decimal,
    to_decimal128,
)

logger = logging.getLogger(__name__)


async def _publish_wallet_event(
    user_id: str | PydanticObjectId,
    *,
    reason: str,
    amount: Decimal,
    balance_after: Decimal,
) -> None:
    """Push a `wallet` event to the user's WS channel so the APK and web app
    invalidate their wallet cache the instant a deposit/withdrawal/brokerage
    move lands. UserEventsProvider on the APK listens for type=="wallet"
    and re-fetches /wallet/summary — perceived latency drops from "next
    refetchInterval poll" (15 s) to "next event loop tick" (~50 ms).

    Best-effort: a Redis hiccup must NOT roll back the wallet write, so any
    exception is swallowed and logged.
    """
    try:
        await publish(
            f"user:{user_id}:wallet",
            {
                "type": "wallet",
                "payload": {
                    "reason": reason,
                    "amount": str(amount),
                    "balance_after": str(balance_after),
                },
            },
        )
    except Exception:  # noqa: BLE001 — best-effort
        logger.exception("wallet_publish_failed user=%s", user_id)
    # Fan out to admin dashboards on the same call so the admin's wallet /
    # margin / equity tiles refresh when a user's balance changes (deposit
    # credit, withdrawal debit, brokerage, P&L settlement).
    try:
        from app.services.admin_events import publish_admin_event

        await publish_admin_event(
            "wallet_update",
            {"user_id": str(user_id), "reason": reason, "amount": str(amount)},
        )
    except Exception:  # pragma: no cover
        pass


async def get_or_create(user_id: str | PydanticObjectId) -> Wallet:
    uid = PydanticObjectId(user_id)
    w = await Wallet.find_one(Wallet.user_id == uid)
    if w is None:
        w = Wallet(user_id=uid)
        await w.insert()
    return w


async def get(user_id: str | PydanticObjectId) -> Wallet:
    w = await Wallet.find_one(Wallet.user_id == PydanticObjectId(user_id))
    if w is None:
        raise NotFoundError("Wallet not found")
    return w


def _balance_total(w: Wallet) -> Decimal:
    return add(w.available_balance, w.credit_limit)


async def adjust(
    user_id: str | PydanticObjectId,
    amount: Decimal | float | int | str,
    *,
    transaction_type: TransactionType,
    narration: str,
    reference_type: str | None = None,
    reference_id: str | None = None,
    actor_id: str | PydanticObjectId | None = None,
) -> WalletTransaction:
    """Apply a signed delta (+ credit, - debit) to available_balance, write ledger."""
    amt = quantize_money(to_decimal(amount))
    w = await get_or_create(user_id)
    before = to_decimal(w.available_balance)
    after = add(before, amt)
    if amt < ZERO and after < ZERO:
        # Allow if credit_limit covers shortfall
        if add(after, w.credit_limit) < ZERO:
            raise InsufficientFundsError(
                f"Insufficient funds: balance ₹{before}, requested ₹{abs(amt)}"
            )

    w.available_balance = to_decimal128(after)
    w.version += 1

    if transaction_type == TransactionType.DEPOSIT:
        w.total_deposits = to_decimal128(add(w.total_deposits, amt))
    elif transaction_type == TransactionType.WITHDRAWAL:
        w.total_withdrawals = to_decimal128(add(w.total_withdrawals, abs(amt)))
    elif transaction_type == TransactionType.BROKERAGE:
        w.total_brokerage = to_decimal128(add(w.total_brokerage, abs(amt)))
    elif transaction_type == TransactionType.CHARGES:
        w.total_charges = to_decimal128(add(w.total_charges, abs(amt)))

    await w.save()

    txn = WalletTransaction(
        user_id=PydanticObjectId(user_id),
        transaction_type=transaction_type,
        amount=Decimal128(str(amt)),
        balance_before=Decimal128(str(before)),
        balance_after=Decimal128(str(after)),
        reference_type=reference_type,
        reference_id=reference_id,
        narration=narration,
        status=TransactionStatus.COMPLETED,
        created_by=PydanticObjectId(actor_id) if actor_id else None,
    )
    await txn.insert()

    # Fire-and-forget WS push so the user's APK/web wallet reflects the
    # credit/debit immediately. NOT awaited — admin's approve-deposit
    # response must not wait on Redis.
    asyncio.create_task(
        _publish_wallet_event(
            user_id,
            reason=transaction_type.value,
            amount=amt,
            balance_after=after,
        )
    )
    return txn


async def block_margin(user_id: str | PydanticObjectId, amount: Decimal | float) -> None:
    """Move money from available → used_margin (no ledger entry — internal lock)."""
    amt = quantize_money(to_decimal(amount))
    if amt <= ZERO:
        return
    w = await get_or_create(user_id)
    if to_decimal(w.available_balance) < amt:
        if add(w.available_balance, w.credit_limit) < amt:
            raise InsufficientFundsError(
                f"Insufficient margin: have ₹{w.available_balance}, need ₹{amt}"
            )
    w.available_balance = to_decimal128(sub(w.available_balance, amt))
    w.used_margin = to_decimal128(add(w.used_margin, amt))
    w.version += 1
    await w.save()
    # Notify the user's APK/web so the wallet's "available" and "used"
    # numbers reflect the new margin block immediately instead of waiting
    # on the 15 s wallet poll.
    asyncio.create_task(
        _publish_wallet_event(
            user_id,
            reason="MARGIN_BLOCK",
            amount=amt,
            balance_after=to_decimal(w.available_balance),
        )
    )


async def release_margin(user_id: str | PydanticObjectId, amount: Decimal | float) -> None:
    amt = quantize_money(to_decimal(amount))
    if amt <= ZERO:
        return
    w = await get_or_create(user_id)
    actual = min(amt, to_decimal(w.used_margin))
    w.used_margin = to_decimal128(sub(w.used_margin, actual))
    w.available_balance = to_decimal128(add(w.available_balance, actual))
    w.version += 1
    await w.save()
    asyncio.create_task(
        _publish_wallet_event(
            user_id,
            reason="MARGIN_RELEASE",
            amount=actual,
            balance_after=to_decimal(w.available_balance),
        )
    )


async def list_transactions(
    user_id: str | PydanticObjectId, *, limit: int = 50, skip: int = 0
) -> list[WalletTransaction]:
    return (
        await WalletTransaction.find(WalletTransaction.user_id == PydanticObjectId(user_id))
        .sort("-created_at")
        .skip(skip)
        .limit(limit)
        .to_list()
    )


async def summary(user_id: str | PydanticObjectId) -> dict[str, Any]:
    w = await get_or_create(user_id)
    return {
        "available_balance": str(w.available_balance),
        "used_margin": str(w.used_margin),
        "realized_pnl": str(w.realized_pnl),
        "unrealized_pnl": str(w.unrealized_pnl),
        "credit_limit": str(w.credit_limit),
        "total_deposits": str(w.total_deposits),
        "total_withdrawals": str(w.total_withdrawals),
        "total_brokerage": str(w.total_brokerage),
        "total_charges": str(w.total_charges),
    }
