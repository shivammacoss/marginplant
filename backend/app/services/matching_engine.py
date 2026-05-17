"""Internal B-Book matching engine.

For market orders we fill immediately at the current LTP.
For limit / SL / SL-M orders, the order is parked OPEN — a background
poller (Phase 4 Celery) walks pending orders and fills any whose conditions
are met. This file ships the **immediate-fill** path used by `order_service`.

CRITICAL: orders are NEVER routed to an external exchange.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
from decimal import Decimal
from typing import Any

from beanie import PydanticObjectId
from bson import Decimal128

from app.models._base import OrderAction, OrderType
from app.models.order import Order, OrderStatus
from app.models.trade import Trade
from app.services import (
    brokerage_calculator,
    market_data_service,
    netting_service,
    position_service,
    wallet_service,
)
from app.utils.decimal_utils import quantize_money, to_decimal
from app.utils.time_utils import now_utc

logger = logging.getLogger(__name__)


def _trade_number() -> str:
    return f"T{now_utc().strftime('%y%m%d')}{secrets.token_hex(4).upper()}"


async def execute_market_order(
    order: Order,
    *,
    cached_ltp: Decimal | None = None,
    cached_netting: dict[str, Any] | None = None,
    expected_price: Decimal | None = None,
) -> Trade:
    """Immediately fill a MARKET order, generate a Trade, update positions/
    holdings, debit charges + (settle PnL if closing).

    Fill-price selection (in priority order):

      1. ``expected_price`` — the BUY (ask) or SELL (bid) value the user saw
         on the order panel when they clicked. This is what makes ENTRY
         match the displayed price exactly. Capped at ±1% from the current
         bid/ask to prevent a tampered client from booking off-market.
      2. Live ask (for BUY) / bid (for SELL) — the broker's bid-ask spread.
      3. LTP — last resort fallback, used when bid/ask are missing (mock
         feed, off-hours).

    Performance: accepts ``cached_ltp`` and ``cached_netting`` from the
    validator to eliminate duplicate fetches. All independent DB writes
    are batched with ``asyncio.gather`` to minimise round-trips.
    """
    from app.models.position import Position, PositionStatus
    from app.models.transaction import TransactionType

    ltp = cached_ltp if cached_ltp is not None else await market_data_service.get_ltp(order.instrument.token)

    fill_price = ltp
    bid: Decimal | None = None
    ask: Decimal | None = None
    try:
        quote = await market_data_service.get_quote(order.instrument.token)
        bid_raw = quote.get("bid")
        ask_raw = quote.get("ask")
        bid = to_decimal(bid_raw) if bid_raw not in (None, 0, "0") else None
        ask = to_decimal(ask_raw) if ask_raw not in (None, 0, "0") else None
    except Exception:
        logger.exception("matching_engine_quote_fetch_failed")

    # Choose the live close-side price for this action.
    live_side: Decimal | None
    if order.action == OrderAction.BUY:
        live_side = ask if (ask is not None and ask > 0) else None
    else:
        live_side = bid if (bid is not None and bid > 0) else None

    # Prefer the client-supplied expected price when it's within 1% of the
    # current live side — that keeps ENTRY identical to what the order
    # panel was showing, and the cap blocks any browser-side tampering.
    SLIPPAGE_CAP = Decimal("0.01")  # 1 %
    if expected_price is not None and expected_price > 0:
        reference = live_side or ltp
        if reference and reference > 0:
            deviation = abs(expected_price - reference) / reference
            if deviation <= SLIPPAGE_CAP:
                fill_price = expected_price
            else:
                fill_price = live_side or ltp
                logger.warning(
                    "matching_engine_expected_price_outside_cap",
                    extra={
                        "expected": str(expected_price),
                        "reference": str(reference),
                        "deviation_pct": float(deviation) * 100,
                    },
                )
        else:
            fill_price = expected_price
    elif live_side is not None:
        fill_price = live_side
    # else: keep ltp fallback

    fill_price = quantize_money(fill_price)
    ltp = fill_price  # downstream uses `ltp` as the executed price

    # ── Netting settings (reuse from validator when available) ────────
    if cached_netting is not None:
        netting_resolved = cached_netting
    else:
        instr_ref = order.instrument
        option_type = None
        if "OPTION" in (instr_ref.segment or "").upper():
            sym = (instr_ref.symbol or "").upper()
            if sym.endswith("CE"):
                option_type = "CE"
            elif sym.endswith("PE"):
                option_type = "PE"
        netting_resolved = await netting_service.get_effective_settings(
            order.user_id,
            instr_ref.segment,
            action=order.action.value if hasattr(order.action, "value") else str(order.action),
            option_type=option_type,
            product_type=order.product_type.value if hasattr(order.product_type, "value") else str(order.product_type),
            symbol=instr_ref.symbol,
        )

    # ── Existing-position lookup first (needed to classify the fill as
    #    opening vs closing — `charge_on` gates brokerage on one or both).
    existing_pos = await Position.find_one(
        Position.user_id == order.user_id,
        Position.instrument.token == order.instrument.token,
        Position.product_type == order.product_type,
        Position.status == PositionStatus.OPEN,
    )
    old_pos_margin = to_decimal(existing_pos.margin_used) if existing_pos else Decimal(0)

    # Classify: this fill is "closing" if it pushes the position toward 0
    # (BUY against a short, SELL against a long). A fresh open or same-side
    # pyramid is "opening". Partial-close / flip cases still count as
    # closing for brokerage gating — the position service realizes the
    # closed portion separately, and the admin's `charge_on` is per-leg
    # not per-share. Without an existing position the fill is always
    # opening (you can't close what you don't have).
    is_closing = False
    if existing_pos is not None:
        cur_qty = to_decimal(existing_pos.quantity)
        if cur_qty > 0 and order.action == OrderAction.SELL:
            is_closing = True
        elif cur_qty < 0 and order.action == OrderAction.BUY:
            is_closing = True

    charge_on = (
        netting_resolved.get("settings", {}).get("charge_on")
        if netting_resolved
        else None
    )
    charges = await brokerage_calculator.calculate(
        segment_type=order.instrument.segment,
        action=order.action,
        product_type=order.product_type,
        qty=order.quantity,
        price=ltp,
        lot_size=order.instrument.lot_size,
        netting_override=netting_resolved.get("settings"),
        is_closing=is_closing,
        charge_on=charge_on,
    )

    # ── Build Trade + update Order (CPU, no I/O) ─────────────────────
    qty_dec = to_decimal(order.quantity)
    notional = quantize_money(ltp * qty_dec)

    # Compute realized P&L in INR for closing legs and freeze it on the
    # trade row. Uses the existing position's avg_price, the fill price,
    # and the USD/INR rate as of NOW (snapshotted — never recomputed).
    # Closing-leg brokerage is folded in here so the History tab's P&L
    # column shows the user's true net cost (raw P&L − close brokerage),
    # matching the user's mental model "close brokerage 20 + P&L −20 →
    # total loss −40". Opening fills leave pnl_inr = None.
    pnl_inr_dec: Decimal | None = None
    if is_closing and existing_pos is not None:
        cur_qty = to_decimal(existing_pos.quantity)
        avg = to_decimal(existing_pos.avg_price)
        closed_qty = min(abs(cur_qty), qty_dec)
        sign = Decimal(1) if cur_qty > 0 else Decimal(-1)
        raw_realized = (ltp - avg) * closed_qty * sign
        if market_data_service.is_usd_quoted_segment(order.instrument.segment):
            fx = to_decimal(market_data_service.get_usd_inr_rate())
            raw_realized = raw_realized * fx
        pnl_inr_dec = quantize_money(raw_realized - to_decimal(charges.brokerage))

    trade = Trade(
        trade_number=_trade_number(),
        order_id=order.id,  # type: ignore[arg-type]
        user_id=order.user_id,
        instrument=order.instrument,
        action=order.action,
        product_type=order.product_type,
        quantity=order.quantity,
        price=Decimal128(str(ltp)),
        value=Decimal128(str(notional)),
        brokerage=Decimal128(str(charges.brokerage)),
        total_charges=Decimal128(str(charges.total)),
        net_amount=Decimal128(
            str(quantize_money(notional + (charges.total if order.action == OrderAction.SELL else -charges.total)))
        ),
        pnl_inr=Decimal128(str(pnl_inr_dec)) if pnl_inr_dec is not None else None,
    )
    order.filled_quantity += order.quantity
    order.pending_quantity = max(0, order.quantity - order.filled_quantity)
    order.average_price = Decimal128(str(ltp))
    order.brokerage = Decimal128(str(charges.brokerage))
    order.other_charges = Decimal128(
        str(quantize_money(charges.total - charges.brokerage))
    )
    order.status = OrderStatus.EXECUTED
    order.executed_at = now_utc()

    # ── Persist trade + order in parallel (independent writes) ────────
    await asyncio.gather(trade.insert(), order.save())

    # ── Update position ──────────────────────────────────────────────
    sl_dec = to_decimal(order.bracket_stop_loss) if order.bracket_stop_loss is not None else None
    tp_dec = to_decimal(order.bracket_target) if order.bracket_target is not None else None
    pos = await position_service.apply_fill(
        user_id=order.user_id,
        instrument=order.instrument,
        segment_type=order.instrument.segment,
        action=order.action,
        product_type=order.product_type,
        quantity=order.quantity,
        price=ltp,
        margin_used=to_decimal(order.margin_blocked),
        stop_loss=sl_dec,
        target=tp_dec,
    )

    # ── Wallet adjustments — B-book / CFD model ──────────────────────
    # In a B-book broker the user never actually receives the notional
    # value of the underlying asset on a SELL — they only realize the
    # price-difference P&L on close. So the wallet only moves by:
    #   • margin block on open (handled inside position_service.apply_fill
    #     via wallet_service.block_margin when margin_used grows)
    #   • margin release on close (when margin_used shrinks)
    #   • charges (brokerage + taxes, always a debit)
    #   • realized P&L (signed: + on profit, − on loss; ONLY on closing legs)
    #
    # The previous version unconditionally credited `ltp × quantity` on
    # every SELL order, which (a) was the wrong economic model for a
    # B-book broker and (b) credited USD notional as INR on USD-quoted
    # instruments like BTCUSD/XAUUSD — that's the bug that ballooned
    # wallets by the underlying's notional on every open-SELL.
    new_pos_margin = to_decimal(pos.margin_used)
    freed_margin = old_pos_margin - new_pos_margin
    if freed_margin > 0:
        await wallet_service.release_margin(order.user_id, freed_margin)

    await wallet_service.adjust(
        order.user_id,
        -charges.total,
        transaction_type=TransactionType.CHARGES,
        narration=f"Charges for {order.action.value} {order.instrument.symbol} x{order.quantity}",
        reference_type="ORDER",
        reference_id=str(order.id),
    )

    # Realized P&L (signed, INR, already FX-converted for USD segments
    # at line ~200) — credited on closing fills only. `pnl_inr_dec` was
    # computed earlier from (close_price − avg_price) × closed_qty × side
    # − closing brokerage, so a positive number means profit and a
    # negative number means loss.
    if pnl_inr_dec is not None and pnl_inr_dec != 0:
        await wallet_service.adjust(
            order.user_id,
            pnl_inr_dec,
            transaction_type=TransactionType.PNL,
            narration=(
                f"Realized {'profit' if pnl_inr_dec > 0 else 'loss'} "
                f"on {order.instrument.symbol} close"
            ),
            reference_type="ORDER",
            reference_id=str(order.id),
        )

    return trade


async def cancel_order(order: Order, *, reason: str | None = None) -> Order:
    if order.status not in (OrderStatus.PENDING, OrderStatus.OPEN, OrderStatus.PARTIAL):
        return order
    order.status = OrderStatus.CANCELLED
    order.cancelled_at = now_utc()
    order.rejection_reason = reason
    await order.save()
    # Release any margin that had been blocked
    if to_decimal(order.margin_blocked) > 0:
        await wallet_service.release_margin(order.user_id, to_decimal(order.margin_blocked))
    return order


# ── Pending-order poller ─────────────────────────────────────────────
# Walks every parked LIMIT / SL-M order every tick and fires the ones whose
# trigger condition is met. Started once from the FastAPI lifespan.

_poller_running: bool = False


def _should_fill(order_type: OrderType, action: OrderAction, ltp: Decimal,
                 limit_price: Decimal, trigger_price: Decimal) -> bool:
    """LIMIT BUY  fills when LTP ≤ limit  (we get our price or better)
       LIMIT SELL fills when LTP ≥ limit
       SL-M  BUY  fills when LTP ≥ trigger (stop-buy / break-out)
       SL-M  SELL fills when LTP ≤ trigger (stop-loss exit)"""
    if order_type == OrderType.LIMIT:
        if limit_price <= 0:
            return False
        if action == OrderAction.BUY:
            return ltp <= limit_price
        return ltp >= limit_price
    if order_type == OrderType.SL_M:
        if trigger_price <= 0:
            return False
        if action == OrderAction.BUY:
            return ltp >= trigger_price
        return ltp <= trigger_price
    return False


async def trigger_pending_orders() -> int:
    """One pass over all OPEN/PARTIAL non-MARKET orders. Returns how many
    orders fired this pass. Logs but never raises — a single bad order
    must not stop the others.

    Fill-price contract: when a LIMIT order's trigger is met the trade
    books at the LIMIT price (what the user typed), not at the LTP that
    the poller happened to read at fire time. Same for SL-M: fills at
    the user's TRIGGER price. Previously this path called
    `execute_market_order(o)` with no `expected_price`, so the engine
    picked up bid/ask/LTP and the realised fill drifted away from the
    user's order — e.g. a BUY LIMIT at 79222 used to record at the
    LTP-of-the-moment (which after a fast tick down could be 79215, a
    7-rupee discrepancy the user noticed in the Orders tab). Passing
    `expected_price = limit_or_trigger` makes the engine use that value
    directly. The engine still clamps to ±1% of live bid/ask as an
    anti-tamper guard, but `_should_fill` only allows fires once LTP
    has crossed the user's price, so the limit/trigger is always well
    inside that cap by definition.
    """
    triggered = 0
    try:
        rows = await Order.find(
            {
                "status": {"$in": [OrderStatus.OPEN.value, OrderStatus.PARTIAL.value]},
                "order_type": {"$in": [OrderType.LIMIT.value, OrderType.SL_M.value]},
            }
        ).to_list()
    except Exception:
        logger.exception("pending_order_scan_failed")
        return 0

    if not rows:
        return 0

    # Parallel LTP fan-out for every distinct token touched by the
    # pending book. Serial `await get_ltp` per row capped the poller's
    # throughput at ~N×100ms — with the user-side limit book sitting
    # at 50+ open orders the 1.5 s interval was eating itself before
    # the last row's fetch even returned. Dedup by token because
    # several limits on the same symbol share an LTP.
    unique_tokens = list({o.instrument.token for o in rows})
    ltp_results = await asyncio.gather(
        *[market_data_service.get_ltp(tok) for tok in unique_tokens],
        return_exceptions=True,
    )
    ltp_map: dict[str, Decimal | None] = {}
    for tok, res in zip(unique_tokens, ltp_results):
        if isinstance(res, BaseException):
            ltp_map[tok] = None
        else:
            try:
                ltp_map[tok] = to_decimal(res)
            except Exception:
                ltp_map[tok] = None

    # Cross-worker dedup. The poller runs in every uvicorn worker — without
    # a distributed claim, two workers reading the same OPEN limit order in
    # the same 1.5 s tick both called `execute_market_order` and TWO trades
    # landed in History for the same fire (the user-reported "limit order
    # 2 baar execute hua" bug). Redis SETNX with a 10 s TTL is enough: only
    # the first worker to claim the order_id key proceeds; the rest skip.
    from app.core.redis_client import idempotency_check_and_set

    for o in rows:
        try:
            ltp = ltp_map.get(o.instrument.token)
            if ltp is None:
                continue
            limit_price = to_decimal(o.price)
            trigger_price = to_decimal(o.trigger_price)
            if not _should_fill(o.order_type, o.action, ltp, limit_price, trigger_price):
                continue
            # Lock the fill at the user's specified price. LIMIT books
            # at `o.price`; SL-M books at `o.trigger_price`.
            if o.order_type == OrderType.LIMIT and limit_price > 0:
                fill_at = limit_price
            elif o.order_type == OrderType.SL_M and trigger_price > 0:
                fill_at = trigger_price
            else:
                fill_at = None

            # Atomic claim. TTL is generously sized vs the expected
            # execute_market_order latency (~50-200 ms) so the key only
            # outlives a real fire long enough to swallow a duplicate from
            # a concurrent worker — never long enough to block a legitimate
            # retry after a crash.
            claim_key = f"pending_fire:{o.id}"
            try:
                claimed = await idempotency_check_and_set(claim_key, ttl_sec=10)
            except Exception:
                logger.exception("pending_fire_claim_failed", extra={"order_id": str(o.id)})
                claimed = False
            if not claimed:
                logger.info(
                    "pending_order_skip_already_claimed",
                    extra={"order_id": str(o.id), "symbol": o.instrument.symbol},
                )
                continue

            await execute_market_order(o, cached_ltp=ltp, expected_price=fill_at)
            triggered += 1
        except Exception:
            logger.exception(
                "pending_order_trigger_failed",
                extra={"order_id": str(o.id), "symbol": o.instrument.symbol},
            )
    return triggered


async def pending_order_poller(interval_sec: float = 1.5) -> None:
    """Background loop launched from the lifespan. Idempotent — second call
    returns immediately."""
    global _poller_running
    if _poller_running:
        return
    _poller_running = True
    logger.info("pending_order_poller_started", extra={"interval_sec": interval_sec})
    try:
        import asyncio as _asyncio
        while _poller_running:
            n = await trigger_pending_orders()
            if n:
                logger.info("pending_orders_triggered", extra={"count": n})
            await _asyncio.sleep(interval_sec)
    finally:
        _poller_running = False
        logger.info("pending_order_poller_stopped")


def stop_pending_order_poller() -> None:
    global _poller_running
    _poller_running = False
