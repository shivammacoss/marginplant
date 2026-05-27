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
from app.utils.time_utils import now_utc

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
    """Apply a signed delta (+ credit, - debit) to available_balance.

    Settlement policy (per admin requirement — user-facing rule:
    "balance kabhi negative na ho, user nahi bhare ga"):
      • A debit that would drop available_balance below 0 is FLOORED at
        0. The shortfall accrues to `settlement_outstanding` and is
        recorded as a SETTLEMENT_OUTSTANDING_BOOKED ledger entry.
      • credit_limit is NOT used to allow a negative balance any more.
        The earlier "credit_limit covers shortfall → allow negative"
        branch was the root cause of the production state where
        `available_balance = −₹995.85` after a stop-out — admin
        snapshot from 21-May confirmed.
      • Inbound credits NO LONGER auto-clear settlement_outstanding.
        The settlement field is informational only; the user is not
        liable to top it up via future deposits. This removes the
        previous DEPOSIT-recovery branch (and the matching
        SETTLEMENT_OUTSTANDING_RECOVERY ledger writes from this path).

    Behavior for opening-side margin checks is unchanged — that runs
    through `order_validator.validate` and `block_margin`, neither of
    which is touched here.
    """
    amt = quantize_money(to_decimal(amount))
    w = await get_or_create(user_id)
    before = to_decimal(w.available_balance)
    after = add(before, amt)

    # ── Auto vs Manual settlement gate ─────────────────────────────────
    # The default `User.auto_settlement = True` runs the legacy
    # floor-at-0 + auto-book-settlement branch below. When admin has
    # flipped a user to `auto_settlement = False`, we instead let
    # `available_balance` go negative and enqueue a pending
    # SettlementRequest for manual admin approval (see
    # `_ensure_pending_settlement_request` below).
    auto_settlement_on = True
    try:
        from app.models.user import User as _User

        _u = await _User.get(PydanticObjectId(user_id))
        if _u is not None:
            auto_settlement_on = bool(getattr(_u, "auto_settlement", True))
    except Exception:
        # If the user lookup itself fails treat as default-ON so we
        # NEVER accidentally allow negative balances on a transient
        # Mongo hiccup. Safer to over-restrict than over-permit.
        auto_settlement_on = True

    # ── Floor-at-0 + settlement booking (auto-ON branch) ──────────────
    # When a debit would push the balance below 0 we clip it to 0 and
    # send the overflow to settlement_outstanding. Two distinct cases:
    #   1) before >= 0 and after < 0 — normal "loss > balance" close.
    #      The debit amt is split: |before| hits balance, the rest
    #      books to settlement.
    #   2) before < 0 (legacy bad state inherited from before this fix)
    #      — every cent of `amt` goes to settlement; balance stays at
    #      whatever non-negative value it would normally land on. This
    #      keeps the migration path graceful for any wallet that was
    #      already negative before redeploy.
    # Withdrawals must NEVER book settlement_outstanding — if the
    # balance is insufficient the caller should have rejected the
    # request upfront.  This guard prevents a withdrawal from silently
    # flooring the wallet and accruing phantom settlement debt.
    if transaction_type == TransactionType.WITHDRAWAL and after < ZERO:
        raise InsufficientFundsError(
            f"Withdrawal of {abs(amt)} exceeds available balance {before}"
        )

    settlement_booked = ZERO
    if auto_settlement_on and amt < ZERO and after < ZERO:
        if before > ZERO:
            settlement_booked = -after  # overflow past zero
            after = ZERO
        else:
            # Already at or below zero — entire debit goes to settlement.
            settlement_booked = -amt
            after = max(before, ZERO)
    # In manual mode (`auto_settlement_on == False`) we deliberately
    # leave `after` at its raw negative value so the wallet ledger row
    # below records the genuine shortfall. The pending
    # SettlementRequest is queued after the wallet save.

    w.available_balance = to_decimal128(after)
    if settlement_booked > ZERO:
        w.settlement_outstanding = to_decimal128(
            add(to_decimal(w.settlement_outstanding), settlement_booked)
        )
    w.version += 1

    if transaction_type == TransactionType.DEPOSIT:
        w.total_deposits = to_decimal128(add(w.total_deposits, amt))
    elif transaction_type == TransactionType.WITHDRAWAL:
        w.total_withdrawals = to_decimal128(add(w.total_withdrawals, abs(amt)))
    elif transaction_type == TransactionType.BROKERAGE:
        w.total_brokerage = to_decimal128(add(w.total_brokerage, abs(amt)))
    elif transaction_type == TransactionType.CHARGES:
        w.total_charges = to_decimal128(add(w.total_charges, abs(amt)))
    elif transaction_type == TransactionType.PNL:
        # Cumulative realised P&L tracker on the wallet itself —
        # signed so winning trades push it up and losers push it down.
        # Without this branch the field stayed at 0 forever even when
        # the ledger had thousands of PNL transactions, and the
        # admin's "Realized P&L" tile + the user's wallet summary
        # both rendered 0 regardless of actual trading activity.
        # Operator-flagged 21-May: account CL62477932 had
        # `realized_pnl = 0` despite 112 trades and -INR 11,675 in
        # PNL transactions for the day. `amt` carries the natural
        # sign (negative for losses, positive for wins).
        w.realized_pnl = to_decimal128(add(w.realized_pnl, amt))

    await w.save()

    # ── Ledger entries ───────────────────────────────────────────────
    # Strict invariant for the user-facing ledger viewer:
    #     EVERY row's balance_before / balance_after are values of the
    #     available_balance field at that moment. Never mix in the
    #     settlement_outstanding field — the column header reads
    #     "Balance" and the user expects that column to be continuous
    #     across rows. Mixing settlement values here was the root of
    #     the 21-May display bug where the ledger jumped
    #         1000 → 0 → 190.82 → 809.26 → 9.26
    #     instead of the actual available_balance path
    #         1000 → 0 → 0 → 809.26 → 9.26.
    primary_delta = after - before
    txn: WalletTransaction | None = None
    # Skip the "primary" CHARGES / PNL / etc. row entirely when nothing
    # actually moved on available_balance (full debit absorbed by the
    # settlement booking that follows). Otherwise the ledger surfaces
    # a confusing zero-amount row in the same second as the real
    # settlement debit.
    write_primary = (primary_delta != ZERO) or (amt == ZERO)
    if write_primary:
        txn = WalletTransaction(
            user_id=PydanticObjectId(user_id),
            transaction_type=transaction_type,
            amount=Decimal128(str(primary_delta)),
            balance_before=Decimal128(str(before)),
            balance_after=Decimal128(str(after)),
            reference_type=reference_type,
            reference_id=reference_id,
            narration=narration,
            status=TransactionStatus.COMPLETED,
            created_by=PydanticObjectId(actor_id) if actor_id else None,
        )
        await txn.insert()

    # Settlement ledger entry — books against settlement_outstanding,
    # not available_balance. balance_before / balance_after stay on
    # `after` (the floored available_balance) so the Balance column
    # in the ledger reads continuously across this row. The amount
    # carries the full magnitude of the settlement booking so the
    # Debit column shows the user where the missing money went.
    if settlement_booked > ZERO:
        settlement_txn = WalletTransaction(
            user_id=PydanticObjectId(user_id),
            transaction_type=TransactionType.SETTLEMENT_OUTSTANDING_BOOKED,
            amount=Decimal128(str(-settlement_booked)),
            balance_before=Decimal128(str(after)),
            balance_after=Decimal128(str(after)),
            reference_type=reference_type,
            reference_id=reference_id,
            narration=(
                f"{narration} — shortfall ₹{settlement_booked} booked to settlement"
            ),
            status=TransactionStatus.COMPLETED,
            created_by=PydanticObjectId(actor_id) if actor_id else None,
        )
        await settlement_txn.insert()
        # If the primary row was skipped, return the settlement row so
        # callers that hand the txn back to the API layer still get a
        # WalletTransaction document.
        if txn is None:
            txn = settlement_txn

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

    # ── Manual-settlement enqueue ─────────────────────────────────────
    # In auto-OFF mode, a debit that left the wallet in red queues a
    # pending SettlementRequest. Best-effort: a Mongo hiccup here must
    # NOT roll back the wallet write — the admin can always re-sync
    # later from the Payments → Settlement Requests tab (the row is
    # re-derived from |available_balance| each time).
    if not auto_settlement_on and after < ZERO:
        try:
            await _ensure_pending_settlement_request(
                user_id=user_id,
                narration=narration,
                reference_type=reference_type,
                reference_id=reference_id,
            )
        except Exception:  # pragma: no cover
            logger.exception(
                "settlement_request_enqueue_failed user=%s", user_id
            )

    return txn


async def _ensure_pending_settlement_request(
    *,
    user_id: str | PydanticObjectId,
    narration: str,
    reference_type: str | None,
    reference_id: str | None,
) -> None:
    """Upsert the per-user pending SettlementRequest.

    Per-user invariant: at most ONE pending row at a time (enforced by
    the partial unique index in the model). This helper either creates
    a fresh PENDING row or refreshes the existing one's
    `requested_amount` to reflect the latest |available_balance|, so the
    admin always sees the current shortfall when they open the
    Settlement Requests tab — even after several debits have piled on
    since the original request.
    """
    from app.models.transaction import SettlementRequest, SettlementStatus

    uid = PydanticObjectId(user_id)
    w = await Wallet.find_one(Wallet.user_id == uid)
    if w is None:
        return
    avail = to_decimal(w.available_balance)
    if avail >= ZERO:
        # Wallet is back in the black — nothing to enqueue. (Possible
        # if a winning trade or admin credit closed the gap between
        # the debit that called us and now.)
        return
    shortfall = -avail  # positive
    outstanding = to_decimal(w.settlement_outstanding)

    existing = await SettlementRequest.find_one(
        SettlementRequest.user_id == uid,
        SettlementRequest.status == SettlementStatus.PENDING,
    )
    if existing is not None:
        existing.requested_amount = to_decimal128(shortfall)
        # Refresh the latest trigger so the admin sees the most recent
        # cause when they read the row. The original `available_at_request`
        # stays as the snapshot from when the row was first created.
        existing.narration = narration or existing.narration
        if reference_type is not None:
            existing.reference_type = reference_type
        if reference_id is not None:
            existing.reference_id = reference_id
        await existing.save()
        logger.info(
            "settlement_request_updated user=%s amount=%s",
            uid,
            shortfall,
        )
        return

    req = SettlementRequest(
        user_id=uid,
        requested_amount=to_decimal128(shortfall),
        available_at_request=to_decimal128(avail),
        settlement_outstanding_at_request=to_decimal128(outstanding),
        reference_type=reference_type,
        reference_id=reference_id,
        narration=narration,
        status=SettlementStatus.PENDING,
    )
    await req.insert()
    logger.info(
        "settlement_request_created user=%s amount=%s",
        uid,
        shortfall,
    )

    # Admin notification bell — fan out one AdminNotification per
    # recipient up the tier chain so the admin sees the pending
    # request in their bell instantly.
    try:
        from app.models.notification import (
            AdminNotificationEventType,
            NotificationLevel,
        )
        from app.services import notification_service

        await notification_service.create_for_admins(
            source_user_id=uid,
            event_type=AdminNotificationEventType.SETTLEMENT_REQUESTED,
            level=NotificationLevel.WARNING,
            title="Settlement approval needed",
            message=f"₹{shortfall} shortfall · {narration}",
            link="/payments?tab=settlements",
            reference_type="SettlementRequest",
            reference_id=str(req.id),
            data={"shortfall": str(shortfall)},
        )
    except Exception:  # pragma: no cover
        logger.exception("settlement_request_notification_failed user=%s", uid)


async def approve_settlement_request(
    request_id: str | PydanticObjectId,
    admin_id: PydanticObjectId,
    admin_user_code: str | None = None,
) -> WalletTransaction:
    """Admin-side approval: do the exact floor-to-0 + settlement booking
    that auto-mode would have done.

    Reads the current `available_balance` (which should be negative for
    a legitimate PENDING request) and:
      • Floors available_balance to 0
      • Adds the magnitude to settlement_outstanding
      • Writes one SETTLEMENT_OUTSTANDING_BOOKED ledger row with
        narration that names the approving admin
      • Marks the SettlementRequest APPROVED + stamps approved_by /
        approved_at

    Returns the ledger row so the calling endpoint can echo it back.
    """
    from app.models.transaction import SettlementRequest, SettlementStatus

    req = await SettlementRequest.get(PydanticObjectId(str(request_id)))
    if req is None:
        raise ValueError("Settlement request not found")
    if req.status != SettlementStatus.PENDING:
        raise ValueError(
            f"Settlement request is {req.status.value}, not PENDING"
        )

    uid = req.user_id
    w = await Wallet.find_one(Wallet.user_id == uid)
    if w is None:
        raise ValueError("Wallet not found for user")
    avail = to_decimal(w.available_balance)

    if avail >= ZERO:
        # Wallet already self-healed (winning trade / admin credit
        # cleared the gap). Mark the request APPROVED with a zero-
        # magnitude record so the audit trail still shows the admin
        # action — no money movement needed.
        req.status = SettlementStatus.APPROVED
        req.approved_by = admin_id
        req.approved_at = now_utc()
        req.requested_amount = to_decimal128(ZERO)
        await req.save()
        # Synthesise a marker transaction so the ledger still records
        # the admin action.
        marker = WalletTransaction(
            user_id=uid,
            transaction_type=TransactionType.SETTLEMENT_OUTSTANDING_BOOKED,
            amount=Decimal128("0"),
            balance_before=Decimal128(str(avail)),
            balance_after=Decimal128(str(avail)),
            reference_type="SettlementRequest",
            reference_id=str(req.id),
            narration=(
                f"Admin {admin_user_code or admin_id} approved settlement "
                f"request — wallet had already recovered, no booking needed"
            ),
            status=TransactionStatus.COMPLETED,
            created_by=admin_id,
        )
        await marker.insert()
        return marker

    shortfall = -avail  # positive magnitude
    new_outstanding = add(to_decimal(w.settlement_outstanding), shortfall)

    w.available_balance = to_decimal128(ZERO)
    w.settlement_outstanding = to_decimal128(new_outstanding)
    w.version += 1
    await w.save()

    ledger = WalletTransaction(
        user_id=uid,
        transaction_type=TransactionType.SETTLEMENT_OUTSTANDING_BOOKED,
        amount=Decimal128(str(-shortfall)),
        balance_before=Decimal128(str(avail)),
        balance_after=Decimal128("0"),
        reference_type="SettlementRequest",
        reference_id=str(req.id),
        narration=(
            f"Admin {admin_user_code or admin_id} approved settlement "
            f"request — shortfall ₹{shortfall} booked to settlement"
        ),
        status=TransactionStatus.COMPLETED,
        created_by=admin_id,
    )
    await ledger.insert()

    req.status = SettlementStatus.APPROVED
    req.approved_by = admin_id
    req.approved_at = now_utc()
    req.requested_amount = to_decimal128(shortfall)
    await req.save()

    asyncio.create_task(
        _publish_wallet_event(
            uid,
            reason="SETTLEMENT_APPROVED",
            amount=-shortfall,
            balance_after=ZERO,
        )
    )
    logger.info(
        "settlement_request_approved user=%s amount=%s admin=%s",
        uid,
        shortfall,
        admin_id,
    )
    return ledger


async def reject_settlement_request(
    request_id: str | PydanticObjectId,
    admin_id: PydanticObjectId,
    reason: str,
) -> None:
    """Admin-side rejection: mark the request REJECTED with the admin's
    reason. Balance stays NEGATIVE; the user stays blocked from new
    opening orders until a fresh debit pushes the wallet further into
    red (which writes a brand-new PENDING request) or until they
    deposit / win enough to bring the balance back above 0.
    """
    from app.models.transaction import SettlementRequest, SettlementStatus

    req = await SettlementRequest.get(PydanticObjectId(str(request_id)))
    if req is None:
        raise ValueError("Settlement request not found")
    if req.status != SettlementStatus.PENDING:
        raise ValueError(
            f"Settlement request is {req.status.value}, not PENDING"
        )
    req.status = SettlementStatus.REJECTED
    req.approved_by = admin_id  # actor stamp
    req.approved_at = now_utc()
    req.rejected_reason = reason
    await req.save()
    logger.info(
        "settlement_request_rejected user=%s admin=%s reason=%s",
        req.user_id,
        admin_id,
        reason,
    )


async def has_pending_settlement_request(
    user_id: str | PydanticObjectId,
) -> bool:
    """O(1) probe used by `order_validator` to block new opening orders
    while a user has a PENDING settlement request hanging."""
    from app.models.transaction import SettlementRequest, SettlementStatus

    uid = PydanticObjectId(str(user_id))
    existing = await SettlementRequest.find_one(
        SettlementRequest.user_id == uid,
        SettlementRequest.status == SettlementStatus.PENDING,
    )
    return existing is not None


async def force_debit(
    user_id: str | PydanticObjectId,
    amount: Decimal | float | int | str,
    *,
    transaction_type: TransactionType,
    narration: str,
    reference_type: str | None = None,
    reference_id: str | None = None,
    actor_id: str | PydanticObjectId | None = None,
) -> WalletTransaction:
    """Debit `amount` from the user's wallet. Unlike `adjust`, never raises
    InsufficientFundsError — the unrecoverable shortfall books to
    `settlement_outstanding`. Used only by force-close paths (risk_enforcer
    stop-out) where the position MUST close even if loss exceeds balance.

    Returns the primary WalletTransaction (for the available_balance debit
    if any; otherwise the SETTLEMENT_OUTSTANDING_BOOKED transaction).

    `amount` must be a POSITIVE magnitude.
    """
    amt = quantize_money(to_decimal(amount))
    if amt <= ZERO:
        raise ValueError("force_debit amount must be positive")

    w = await get_or_create(user_id)
    before = to_decimal(w.available_balance)

    # ── Auto vs Manual settlement gate (same as adjust()) ─────────────
    # Risk-enforcer stop-outs run through force_debit. On an auto-OFF
    # user we still want the position to close, but we shouldn't
    # auto-book the shortfall to `settlement_outstanding` — that's the
    # admin's call. Instead we let `available_balance` go negative and
    # enqueue a SettlementRequest, mirroring the adjust() OFF branch.
    auto_settlement_on = True
    try:
        from app.models.user import User as _User

        _u = await _User.get(PydanticObjectId(user_id))
        if _u is not None:
            auto_settlement_on = bool(getattr(_u, "auto_settlement", True))
    except Exception:
        auto_settlement_on = True

    if auto_settlement_on:
        # Legacy split: take from available first, overflow → settlement.
        from_balance = min(before, amt)
        overflow = amt - from_balance
        new_balance = before - from_balance
        new_outstanding = to_decimal(w.settlement_outstanding) + overflow
    else:
        # Manual mode: full magnitude hits available, no settlement
        # booking. The pending SettlementRequest captures the gap.
        from_balance = amt
        overflow = ZERO
        new_balance = before - amt  # may go negative
        new_outstanding = to_decimal(w.settlement_outstanding)

    w.available_balance = to_decimal128(new_balance)
    w.settlement_outstanding = to_decimal128(new_outstanding)
    w.version += 1
    await w.save()

    primary_tx: WalletTransaction | None = None
    if from_balance > ZERO:
        primary_tx = WalletTransaction(
            user_id=PydanticObjectId(user_id),
            transaction_type=transaction_type,
            amount=Decimal128(str(-from_balance)),
            balance_before=Decimal128(str(before)),
            balance_after=Decimal128(str(new_balance)),
            reference_type=reference_type,
            reference_id=reference_id,
            narration=narration,
            status=TransactionStatus.COMPLETED,
            created_by=PydanticObjectId(actor_id) if actor_id else None,
        )
        await primary_tx.insert()

    if overflow > ZERO:
        outstanding_tx = WalletTransaction(
            user_id=PydanticObjectId(user_id),
            transaction_type=TransactionType.SETTLEMENT_OUTSTANDING_BOOKED,
            amount=Decimal128(str(-overflow)),
            balance_before=Decimal128(str(new_balance)),
            balance_after=Decimal128(str(new_balance)),
            reference_type=reference_type,
            reference_id=reference_id,
            narration=f"{narration} (shortfall booked to outstanding)",
            status=TransactionStatus.COMPLETED,
            created_by=PydanticObjectId(actor_id) if actor_id else None,
        )
        await outstanding_tx.insert()
        if primary_tx is None:
            primary_tx = outstanding_tx

    asyncio.create_task(
        _publish_wallet_event(
            user_id,
            reason=transaction_type.value,
            amount=-amt,
            balance_after=new_balance,
        )
    )

    # Enqueue pending settlement when manual mode left the wallet in red.
    if not auto_settlement_on and new_balance < ZERO:
        try:
            await _ensure_pending_settlement_request(
                user_id=user_id,
                narration=narration,
                reference_type=reference_type,
                reference_id=reference_id,
            )
        except Exception:  # pragma: no cover
            logger.exception(
                "settlement_request_enqueue_failed_on_force_debit user=%s",
                user_id,
            )

    return primary_tx  # type: ignore[return-value]


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
    """Return blocked margin to the wallet.

    Per the settlement policy update (21-May): released margin is
    credited STRAIGHT back to available_balance. The previous
    "auto-recover settlement_outstanding from released margin first"
    branch is gone — settlement is now informational only and is
    never auto-recovered from any inbound credit (deposit, bonus,
    released margin, winning-trade PnL). See `adjust()` docstring
    for the full rule.
    """
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


async def recompute_used_margin(
    user_id: str | PydanticObjectId,
) -> dict[str, Any]:
    """Source-of-truth reconciliation for wallet.used_margin.

    `block_margin` / `release_margin` are delta operations — they
    adjust the running counter as orders fill and positions close.
    Over time that counter drifts because:
      • admin hard-deletes a Position (no release_margin call)
      • mid-flow crash between Position.save and release_margin
      • partial-close math mismatches the original block amount
      • legacy positions written before margin_used was tracked
    Admin-flagged symptom: "0 open positions, 0 active trades, but
    USED MARGIN shows ₹1,728.70 — bahut sare IDs me ho raha".

    This helper computes the canonical used_margin as
    ``sum(p.margin_used for p in open positions)`` and resets the
    wallet's field to match. Any positive delta (real margin was
    locked we're now releasing) is credited back to
    available_balance. A negative delta (the wallet was UNDER-counting
    locked margin, rare) is debited from available_balance.

    Returns a small diff summary so an admin endpoint / periodic
    loop can log what was repaired.

    Note: this does NOT publish a ledger entry — released margin is
    an internal lock, never a real money movement. Same semantics as
    `release_margin` which also writes no ledger (only the
    SETTLEMENT_OUTSTANDING_RECOVERY branch is ledger-bearing, and
    that side-effect only kicks in for an actual close fill).
    """
    from app.models.position import Position, PositionStatus

    uid = PydanticObjectId(str(user_id))
    open_positions = await Position.find(
        Position.user_id == uid,
        Position.status == PositionStatus.OPEN,
    ).to_list()
    canonical = ZERO
    for p in open_positions:
        m = to_decimal(p.margin_used or 0)
        if m > ZERO:
            canonical = add(canonical, m)

    w = await get_or_create(uid)
    current = to_decimal(w.used_margin)
    delta = sub(canonical, current)  # canonical - current
    if delta == ZERO:
        return {
            "ok": True,
            "changed": False,
            "before_used": str(current),
            "after_used": str(canonical),
            "delta": "0",
            "open_positions": len(open_positions),
        }

    if delta < ZERO:
        # Wallet was over-counting → release the excess back to balance.
        excess = -delta  # positive
        w.used_margin = to_decimal128(canonical)
        w.available_balance = to_decimal128(
            add(to_decimal(w.available_balance), excess)
        )
    else:
        # Wallet was under-counting (rare). Move the missing amount
        # from available → used_margin so the invariant holds. If
        # available can't cover it (very rare; would mean a position
        # was opened on credit that exceeded the limit), we still
        # commit the new used_margin and leave available negative —
        # the operator can then audit and reset deliberately.
        w.used_margin = to_decimal128(canonical)
        w.available_balance = to_decimal128(
            sub(to_decimal(w.available_balance), delta)
        )
    w.version += 1
    await w.save()

    return {
        "ok": True,
        "changed": True,
        "before_used": str(current),
        "after_used": str(canonical),
        "delta": str(delta),
        "open_positions": len(open_positions),
    }


async def recompute_realized_pnl_for_all() -> dict[str, int]:
    """One-shot backfill for ``wallet.realized_pnl``.

    Until 21-May `adjust()` only updated total_* fields for
    deposit/withdrawal/brokerage/charges — PNL transactions skipped
    the cumulative tracker entirely, so every wallet showed
    realized_pnl = 0 regardless of actual trading. This helper sums
    every PNL transaction (signed) per user and writes the result
    onto the wallet.

    Idempotent — re-runs converge on the same value because the
    source-of-truth is the immutable wallet_transactions ledger.
    Cheap: one $group aggregate followed by one $set per wallet
    that needs repair.
    """
    log = logging.getLogger(__name__)
    txn_coll = WalletTransaction.get_motor_collection()
    wallet_coll = Wallet.get_motor_collection()

    cursor = txn_coll.aggregate(
        [
            {"$match": {"transaction_type": "PNL"}},
            {
                "$group": {
                    "_id": "$user_id",
                    "total": {"$sum": {"$toDecimal": "$amount"}},
                }
            },
        ]
    )

    scanned = 0
    repaired = 0
    async for row in cursor:
        scanned += 1
        try:
            user_id = row["_id"]
            total_dec = to_decimal(row["total"])
            quantised = quantize_money(total_dec)
            existing = await Wallet.find_one(Wallet.user_id == user_id)
            if existing is None:
                continue
            current = to_decimal(existing.realized_pnl)
            if current == quantised:
                continue
            await wallet_coll.update_one(
                {"user_id": user_id},
                {"$set": {"realized_pnl": Decimal128(str(quantised))}},
            )
            repaired += 1
            log.info(
                "realized_pnl_repaired user=%s before=%s after=%s",
                user_id,
                current,
                quantised,
            )
        except Exception:
            log.warning("recompute_realized_pnl_failed row=%s", row, exc_info=True)

    if repaired:
        log.info("realized_pnl_backfill scanned=%d repaired=%d", scanned, repaired)
    return {"scanned": scanned, "repaired": repaired}


async def clamp_negative_balances_to_settlement() -> dict[str, int]:
    """One-shot migration: every wallet with available_balance < 0 has its
    balance clipped to 0 and the magnitude added to settlement_outstanding.
    Writes one SETTLEMENT_OUTSTANDING_BOOKED ledger entry per fix so the
    repair is auditable in the user's transaction list.

    Called from the FastAPI lifespan on every boot — idempotent (a wallet
    with balance >= 0 is a no-op). Cheap (one full-table scan that filters
    in Mongo first, so only the negatives are read into memory).

    Why this exists: before the floor-at-0 fix, `adjust()` allowed any
    debit to push available_balance negative as long as credit_limit
    covered the shortfall. Production state on 21-May had at least one
    wallet at −₹995.85 / Outstanding ₹680.50 — admin screenshot
    confirmed. Without this migration that user (and any other affected
    accounts) would keep showing a negative number on the wallet page
    even after the new code is deployed.
    """
    from datetime import datetime as _dt

    log = logging.getLogger(__name__)

    # Mongo can't directly compare a Decimal128 against numeric 0 in a
    # find() filter without an explicit Decimal128 sentinel, so we cast
    # on the server side via $expr. Fetches only the rows that need
    # fixing — fast even with thousands of wallets.
    wallets = await Wallet.find(
        {"$expr": {"$lt": [{"$toDecimal": "$available_balance"}, 0]}}
    ).to_list()

    fixed = 0
    for w in wallets:
        before_balance = to_decimal(w.available_balance)
        if before_balance >= ZERO:
            continue  # defensive — the $expr filter should have excluded these
        shortfall = -before_balance  # positive
        outstanding_before = to_decimal(w.settlement_outstanding)
        outstanding_after = add(outstanding_before, shortfall)
        w.available_balance = to_decimal128(ZERO)
        w.settlement_outstanding = to_decimal128(outstanding_after)
        w.version += 1
        await w.save()

        try:
            settlement_txn = WalletTransaction(
                user_id=w.user_id,
                transaction_type=TransactionType.SETTLEMENT_OUTSTANDING_BOOKED,
                amount=Decimal128(str(-shortfall)),
                balance_before=Decimal128(str(outstanding_before)),
                balance_after=Decimal128(str(outstanding_after)),
                narration=(
                    f"Migration: clamped negative available_balance "
                    f"(₹{before_balance}) to 0, shortfall booked to settlement"
                ),
                status=TransactionStatus.COMPLETED,
            )
            await settlement_txn.insert()
        except Exception:  # pragma: no cover
            log.warning(
                "negative_balance_clamp_audit_failed user=%s",
                w.user_id,
                exc_info=True,
            )

        fixed += 1
        log.info(
            "negative_balance_clamped user=%s before=%s outstanding_before=%s outstanding_after=%s",
            w.user_id,
            before_balance,
            outstanding_before,
            outstanding_after,
        )

    _ = _dt  # silence linter if datetime helper unused
    return {"scanned": len(wallets), "fixed": fixed}


async def reconcile_all_used_margins() -> dict[str, int]:
    """Walk every wallet and reconcile its used_margin against the
    user's open Position docs. Cheap (one query per user) — called
    from the tracker reconcile loop every 15 minutes so any drift
    self-heals without an operator opening the admin panel.
    """
    import logging

    log = logging.getLogger(__name__)
    wallets = await Wallet.find_all().to_list()
    scanned = 0
    repaired = 0
    for w in wallets:
        scanned += 1
        try:
            r = await recompute_used_margin(w.user_id)
            if r.get("changed"):
                repaired += 1
                log.info(
                    "wallet_margin_drift_fixed user=%s before=%s after=%s",
                    w.user_id,
                    r["before_used"],
                    r["after_used"],
                )
        except Exception:
            log.warning(
                "recompute_used_margin_failed user=%s",
                w.user_id,
                exc_info=True,
            )
    if repaired:
        log.info(
            "wallet_used_margin_reconcile scanned=%s repaired=%s",
            scanned,
            repaired,
        )
    return {"scanned": scanned, "repaired": repaired}


async def summary(user_id: str | PydanticObjectId) -> dict[str, Any]:
    """Wallet summary in Dabba/CFD presentation:
        - bal              = main_balance display (available + used, since
                             margin is internally "locked" but conceptually
                             still part of the user's wallet)
        - margin           = locked margin against open positions
        - unrealized_pnl   = sum of floating PnL across open positions
        - equity           = bal + unrealized_pnl
        - free             = equity − margin (what's deployable on a new
                             trade after honouring current float losses)
        - margin_level_pct = equity / margin × 100 (the stop-out gauge;
                             None when no positions are open)

    Legacy fields (available_balance / used_margin) stay on the payload
    so older APK / web clients keep working through one rollout window.
    """
    from app.models.position import Position, PositionStatus

    w = await get_or_create(user_id)

    # Float PnL across this user's open positions. Stored on Position by
    # risk_enforcer.refresh_unrealized_pnl every tick, so reading is cheap.
    open_positions = await Position.find(
        Position.user_id == PydanticObjectId(user_id)
        if not isinstance(user_id, PydanticObjectId)
        else Position.user_id == user_id,
        Position.status == PositionStatus.OPEN,
    ).to_list()
    float_pnl = ZERO
    open_margin_sum = ZERO
    for p in open_positions:
        try:
            float_pnl = add(float_pnl, to_decimal(p.unrealized_pnl))
        except Exception:
            pass
        try:
            open_margin_sum = add(open_margin_sum, to_decimal(p.margin_used))
        except Exception:
            pass

    avail = to_decimal(w.available_balance)
    used = to_decimal(w.used_margin)
    credit = to_decimal(w.credit_limit)

    # Bal = wallet "wealth at rest" — what the user sees as their main
    # account balance, stable regardless of currently-locked margin
    # (only brokerage + realised PnL move it). Internally this equals
    # (available + used) because legacy block_margin() shuffles cash
    # between those two fields; in the trader-facing presentation we
    # add them back to show one number.
    bal = add(avail, used)
    equity = add(bal, float_pnl)

    # `open_margin_sum` SHOULD equal `used` in steady state, but the
    # per-position field is the authoritative truth (the wallet field
    # is legacy from when margin was tracked centrally). Prefer the
    # position sum when they disagree — that's what every order touched.
    margin = open_margin_sum if open_margin_sum > ZERO else used

    # Free = Bal − Margin (NOT Equity − Margin).
    # User feedback: "free margin balance se calculate hoga, used hoga".
    # The trader wants `Free` to represent "how much of my MAIN BALANCE
    # is unlocked for a fresh trade right now", independent of whether
    # open positions are currently in profit or loss. Float PnL is
    # already surfaced via the Equity tile next door; double-counting it
    # into Free made the number swing whenever the market ticked, which
    # the trader found confusing on Indian brokers where Free is a
    # margin-reservation gauge, not a P&L-net gauge.
    free = sub(bal, margin)
    margin_level_pct: float | None = None
    if margin > ZERO:
        try:
            margin_level_pct = float(equity / margin * to_decimal(100))
        except Exception:
            margin_level_pct = None

    return {
        # ── Dabba-style KPIs (preferred) ────────────────────────────
        "bal": str(bal),
        "equity": str(equity),
        "margin": str(margin),
        "free": str(free),
        "margin_level_pct": margin_level_pct,
        "open_unrealized_pnl": str(float_pnl),
        # ── Legacy fields (kept for backward compat) ────────────────
        "available_balance": str(w.available_balance),
        "used_margin": str(w.used_margin),
        "realized_pnl": str(w.realized_pnl),
        "unrealized_pnl": str(w.unrealized_pnl),
        "credit_limit": str(w.credit_limit),
        "settlement_outstanding": str(w.settlement_outstanding),
        "total_deposits": str(w.total_deposits),
        "total_withdrawals": str(w.total_withdrawals),
        "total_brokerage": str(w.total_brokerage),
        "total_charges": str(w.total_charges),
    }
