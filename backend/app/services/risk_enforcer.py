"""Risk Management background enforcer.

Runs every 250 ms (see `risk_enforcer_loop` default). Implements the
simplified spec:

    stopOutWarningPercent  — notify when (-total_pnl) / balance × 100 ≥ this %.
                             "balance" = wallet.available + used_margin + credit_limit
                             (matches the admin UI help text).
    stopOutPercent         — force-close EVERY open position when the same
                             ratio crosses this %.
    profitTradeHoldMinSeconds / lossTradeHoldMinSeconds / exitOnlyMode are
    enforced synchronously by the order validator; they don't need a
    background loop.

Plus a built-in bracket SL / TP scan per position (LONG: SL when LTP ≤ SL,
TP when LTP ≥ TP; SHORT: mirrored). The pending-order poller handles
stand-alone LIMIT / SL-M; bracket legs attached to positions land here.
"""

from __future__ import annotations

import asyncio
import logging
from decimal import Decimal
from typing import Any

from bson import Decimal128

from app.models._base import OrderAction, OrderType
from app.models.position import Position, PositionStatus
from app.models.user import User
from app.services import (
    market_data_service,
    netting_service,
    order_service,
    position_service,
    wallet_service,
)
from app.utils.decimal_utils import to_decimal

logger = logging.getLogger(__name__)

_running = False
# Per-user re-arm flag for the warning notification — "once per crossing"
# means we send a single ping when loss first crosses the warning threshold
# and don't ping again until loss drops back below it (then we re-arm).
_warning_armed: dict[str, bool] = {}


def _wallet_balance(wallet: Any) -> Decimal:
    """Denominator the stop-out percentages are measured against.

    Total wallet pool = available cash + currently locked margin + admin-
    extended credit. With balance ₹1000 and stop-out 80 %, a floating
    loss of ₹800 triggers stop-out — matching the broker's spec:
        loss_pct = (floating_loss + estimated_close_brokerage) / balance × 100

    Note: callers fold the close-leg brokerage estimate INTO the
    numerator (see `enforce_for_user`); this function only returns the
    denominator, kept simple and dependency-free so it stays cheap to
    call every tick.
    """
    return (
        to_decimal(wallet.available_balance)
        + to_decimal(wallet.used_margin)
        + to_decimal(wallet.credit_limit)
    )


async def _send_warning(user_id: str, threshold: float, loss_pct: float) -> None:
    """Best-effort warning ping over the per-user Redis pub/sub channel.
    The user's open terminal subscribes to `user:{id}:risk` and renders a
    banner. We don't block the loop on this."""
    try:
        from app.core.redis_client import publish

        await publish(
            f"user:{user_id}:risk",
            {
                "type": "stop_out_warning",
                "threshold_pct": round(threshold, 2),
                "loss_pct": round(loss_pct, 2),
            },
        )
    except Exception:
        logger.debug("stop_out_warning_publish_failed", extra={"user_id": user_id})


def _classify_close_reason(raw: str) -> str:
    """Map the verbose internal reason string to the compact tag stored on
    Position.close_reason. The tag is what the UI renders on the Closed
    tab, so it has to be human-friendly and stable.
    """
    if "bracket_sl" in raw:
        return "SL_HIT"
    if "bracket_tp" in raw:
        return "TP_HIT"
    if "stop_out" in raw:
        return "STOP_OUT"
    return "AUTO"


async def _stamp_close_reason(position_id: Any, tag: str) -> None:
    """Refetch the position and stamp `close_reason` if it actually closed.
    Idempotent — won't overwrite an existing tag.
    """
    try:
        fresh = await Position.get(position_id)
        if (
            fresh is not None
            and fresh.status == PositionStatus.CLOSED
            and not fresh.close_reason
        ):
            fresh.close_reason = tag
            await fresh.save()
    except Exception:
        logger.warning(
            "close_reason_stamp_failed",
            extra={"position_id": str(position_id)},
        )


async def _squareoff_position(
    user: User,
    p: Position,
    reason: str,
    fill_at: Decimal | None = None,
) -> None:
    """Fire an opposite-side market order to flatten one position. Same
    pattern the kill-switch + EOD rollover use: `force_quantity` so the
    close moves exactly the open qty (legacy positions with stale
    lot_size land correctly), and `is_squareoff=True` so the validator's
    hold-time + exit-only gates pass through.

    `fill_at` (optional) is the price the close should book at. For
    SL/TP bracket fires we pass the user's trigger value (`stop_loss`
    or `target`) so the realised close price equals what the user set,
    not the live LTP at the moment the enforcer ticked — eliminates
    the 1-5 point slippage the poll-interval gap used to introduce.
    The matching engine treats this as `expected_price` and clamps it
    to ±1% of live bid/ask anyway, so an absurd value can't sneak
    through; SL/TP triggers by definition fire at the current LTP, so
    they always land well inside that cap."""
    if p.quantity == 0:
        return
    action = OrderAction.SELL if p.quantity > 0 else OrderAction.BUY
    qty = abs(p.quantity)
    lots = max(0.01, qty / max(1, p.instrument.lot_size or 1))
    payload: dict[str, Any] = {
        "token": p.instrument.token,
        "action": action.value,
        "order_type": OrderType.MARKET.value,
        "product_type": p.product_type.value,
        "lots": lots,
        "force_quantity": qty,
        "is_squareoff": True,
        "placed_from": "RISK_ENFORCER",
    }
    if fill_at is not None and fill_at > 0:
        payload["expected_price"] = str(fill_at)
    try:
        await order_service.place_order(user=user, payload=payload)
        # The market order fills synchronously inside place_order — so by
        # the time we return here the position's status has been mutated
        # (see services/position_service.apply_fill). Stamp the
        # user-visible reason so the Closed tab on the app can show
        # "Closed by SL" / "Closed by TP" / "Stop-out".
        await _stamp_close_reason(p.id, _classify_close_reason(reason))
        logger.info(
            "risk_auto_squareoff",
            extra={
                "user_id": str(user.id),
                "position_id": str(p.id),
                "symbol": p.instrument.symbol,
                "reason": reason,
            },
        )
    except Exception:
        logger.exception(
            "risk_auto_squareoff_failed",
            extra={"user_id": str(user.id), "position_id": str(p.id)},
        )


async def _enforce_for_user(user: User) -> None:
    """One sweep for one user."""
    open_positions = await Position.find(
        Position.user_id == user.id, Position.status == PositionStatus.OPEN
    ).to_list()
    if not open_positions:
        # No open exposure → re-arm the warning for the next breach.
        _warning_armed[str(user.id)] = True
        return

    # Parallel LTP fan-out so the 1 s loop tick stays well under
    # budget even with dozens of open positions on a single user.
    # Previously the per-position serial `await get_ltp` here was the
    # main reason we couldn't safely shorten the poll interval —
    # 50 positions × 100 ms = a full 5 s tick consumed before any
    # bracket check even ran.
    unique_tokens = list({p.instrument.token for p in open_positions})
    ltp_results = await asyncio.gather(
        *[market_data_service.get_ltp(tok) for tok in unique_tokens],
        return_exceptions=True,
    )
    ltp_map: dict[str, Any] = {}
    for tok, res in zip(unique_tokens, ltp_results):
        ltp_map[tok] = None if isinstance(res, BaseException) else res

    # Refresh LTP + run bracket SL/TP checks per position. Bracket legs on
    # open positions don't live in the pending-order book, so this is where
    # they fire.
    #
    # Market-closed gate: for Indian equity / F&O (close 15:30 IST) and MCX
    # (close 23:55 IST) we MUST NOT auto-fire SL/TP brackets after close.
    # The cached LTP is whatever the last tick before close was — comparing
    # it against the user's bracket trigger one second later (or hours
    # later) and "filling" the close at that stale price is a phantom
    # execution: there's no exchange, no counterparty, no real fill. The
    # user reported "market closed ho gaya phir bhi mere trade close ho
    # gaya" because the enforcer was happily booking these phantom closes.
    # Forex / crypto / spot commodity stay 24×5 / 24×7, so they get the
    # full bracket evaluation as before.
    from app.utils.time_utils import is_after_close, is_weekend, now_ist

    now_now = now_ist()
    is_weekend_now = is_weekend(now_now.date())

    def _segment_closed(seg: str | None) -> bool:
        if not seg:
            return False
        if is_weekend_now:
            # Indian exchanges + MCX are closed Sat/Sun. is_after_close
            # only handles weekday close-of-day, so OR with a prefix
            # check that covers the full weekend window. Forex (CDS_*)
            # is 24×5 — closed Sat all day, Sun till ~Mon 04:00 IST;
            # we cover that conservatively by NOT including it here so
            # 24×5 instruments still trade Sun evening if open. Crypto
            # is 24×7 and never closes.
            if seg.startswith(("NSE_", "BSE_", "MCX_", "NFO_", "BFO_")):
                return True
        return is_after_close(seg, now_now)

    total_unrealised = Decimal("0")
    bracket_fired_ids: set[str] = set()
    for p in open_positions:
        # ── Market-closed skip ─────────────────────────────────────────
        # Skip the ENTIRE evaluation (LTP refresh, bracket fire, and
        # this position's contribution to the aggregate stop-out loss)
        # when its segment is past close. The cached LTP at this point
        # is whatever the last tick before close was — booking a phantom
        # close at that stale price is what caused the "market closed
        # ho gaya phir bhi mere trade close ho gaya" bug. Re-evaluation
        # resumes on the next tick once the segment reopens.
        seg_for_check = (
            getattr(p, "segment_type", None) or getattr(p.instrument, "segment", None)
        )
        if _segment_closed(str(seg_for_check) if seg_for_check else None):
            # Preserve the position's last-known unrealised P/L on the
            # aggregate so the warning re-arm logic and admin telemetry
            # still see "this user has open exposure" — but DON'T treat
            # any change as actionable.
            try:
                total_unrealised += to_decimal(p.unrealized_pnl)
            except Exception:
                pass
            continue

        ltp = ltp_map.get(p.instrument.token)
        # Reject zero / negative LTPs the same way we reject `None`. A
        # 0 LTP fed to `refresh_unrealized_pnl` would compute floating
        # loss = (0 − avg) × qty = −notional, which the aggregate then
        # mis-reads as a colossal drawdown and force-closes the
        # position even when it's in profit. 21-May 08:11 production
        # incident: COPPER 2500-lot stop-out fired with loss_pct =
        # 9124.17 % because the cached LTP was 0 at scan time.
        ltp_valid = ltp is not None
        if ltp_valid:
            try:
                if to_decimal(ltp) <= 0:
                    ltp_valid = False
            except Exception:
                ltp_valid = False
        if ltp_valid:
            try:
                await position_service.refresh_unrealized_pnl(p, ltp)
            except Exception:
                logger.warning(
                    "risk_pnl_refresh_failed",
                    extra={
                        "user_id": str(user.id),
                        "position_id": str(p.id),
                        "symbol": p.instrument.symbol,
                    },
                )
        else:
            logger.warning(
                "risk_ltp_fetch_failed",
                extra={
                    "user_id": str(user.id),
                    "position_id": str(p.id),
                    "symbol": p.instrument.symbol,
                    "token": p.instrument.token,
                    "has_sl": p.stop_loss is not None,
                    "has_tp": p.target is not None,
                    "raw_ltp": str(ltp) if ltp is not None else None,
                },
            )
            # No usable LTP this tick — preserve the position's last
            # known unrealised P/L on the aggregate but DO NOT add a
            # bogus negative driven by a zero tick. Skip bracket SL/TP
            # checks too; they need a current price to be meaningful.
            try:
                total_unrealised += to_decimal(p.unrealized_pnl)
            except Exception:
                pass
            continue
        try:
            total_unrealised += to_decimal(p.unrealized_pnl)
        except Exception:
            pass

        if p.quantity == 0:
            continue
        try:
            ltp_dec = to_decimal(ltp)
            sl = to_decimal(p.stop_loss) if p.stop_loss is not None else None
            tp = to_decimal(p.target) if p.target is not None else None
            avg = to_decimal(p.avg_price)
        except Exception:
            continue

        # Self-heal legacy wrong-side SL/TP: positions opened before the
        # directional check landed in the validator may carry an SL above
        # entry (long) or a TP below entry (long). Those would auto-fire
        # on the very next tick and instantly square-off the position.
        # Clear the bogus leg instead of triggering — user gets to set a
        # correct one from the edit dialog. Saves silently; no notification.
        cleared = False
        if p.quantity > 0:  # LONG
            if sl is not None and sl > 0 and avg > 0 and sl >= avg:
                p.stop_loss = None
                sl = None
                cleared = True
            if tp is not None and tp > 0 and avg > 0 and tp <= avg:
                p.target = None
                tp = None
                cleared = True
        else:  # SHORT
            if sl is not None and sl > 0 and avg > 0 and sl <= avg:
                p.stop_loss = None
                sl = None
                cleared = True
            if tp is not None and tp > 0 and avg > 0 and tp >= avg:
                p.target = None
                tp = None
                cleared = True
        if cleared:
            try:
                await p.save()
                logger.info(
                    "bracket_wrong_side_self_heal",
                    extra={
                        "user_id": str(user.id),
                        "position_id": str(p.id),
                        "symbol": p.instrument.symbol,
                    },
                )
            except Exception:
                logger.warning("bracket_self_heal_save_failed", extra={"position_id": str(p.id)})

        # Identify the trigger that fired and remember WHICH price the
        # close should book at. The user set `stop_loss` / `target` as
        # an explicit price barrier — they expect the trade to record
        # at THAT price, not at whatever LTP the next risk-enforcer
        # tick happened to read (which can drift several ticks past
        # the trigger between sweeps). Passing the trigger as
        # `fill_at` makes the matching engine use it directly.
        hit_reason: str | None = None
        fill_at: Decimal | None = None
        if p.quantity > 0:  # LONG
            if sl is not None and sl > 0 and ltp_dec <= sl:
                hit_reason = f"bracket_sl_long@{ltp_dec}"
                fill_at = sl
            elif tp is not None and tp > 0 and ltp_dec >= tp:
                hit_reason = f"bracket_tp_long@{ltp_dec}"
                fill_at = tp
        else:  # SHORT
            if sl is not None and sl > 0 and ltp_dec >= sl:
                hit_reason = f"bracket_sl_short@{ltp_dec}"
                fill_at = sl
            elif tp is not None and tp > 0 and ltp_dec <= tp:
                hit_reason = f"bracket_tp_short@{ltp_dec}"
                fill_at = tp

        if hit_reason is not None:
            # ── Cross-worker dedup via atomic Mongo claim ───────────
            # The risk_enforcer_loop runs in every uvicorn worker/instance,
            # and two of them can read the same OPEN position with target
            # set in the same 5 s tick. Without a distributed lock both
            # called _squareoff_position and TWO opposite-side SELL orders
            # landed in the History tab for the same close (the user-
            # reported "limit order me 2 baar execute hua" bug).
            #
            # Fix: race the workers on a `findOneAndUpdate` that clears the
            # bracket leg BEFORE placing the squareoff. Whichever worker's
            # update has a `modified_count > 0` legitimately claimed the
            # fire; the rest will see the leg already cleared and skip.
            # Idempotent: if the fire fails downstream we restore the leg
            # in the except block so the next tick can retry.
            is_sl_fire = "bracket_sl" in hit_reason
            leg_field = "stop_loss" if is_sl_fire else "target"
            try:
                claim_result = await Position.get_motor_collection().update_one(
                    {
                        "_id": p.id,
                        "status": PositionStatus.OPEN.value,
                        leg_field: {"$ne": None},
                    },
                    {"$set": {leg_field: None}},
                )
            except Exception:
                logger.exception("bracket_claim_query_failed", extra={"position_id": str(p.id)})
                continue
            if not claim_result.modified_count:
                # Another worker won the race; nothing to do here.
                logger.info(
                    "bracket_skip_already_claimed",
                    extra={"position_id": str(p.id), "reason": hit_reason},
                )
                continue

            # Snapshot the leg value we just cleared so we can restore it
            # if the squareoff itself blows up.
            restore_value = sl if is_sl_fire else tp
            try:
                await _squareoff_position(user, p, hit_reason, fill_at=fill_at)
                bracket_fired_ids.add(str(p.id))
            except Exception:
                logger.exception(
                    "bracket_squareoff_failed_restoring_leg",
                    extra={"position_id": str(p.id), "reason": hit_reason},
                )
                if restore_value is not None:
                    try:
                        await Position.get_motor_collection().update_one(
                            {"_id": p.id},
                            {"$set": {leg_field: Decimal128(str(restore_value))}},
                        )
                    except Exception:
                        logger.exception(
                            "bracket_leg_restore_failed",
                            extra={"position_id": str(p.id)},
                        )

    # Drop bracket-flattened positions before the stop-out check so we
    # don't double-close them.
    if bracket_fired_ids:
        open_positions = [p for p in open_positions if str(p.id) not in bracket_fired_ids]
        if not open_positions:
            return

    # Risk policy snapshot. `get_effective_risk` walks global → per-user
    # override and returns a flat dict the same way segment-settings does.
    risk = (await netting_service.get_effective_risk(str(user.id)))["settings"]
    warning_pct = float(risk.get("stopOutWarningPercent") or 0)
    stop_pct = float(risk.get("stopOutPercent") or 0)
    if warning_pct <= 0 and stop_pct <= 0:
        # Both knobs off — nothing to enforce, just keep the warning re-armed.
        _warning_armed[str(user.id)] = True
        return

    wallet = await wallet_service.get_or_create(user.id)  # type: ignore[arg-type]
    balance = _wallet_balance(wallet)
    if balance <= 0:
        return  # Can't divide by 0 — wait for a deposit.

    # Estimate the closing-leg brokerage that would be charged if every
    # open position were force-closed right now. Per broker spec the
    # stop-out check looks at floating P&L AFTER deducting close
    # brokerage — so a position that's a hair from break-even still
    # trips stop-out once round-trip costs are folded in. Uses the same
    # netting + brokerage_calculator stack the matching engine runs at
    # fill time, so the estimate matches what will actually be billed.
    from app.models._base import OrderAction as _OA
    from app.services import brokerage_calculator as _bc

    estimated_close_brokerage = Decimal("0")
    for p in open_positions:
        if not p.quantity:
            continue
        try:
            # Closing direction is opposite the position direction.
            close_action = _OA.SELL if p.quantity > 0 else _OA.BUY
            netting = await netting_service.get_effective_settings(
                user.id,
                p.instrument.segment,
                action=close_action.value,
                product_type=p.product_type.value,
                symbol=p.instrument.symbol,
            )
            charges = await _bc.calculate(
                segment_type=p.instrument.segment,
                action=close_action,
                product_type=p.product_type,
                qty=abs(float(p.quantity)),
                price=to_decimal(p.ltp) if p.ltp is not None else to_decimal(p.avg_price),
                lot_size=int(p.instrument.lot_size or 1),
                netting_override=netting.get("settings"),
                is_closing=True,
                charge_on=netting.get("settings", {}).get("charge_on"),
            )
            estimated_close_brokerage += to_decimal(charges.total)
        except Exception:
            # Don't let one bad position kill the whole sweep — just skip
            # its brokerage contribution this tick.
            logger.warning(
                "risk_close_brokerage_estimate_failed",
                extra={"user_id": str(user.id), "position_id": str(p.id)},
            )

    # Bal-protection stop-out semantics.
    #
    #   loss_pct = (floating_loss + estimated_close_brokerage) / bal × 100
    #
    # Where bal = wallet wealth at rest (available + used_margin). This is
    # NOT the CFD "Margin Level" gauge — it's a "% of MAIN BALANCE the user
    # is about to lose" gauge. Fire when loss_pct ≥ stopOutPercent. Keeps
    # the main balance from going negative: at stopOutPercent = 100% the
    # auto-close fires the instant projected loss equals the entire bal,
    # i.e. bal touches zero AT MOST. Setting stopOutPercent below 100%
    # (e.g. 80%) closes positions BEFORE bal is fully wiped — preserving a
    # cushion as the user explicitly asked: "main wallet kabhi negative
    # nahi jana chahiye, stop-out apne se sab close kar de".
    #
    # `balance` already includes credit_limit (see _wallet_balance) so a
    # user with extended credit gets that buffer too — the gauge measures
    # against the total "money the broker has on the line for this user".
    user_id_str = str(user.id)
    floating_loss = (-total_unrealised) if total_unrealised < 0 else Decimal("0")
    projected_loss = floating_loss + estimated_close_brokerage
    loss_pct = (
        float(projected_loss / balance * Decimal(100)) if projected_loss > 0 else 0.0
    )

    # 1) Stop-out — force-close EVERYTHING when projected loss reaches the
    # configured % of main balance. Done before the warning check because
    # hitting stop-out implicitly crossed the warning too.
    if stop_pct > 0 and loss_pct >= stop_pct:
        logger.warning(
            "stop_out_triggered",
            extra={
                "user_id": user_id_str,
                "loss_pct": round(loss_pct, 2),
                "threshold_pct": stop_pct,
                "floating_loss": float(floating_loss),
                "bal": float(balance),
            },
        )
        for p in open_positions:
            await _squareoff_position(
                user,
                p,
                f"stop_out_loss_pct_{loss_pct:.2f}>={stop_pct}",
            )
        _warning_armed[user_id_str] = True
        return

    # 2) Warning — fire once per crossing FROM BELOW. Armed = ready to
    # fire. Once fired we disarm; reset to armed when loss drops back
    # below the warning threshold. `stopOutWarningPercent` is in the
    # same units as `stopOutPercent` (loss % of bal). Set it LOWER than
    # the stop-out value to get an early heads-up (e.g. warning 60%,
    # stop-out 80%).
    armed = _warning_armed.get(user_id_str, True)
    if warning_pct > 0 and loss_pct >= warning_pct:
        if armed:
            await _send_warning(user_id_str, warning_pct, loss_pct)
            _warning_armed[user_id_str] = False
            logger.info(
                "stop_out_warning_sent",
                extra={
                    "user_id": user_id_str,
                    "loss_pct": round(loss_pct, 2),
                    "threshold_pct": warning_pct,
                },
            )
    elif loss_pct < warning_pct:
        _warning_armed[user_id_str] = True


# How many users to enforce concurrently in one batch. Sized so the
# concurrent Mongo fan-out fits comfortably inside `MONGODB_MAX_POOL_SIZE`
# (default 100) — `_enforce_for_user` issues ~3-5 reads per user, so 25
# wide ≈ 75-125 simultaneous ops which the pool can absorb without
# starving HTTP requests sharing the same client. Tune via env later if
# the production pool is bumped — value is module-level for visibility.
_RISK_ENFORCE_BATCH_SIZE = 25


async def _enforce_one_user_safe(uid: Any) -> bool:
    """Run one user's risk sweep with full per-user error isolation.

    Returns ``True`` iff the user was found and ``_enforce_for_user``
    completed without raising. Identical contract to the body of the
    original serial loop's iteration — same `User.get` lookup, same
    None-skip, same exception swallow + ``risk_enforcer_user_failed``
    log line — just packaged so we can run many at once.
    """
    try:
        user = await User.get(uid)
        if user is None:
            return False
        await _enforce_for_user(user)
        return True
    except Exception:
        logger.exception("risk_enforcer_user_failed", extra={"user_id": str(uid)})
        return False


async def enforce_once() -> int:
    """One full sweep across every user with open positions. Returns the
    count of users processed (useful for liveness telemetry).

    Users are processed in concurrent batches of
    ``_RISK_ENFORCE_BATCH_SIZE`` so a single tick's wall-clock cost
    scales with ``ceil(N / batch_size)`` rather than ``N`` itself. The
    per-user enforcement (``_enforce_for_user``) is unchanged — only the
    outer scheduling moved from serial to batched-concurrent. Mongo
    pool capacity is the natural ceiling on batch width; see the
    constant above for the sizing rationale.
    """
    user_ids = await Position.distinct("user_id", {"status": PositionStatus.OPEN.value})
    if not user_ids:
        return 0
    count = 0
    batch_size = max(1, _RISK_ENFORCE_BATCH_SIZE)
    for i in range(0, len(user_ids), batch_size):
        chunk = user_ids[i : i + batch_size]
        # ``_enforce_one_user_safe`` never raises, so plain gather is
        # safe — but keep ``return_exceptions=True`` as a defensive
        # belt-and-braces against a future refactor letting an
        # exception slip through.
        results = await asyncio.gather(
            *(_enforce_one_user_safe(uid) for uid in chunk),
            return_exceptions=True,
        )
        for r in results:
            if r is True:
                count += 1
    return count


# Hard lower bound on inter-tick sleep. Even if a single tick somehow
# takes longer than `interval_sec`, we still yield this much so we
# never hot-spin and starve the event loop. 50 ms is short enough that
# the 250 ms cadence is preserved when ticks run on time, but long
# enough to keep the worker responsive to other coroutines if
# something goes wrong (network blip on Mongo, Redis hiccup, etc).
_MIN_TICK_GAP_SEC = 0.05


async def risk_enforcer_loop(interval_sec: float = 0.25) -> None:
    """Background loop launched from the FastAPI lifespan.

    250 ms cadence — four sweeps per second — so an SL/TP bracket or
    a stop-out threshold breach is caught within ~quarter of a second
    of the price crossing it, instead of the old 5-s gap that let
    LTP drift several ticks past the trigger before the close booked.

    Per-tick cost is small by design:
      • `enforce_once` issues ONE indexed Mongo `distinct` to find
        users with open positions.
      • `_enforce_for_user` parallelises every LTP lookup, and reads
        wallet + risk policy from Redis-backed cache.
      • `refresh_unrealized_pnl` is in-memory — no Mongo write per
        tick. Saves only happen when something actually fires
        (close, self-heal).
      • Bracket fires are idempotent (closed positions filter out of
        the next sweep) and the squareoff path uses an atomic Mongo
        claim to dedup across workers / leader handoffs.

    Drift-corrected sleep: we measure how long the tick took and
    sleep for the REMAINDER of the interval, not a fixed slice. So
    an 80-ms tick is followed by a 170-ms sleep — keeping the real
    cadence locked at `interval_sec` regardless of load, instead of
    compounding to 330 ms per tick the way a fixed sleep would.

    Overrun warning: if a tick exceeds the interval we log it once
    at WARNING (`risk_enforcer_tick_overrun`). That's the operator
    signal to either bump the interval or scale workers — we still
    complete the tick (no skip), but the user is told the risk loop
    is falling behind so they can act on it.
    """
    global _running
    if _running:
        return
    _running = True
    logger.info("risk_enforcer_started", extra={"interval_sec": interval_sec})
    try:
        loop = asyncio.get_event_loop()
        while _running:
            t0 = loop.time()
            try:
                await enforce_once()
            except Exception:
                logger.exception("risk_enforcer_tick_failed")
            elapsed = loop.time() - t0
            if elapsed > interval_sec:
                logger.warning(
                    "risk_enforcer_tick_overrun",
                    extra={
                        "elapsed_sec": round(elapsed, 3),
                        "interval_sec": interval_sec,
                    },
                )
            sleep_for = max(_MIN_TICK_GAP_SEC, interval_sec - elapsed)
            await asyncio.sleep(sleep_for)
    finally:
        _running = False
        logger.info("risk_enforcer_stopped")


def stop_risk_enforcer() -> None:
    global _running
    _running = False
