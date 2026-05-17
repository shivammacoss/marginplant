"""User positions + holdings endpoints."""

from __future__ import annotations

import asyncio
from typing import Any

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, Query, Request

from app.core.dependencies import CurrentUser
from app.models._base import OrderAction, OrderType, ProductType
from app.models.audit_log import AuditAction
from app.models.position import Position, PositionStatus
from app.models.trade import Trade
from app.schemas.common import APIResponse
from app.schemas.trading import HoldingOut, PositionOut
from app.services import audit_service, market_data_service, order_service, position_service
from app.utils.decimal_utils import to_decimal

router = APIRouter(prefix="/positions", tags=["user-positions"])


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "0.0.0.0"


def _is_segment_market_open_now(segment_type: str | None) -> bool:
    """Server-side mirror of the apk's `isInstrumentMarketOpen`. Reject
    user-initiated squareoff calls when the segment's market is closed
    — bypasses are only available via admin force-close. Crypto + Forex
    always return True (24/7 / 24×5 segments).
    """
    from datetime import datetime as _dt
    from app.utils.time_utils import now_ist

    seg = (segment_type or "").upper()
    if "CRYPTO" in seg:
        return True
    if (
        seg == "FOREX"
        or seg == "STOCKS"
        or seg == "INDICES"
        or seg == "COMMODITIES"
        or "FOREX" in seg
        or seg.startswith("CDS")
    ):
        now: _dt = now_ist()
        wd = now.weekday()  # Mon=0 … Sun=6
        if wd == 5:  # Saturday
            return False
        if wd == 6 and now.hour < 21:  # Sunday before 21:00 IST
            return False
        return True
    now2 = now_ist()
    wd2 = now2.weekday()
    if wd2 >= 5:  # Weekend
        return False
    mins = now2.hour * 60 + now2.minute
    if seg.startswith("MCX"):
        return 9 * 60 <= mins <= 23 * 60 + 30
    # NSE / BSE equity + F&O fallback
    return 9 * 60 + 15 <= mins <= 15 * 60 + 30


def _segment_market_label(segment_type: str | None) -> str:
    seg = (segment_type or "").upper()
    if "CRYPTO" in seg:
        return "Crypto"
    if seg == "FOREX" or "FOREX" in seg or seg.startswith("CDS"):
        return "Forex"
    if seg == "COMMODITIES":
        return "Commodities"
    if seg == "STOCKS":
        return "Global stocks"
    if seg == "INDICES":
        return "Global indices"
    if seg.startswith("MCX"):
        return "MCX"
    if seg.startswith("BSE"):
        return "BSE"
    return "NSE"


def _parse_position_id(position_id: str) -> PydanticObjectId:
    """Convert the URL path param into a Mongo ObjectId, raising a clean
    HTTP 404 if it isn't a valid 24-char hex id.

    Without this guard, the frontend's optimistic synthetic IDs
    (`optimistic_<ts>`) would bubble `bson.errors.InvalidId` out of the
    route handler as a 500 — and 500s skip CORS headers, which makes the
    browser show a misleading "CORS blocked" error in the console
    (real issue: 500 from the backend). 404 lets the frontend handle it
    cleanly.
    """
    try:
        return PydanticObjectId(position_id)
    except Exception:  # bson.errors.InvalidId
        raise HTTPException(status_code=404, detail="Position not found")


def _effective_qty(p: Position) -> tuple[float, float, int]:
    """Resolve (qty_in_contracts, lots, lot_size) from a Position row.

    The stored ``p.quantity`` is the canonical contract count written at
    fill time — `order_service.place_order` resolves the lot size from
    Zerodha's CSV (NSE/BSE F&O) or the MCX_LOT_SIZES table (MCX) and
    multiplies before persisting. Trust that here; do not re-derive
    from a hardcoded table that may disagree with the exchange's
    current revision.

    The stored ``p.instrument.lot_size`` is the snapshot taken at fill
    time. For MTM display we keep it as the displayed `lot_size` /
    `lots` denominator so legacy positions opened before a lot revision
    still report their original ratio.
    """
    stored_lot = int(getattr(p.instrument, "lot_size", 0) or 1) or 1
    qty = float(p.quantity)
    lots = qty / stored_lot if stored_lot > 0 else qty
    return qty, lots, stored_lot


def _pos(p: Position) -> dict:
    """Position view.

    For USD-quoted instruments (crypto / forex) the live feed quotes in
    USD, so we keep ``avg_price`` and ``ltp`` in dollars — the UI renders
    them with a ``$`` prefix based on ``currency_quote``. Only realised
    and unrealised P&L (and margin used) are converted to INR, since
    those flow into the user's rupee wallet.
    """
    avg_native = float(str(p.avg_price))
    ltp_native = float(str(p.ltp))
    realized = float(str(p.realized_pnl))
    margin = float(str(p.margin_used))

    is_usd = market_data_service.is_usd_quoted_segment(p.segment_type) or \
        market_data_service.is_usd_quoted_segment(p.instrument.segment)
    current_rate = market_data_service.get_usd_inr_rate() if is_usd else 1.0
    open_rate = (
        float(str(p.open_usd_inr_rate))
        if (is_usd and p.open_usd_inr_rate is not None)
        else current_rate
    )

    # Canonical-lot self-heal: legacy positions opened before the canonical
    # lot tables existed got stored with `quantity = lots × stored_lot` where
    # `stored_lot` was 1 (auto-created from a half-warm Zerodha CSV cache).
    # The frontend already self-heals via `resolveQty` using the canonical
    # NIFTY=75 / BANKNIFTY=35 / SENSEX=20 etc tables, so the row shows the
    # right size and P/L. The header total — which sums `unrealized_pnl`
    # straight from this serializer — was the only place still using the
    # broken stored qty, producing a 75× understatement. Apply the same
    # canonical resolution here so the header agrees with the rows.
    effective_qty, lots_value, effective_lot = _effective_qty(p)

    if is_usd:
        unrealized_pnl_inr = (ltp_native - avg_native) * effective_qty * current_rate
        realized_pnl_inr = realized * open_rate
        # margin_used is already stored as the wallet-currency number that
        # was actually locked at order time (validator computes it in INR via
        # block_margin), so we DON'T re-multiply by FX rate here. Otherwise
        # this view would disagree with wallet.used_margin by ~80×.
        margin_inr = margin
    else:
        unrealized_pnl_inr = (ltp_native - avg_native) * effective_qty
        realized_pnl_inr = realized
        margin_inr = margin

    # Lot size echoed back so the UI can show "Long 2 lots (150 qty)" style
    # labels without re-fetching the instrument. Prefer the canonical lot
    # so the UI shows the same value the math above used.
    pos_lot_size = effective_lot

    # Peak |qty| recorded by apply_fill — preserved across full close so
    # the Closed/History tab can show the size the user actually held
    # (where ``quantity`` has been zeroed). For OPEN rows the current
    # signed `quantity` is the source of truth.
    opening_qty_raw = getattr(p, "opening_quantity", None)
    opening_qty = float(opening_qty_raw) if opening_qty_raw is not None else abs(effective_qty)

    return {
        "id": str(p.id),
        "user_id": str(p.user_id),
        "symbol": p.instrument.symbol,
        "trading_symbol": getattr(p.instrument, "trading_symbol", None),
        "exchange": str(p.instrument.exchange),
        "instrument_token": p.instrument.token,
        "segment_type": p.segment_type,
        "product_type": p.product_type.value,
        # Quantity reported in CONTRACTS (the number the exchange would
        # see), not lots. For legacy positions where the stored quantity
        # was lots × stale lot_size, the canonical resolution above turns
        # it into the right contracts count so this matches what the
        # frontend's `resolveQty` derives.
        "quantity": effective_qty,
        "opening_quantity": opening_qty,
        "lot_size": pos_lot_size,
        "lots": lots_value,
        # Prices in source currency — UI prefixes $ when currency_quote=USD.
        "avg_price": f"{avg_native:.4f}" if is_usd else f"{avg_native:.2f}",
        "ltp": f"{ltp_native:.4f}" if is_usd else f"{ltp_native:.2f}",
        # P&L + margin always in INR — that's the wallet currency.
        "realized_pnl": f"{realized_pnl_inr:.2f}",
        "unrealized_pnl": f"{unrealized_pnl_inr:.2f}",
        "margin_used": f"{margin_inr:.2f}",
        # FX context so the UI can show e.g. "USD/INR @ 83.21" next to the row
        "currency_quote": "USD" if is_usd else "INR",
        "open_usd_inr_rate": f"{open_rate:.4f}" if is_usd else None,
        "current_usd_inr_rate": f"{current_rate:.4f}" if is_usd else None,
        "stop_loss": str(p.stop_loss) if p.stop_loss is not None else None,
        "target": str(p.target) if p.target is not None else None,
        "status": p.status.value,
        "opened_at": p.opened_at.isoformat() if p.opened_at else None,
        "closed_at": p.closed_at.isoformat() if p.closed_at else None,
        # Compact tag — see Position.close_reason for the legal set.
        "close_reason": p.close_reason,
        # Original direction the user took. Stays "BUY" / "SELL" even after
        # a full close flattens `quantity` to 0 — the Closed-tab card uses
        # this so a closed long doesn't get mis-rendered as a short.
        # Falls back to inferring from `quantity` for legacy rows written
        # before this field existed.
        "opened_side": (
            p.opened_side.value if p.opened_side is not None
            else ("BUY" if p.quantity > 0 else ("SELL" if p.quantity < 0 else None))
        ),
    }


@router.get("/open", response_model=APIResponse[list[PositionOut]])
async def open_positions(user: CurrentUser):
    rows = await position_service.list_open(user.id)
    if not rows:
        return APIResponse(data=[])

    # Refresh LTP and unrealized PnL for the response (best-effort)
    # Also fetch total brokerage per position from associated trades.
    from datetime import timedelta
    tokens = [r.instrument.token for r in rows]
    oldest_open = min((r.opened_at for r in rows if r.opened_at), default=None)
    trade_q: dict[str, Any] = {
        "user_id": user.id,
        "instrument.token": {"$in": tokens},
    }
    if oldest_open is not None:
        trade_q["executed_at"] = {"$gte": oldest_open - timedelta(seconds=5)}
    trades = await Trade.find(trade_q).to_list()

    # Sum brokerage per (token, product_type)
    charges_map: dict[tuple[str, str], float] = {}
    for t in trades:
        k = (t.instrument.token, str(t.product_type.value))
        charges_map[k] = charges_map.get(k, 0.0) + float(str(t.brokerage))

    # Parallelise LTP fetch + unrealised P&L refresh across every open
    # position with asyncio.gather. Sequential awaits made this O(N) on
    # market_data latency — typically 50 ms × 10 positions = 500 ms wall
    # time. Gathered, the whole batch finishes in ~one network roundtrip.
    ltps = await asyncio.gather(
        *[market_data_service.get_ltp(r.instrument.token) for r in rows],
        return_exceptions=True,
    )
    await asyncio.gather(
        *[
            position_service.refresh_unrealized_pnl(r, ltp if not isinstance(ltp, Exception) else 0)
            for r, ltp in zip(rows, ltps)
        ],
        return_exceptions=True,
    )

    out = []
    for r in rows:
        d = _pos(r)
        k = (r.instrument.token, str(r.product_type.value))
        charges_amt = charges_map.get(k, 0.0)
        d["charges"] = f"{charges_amt:.2f}"
        # Net the displayed P&L with the commission the admin charges.
        # The user reported the broker brokerage being deducted from
        # their wallet but NOT showing in the position-card P&L number
        # — they wanted the card to read post-commission. The Position
        # document still stores RAW realized for accounting (so admin
        # reports / ledgers can decompose), but the user-facing card
        # subtracts brokerage so what they see matches what hit their
        # wallet.
        if charges_amt > 0:
            try:
                d["unrealized_pnl"] = f"{float(d['unrealized_pnl']) - charges_amt:.2f}"
                d["realized_pnl"] = f"{float(d['realized_pnl']) - charges_amt:.2f}"
            except (TypeError, ValueError):
                pass
        out.append(d)
    return APIResponse(data=out)


@router.get("/closed", response_model=APIResponse[list[PositionOut]])
async def closed_positions(user: CurrentUser):
    rows = await position_service.list_closed_today(user.id)
    if not rows:
        return APIResponse(data=[])

    # One bulk Trade fetch covers BOTH (a) the legacy opening-quantity
    # backfill for rows written before the field existed AND (b) the
    # brokerage / total-charges sum that the Closed tab renders in the
    # Brokerage column. Sorting `+executed_at` keeps the peak-qty walk
    # in chronological order.
    from datetime import timedelta as _td

    oldest = min((r.opened_at for r in rows if r.opened_at), default=None)
    tokens = list({r.instrument.token for r in rows})
    trade_q: dict[str, Any] = {
        "user_id": user.id,
        "instrument.token": {"$in": tokens},
    }
    if oldest is not None:
        trade_q["executed_at"] = {"$gte": oldest - _td(seconds=5)}
    trades = await Trade.find(trade_q).sort("+executed_at").to_list()

    by_key: dict[tuple[str, str], list[Trade]] = {}
    for t in trades:
        k = (t.instrument.token, t.product_type.value)
        by_key.setdefault(k, []).append(t)

    # Per-position attribution. Trades sharing the same (token, product_type)
    # but belonging to DIFFERENT closed-position lifecycles must not pool
    # together — bucketing only by (token, product_type) made two closed
    # XAUUSD positions both show the sum of all XAUUSD trades. We slice
    # each trade to the closed-position window it falls inside; if a
    # position has no opened_at (very legacy rows) we fall back to the
    # all-trades sum so the column doesn't blank out.
    def _trades_for_position(r: Position) -> list[Trade]:
        key = (r.instrument.token, r.product_type.value)
        bucket = by_key.get(key, [])
        if not r.opened_at:
            return bucket
        start = r.opened_at
        end = r.closed_at or r.opened_at
        # Small slack on both sides — `apply_fill` writes the Position's
        # opened_at AFTER the Trade is inserted, so the very first opening
        # trade can carry an executed_at a few ms before opened_at.
        from datetime import timedelta as _td2
        slack = _td2(seconds=5)
        return [t for t in bucket if (start - slack) <= t.executed_at <= (end + slack)]

    out: list[dict] = []
    for r in rows:
        scoped = _trades_for_position(r)

        # Legacy backfill — positions closed before the `opening_quantity`
        # field existed have it as None. Recover by walking the position's
        # OWN trades and taking the peak running |qty|.
        if getattr(r, "opening_quantity", None) is None and scoped:
            running = 0.0
            peak = 0.0
            for t in scoped:
                signed = float(t.quantity) if t.action == OrderAction.BUY else -float(t.quantity)
                running += signed
                if abs(running) > peak:
                    peak = abs(running)
            r.opening_quantity = peak or None

        # Sum total_charges (brokerage + any other charges recorded on the
        # trade row) for THIS closed position's trades only.
        charges_total = 0.0
        for t in scoped:
            charges_total += float(str(getattr(t, "total_charges", None) or t.brokerage or 0))

        d = _pos(r)
        d["charges"] = f"{charges_total:.2f}"
        # Net the realized P&L the APK shows on the Closed-tab card with
        # the brokerage that was actually charged on this position's
        # life-cycle. Without this the user sees "P&L +47.75" on a row
        # where the wallet was actually debited by 47.75 − close-leg
        # brokerage. The stored Position.realized_pnl is left raw so
        # admin reports can still decompose gross vs net.
        if charges_total > 0:
            try:
                d["realized_pnl"] = f"{float(d['realized_pnl']) - charges_total:.2f}"
                # Unrealized is 0 on a closed row by definition, but keep
                # the symmetric subtraction in case the serializer ever
                # populates it.
                d["unrealized_pnl"] = f"{float(d['unrealized_pnl']) - 0:.2f}"
            except (TypeError, ValueError):
                pass
        out.append(d)
    return APIResponse(data=out)


@router.post("/{position_id}/squareoff", response_model=APIResponse[dict])
async def squareoff(
    position_id: str,
    user: CurrentUser,
    request: Request,
    lots: float = Query(default=0.0, ge=0.0, description="Partial close size in lots; 0 = close full position"),
):
    p = await Position.get(_parse_position_id(position_id))
    if p is None or p.user_id != user.id:
        raise HTTPException(status_code=404, detail="Position not found")
    if p.status != PositionStatus.OPEN or p.quantity == 0:
        raise HTTPException(status_code=400, detail="Position already closed")

    # ── Market-hours guard ──────────────────────────────────────────
    # Defence-in-depth: the apk already blocks the tap when the segment
    # market is closed, but the web can also call this endpoint and an
    # attacker could bypass the client guard with a direct curl. Only
    # admin force-close (admin trading.py:admin_squareoff) should be
    # able to flatten positions outside trading hours.
    if not _is_segment_market_open_now(p.segment_type):
        raise HTTPException(
            status_code=400,
            detail=f"{_segment_market_label(p.segment_type)} market is closed — try during trading hours.",
        )

    # ── Risk: hold-time minimum ─────────────────────────────────────
    # Admin's Risk Management page sets a floor on how quickly a profitable
    # OR losing position may be closed. Stops scalpers from hammering the
    # backend / abusing latency arbitrage. Skip for MIS auto-squareoff
    # (no `placed_from`); fire only on user-initiated closes.
    from datetime import datetime as _dt, timezone as _tz
    from app.services import netting_service as _ns

    risk = (await _ns.get_effective_risk(str(user.id)))["settings"]
    profit_min = int(risk.get("profitTradeHoldMinSeconds") or 0)
    loss_min = int(risk.get("lossTradeHoldMinSeconds") or 0)
    if (profit_min or loss_min) and p.opened_at:
        opened = p.opened_at if p.opened_at.tzinfo else p.opened_at.replace(tzinfo=_tz.utc)
        held = (_dt.now(_tz.utc) - opened).total_seconds()
        # In-profit vs in-loss decided by latest unrealised P&L on the row.
        try:
            cur_pnl = float(str(p.unrealized_pnl))
        except Exception:
            cur_pnl = 0.0
        floor = profit_min if cur_pnl >= 0 else loss_min
        if floor and held < floor:
            remaining = int(floor - held)
            kind = "profitable" if cur_pnl >= 0 else "losing"
            raise HTTPException(
                status_code=400,
                detail=f"Hold-time guard: {kind} trade must be held for {floor}s "
                       f"(wait {remaining}s more before closing).",
            )

    # Place an opposite-side market order. When `lots` is provided we close
    # exactly that slice of the position (clamped to <= total). Otherwise we
    # close everything.
    action = OrderAction.SELL if p.quantity > 0 else OrderAction.BUY
    full_qty = abs(p.quantity)
    full_lots = max(0.01, full_qty / max(1, p.instrument.lot_size or 1))
    close_lots = full_lots if lots <= 0 else min(float(lots), full_lots)
    # `force_quantity` flattens exactly what's open — closes the actual
    # stored quantity regardless of whether `lot_size` has drifted (legacy
    # positions stored as `lots × 1`).  For partial closes we scale the
    # force-qty by the requested lots / full-lots ratio so partial closes
    # still work proportionally.
    close_qty = full_qty if close_lots >= full_lots else full_qty * (close_lots / full_lots)
    o = await order_service.place_order(
        user=user,
        payload={
            "token": p.instrument.token,
            "action": action.value,
            "order_type": OrderType.MARKET.value,
            "product_type": p.product_type.value,
            "lots": close_lots,
            "force_quantity": close_qty,
            "placed_from": "WEB",
            "is_squareoff": True,
        },
    )

    # If this squareoff actually flattened the position, stamp the
    # close_reason so the Closed tab shows "Closed by User". The matching
    # engine mutated the row in place inside place_order, so we re-read.
    try:
        fresh = await Position.get(p.id)
        if (
            fresh is not None
            and fresh.status == PositionStatus.CLOSED
            and not fresh.close_reason
        ):
            fresh.close_reason = "USER"
            await fresh.save()
    except Exception:
        pass

    await audit_service.log_event(
        action=AuditAction.SQUAREOFF,
        entity_type="Position",
        entity_id=p.id,
        actor_id=user.id,
        target_user_id=user.id,
        ip_address=_client_ip(request),
        user_agent=request.headers.get("user-agent"),
        metadata={
            "symbol": p.instrument.symbol,
            "closed_lots": close_lots,
            "closed_qty": close_qty,
        },
    )
    return APIResponse(data={"order_id": str(o.id), "status": o.status.value, "closed_lots": close_lots})


def _validate_sl_tp_direction(
    *,
    avg_price: float,
    is_long: bool,
    sl: float | None,
    tp: float | None,
) -> None:
    """Reject SL/TP on the wrong side of entry. A long with TP below avg
    (or SL above avg) would auto-trigger immediately and close the position
    the moment the next tick lands — that's never what the user means."""
    if sl is not None and sl > 0:
        if is_long and sl >= avg_price:
            raise HTTPException(
                status_code=400,
                detail=f"Stop loss ₹{sl} must be BELOW entry ₹{avg_price:.2f} for a long position",
            )
        if not is_long and sl <= avg_price:
            raise HTTPException(
                status_code=400,
                detail=f"Stop loss ₹{sl} must be ABOVE entry ₹{avg_price:.2f} for a short position",
            )
    if tp is not None and tp > 0:
        if is_long and tp <= avg_price:
            raise HTTPException(
                status_code=400,
                detail=f"Target ₹{tp} must be ABOVE entry ₹{avg_price:.2f} for a long position",
            )
        if not is_long and tp >= avg_price:
            raise HTTPException(
                status_code=400,
                detail=f"Target ₹{tp} must be BELOW entry ₹{avg_price:.2f} for a short position",
            )


@router.put("/{position_id}/sl-tp", response_model=APIResponse[dict])
async def update_sl_tp(position_id: str, payload: dict, user: CurrentUser):
    """Edit the stop-loss and target on an open position. Pass null/0 to clear."""
    from bson import Decimal128

    p = await Position.get(_parse_position_id(position_id))
    if p is None or p.user_id != user.id:
        raise HTTPException(status_code=404, detail="Position not found")
    if p.status != PositionStatus.OPEN:
        raise HTTPException(status_code=400, detail="Position is not open")

    def _to_float(v: Any) -> float | None:
        if v in (None, "", 0, "0"):
            return None
        try:
            return float(str(v))
        except (TypeError, ValueError):
            return None

    sl_in = _to_float(payload.get("stop_loss")) if "stop_loss" in payload else None
    tp_in = _to_float(payload.get("target")) if "target" in payload else None
    avg_price = float(str(p.avg_price))
    is_long = p.quantity > 0
    _validate_sl_tp_direction(avg_price=avg_price, is_long=is_long, sl=sl_in, tp=tp_in)

    if "stop_loss" in payload:
        sl = payload["stop_loss"]
        p.stop_loss = (
            Decimal128(str(sl))
            if sl not in (None, "", 0, "0")
            else None
        )
    if "target" in payload:
        tp = payload["target"]
        p.target = (
            Decimal128(str(tp))
            if tp not in (None, "", 0, "0")
            else None
        )
    await p.save()
    return APIResponse(data=_pos(p))


@router.get("/active-trades", response_model=APIResponse[list])
async def list_active_trades(user: CurrentUser):
    """Per-fill view of currently-open exposure.

    Returns one row per Trade record where:
      • the user's matching Position is still OPEN, AND
      • the trade's action matches the position direction (a BUY contributes
        to a long, a SELL to a short — opposite-side fills are closing legs
        and don't represent ongoing exposure).

    The aggregation model means closing one row partially closes the whole
    position at its weighted-average price (FIFO/avg accounting). P&L per row
    is computed against the row's own fill price so the trader sees the
    unrealised gain on each individual entry.
    """
    open_positions = await Position.find(
        Position.user_id == user.id, Position.status == PositionStatus.OPEN
    ).to_list()
    if not open_positions:
        return APIResponse(data=[])

    # Map (instrument_token, product_type) → Position for fast lookup.
    pos_by_key: dict[tuple[str, str], Position] = {
        (p.instrument.token, str(p.product_type.value)): p for p in open_positions
    }
    tokens = [p.instrument.token for p in open_positions]

    # Pull every trade for these instruments since just before the OLDEST
    # position open time. We subtract a buffer because trade.executed_at is
    # set BEFORE position.opened_at (trade is inserted first in the engine).
    from datetime import timedelta
    oldest_open = min((p.opened_at for p in open_positions if p.opened_at), default=None)
    trade_q: dict[str, Any] = {
        "user_id": user.id,
        "instrument.token": {"$in": tokens},
    }
    if oldest_open is not None:
        trade_q["executed_at"] = {"$gte": oldest_open - timedelta(seconds=5)}
    trades = await Trade.find(trade_q).sort("-executed_at").to_list()

    # Fallback: if Beanie raw-dict query returns nothing but positions exist,
    # try with explicit ObjectId cast (guards against type mismatch).
    if not trades and open_positions:
        from bson import ObjectId as _OID
        trade_q_fallback: dict[str, Any] = {
            "user_id": _OID(str(user.id)),
            "instrument.token": {"$in": tokens},
        }
        trades = await Trade.find(trade_q_fallback).sort("-executed_at").to_list()

    # Live LTP per token + FX rate (USD-quoted instruments report price in $)
    ltp_by_token: dict[str, float] = {}
    for tok in set(tokens):
        try:
            ltp_by_token[tok] = float(await market_data_service.get_ltp(tok))
        except Exception:
            ltp_by_token[tok] = 0.0
    usd_inr = market_data_service.get_usd_inr_rate()

    # ── FIFO matching ─────────────────────────────────────────────────
    # Without this, closing one BUY fill via the active-trades "Close"
    # button reduces the underlying position but the BUY trade record
    # still exists, so the next refetch shows it again. User perception:
    # "trade close hi nahi ho rahi". FIFO-consume opposite-side trades
    # against same-side trades (oldest first) and drop any same-side
    # trade whose entire qty has been closed out.
    from collections import defaultdict
    from datetime import datetime as _datetime

    # Group trades per (token, product) — sort same-side ASC (oldest
    # first so FIFO consumes the earliest fill), opposite-side total.
    same_side_by_key: dict[tuple[str, str], list[Any]] = defaultdict(list)
    opposite_total_by_key: dict[tuple[str, str], float] = defaultdict(float)
    for t in trades:
        key = (t.instrument.token, str(t.product_type.value))
        p = pos_by_key.get(key)
        if p is None:
            continue
        is_long = p.quantity > 0
        is_buy = t.action == OrderAction.BUY
        if is_long == is_buy:
            same_side_by_key[key].append(t)
        else:
            opposite_total_by_key[key] += t.quantity

    # Sort each bucket oldest-first so FIFO consumes from the earliest
    # entry. Compute remaining qty per same-side trade.
    remaining_qty: dict[str, float] = {}
    for key, side_trades in same_side_by_key.items():
        side_trades.sort(key=lambda tr: tr.executed_at or _datetime.min)
        to_consume = opposite_total_by_key.get(key, 0.0)
        for tr in side_trades:
            tq = tr.quantity
            if to_consume <= 0:
                remaining_qty[str(tr.id)] = tq
                continue
            consume = min(tq, to_consume)
            to_consume -= consume
            leftover = tq - consume
            if leftover > 1e-9:
                remaining_qty[str(tr.id)] = leftover

    rows: list[dict[str, Any]] = []
    for t in trades:
        key = (t.instrument.token, str(t.product_type.value))
        p = pos_by_key.get(key)
        if p is None:
            continue
        # Direction filter: only keep fills that ADD to the current direction.
        # BUYs are kept for longs (qty > 0), SELLs for shorts (qty < 0).
        if p.quantity > 0 and t.action != OrderAction.BUY:
            continue
        if p.quantity < 0 and t.action != OrderAction.SELL:
            continue

        # Skip trades whose qty has been fully closed by opposite-side fills.
        qty = remaining_qty.get(str(t.id), 0.0)
        if qty <= 0:
            continue

        price = float(str(t.price))
        ltp = ltp_by_token.get(t.instrument.token, 0.0)
        is_usd = market_data_service.is_usd_quoted_segment(p.segment_type) or \
            market_data_service.is_usd_quoted_segment(p.instrument.segment)
        fx = usd_inr if is_usd else 1.0
        direction = 1 if t.action == OrderAction.BUY else -1
        gross_pnl_inr = direction * (ltp - price) * qty * fx if ltp > 0 else 0.0
        # Subtract this fill's commission so the per-trade row shows
        # the user's true booked P&L — same correction we apply on the
        # /open and /closed position endpoints. The user wants the
        # commission the admin set to be reflected in the displayed P&L
        # rather than only hidden in the wallet ledger.
        try:
            brokerage_inr = float(str(t.brokerage)) if t.brokerage is not None else 0.0
        except (TypeError, ValueError):
            brokerage_inr = 0.0
        pnl_inr = gross_pnl_inr - brokerage_inr

        # Per-fill margin attribution. Position.margin_used is the
        # aggregate locked margin for the whole position; we apportion
        # it across each still-open same-side trade proportional to
        # this trade's remaining qty. Without this the frontend's
        # `r.margin_used / r.margin` keys both fall through to 0 and
        # the Used / Holding columns render as "₹0.00" for every row.
        # `holding_margin` is the carryforward (NRML) requirement —
        # for MIS positions that's 1.4× of the locked intraday, for
        # NRML (already overnight) it's the same as `used`.
        pos_total_qty = abs(float(p.quantity)) or 1.0
        pos_margin = float(str(p.margin_used or 0))
        trade_share = qty / pos_total_qty if pos_total_qty > 0 else 0.0
        used_margin_inr = round(pos_margin * trade_share, 2)
        is_mis = str(p.product_type.value).upper() == "MIS"
        holding_margin_inr = round(
            used_margin_inr * (1.4 if is_mis else 1.0), 2
        )

        rows.append({
            "id": str(t.id),
            "trade_number": t.trade_number,
            "executed_at": t.executed_at.isoformat() if t.executed_at else None,
            "position_id": str(p.id),
            "symbol": p.instrument.symbol,
            "trading_symbol": getattr(p.instrument, "trading_symbol", None),
            "exchange": str(p.instrument.exchange),
            "segment": p.segment_type,
            "instrument_token": p.instrument.token,
            "currency_quote": "USD" if is_usd else "INR",
            "action": t.action.value,
            "side": t.action.value,  # alias for the UI
            "product_type": p.product_type.value,
            "quantity": qty,
            "lots": qty / max(1, p.instrument.lot_size or 1),
            "lot_size": p.instrument.lot_size or 1,
            "price": f"{price:.4f}" if is_usd else f"{price:.2f}",
            "ltp": f"{ltp:.4f}" if is_usd else f"{ltp:.2f}",
            "stop_loss": str(p.stop_loss) if p.stop_loss is not None else None,
            "target": str(p.target) if p.target is not None else None,
            "pnl": f"{pnl_inr:.2f}",
            "brokerage": str(t.brokerage),
            # Per-fill margin (INR). `used_margin` = currently locked;
            # `holding_margin` = what would lock if rolled overnight.
            "used_margin": f"{used_margin_inr:.2f}",
            "margin_used": f"{used_margin_inr:.2f}",  # alias for FE
            "margin": f"{used_margin_inr:.2f}",       # alias for FE
            "holding_margin": f"{holding_margin_inr:.2f}",
        })
    return APIResponse(data=rows)


@router.post("/active-trades/{trade_id}/close", response_model=APIResponse[dict])
async def close_active_trade(trade_id: str, user: CurrentUser):
    """Close exactly the slice represented by this trade — issues an opposite
    market order for the trade's quantity. The P&L is realised against the
    position's weighted-average price, not the trade's individual fill price."""
    try:
        oid = PydanticObjectId(trade_id)
    except Exception:
        raise HTTPException(status_code=404, detail="Trade not found")
    t = await Trade.get(oid)
    if t is None or t.user_id != user.id:
        raise HTTPException(status_code=404, detail="Trade not found")
    # Find the matching open position
    p = await Position.find_one(
        Position.user_id == user.id,
        Position.instrument.token == t.instrument.token,
        Position.product_type == t.product_type,
        Position.status == PositionStatus.OPEN,
    )
    if p is None or p.quantity == 0:
        raise HTTPException(status_code=400, detail="No open position to close this trade against")

    close_qty = min(float(t.quantity), abs(float(p.quantity)))
    close_lots = max(0.01, close_qty / max(1, p.instrument.lot_size or 1))
    action = OrderAction.SELL if p.quantity > 0 else OrderAction.BUY
    o = await order_service.place_order(
        user=user,
        payload={
            "token": p.instrument.token,
            "action": action.value,
            "order_type": OrderType.MARKET.value,
            "product_type": p.product_type.value,
            "lots": close_lots,
            "force_quantity": close_qty,
            "placed_from": "WEB",
            "is_squareoff": True,
        },
    )

    # Stamp USER close_reason if the trade close actually flattened the
    # parent position. Same pattern as the /squareoff endpoint.
    try:
        fresh = await Position.get(p.id)
        if (
            fresh is not None
            and fresh.status == PositionStatus.CLOSED
            and not fresh.close_reason
        ):
            fresh.close_reason = "USER"
            await fresh.save()
    except Exception:
        pass

    return APIResponse(data={"order_id": str(o.id), "status": o.status.value, "closed_lots": close_lots})


@router.put("/active-trades/{trade_id}/sl-tp", response_model=APIResponse[dict])
async def update_active_trade_sl_tp(trade_id: str, payload: dict, user: CurrentUser):
    """SL/TP lives at the position level (FIFO/avg accounting — we don't track
    per-fill stops), so this delegates to the parent position's SL/TP."""
    from bson import Decimal128

    try:
        oid = PydanticObjectId(trade_id)
    except Exception:
        raise HTTPException(status_code=404, detail="Trade not found")
    t = await Trade.get(oid)
    if t is None or t.user_id != user.id:
        raise HTTPException(status_code=404, detail="Trade not found")
    p = await Position.find_one(
        Position.user_id == user.id,
        Position.instrument.token == t.instrument.token,
        Position.product_type == t.product_type,
        Position.status == PositionStatus.OPEN,
    )
    if p is None:
        raise HTTPException(status_code=400, detail="Parent position not open")

    def _to_float(v: Any) -> float | None:
        if v in (None, "", 0, "0"):
            return None
        try:
            return float(str(v))
        except (TypeError, ValueError):
            return None

    sl_in = _to_float(payload.get("stop_loss")) if "stop_loss" in payload else None
    tp_in = _to_float(payload.get("target")) if "target" in payload else None
    avg_price = float(str(p.avg_price))
    is_long = p.quantity > 0
    _validate_sl_tp_direction(avg_price=avg_price, is_long=is_long, sl=sl_in, tp=tp_in)

    if "stop_loss" in payload:
        sl = payload["stop_loss"]
        p.stop_loss = Decimal128(str(sl)) if sl not in (None, "", 0, "0") else None
    if "target" in payload:
        tp = payload["target"]
        p.target = Decimal128(str(tp)) if tp not in (None, "", 0, "0") else None
    await p.save()
    return APIResponse(data=_pos(p))


@router.get("/pnl-summary", response_model=APIResponse[dict])
async def positions_pnl_summary(user: CurrentUser):
    """Per-user PnL windows for the dashboard cards (Today / Week / Last week).

    today_pnl     — realised P&L since IST midnight + current open unrealised.
    week_pnl      — same, since the most recent IST Sunday 00:00.
    last_week_pnl — total realised P&L of the previous Sun→Sat window.

    NOTE on FX: ``Position.realized_pnl`` and ``unrealized_pnl`` are stored in
    the instrument's NATIVE currency (USD for crypto/forex). We convert each
    USD-quoted position to INR using the position's locked-at-open USD/INR
    rate (realised) or the live rate (unrealised), matching what ``_pos()``
    sends to the live-positions strip.
    """
    from datetime import datetime as _dt, timedelta as _td, timezone as _tz

    IST = _tz(_td(hours=5, minutes=30))
    now_ist = _dt.now(IST)
    today_start_ist = now_ist.replace(hour=0, minute=0, second=0, microsecond=0)
    days_back = (now_ist.weekday() + 1) % 7
    week_start_ist = today_start_ist - _td(days=days_back)
    last_week_start_ist = week_start_ist - _td(days=7)
    last_week_end_ist = week_start_ist  # exclusive

    today_start = today_start_ist.astimezone(_tz.utc)
    week_start = week_start_ist.astimezone(_tz.utc)
    last_week_start = last_week_start_ist.astimezone(_tz.utc)
    last_week_end = last_week_end_ist.astimezone(_tz.utc)

    current_usd_inr = market_data_service.get_usd_inr_rate()

    def _is_usd(p: Position) -> bool:
        return market_data_service.is_usd_quoted_segment(p.segment_type) or \
            market_data_service.is_usd_quoted_segment(p.instrument.segment)

    def _realised_inr(p: Position) -> float:
        raw = float(str(p.realized_pnl))
        if not _is_usd(p):
            return raw
        rate = (
            float(str(p.open_usd_inr_rate))
            if p.open_usd_inr_rate is not None
            else current_usd_inr
        )
        return raw * rate

    async def _realised_in(window_start, window_end=None) -> float:
        rng: dict[str, Any] = {"$gte": window_start}
        if window_end is not None:
            rng["$lt"] = window_end
        # closed_at OR updated_at falls in window — covers fully-closed and
        # partially-closed-but-still-open positions.
        rows = await Position.find(
            {
                "user_id": user.id,
                "$or": [{"closed_at": rng}, {"updated_at": rng}],
            }
        ).to_list()
        return sum(_realised_inr(p) for p in rows)

    today_realised = await _realised_in(today_start)
    week_realised = await _realised_in(week_start)
    last_week_realised = await _realised_in(last_week_start, last_week_end)

    open_positions = await Position.find(
        {"user_id": user.id, "status": PositionStatus.OPEN.value}
    ).to_list()

    # Parallel LTP + unrealised refresh — same optimisation as /open above.
    # Sequential awaits across N open positions added linear latency to a
    # 10-second-polled endpoint; gather keeps total wall time ≈ slowest leg.
    if open_positions:
        ltps = await asyncio.gather(
            *[market_data_service.get_ltp(p.instrument.token) for p in open_positions],
            return_exceptions=True,
        )
        await asyncio.gather(
            *[
                position_service.refresh_unrealized_pnl(
                    p, ltp if not isinstance(ltp, Exception) else 0
                )
                for p, ltp in zip(open_positions, ltps)
            ],
            return_exceptions=True,
        )

    total_unrealised = 0.0
    for p in open_positions:
        # Recompute from canonical-lot qty rather than reading the stored
        # `unrealized_pnl`. That stored value was written by
        # `refresh_unrealized_pnl` using `p.quantity` directly, which is
        # wrong for legacy positions where qty was saved as lots. The
        # frontend rows show the canonical number; this summary must agree.
        eff_qty, _, _ = _effective_qty(p)
        avg = float(str(p.avg_price))
        ltp_native = float(str(p.ltp))
        raw = (ltp_native - avg) * eff_qty
        if _is_usd(p):
            raw *= current_usd_inr
        total_unrealised += raw

    return APIResponse(
        data={
            "today_pnl": round(today_realised + total_unrealised, 2),
            "today_realised": round(today_realised, 2),
            "open_unrealised": round(total_unrealised, 2),
            "week_pnl": round(week_realised + total_unrealised, 2),
            "week_realised": round(week_realised, 2),
            "last_week_pnl": round(last_week_realised, 2),
            "today_start": today_start.isoformat(),
            "week_start": week_start.isoformat(),
            "last_week_start": last_week_start.isoformat(),
            "last_week_end": last_week_end.isoformat(),
            "usd_inr_rate": round(current_usd_inr, 4),
        }
    )


@router.post("/squareoff-all", response_model=APIResponse[dict])
async def squareoff_all(user: CurrentUser):
    from datetime import datetime as _dt, timezone as _tz
    from app.services import netting_service as _ns

    risk = (await _ns.get_effective_risk(str(user.id)))["settings"]
    profit_min = int(risk.get("profitTradeHoldMinSeconds") or 0)
    loss_min = int(risk.get("lossTradeHoldMinSeconds") or 0)

    rows = await position_service.list_open(user.id)
    placed = 0
    blocked = 0
    blocked_by_market_closed = 0
    for r in rows:
        if r.quantity == 0:
            continue
        # ── Market-hours gate ──────────────────────────────────────
        # Defence-in-depth: the apk pre-filters positions whose market
        # is closed before issuing per-position squareoff calls (so the
        # bulk endpoint mostly receives only tradable rows). The server
        # still enforces it here for web / direct-API callers and so
        # the user can't bypass via curl. Crypto + Forex always pass
        # (24/7 / 24x5).
        if not _is_segment_market_open_now(r.segment_type):
            blocked_by_market_closed += 1
            continue
        # Per-row hold-time gate: skip (don't fail the whole batch) when the
        # row is too young. The user gets a count of how many were blocked.
        if (profit_min or loss_min) and r.opened_at:
            opened = r.opened_at if r.opened_at.tzinfo else r.opened_at.replace(tzinfo=_tz.utc)
            held = (_dt.now(_tz.utc) - opened).total_seconds()
            try:
                cur_pnl = float(str(r.unrealized_pnl))
            except Exception:
                cur_pnl = 0.0
            floor = profit_min if cur_pnl >= 0 else loss_min
            if floor and held < floor:
                blocked += 1
                continue
        action = OrderAction.SELL if r.quantity > 0 else OrderAction.BUY
        qty = abs(r.quantity)
        lots = max(1, qty // max(1, r.instrument.lot_size or 1))
        try:
            await order_service.place_order(
                user=user,
                payload={
                    "token": r.instrument.token,
                    "action": action.value,
                    "order_type": OrderType.MARKET.value,
                    "product_type": r.product_type.value,
                    "lots": lots,
                    "force_quantity": qty,
                    "is_squareoff": True,
                    "placed_from": "WEB",
                },
            )
            placed += 1
            # Stamp USER close_reason on every row that actually closed.
            # Done per-row so partial flatten failures don't break the rest.
            try:
                fresh = await Position.get(r.id)
                if (
                    fresh is not None
                    and fresh.status == PositionStatus.CLOSED
                    and not fresh.close_reason
                ):
                    fresh.close_reason = "USER"
                    await fresh.save()
            except Exception:
                pass
        except Exception:
            continue
    return APIResponse(
        data={
            "squared_off": placed,
            "total": len(rows),
            "blocked_by_hold_time": blocked,
            "blocked_by_market_closed": blocked_by_market_closed,
        }
    )


# ── Holdings ──────────────────────────────────────────────────────────
holdings_router = APIRouter(prefix="/holdings", tags=["user-holdings"])


@holdings_router.get("", response_model=APIResponse[list[HoldingOut]])
async def list_holdings(user: CurrentUser):
    rows = await position_service.list_holdings(user.id)
    out = []
    for r in rows:
        ltp = await market_data_service.get_ltp(r.instrument.token)
        from bson import Decimal128
        r.ltp = Decimal128(str(ltp))
        out.append(
            {
                "id": str(r.id),
                "user_id": str(r.user_id),
                "symbol": r.instrument.symbol,
                "exchange": str(r.instrument.exchange),
                "instrument_token": r.instrument.token,
                "quantity": r.quantity,
                "avg_price": str(r.avg_price),
                "ltp": str(r.ltp),
                "invested_value": str(r.invested_value),
                "current_value": str(r.current_value),
                "pnl": str(r.pnl),
                "pnl_percentage": r.pnl_percentage,
            }
        )
    return APIResponse(data=out)
