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

    # ── Floor-at-0 + settlement booking ────────────────────────────────
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
    settlement_booked = ZERO
    if amt < ZERO and after < ZERO:
        if before > ZERO:
            settlement_booked = -after  # overflow past zero
            after = ZERO
        else:
            # Already at or below zero — entire debit goes to settlement.
            settlement_booked = -amt
            after = max(before, ZERO)

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

    await w.save()

    # Primary ledger entry shows the portion that actually moved on
    # available_balance — keeps balance_after − balance_before == amount
    # as an invariant for downstream reconciliation tooling.
    primary_delta = after - before
    txn = WalletTransaction(
        user_id=PydanticObjectId(user_id),
        transaction_type=transaction_type,
        amount=Decimal128(str(primary_delta if amt != ZERO else ZERO)),
        balance_before=Decimal128(str(before)),
        balance_after=Decimal128(str(after)),
        reference_type=reference_type,
        reference_id=reference_id,
        narration=narration,
        status=TransactionStatus.COMPLETED,
        created_by=PydanticObjectId(actor_id) if actor_id else None,
    )
    await txn.insert()

    # Settlement ledger entry — only the portion that booked against
    # settlement_outstanding (NOT the balance). balance_before/after
    # are the SETTLEMENT_OUTSTANDING field values so the reconciliation
    # invariant holds for that field too.
    if settlement_booked > ZERO:
        outstanding_after = to_decimal(w.settlement_outstanding)
        outstanding_before = outstanding_after - settlement_booked
        settlement_txn = WalletTransaction(
            user_id=PydanticObjectId(user_id),
            transaction_type=TransactionType.SETTLEMENT_OUTSTANDING_BOOKED,
            amount=Decimal128(str(-settlement_booked)),
            balance_before=Decimal128(str(outstanding_before)),
            balance_after=Decimal128(str(outstanding_after)),
            reference_type=reference_type,
            reference_id=reference_id,
            narration=(
                f"{narration} — shortfall ₹{settlement_booked} booked to settlement"
            ),
            status=TransactionStatus.COMPLETED,
            created_by=PydanticObjectId(actor_id) if actor_id else None,
        )
        await settlement_txn.insert()

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

    # Split: take from available first, overflow goes to outstanding.
    from_balance = min(before, amt)
    overflow = amt - from_balance

    new_balance = before - from_balance
    new_outstanding = to_decimal(w.settlement_outstanding) + overflow

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
