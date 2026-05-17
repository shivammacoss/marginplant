"""Position + Holding maintenance.

Called by the matching engine on each fill: updates the user's open Position
(or closes one out), maintains the per-(user,segment,instrument) tracker,
and for CNC trades writes/updates the long-term Holding record.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from beanie import PydanticObjectId
from bson import Decimal128

from app.models._base import OrderAction, ProductType
from app.models.holding import Holding
from app.models.order import InstrumentRef
from app.models.position import Position, PositionStatus, UserPositionTracker
from app.utils.decimal_utils import (
    ZERO,
    add,
    quantize_money,
    sub,
    to_decimal,
    to_decimal128,
)
from app.utils.time_utils import now_utc


async def apply_fill(
    *,
    user_id: PydanticObjectId,
    instrument: InstrumentRef,
    segment_type: str,
    action: OrderAction,
    product_type: ProductType,
    quantity: float,
    price: Decimal,
    margin_used: Decimal,
    stop_loss: Decimal | None = None,
    target: Decimal | None = None,
) -> Position:
    """Idempotent-ish: looks up an open position for this instrument+product
    and merges. For opposite-side fills it reduces and may close out."""
    pos = await Position.find_one(
        Position.user_id == user_id,
        Position.instrument.token == instrument.token,  # type: ignore[union-attr]
        Position.product_type == product_type,
        Position.status == PositionStatus.OPEN,
    )

    signed_qty = quantity if action == OrderAction.BUY else -quantity

    # Capture the prevailing USD/INR rate at the moment of fill — used later
    # to convert P&L on USD-quoted instruments (BTCUSD, EURUSD, …) into INR.
    # ``None`` for instruments already priced in INR.
    from app.services.market_data_service import get_usd_inr_rate, is_usd_quoted_segment

    open_fx_rate = (
        Decimal128(str(round(get_usd_inr_rate(), 4)))
        if is_usd_quoted_segment(segment_type) or is_usd_quoted_segment(instrument.segment)
        else None
    )

    if pos is None:
        pos = Position(
            user_id=user_id,
            instrument=instrument,
            segment_type=segment_type,
            product_type=product_type,
            quantity=signed_qty,
            # Stamp the side at open so the Closed-tab card knows whether
            # the user originally went long or short, even after quantity
            # is reduced to 0 by the closing leg.
            opened_side=action,
            opening_quantity=abs(signed_qty),
            avg_price=Decimal128(str(price)),
            ltp=Decimal128(str(price)),
            margin_used=Decimal128(str(margin_used)),
            stop_loss=Decimal128(str(stop_loss)) if stop_loss is not None else None,
            target=Decimal128(str(target)) if target is not None else None,
            open_usd_inr_rate=open_fx_rate,
            opened_at=now_utc(),
            status=PositionStatus.OPEN,
        )
        await pos.insert()
    else:
        cur_qty = pos.quantity
        new_qty = cur_qty + signed_qty
        cur_avg = to_decimal(pos.avg_price)

        # The position's `margin_used` represents how much wallet margin is
        # currently locked against this position. It must scale with
        # |quantity|, NOT just accumulate on every fill — otherwise SELL
        # legs that close a long add margin on top of the BUY margin instead
        # of releasing it, and the field grows by ~2× per round-trip cycle.
        # We compute the new margin_used below based on what kind of fill
        # this is, then assign it in one place.
        new_margin_used: Decimal | None = None

        # Whether the new order's bracket SL/TP should overwrite what's on
        # the position. Only the SAME-direction paths (fresh re-open after
        # close, same-side pyramid, or the new-direction half of a flip)
        # carry SL/TP that make sense for the surviving position. A
        # closing leg's bracket is for THAT closing trade — applying it
        # to the (still-open) original-direction position puts the SL/TP
        # on the wrong side of avg_price, which the risk-enforcer's
        # self-heal then clears the next tick. That's the
        # "SL/TP set kiya par position se gayab ho gaya" symptom.
        apply_brackets = False
        if cur_qty == 0:
            # Previously closed position being reopened on this fill.
            pos.avg_price = Decimal128(str(price))
            pos.quantity = signed_qty
            # Reopen — reset the recorded opening side to the new direction.
            pos.opened_side = action
            pos.opening_quantity = abs(signed_qty)
            new_margin_used = to_decimal(margin_used)
            apply_brackets = True
        elif (cur_qty > 0 and signed_qty > 0) or (cur_qty < 0 and signed_qty < 0):
            # Same side (pyramiding): weighted avg, ADD the new leg's margin.
            total = to_decimal(abs(cur_qty) + abs(signed_qty))
            pos.avg_price = Decimal128(
                str(quantize_money((cur_avg * to_decimal(abs(cur_qty)) + price * to_decimal(abs(signed_qty))) / total))
            )
            pos.quantity = new_qty
            pos.opening_quantity = max(float(pos.opening_quantity or 0), abs(new_qty))
            new_margin_used = to_decimal(pos.margin_used) + to_decimal(margin_used)
            apply_brackets = True
        else:
            # Opposite side: realize PnL on the closed portion + release
            # margin proportional to how much of the original was closed.
            closed_qty = min(abs(cur_qty), abs(signed_qty))
            sign = 1 if cur_qty > 0 else -1
            realized = (price - cur_avg) * to_decimal(closed_qty) * sign
            pos.realized_pnl = Decimal128(str(quantize_money(to_decimal(pos.realized_pnl) + realized)))
            pos.quantity = new_qty
            if new_qty == 0:
                # Fully closed: all locked margin against this position is freed.
                pos.status = PositionStatus.CLOSED
                pos.closed_at = now_utc()
                if pos.open_usd_inr_rate is not None and pos.close_usd_inr_rate is None:
                    pos.close_usd_inr_rate = Decimal128(str(round(get_usd_inr_rate(), 4)))
                new_margin_used = to_decimal(0)
                # Position is closing — clear any SL/TP that were on it so a
                # later re-open on the same instrument doesn't inherit stale
                # brackets from a long-gone direction. `apply_brackets` stays
                # False; the closing order's own bracket is meaningless here.
                pos.stop_loss = None
                pos.target = None
            elif (cur_qty > 0 and new_qty < 0) or (cur_qty < 0 and new_qty > 0):
                # Flipped sides — the closing leg fully cleared the original
                # direction; whatever of `signed_qty` remained opened a new
                # opposite position. Margin = the portion of the new order
                # margin that backs the remaining qty.
                pos.avg_price = Decimal128(str(price))
                # Flip — record the new active direction so the Closed-tab
                # card (and anyone else reading `opened_side`) reflects the
                # surviving leg, not the one that was just flattened.
                pos.opened_side = action
                pos.opening_quantity = abs(new_qty)
                if open_fx_rate is not None:
                    pos.open_usd_inr_rate = open_fx_rate
                flip_ratio = to_decimal(abs(new_qty)) / to_decimal(abs(signed_qty))
                new_margin_used = to_decimal(margin_used) * flip_ratio
                # Direction flipped — old SL/TP were positioned for the OLD
                # direction (e.g. SL above entry for a SHORT). On the new
                # opposite-side position they'd be on the wrong side of the
                # new avg and self-heal would clear them anyway. Wipe up
                # front so the bracket from THIS order (if any) cleanly
                # replaces them via apply_brackets below.
                pos.stop_loss = None
                pos.target = None
                apply_brackets = True
            else:
                # Partial close on same side: scale the existing margin down
                # to the remaining quantity ratio. (The SELL order itself
                # doesn't add new locked margin — it releases existing.)
                scale = to_decimal(abs(new_qty)) / to_decimal(abs(cur_qty))
                new_margin_used = to_decimal(pos.margin_used) * scale
                # apply_brackets stays False — the surviving position is in
                # its original direction with its original avg, so existing
                # SL/TP remain valid (if any). The closing order's bracket
                # was sized for the closing direction and would land on the
                # wrong side if we wrote it onto the surviving position.

        pos.ltp = Decimal128(str(price))
        if new_margin_used is not None:
            # Floor at 0 so accumulated rounding can't drive it negative.
            if new_margin_used < 0:
                new_margin_used = to_decimal(0)
            pos.margin_used = Decimal128(str(quantize_money(new_margin_used)))
        # Carry over SL/TP from the originating Order ONLY on paths where
        # the new order opens / extends exposure in the surviving
        # position's direction (see apply_brackets logic above). Latest
        # bracket wins over the existing one — matches Zerodha's behaviour
        # so the user can update bracket SL/TP by placing a fresh order.
        if apply_brackets:
            if stop_loss is not None:
                pos.stop_loss = Decimal128(str(stop_loss))
            if target is not None:
                pos.target = Decimal128(str(target))
        await pos.save()

    # Tracker
    await _bump_tracker(
        user_id=user_id,
        segment_type=segment_type,
        token=instrument.token,
        product_type=product_type,
        delta_lots=quantity / max(1, instrument.lot_size),
        delta_margin=margin_used,
        signed_qty=signed_qty,
    )

    # CNC also updates long-term Holding
    if product_type == ProductType.CNC:
        await _apply_holding(
            user_id=user_id,
            instrument=instrument,
            action=action,
            quantity=quantity,
            price=price,
        )

    # Notify admin dashboards — every fill (matching-engine market fill,
    # SL/TP hit, user squareoff, admin force-close) routes through here
    # so one publish at the bottom of `apply_fill` covers all of them.
    # Fire-and-forget; failures are swallowed inside `publish_admin_event`.
    try:
        from app.services.admin_events import publish_admin_event

        await publish_admin_event(
            "position_update",
            {
                "event": "fill",
                "user_id": str(user_id),
                "position_id": str(pos.id),
                "status": pos.status.value,
            },
        )
    except Exception:  # pragma: no cover
        pass

    return pos


async def _bump_tracker(
    *,
    user_id: PydanticObjectId,
    segment_type: str,
    token: str,
    product_type: ProductType,
    delta_lots: float,
    delta_margin: Decimal,
    signed_qty: float,
) -> None:
    t = await UserPositionTracker.find_one(
        UserPositionTracker.user_id == user_id,
        UserPositionTracker.segment_type == segment_type,
        UserPositionTracker.instrument_token == token,
    )
    if t is None:
        t = UserPositionTracker(
            user_id=user_id, segment_type=segment_type, instrument_token=token
        )
    if product_type == ProductType.MIS:
        t.intraday_lots = max(0.0, t.intraday_lots + (delta_lots if signed_qty > 0 else -delta_lots))
    else:
        t.holding_lots = max(0.0, t.holding_lots + (delta_lots if signed_qty > 0 else -delta_lots))
    t.total_lots = abs(t.intraday_lots) + abs(t.holding_lots)
    t.margin_blocked = to_decimal128(add(t.margin_blocked, delta_margin))
    await t.save()


async def _apply_holding(
    *,
    user_id: PydanticObjectId,
    instrument: InstrumentRef,
    action: OrderAction,
    quantity: float,
    price: Decimal,
) -> None:
    h = await Holding.find_one(
        Holding.user_id == user_id, Holding.instrument.token == instrument.token  # type: ignore[union-attr]
    )
    qty_dec = to_decimal(quantity)
    if h is None:
        if action == OrderAction.BUY:
            h = Holding(
                user_id=user_id,
                instrument=instrument,
                quantity=quantity,
                avg_price=Decimal128(str(price)),
                ltp=Decimal128(str(price)),
                invested_value=Decimal128(str(quantize_money(price * qty_dec))),
                current_value=Decimal128(str(quantize_money(price * qty_dec))),
            )
            await h.insert()
        return

    if action == OrderAction.BUY:
        new_qty = h.quantity + quantity
        denom = to_decimal(max(1.0, new_qty))
        new_avg = quantize_money(
            (to_decimal(h.avg_price) * to_decimal(h.quantity) + price * qty_dec) / denom
        )
        h.quantity = new_qty
        h.avg_price = Decimal128(str(new_avg))
    else:
        # SELL — reduce
        h.quantity = max(0.0, h.quantity - quantity)

    h.ltp = Decimal128(str(price))
    h.invested_value = Decimal128(
        str(quantize_money(to_decimal(h.avg_price) * to_decimal(h.quantity)))
    )
    h.current_value = Decimal128(
        str(quantize_money(to_decimal(h.ltp) * to_decimal(h.quantity)))
    )
    pnl = sub(h.current_value, h.invested_value)
    h.pnl = Decimal128(str(pnl))
    invested = to_decimal(h.invested_value)
    h.pnl_percentage = float((pnl / invested) * 100) if invested > ZERO else 0.0
    if h.quantity == 0:
        await h.delete()
    else:
        await h.save()


async def list_open(user_id: str | PydanticObjectId) -> list[Position]:
    return await Position.find(
        Position.user_id == PydanticObjectId(user_id), Position.status == PositionStatus.OPEN
    ).to_list()


async def list_closed_today(user_id: str | PydanticObjectId) -> list[Position]:
    """Closed positions blotter — returns the most recent 200 closes,
    newest first. Previously filtered by `closed_at >= IST midnight`
    which silently hid positions closed yesterday or earlier, so the
    Closed tab rendered empty for traders who hadn't closed anything
    today. We keep the legacy name to avoid touching every caller,
    but the implementation is now date-agnostic.

    A trader who actively wants only "today" already has the dashboard
    Today's P&L cards + the realized window on /reports/pnl, so
    surfacing ALL closes here is the more useful default.
    """
    return await (
        Position.find(
            Position.user_id == PydanticObjectId(user_id),
            Position.status == PositionStatus.CLOSED,
        )
        .sort("-closed_at")
        .limit(200)
        .to_list()
    )


async def refresh_unrealized_pnl(position: Position, ltp: Decimal) -> Position:
    position.ltp = Decimal128(str(ltp))
    pnl = (ltp - to_decimal(position.avg_price)) * to_decimal(position.quantity)
    position.unrealized_pnl = Decimal128(str(quantize_money(pnl)))
    return position


async def list_holdings(user_id: str | PydanticObjectId) -> list[Holding]:
    return await Holding.find(Holding.user_id == PydanticObjectId(user_id)).to_list()


# ── Intraday → carryforward auto-rollover ───────────────────────────
async def convert_intraday_to_carry(segment_set: frozenset[str] | set[str]) -> dict[str, int]:
    """At market close for a segment group, flip every open MIS position in
    that group to NRML. For each position we re-resolve the NRML margin
    against the user's effective segment settings; if the wallet can't
    afford the overnight delta, the position is force-squareoff'd before
    the type flip (so we never leave it in NRML while under-margined).

    Idempotent — only acts on `status=OPEN, product_type=MIS` rows. Returns
    a small summary dict for logging / audit:
        {"converted": N, "force_closed": M, "skipped": K}

    Used by the `intraday_to_carry_loop` lifespan task. The loop calls this
    once per IST day per segment group, right after the exchange's close
    minute.
    """
    from app.core.redis_client import cache_delete_pattern
    from app.models._base import ProductType as _PT
    from app.models.audit_log import AuditAction
    from app.services import (
        audit_service,
        netting_service,
        order_service,
        wallet_service,
    )
    from app.services.market_data_service import is_usd_quoted_segment

    if not segment_set:
        return {"converted": 0, "force_closed": 0, "skipped": 0}

    # Fetch BOTH MIS and NRML positions in this segment group. MIS rows
    # get the normal rollover treatment; NRML rows are only touched when
    # admin has set `allowOvernight=false` on the segment, in which case
    # we force-close them too (the segment-spec says nothing can carry
    # past close).
    rows = await Position.find(
        {
            "status": PositionStatus.OPEN.value,
            "product_type": {"$in": [_PT.MIS.value, _PT.NRML.value]},
            "instrument.segment": {"$in": list(segment_set)},
        }
    ).to_list()

    converted = 0
    force_closed = 0
    skipped = 0

    for pos in rows:
        # Resolve NRML-side margin via the same resolver that runs at
        # order-placement time. Single source of truth — admin's segment
        # override stack is honoured.
        try:
            resolved = await netting_service.get_effective_settings(
                pos.user_id,
                pos.instrument.segment,
                action="BUY" if pos.quantity >= 0 else "SELL",
                option_type=None,
                product_type="NRML",
                symbol=pos.instrument.symbol,
            )
        except Exception:  # noqa: BLE001
            skipped += 1
            continue
        s = resolved.get("settings") or {}

        # Hard close-out path: admin disabled overnight carrying for this
        # segment (`allowOvernight=false`). Nothing carries past close —
        # squareoff every open position regardless of product type. Runs
        # before the type-flip / margin-recompute below so we don't bother
        # locking new margin on a position we're about to close.
        allow_overnight = bool(s.get("selling_overnight", True))
        if not allow_overnight:
            from app.models._base import OrderAction as _OA, OrderType as _OT
            from app.models.user import User as _User

            try:
                user_doc = await _User.get(pos.user_id)
                if user_doc is None:
                    skipped += 1
                    continue
                qty_open = abs(pos.quantity)
                lots_open = max(0.01, qty_open / max(1, pos.instrument.lot_size or 1))
                action = _OA.SELL if pos.quantity > 0 else _OA.BUY
                await order_service.place_order(
                    user=user_doc,
                    payload={
                        "token": pos.instrument.token,
                        "action": action.value,
                        "order_type": _OT.MARKET.value,
                        "product_type": pos.product_type.value,
                        "lots": lots_open,
                        "force_quantity": qty_open,
                        "is_squareoff": True,
                        "placed_from": "OVERNIGHT_DISABLED_CLOSE",
                    },
                )
                force_closed += 1
            except Exception:  # noqa: BLE001
                skipped += 1
            continue

        # `allowOvernight=true`: only MIS positions roll over to NRML.
        # Existing NRML positions stay as-is (already on overnight margin).
        if pos.product_type != _PT.MIS:
            continue

        # Compute the overnight margin requirement against the same
        # notional that's currently locked. Mirrors order_validator's
        # fixed-mode vs percent-vs-times logic.
        cur_avg = to_decimal(pos.avg_price)
        cur_qty_abs = to_decimal(abs(pos.quantity))
        notional = cur_avg * cur_qty_abs

        fixed_per_lot = to_decimal(s.get("fixed_margin_per_lot") or 0)
        if (s.get("margin_calc_mode") == "fixed") and fixed_per_lot > 0:
            lot_size = max(1, int(pos.instrument.lot_size or 1))
            lots = cur_qty_abs / to_decimal(lot_size)
            new_margin = fixed_per_lot * lots
        else:
            margin_pct = to_decimal(s.get("margin_percentage") or 100.0) / to_decimal(100)
            leverage = to_decimal(s.get("leverage") or 1.0) or to_decimal(1)
            new_margin = notional * margin_pct / leverage

        # USD-quoted instruments lock margin in INR; same conversion as
        # order_validator.validate. Skipped for fixed-per-lot (already INR).
        if (
            is_usd_quoted_segment(pos.segment_type)
            or is_usd_quoted_segment(pos.instrument.segment)
        ):
            if not ((s.get("margin_calc_mode") == "fixed") and fixed_per_lot > 0):
                from app.services.market_data_service import get_usd_inr_rate

                new_margin = new_margin * to_decimal(get_usd_inr_rate())

        new_margin = quantize_money(new_margin)
        old_margin = to_decimal(pos.margin_used)
        delta = new_margin - old_margin

        wallet = await wallet_service.get_or_create(pos.user_id)
        affordable = (to_decimal(wallet.available_balance) + to_decimal(wallet.credit_limit)) >= delta

        if delta > 0 and not affordable:
            # Can't cover the overnight requirement — flatten the position
            # at market before the type flip. Same pattern risk_enforcer
            # uses: opposite-side MARKET order with `force_quantity` and
            # `is_squareoff` so hold-time guards are bypassed and the close
            # moves EXACTLY the open qty (no off-by-one against a stale
            # lot_size).
            from app.models._base import OrderAction as _OA, OrderType as _OT
            from app.models.user import User as _User

            try:
                user_doc = await _User.get(pos.user_id)
                if user_doc is None:
                    skipped += 1
                    continue
                qty_open = abs(pos.quantity)
                lots_open = max(0.01, qty_open / max(1, pos.instrument.lot_size or 1))
                action = _OA.SELL if pos.quantity > 0 else _OA.BUY
                await order_service.place_order(
                    user=user_doc,
                    payload={
                        "token": pos.instrument.token,
                        "action": action.value,
                        "order_type": _OT.MARKET.value,
                        "product_type": pos.product_type.value,
                        "lots": lots_open,
                        "force_quantity": qty_open,
                        "is_squareoff": True,
                        "placed_from": "INTRADAY_ROLLOVER",
                    },
                )
                force_closed += 1
            except Exception:  # noqa: BLE001
                skipped += 1
            continue

        # Type flip + margin reconciliation.
        try:
            if delta > 0:
                await wallet_service.block_margin(pos.user_id, delta)
            elif delta < 0:
                await wallet_service.release_margin(pos.user_id, -delta)

            pos.product_type = _PT.NRML
            pos.margin_used = Decimal128(str(new_margin))
            await pos.save()

            # Tracker counters — same magnitude, different bucket.
            tracker = await UserPositionTracker.find_one(
                UserPositionTracker.user_id == pos.user_id
            )
            if tracker is not None:
                lots_for_tracker = float(cur_qty_abs / to_decimal(max(1, int(pos.instrument.lot_size or 1))))
                tracker.intraday_lots = max(0.0, tracker.intraday_lots - lots_for_tracker)
                tracker.holding_lots = tracker.holding_lots + lots_for_tracker
                await tracker.save()

            try:
                await audit_service.log_event(
                    action=AuditAction.UPDATE,
                    entity_type="Position",
                    entity_id=pos.id,
                    actor_id=None,
                    target_user_id=pos.user_id,
                    metadata={
                        "kind": "INTRADAY_TO_CARRY_CONVERSION",
                        "symbol": pos.instrument.symbol,
                        "old_margin": str(old_margin),
                        "new_margin": str(new_margin),
                        "delta": str(delta),
                    },
                )
            except Exception:  # noqa: BLE001
                pass

            converted += 1
        except Exception:  # noqa: BLE001
            skipped += 1

    # Per-user effective-settings cache no longer matches reality (the
    # product_type changed); wipe so the next read re-resolves.
    try:
        await cache_delete_pattern("netting_eff:*")
    except Exception:  # noqa: BLE001
        pass

    return {"converted": converted, "force_closed": force_closed, "skipped": skipped}


# Module-level kill switch + state — same pattern as risk_enforcer_loop.
_intraday_loop_stop = False
_last_rollover_day: dict[str, str] = {}


def stop_intraday_to_carry_loop() -> None:
    global _intraday_loop_stop
    _intraday_loop_stop = True


async def intraday_to_carry_loop(interval_sec: float = 60.0) -> None:
    """Wake every minute; at each segment group's close minute (once per
    IST day), run `convert_intraday_to_carry` against that group.

    Segment groups + close times come from time_utils:
        • Indian equity + F&O → 15:30 IST
        • MCX                 → 23:55 IST
        • Forex (CDS) + crypto → no close, skipped entirely

    Weekends are skipped (Indian exchanges are closed). The per-day
    bookkeeping `_last_rollover_day` ensures we only fire once per group
    even if the loop sleeps drift slightly past the close-minute mark.
    """
    import asyncio as _asyncio
    import logging as _logging

    from app.utils.time_utils import (
        INDIAN_EQUITY_FNO_SEGMENTS,
        MCX_SEGMENTS,
        is_weekend,
        market_close_time_for_segment,
        now_ist,
    )

    _log = _logging.getLogger(__name__)
    global _intraday_loop_stop
    _intraday_loop_stop = False

    groups = (
        ("INDIAN_EQUITY_FNO", INDIAN_EQUITY_FNO_SEGMENTS),
        ("MCX", MCX_SEGMENTS),
    )

    while not _intraday_loop_stop:
        try:
            now = now_ist()
            if not is_weekend(now.date()):
                day_key = now.strftime("%Y%m%d")
                for group_name, group_set in groups:
                    if _last_rollover_day.get(group_name) == day_key:
                        continue
                    close_t = market_close_time_for_segment(next(iter(group_set)))
                    if close_t is None:
                        continue
                    # Fire the minute after close — gives any straggler
                    # orders one tick to settle before we sweep.
                    fire_after = (close_t.hour, close_t.minute + 1)
                    if (now.hour, now.minute) >= fire_after:
                        summary = await convert_intraday_to_carry(group_set)
                        _last_rollover_day[group_name] = day_key
                        _log.info(
                            "intraday_to_carry_rolled",
                            extra={"group": group_name, **summary},
                        )
        except Exception:  # noqa: BLE001
            _log.exception("intraday_to_carry_loop_failed")
        try:
            await _asyncio.sleep(interval_sec)
        except _asyncio.CancelledError:
            return
