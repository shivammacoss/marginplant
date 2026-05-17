"""Order pre-trade validator — 12 checks per spec, in order.

Returns (ok, applied_settings_snapshot) on success or raises OrderRejectedError.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, time
from decimal import Decimal
from typing import Any

from app.core.exceptions import (
    InsufficientFundsError,
    MarketClosedError,
    OrderRejectedError,
    SegmentNotAllowedError,
)
from app.models._base import (
    OrderAction,
    OrderType,
    ProductType,
)
from app.models.holiday import TradingHoliday
from app.models.instrument import Instrument
from app.models.position import Position, PositionStatus, UserPositionTracker
from app.models.user import User, UserStatus
from app.services import market_data_service, netting_service, wallet_service
from app.utils.decimal_utils import to_decimal
from app.utils.time_utils import is_weekend, now_ist, parse_hhmm, to_ist


@dataclass
class ValidatedOrder:
    settings: dict[str, Any]
    netting_settings: dict[str, Any]  # full netting resolved dict for matching engine
    margin_required: Decimal
    ltp: Decimal


def _money_to_float(v: Any) -> float:
    """Coerce ANY money-shaped value (Decimal128 / Decimal / str / number / None)
    into a Python float. Python's built-in ``float()`` does NOT accept
    ``bson.Decimal128`` and raises ``TypeError: float() argument must be a
    string or a real number, not 'Decimal128'`` — which is the exact error
    the user saw on SELL / reducing orders against an open Position. We
    route every money read in this validator through this helper so that
    bug can never resurface."""
    if v is None:
        return 0.0
    try:
        return float(to_decimal(v))
    except Exception:
        try:
            return float(str(v))
        except Exception:
            return 0.0


async def validate(
    *,
    user: User,
    instrument: Instrument,
    segment_type: str,
    action: OrderAction,
    order_type: OrderType,
    product_type: ProductType,
    lots: float,
    quantity: float,
    price: Decimal,
    trigger_price: Decimal,
    is_amo: bool,
    is_squareoff: bool = False,
    expected_price: Decimal | None = None,
    bracket_sl: Decimal | None = None,
    bracket_tp: Decimal | None = None,
) -> ValidatedOrder:
    # 12) user status
    if user.status != UserStatus.ACTIVE:
        raise OrderRejectedError("Account is not active", code="ACCOUNT_INACTIVE")
    if not user.permissions.can_place_orders:
        raise OrderRejectedError("Order placement disabled for this account", code="PERMISSION_DENIED")

    # ── Batch independent async lookups to cut latency ────────────
    # Risk, netting settings, position tracker, and open position are all
    # independent — fire them in parallel instead of sequentially.
    is_expiry_day_now = bool(instrument.expiry and instrument.expiry == now_ist().date())

    async def _fetch_risk() -> dict[str, Any]:
        try:
            rp = await netting_service.get_effective_risk(str(user.id))
            return rp.get("settings", {}) if rp else {}
        except Exception:
            return {}

    async def _fetch_netting() -> dict[str, Any]:
        return await netting_service.get_effective_settings(
            user.id,  # type: ignore[arg-type]
            segment_type,
            action=action.value if hasattr(action, "value") else str(action),
            option_type=instrument.option_type.value if instrument.option_type else None,
            product_type=product_type.value if hasattr(product_type, "value") else str(product_type),
            is_expiry_day=is_expiry_day_now,
            symbol=instrument.symbol,
        )

    import logging as _logging
    import time as _time

    _vlog = _logging.getLogger(__name__)
    _t0 = _time.perf_counter()
    risk, resolved, tracker, open_position, ltp = await asyncio.gather(
        _fetch_risk(),
        _fetch_netting(),
        UserPositionTracker.find_one(
            UserPositionTracker.user_id == user.id,
            UserPositionTracker.segment_type == segment_type,
            UserPositionTracker.instrument_token == instrument.token,
        ),
        Position.find_one(
            Position.user_id == user.id,
            Position.instrument.token == instrument.token,
            Position.segment_type == segment_type,
            Position.status == PositionStatus.OPEN,
        ),
        market_data_service.get_ltp(instrument.token),
    )
    _vlog.info(
        "order_perf step=validate.gather5 ms=%.1f",
        (_time.perf_counter() - _t0) * 1000,
    )
    s: dict[str, Any] = resolved["settings"]

    # 1) Block gate — split into two flags so closing trades survive a
    # paused segment:
    #   • `is_active = false`   → segment is turned OFF entirely. The
    #     user side hides instruments from search and we reject EVERY
    #     order (including squareoff) here as a belt-and-braces check.
    #   • `trading_enabled = false` → new entries are blocked but the
    #     user can still see prices and CLOSE existing positions. The
    #     `is_reducing` / `is_squareoff` exemption fires below once
    #     those values are computed.
    if not bool(s.get("is_active", True)):
        raise SegmentNotAllowedError(
            f"Segment {segment_type} is disabled — contact your broker"
        )

    lot_size = max(1, instrument.lot_size or 1)

    # 2) lot limits — admin's segment settings are the single source of truth.
    # Squareoff orders are EXEMPT from the min-lot floor: a legacy position
    # opened before the Infoway lot-size table existed may have stored
    # `quantity = 0.99` against `lot_size = 1`; once the canonical heal
    # rewrites lot_size to 100 (XAUUSD = 100 oz/lot), the close path
    # recomputes `lots = quantity / lot_size = 0.0099` which would
    # otherwise trip the 0.01 minimum and leave the trader unable to
    # exit. Same exemption applies to admin-initiated force-closes
    # (kill switch, risk auto-flatten, EOD rollover) which all set
    # `is_squareoff=True`.
    min_lot = float(s.get("min_lot") or 1)
    order_lot = float(s.get("order_lot") or 0)  # per-order maximum (new positions only)
    if lots < min_lot and not is_squareoff:
        raise OrderRejectedError(f"Minimum {min_lot} lot(s) required", code="LOT_BELOW_MIN")

    # 3) position limits — running total per instrument + per segment
    #
    # `Position.quantity` is stored in CONTRACTS (lots × lot_size), while
    # the admin's caps and the user's `lots` field are in LOTS. Mixing
    # the two units meant a 1-lot follow-up on a NIFTY long (75 contracts
    # held) computed `projected_net = 75 + 1 = 76` and tripped the
    # 100-lot per-instrument cap as if the user already held 75 lots.
    # Convert to lots up-front so every downstream check (`is_reducing`,
    # `MAX_EACH_EXCEEDED`) compares apples to apples. We divide by the
    # POSITION's own stored lot_size (not the live instrument's) so a
    # legacy row where lot_size has since been corrected by the canonical
    # table still resolves to the same lot count it was opened with.
    held = tracker.total_lots if tracker else 0
    pos_lot_size = max(
        1,
        int(
            (getattr(open_position.instrument, "lot_size", 0) or lot_size)
            if open_position
            else lot_size
        ),
    )
    signed_held = (
        float(open_position.quantity) / pos_lot_size if open_position else 0.0
    )  # IN LOTS (signed: + long, − short, 0 flat)
    delta = float(lots) if action == OrderAction.BUY else -float(lots)
    projected_net = signed_held + delta
    is_reducing = abs(projected_net) < abs(signed_held)  # closing / partial close

    # Per-order cap: only applies to NEW/opening orders — closing must always
    # be allowed in full so user can exit the entire position in one click.
    if not is_squareoff and not is_reducing and order_lot > 0 and lots > order_lot:
        raise OrderRejectedError(
            f"Maximum {order_lot} lot(s) per order", code="LOT_PER_ORDER_MAX"
        )

    # ── Risk: exit-only mode ───────────────────────────────────────
    # Admin freezes the account for new entries (e.g. during volatility,
    # margin warnings). Only reducing/closing trades remain allowed.
    if risk.get("exitOnlyMode") and not is_reducing:
        raise OrderRejectedError(
            "Exit-only mode is active — only closing trades are allowed",
            code="EXIT_ONLY_MODE",
        )

    # ── Block gate (segment level): tradingEnabled = false ────────
    # Admin paused this segment. Existing positions can still be closed
    # (the user can exit their book) but no new entries are allowed.
    # `is_squareoff` covers admin-initiated kill-switch / risk auto-flatten
    # so those always pass through.
    if not bool(s.get("trading_enabled", True)) and not is_reducing and not is_squareoff:
        raise SegmentNotAllowedError(
            f"Segment {segment_type} is paused — only closing trades are allowed",
        )

    # ── Expiry-day hold timer ─────────────────────────────────────
    # Admin can force users to hold profitable / losing trades for a
    # minimum number of seconds on expiry day before allowing close.
    # The check fires only when:
    #   • This is a CLOSING order (`is_reducing`) and not an admin-driven
    #     squareoff (kill-switch / risk auto-flatten / EOD rollover are
    #     never gated by the user-facing hold timer).
    #   • The instrument expires today (matches the same predicate the
    #     resolver uses).
    #   • An open position exists with an `opened_at` timestamp we can
    #     compare against.
    # Zero means "no minimum" — opt out per segment.
    if (
        is_reducing
        and not is_squareoff
        and is_expiry_day_now
        and open_position is not None
        and getattr(open_position, "opened_at", None) is not None
    ):
        from app.utils.time_utils import now_utc

        try:
            held_sec = (now_utc() - open_position.opened_at).total_seconds()
            # Sign of the current position tells us whether the user is
            # closing a long (cur_qty > 0, P/L = ltp − avg) or a short
            # (cur_qty < 0, P/L = avg − ltp). Every money read uses
            # `_money_to_float` so a Decimal128 / Decimal / str payload
            # all coerce cleanly — the soft hold-timer must never crash
            # the entire order pipeline.
            avg = _money_to_float(getattr(open_position, "avg_price", 0))
            ltp_f = _money_to_float(ltp)
            qty_f = float(open_position.quantity or 0)
            if avg > 0 and ltp_f > 0:
                unrealized = (ltp_f - avg) if qty_f > 0 else (avg - ltp_f)
                min_hold = float(
                    s.get("expiry_profit_hold") if unrealized >= 0 else s.get("expiry_loss_holding")
                    or 0
                )
                if min_hold > 0 and held_sec < min_hold:
                    kind = "profit" if unrealized >= 0 else "loss"
                    raise OrderRejectedError(
                        f"Expiry-day {kind}-hold: this position must be held for "
                        f"{int(min_hold)} s before closing (held {int(held_sec)} s)",
                        code=f"EXPIRY_{kind.upper()}_HOLD",
                    )
        except OrderRejectedError:
            # Hold-timer rejection is a legitimate user-facing error —
            # bubble it through. Other exceptions are swallowed below.
            raise
        except Exception:
            _vlog.warning("expiry_hold_check_failed", exc_info=True)

    # ── Always-on hold timer (Risk Management settings) ─────────────
    # The two `*TradeHoldMinSeconds` knobs on the Risk Management page
    # apply to every user-initiated close, every day — not just expiry.
    # Admin uses these to prevent scalping (positive hold) or panic
    # closing (loss hold). Same exemptions as the expiry-day version
    # above: only fires on user-driven reductions, never on admin
    # squareoff. Zero = feature off.
    if (
        is_reducing
        and not is_squareoff
        and open_position is not None
        and getattr(open_position, "opened_at", None) is not None
    ):
        from app.utils.time_utils import now_utc

        try:
            held_sec_rs = (now_utc() - open_position.opened_at).total_seconds()
            avg_rs = _money_to_float(getattr(open_position, "avg_price", 0))
            ltp_rs = _money_to_float(ltp)
            qty_rs = float(open_position.quantity or 0)
            if avg_rs > 0 and ltp_rs > 0:
                unrealized_rs = (ltp_rs - avg_rs) if qty_rs > 0 else (avg_rs - ltp_rs)
                min_hold_rs = float(
                    (risk.get("profitTradeHoldMinSeconds") if unrealized_rs >= 0 else risk.get("lossTradeHoldMinSeconds"))
                    or 0
                )
                if min_hold_rs > 0 and held_sec_rs < min_hold_rs:
                    kind = "profit" if unrealized_rs >= 0 else "loss"
                    raise OrderRejectedError(
                        f"{kind.capitalize()} trade must be held for "
                        f"{int(min_hold_rs)} s before close (held {int(held_sec_rs)} s)",
                        code=f"{kind.upper()}_HOLD",
                    )
        except OrderRejectedError:
            raise
        except Exception:
            _vlog.warning("trade_hold_check_failed", exc_info=True)

    intra_limit = int(s.get("intraday_lot_limit") or 0)
    hold_limit = int(s.get("holding_lot_limit") or 0)
    max_each = int(s.get("max_each_lot") or 0)

    # Cap only applies when the order would INCREASE exposure on this script.
    if max_each and not is_reducing and abs(projected_net) > max_each:
        raise OrderRejectedError(
            f"Per-instrument cap reached: would hold {abs(projected_net)} > {max_each}",
            code="MAX_EACH_EXCEEDED",
        )
    if (
        not is_reducing
        and product_type == ProductType.MIS
        and intra_limit
        and (tracker.intraday_lots if tracker else 0) + lots > intra_limit
    ):
        raise OrderRejectedError(f"Intraday lot limit {intra_limit} reached", code="INTRADAY_LIMIT")
    if (
        not is_reducing
        and product_type in (ProductType.NRML, ProductType.CNC)
        and hold_limit
        and (tracker.holding_lots if tracker else 0) + lots > hold_limit
    ):
        raise OrderRejectedError(f"Holding lot limit {hold_limit} reached", code="HOLDING_LIMIT")

    # 4) Limit-away check.
    #
    # Bounds every limit-style price the order carries by ±limit_pct of the
    # bid/ask of the side that will actually transact on that leg:
    #
    #   • Entry leg (LIMIT price / SL-M trigger): user is the maker — BUY
    #     orders reference the ask (the price they'd cross to fill); SELL
    #     orders reference the bid.
    #   • Bracket SL / target: the closing leg trades the opposite side,
    #     so a BUY (long) entry's SL/TP both reference the bid (close = SELL),
    #     and a SELL (short) entry's SL/TP reference the ask (close = BUY).
    #
    # Falls back to LTP when bid/ask are missing (off-hours / mock feed).
    # MARKET orders skip the entry-leg check (no user-priced field) but
    # their bracket prices are still validated.

    # ── 4a) Bracket SL / TP directional sanity ─────────────────────
    # Independent of `limit_pct` (which can be 0 in some segments). Without
    # this, a user could type TP=95 on a LONG at 100 and the risk-enforcer
    # would immediately square-off the position the moment the order fills
    # because the trigger condition `ltp >= tp` would be true on every
    # tick. Same for SL on the wrong side: trigger condition becomes
    # impossible and the bracket never fires. The check uses the entry
    # price the order is actually going to land at:
    #   • LIMIT / SL-M → user-entered price / trigger.
    #   • MARKET       → live close-side quote (ask for BUY, bid for SELL),
    #                    falling back to LTP.
    if bracket_sl is not None or bracket_tp is not None:
        if order_type != OrderType.MARKET and price is not None and price > 0:
            entry_ref_dir = price
        elif order_type == OrderType.SL_M and trigger_price is not None and trigger_price > 0:
            entry_ref_dir = trigger_price
        else:
            entry_ref_dir = ltp
        if entry_ref_dir is not None and entry_ref_dir > 0:
            if bracket_sl is not None and bracket_sl > 0:
                if action == OrderAction.BUY and bracket_sl >= entry_ref_dir:
                    raise OrderRejectedError(
                        f"Stop loss ₹{bracket_sl} must be BELOW entry ₹{entry_ref_dir} for a BUY",
                        code="SL_WRONG_SIDE",
                    )
                if action == OrderAction.SELL and bracket_sl <= entry_ref_dir:
                    raise OrderRejectedError(
                        f"Stop loss ₹{bracket_sl} must be ABOVE entry ₹{entry_ref_dir} for a SELL",
                        code="SL_WRONG_SIDE",
                    )
            if bracket_tp is not None and bracket_tp > 0:
                if action == OrderAction.BUY and bracket_tp <= entry_ref_dir:
                    raise OrderRejectedError(
                        f"Target ₹{bracket_tp} must be ABOVE entry ₹{entry_ref_dir} for a BUY",
                        code="TP_WRONG_SIDE",
                    )
                if action == OrderAction.SELL and bracket_tp >= entry_ref_dir:
                    raise OrderRejectedError(
                        f"Target ₹{bracket_tp} must be BELOW entry ₹{entry_ref_dir} for a SELL",
                        code="TP_WRONG_SIDE",
                    )

    limit_pct = float(s.get("limit_percentage") or 0)
    if limit_pct > 0 and ltp > 0:
        try:
            _quote = await market_data_service.get_quote(instrument.token)
            _bid_raw = _quote.get("bid")
            _ask_raw = _quote.get("ask")
            _bid = to_decimal(_bid_raw) if _bid_raw not in (None, 0, "0") else None
            _ask = to_decimal(_ask_raw) if _ask_raw not in (None, 0, "0") else None
        except Exception:
            _bid = _ask = None

        def _market_ref(side_word: str) -> Decimal:
            # BUY-leg reference is the ask (you'd cross the spread upward
            # to fill), SELL-leg is the bid. Fall back to LTP when bid/ask
            # are missing.
            if side_word == "BUY":
                return _ask if _ask is not None and _ask > 0 else ltp
            return _bid if _bid is not None and _bid > 0 else ltp

        def _check(name: str, ref: Decimal, candidate: Decimal | None) -> None:
            """`limit_pct` is interpreted as a MINIMUM distance from the
            market reference — orders must be placed AT LEAST `limit_pct`
            away in either direction, never inside the band. Rejected
            when the candidate sits within (lower, upper) exclusive.
            Allowed exactly ON the boundary so a placeholder hint that
            shows ``ref × (1 ± pct)`` is itself a placeable price.

            Earlier this was inverted (orders had to stay INSIDE the
            band). Switched to match the broker's spec — limit_pct is a
            "don't-fill-too-close" rail, not a "stay-close-to-market"
            rail.
            """
            if candidate is None or candidate <= 0:
                return
            if ref is None or ref <= 0:
                return
            upper = ref * to_decimal(1 + limit_pct / 100)
            lower = ref * to_decimal(1 - limit_pct / 100)
            if lower < candidate < upper:
                raise OrderRejectedError(
                    f"{name} ₹{candidate} is too close to reference ₹{ref}. "
                    f"Must be at least {limit_pct}% away (≤ ₹{lower} or ≥ ₹{upper}).",
                    code=f"{name.upper().replace(' ', '_')}_TOO_CLOSE",
                )

        entry_side = "BUY" if action == OrderAction.BUY else "SELL"
        # Entry leg (LIMIT price / SL-M trigger) is bounded by the market
        # side the order will fill against.
        entry_ref = _market_ref(entry_side)
        # Bracket SL / target reference:
        #   • For MARKET orders the user is filling at market, so we anchor
        #     SL / TP to the live opposite side (close-leg quote).
        #   • For LIMIT / SL-M orders the user explicitly chose a price —
        #     SL and TP should be evaluated against THAT price (the entry
        #     they're shooting for), not the live tick that may drift away
        #     before the limit fills. This is what users mean by "if price
        #     is 100 and limit-away is 10, SL is 90 and TP is 110".
        if order_type != OrderType.MARKET and price is not None and price > 0:
            bracket_ref = price
        else:
            bracket_ref = _market_ref("SELL" if action == OrderAction.BUY else "BUY")

        if order_type != OrderType.MARKET:
            _check("limit price", entry_ref, price)
            _check("trigger price", entry_ref, trigger_price)
        _check("stop loss", bracket_ref, bracket_sl)
        _check("target", bracket_ref, bracket_tp)

    # 5) strike difference (only for option segments)
    strike_diff = int(s.get("strike_difference") or 0)
    if strike_diff > 0 and instrument.strike is not None and "OPTION" in segment_type.upper():
        underlying = await Instrument.find_one(
            Instrument.token == (instrument.underlying_token or "")
        )
        if underlying is not None:
            spot = await market_data_service.get_ltp(underlying.token)
            atm = round(float(spot) / strike_diff) * strike_diff
            strike_val = float(to_decimal(instrument.strike))
            steps = abs(strike_val - atm) // strike_diff
            max_steps = int(s.get("strike_difference") or 5)
            if steps > max_steps:
                raise OrderRejectedError(
                    f"Strike too far from ATM ({int(steps)} > {max_steps})", code="STRIKE_OUT_OF_RANGE"
                )

    # 6) OTM extra-strict cap
    otm_max = int(s.get("otm_max_each_lot") or 0)
    if otm_max and "OPTION" in segment_type.upper() and instrument.option_type:
        # Heuristic: rely on max_each_lot already handling general cap; here we tighten
        if (held + lots) > otm_max:
            raise OrderRejectedError(f"OTM cap {otm_max} reached", code="OTM_CAP_EXCEEDED")

    # 6a-i) minimum quantity check (equity segments that use qty instead of lots)
    min_qty = float(s.get("min_qty") or 0)
    if min_qty > 0 and quantity < min_qty:
        raise OrderRejectedError(
            f"Minimum quantity is {min_qty}, got {quantity}",
            code="QTY_BELOW_MIN",
        )

    # 6a) per-order quantity cap (relevant mostly for equity segments).
    # Skip for reducing/closing orders — those exit existing exposure.
    per_order_qty = float(s.get("per_order_qty") or 0)
    if not is_reducing and per_order_qty > 0 and quantity > per_order_qty:
        raise OrderRejectedError(
            f"Quantity {quantity} exceeds per-order cap of {per_order_qty}",
            code="QTY_PER_ORDER_EXCEEDED",
        )

    # 6b) running total quantity per script (running held + new ≤ cap)
    max_qty_script = float(s.get("max_qty_per_script") or 0)
    if not is_reducing and max_qty_script > 0:
        held_qty = (tracker.total_lots if tracker else 0) * lot_size
        if held_qty + quantity > max_qty_script:
            raise OrderRejectedError(
                f"Per-script quantity cap {max_qty_script} would be breached "
                f"(held {held_qty} + new {quantity})",
                code="MAX_QTY_PER_SCRIPT",
            )

    # 6c) per-order notional cap (₹ value) — skip for closing orders
    max_value = float(s.get("max_value") or 0)
    if not is_reducing and max_value > 0:
        ref_price_for_value = price if price > 0 else ltp
        notional_check = quantity * float(ref_price_for_value)
        if notional_check > max_value:
            raise OrderRejectedError(
                f"Order value ₹{notional_check:,.0f} exceeds per-order cap of ₹{max_value:,.0f}",
                code="MAX_VALUE_EXCEEDED",
            )

    # 6d) Option-leg strike-distance from spot. Single percent cap from
    # admin's Options column — same value gates both BUY and SELL legs.
    # The option-chain dialog filters the same way (strikes outside this
    # band aren't shown to the user) so anything that reaches this check
    # is the result of a deliberate token-paste, not normal click flow.
    far_pct = float(s.get("strike_far_percent") or 0)
    if (
        far_pct > 0
        and "OPTION" in segment_type.upper()
        and instrument.strike is not None
        and instrument.underlying_token
    ):
        underlying = await Instrument.find_one(Instrument.token == instrument.underlying_token)
        if underlying is not None:
            spot = float(await market_data_service.get_ltp(underlying.token))
            if spot > 0:
                strike_val = float(to_decimal(instrument.strike))
                deviation_pct = abs(strike_val - spot) / spot * 100
                if deviation_pct > far_pct:
                    raise OrderRejectedError(
                        f"Strike {strike_val:.0f} is {deviation_pct:.1f}% from spot {spot:.2f} "
                        f"— cap is {far_pct:.1f}%",
                        code="STRIKE_FAR_CAP",
                    )

    # 7) overnight selling
    if not s.get("selling_overnight", True) and action == OrderAction.SELL and product_type != ProductType.MIS:
        # Only block if user has no current long position to cover
        if not tracker or tracker.holding_lots <= 0:
            raise OrderRejectedError(
                "Overnight short selling is disabled for your account", code="NO_OVERNIGHT_SHORT"
            )

    # 8) expiry-day rules
    # Two knobs on the segment matrix drive this:
    #   • `expiry_intraday_margin` (and the OPTION-buy/sell variants
    #     picked earlier in the resolver) → the value to use today.
    #   • `expiry_margin_as_percent` → when False the value above is a
    #     flat ₹/lot (mirrors `margin_calc_mode = fixed`); when True
    #     it's % of notional. Lets admin run normal trading on, say,
    #     Times-leverage and still impose a punitive flat ₹ on expiry.
    is_expiry_today = bool(instrument.expiry and instrument.expiry == now_ist().date())
    if is_expiry_today:
        expiry_margin = float(
            s.get("expiry_intraday_margin") or s.get("margin_percentage") or 100.0
        )
        expiry_as_percent = bool(s.get("expiry_margin_as_percent", True))
        if expiry_as_percent:
            # Percent path — replace the segment's margin_percentage. The
            # downstream calc continues through `notional × pct ÷ leverage`.
            s["margin_percentage"] = expiry_margin
            # Force `leverage = 1` so the value is consumed straight as
            # % of notional even if the segment is in Times mode.
            s["leverage"] = 1.0
        else:
            # Flat-₹-per-lot path — switch the calc into fixed mode for
            # this order, with the expiry-day value as the per-lot rupee
            # amount. Zero out percent/leverage so the downstream check
            # falls into the fixed-margin branch below.
            s["margin_calc_mode"] = "fixed"
            s["fixed_margin_per_lot"] = expiry_margin
            s["margin_percentage"] = 0.0
            s["leverage"] = 1.0

    # 9) margin check (all-Decimal arithmetic — never mix Decimal × float)
    margin_pct = to_decimal(s.get("margin_percentage") or 100.0) / to_decimal(100)
    leverage = to_decimal(s.get("leverage") or 1.0)
    if leverage <= 0:
        leverage = to_decimal(1)
    # Reference price for the notional / margin calc, in priority order:
    #   1. LIMIT / SL — user-entered price.
    #   2. `expected_price` from the order panel (the BUY/SELL price the
    #      user clicked). Same value the matching engine fills at, so the
    #      wallet locks exactly what the user will be charged.
    #   3. Live ask (BUY) or bid (SELL) — the actual fill side.
    #   4. LTP fallback for off-hours / missing depth.
    if price > 0:
        ref_price = price
    elif expected_price is not None and expected_price > 0:
        ref_price = expected_price
    else:
        try:
            quote = await market_data_service.get_quote(instrument.token)
            bid_raw = quote.get("bid")
            ask_raw = quote.get("ask")
            bid = to_decimal(bid_raw) if bid_raw not in (None, 0, "0") else None
            ask = to_decimal(ask_raw) if ask_raw not in (None, 0, "0") else None
        except Exception:
            bid = ask = None
        if action == OrderAction.BUY and ask is not None and ask > 0:
            ref_price = ask
        elif action == OrderAction.SELL and bid is not None and bid > 0:
            ref_price = bid
        else:
            ref_price = ltp
    notional = to_decimal(quantity) * ref_price
    # Fixed-margin segments skip the notional × pct ÷ leverage formula
    # entirely — the admin's configured value is a flat ₹/lot charged
    # once per lot. Anything else falls into the standard percent/times
    # path. (`margin_pct` is already 100% with the `leverage` set for
    # times mode, and is the literal percent for legacy percent mode.)
    fixed_per_lot = to_decimal(s.get("fixed_margin_per_lot") or 0)
    if (s.get("margin_calc_mode") == "fixed") and fixed_per_lot > 0:
        margin_required = to_decimal(lots) * fixed_per_lot
    else:
        margin_required = notional * margin_pct / leverage

    # USD-quoted instruments (Infoway: crypto / forex / metals / energy)
    # price `ref_price` in dollars — wallet runs in INR, so the margin we
    # lock must be in INR too. Multiply by the live USD/INR rate. Skip for
    # native-INR segments (NSE / BSE / MCX / NFO / BFO). Fixed-per-lot
    # values are admin-entered in INR already, so this conversion is
    # skipped for fixed mode.
    inst_segment = str(getattr(instrument.segment, "value", instrument.segment) or "")
    if (
        (market_data_service.is_usd_quoted_segment(segment_type) or market_data_service.is_usd_quoted_segment(inst_segment))
        and not ((s.get("margin_calc_mode") == "fixed") and fixed_per_lot > 0)
    ):
        usd_inr = to_decimal(market_data_service.get_usd_inr_rate())
        margin_required = margin_required * usd_inr
    wallet = await wallet_service.get_or_create(user.id)  # type: ignore[arg-type]
    available = to_decimal(wallet.available_balance) + to_decimal(wallet.credit_limit)
    # Closing/reducing orders don't lock new margin — they free it up — so
    # skip the funds + utilisation cap checks for them.
    if is_reducing or is_squareoff:
        margin_required = to_decimal(0)
    elif margin_required > available:
        raise InsufficientFundsError(
            f"Need ₹{margin_required:.2f}, have ₹{available:.2f}"
        )

    # 10) stop-loss mandatory
    if s.get("stop_loss_mandatory") and order_type not in (OrderType.SL, OrderType.SL_M):
        raise OrderRejectedError("Stop-loss is mandatory for this segment", code="SL_MANDATORY")

    # 11) market hours (skip for AMO and 24×7 segments)
    seg_upper = (segment_type or "").upper()
    exch_upper = str(getattr(instrument.exchange, "value", instrument.exchange) or "").upper()
    is_24x7 = "CRYPTO" in seg_upper or exch_upper == "CRYPTO"  # crypto runs 24×7
    # Forex + spot metals (XAU/XAG…) + energy (USOIL/UKOIL/NATGAS) all
    # follow the international 24×5 calendar — closed only on weekends.
    # They all sit on the virtual `CDS` exchange in our catalogue.
    is_24x5 = (
        "FOREX" in seg_upper
        or "FX" in seg_upper
        or "COMMODITIES" in seg_upper
        or "CDS" in seg_upper
        or exch_upper == "CDS"
    )
    is_mcx = "MCX" in seg_upper  # MCX has its own hours (~09:00-23:30 IST)

    # Squareoff orders (admin force-close, user kill-switch, risk
    # auto-flatten, SL/TP/stop-out fires) intentionally bypass the
    # market-hours guard. We're a B-book — matching is internal, prices
    # come from the cached LTP — so closing a position never needs the
    # external exchange to be live. Before this exemption the admin's
    # "Close" button on the Position Management page silently 400'd with
    # `MarketClosedError` after-hours, leaving the admin with no way to
    # flatten a runaway position outside trading hours.
    if not is_amo and not is_24x7 and not is_squareoff:
        ist = now_ist()

        # 24×5 (forex / metals / energy): closed only on weekends (Sat full-day;
        # Sun close before 17:30 ET ≈ 03:00 IST Mon)
        if is_24x5:
            wd = ist.weekday()  # Mon=0 ... Sun=6
            if wd == 5 or (wd == 6 and ist.hour < 4):
                raise MarketClosedError("Forex market is closed for the weekend.")
        else:
            if is_weekend(ist.date()):
                raise MarketClosedError("Market is closed (weekend). Place AMO instead.")
            # holiday lookup (only Indian exchanges)
            h = await TradingHoliday.find_one(
                TradingHoliday.holiday_date == ist.date(),
                TradingHoliday.exchange == instrument.exchange,
            )
            if h is not None and h.is_full_day:
                raise MarketClosedError(f"Holiday: {h.description}. Place AMO instead.")

            from app.core.config import settings as cfg

            if is_mcx:
                # MCX: 09:00 – 23:30 IST (winter) / 23:55 IST (summer evening session)
                # We use a generous 09:00 – 23:30 window.
                from datetime import time as _t

                if not (_t(9, 0) <= ist.time() <= _t(23, 30)):
                    raise MarketClosedError("MCX is closed. Place AMO instead.")
            else:
                # NSE / BSE equities + F&O: 09:15 – 15:30 IST
                open_t = parse_hhmm(cfg.MARKET_OPEN_TIME)
                close_t = parse_hhmm(cfg.MARKET_CLOSE_TIME)
                if not (open_t <= ist.time() <= close_t):
                    raise MarketClosedError("Market is closed. Place AMO instead.")

    # Build snapshot for the order document
    settings_snapshot = {
        "segment_type": segment_type,
        "margin_percentage": s.get("margin_percentage"),
        "leverage": s.get("leverage"),
        "commission_type": str(s.get("commission_type")) if s.get("commission_type") else None,
        "commission_value": s.get("commission_value"),
        "min_brokerage": s.get("min_brokerage"),
        "limit_percentage": s.get("limit_percentage"),
        "stop_loss_mandatory": s.get("stop_loss_mandatory"),
        "auto_squareoff_time": s.get("auto_squareoff_time"),
        "m2m_squareoff_percent": s.get("m2m_squareoff_percent"),
    }

    return ValidatedOrder(settings=settings_snapshot, netting_settings=resolved, margin_required=margin_required, ltp=ltp)
