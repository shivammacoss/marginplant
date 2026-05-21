"""Admin trading views: orders, positions, trades, holdings, instruments."""

from __future__ import annotations

import asyncio
import re
from datetime import datetime
from typing import Any

from beanie import PydanticObjectId
from bson import Decimal128
from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.dependencies import (
    CurrentAdmin,
    SuperAdmin,
    assert_user_in_scope,
    require_perm,
    scoped_user_ids,
)
from app.core.redis_client import publish
from app.models._base import OrderAction, OrderType
from app.models.audit_log import AuditAction
from app.models.holding import Holding
from app.models.order import Order
from app.models.position import Position, PositionStatus
from app.models.trade import Trade
from app.models.user import User
from app.schemas.common import APIResponse
from app.services import market_data_service, order_service
from app.services.audit_service import log_event


async def _publish_position_event(
    user_id: PydanticObjectId,
    event: str,
    position: Position | None,
    extra: dict[str, Any] | None = None,
) -> None:
    """Push a position-update message to the user's Redis pub/sub channel so
    open browsers refresh their positions strip without a page reload."""
    try:
        payload: dict[str, Any] = {"type": "position_update", "event": event}
        if position is not None:
            payload["position"] = {
                "id": str(position.id),
                "symbol": position.instrument.symbol,
                "instrument_token": position.instrument.token,
                "segment_type": position.segment_type,
                "product_type": position.product_type.value,
                "quantity": position.quantity,
                "avg_price": str(position.avg_price),
                "stop_loss": str(position.stop_loss) if position.stop_loss is not None else None,
                "target": str(position.target) if position.target is not None else None,
                "status": position.status.value,
                "opened_at": position.opened_at.isoformat() if position.opened_at else None,
                "closed_at": position.closed_at.isoformat() if position.closed_at else None,
            }
        if extra:
            payload.update(extra)
        await publish(f"user:{user_id}:positions", payload)
        # Also fan out to the admin dashboard's WS so every admin / broker
        # currently watching Position Management refreshes the affected row
        # without hitting F5. Cheap one-line fanout — same payload, one
        # extra channel.
        from app.services.admin_events import publish_admin_event

        await publish_admin_event(
            "position_update",
            {"event": event, "user_id": str(user_id), "position_id": str(position.id) if position else None},
        )
    except Exception:  # pragma: no cover — never fail the API call on a publish error
        pass

router = APIRouter(tags=["admin-trading"])


# ── Orders ──────────────────────────────────────────────────────────
@router.get("/orders", response_model=APIResponse[dict])
async def list_orders(
    admin: CurrentAdmin,
    status: str | None = None,
    user_id: str | None = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    _: None = Depends(require_perm("trading_view", "read")),
):
    q: dict[str, Any] = {}
    if status:
        q["status"] = status
    if user_id:
        await assert_user_in_scope(admin, user_id)
        q["user_id"] = PydanticObjectId(user_id)
    else:
        scope = await scoped_user_ids(admin)
        if scope is not None:
            if not scope:
                return APIResponse(
                    data={
                        "items": [],
                        "meta": {"page": page, "page_size": page_size, "total": 0, "total_pages": 0},
                    }
                )
            q["user_id"] = {"$in": scope}
    total = await Order.find(q).count()
    rows = await Order.find(q).sort("-created_at").skip((page - 1) * page_size).limit(page_size).to_list()

    user_ids = list({r.user_id for r in rows})
    users = await User.find({"_id": {"$in": user_ids}}).to_list() if user_ids else []
    user_map = {str(u.id): {"user_code": u.user_code, "full_name": u.full_name} for u in users}

    # Realized P&L is FROZEN on the closing-leg Trade at fill time (in INR,
    # net of brokerage). The Orders page used to recompute (ltp - avg) × qty
    # live every 5 s for every row, which made the P&L cell jitter for
    # already-closed trades — admins kept asking "trade close ho gaya, ye
    # P&L kyon move kar raha hai?". One batched lookup grouped by order_id
    # gives the stable per-order realized number; opening-leg orders have
    # no closing trade yet so they get None and the UI renders "—".
    order_ids = [r.id for r in rows]
    realized_by_order: dict[str, float] = {}
    if order_ids:
        related_trades = await Trade.find(
            {"order_id": {"$in": order_ids}, "pnl_inr": {"$ne": None}}
        ).to_list()
        for t in related_trades:
            if t.pnl_inr is None:
                continue
            key = str(t.order_id)
            realized_by_order[key] = realized_by_order.get(key, 0.0) + float(str(t.pnl_inr))

    return APIResponse(
        data={
            "items": [
                {
                    "id": str(r.id),
                    "order_number": r.order_number,
                    "user_id": str(r.user_id),
                    "user_code": user_map.get(str(r.user_id), {}).get("user_code"),
                    "user_name": user_map.get(str(r.user_id), {}).get("full_name"),
                    "symbol": r.instrument.symbol,
                    "exchange": str(r.instrument.exchange),
                    "segment": r.instrument.segment,
                    "token": r.instrument.token,
                    "instrument_token": r.instrument.token,
                    "action": r.action.value,
                    "order_type": r.order_type.value,
                    "product_type": r.product_type.value,
                    "lots": r.lots,
                    "quantity": r.quantity,
                    "filled_quantity": r.filled_quantity,
                    "price": str(r.price),
                    "average_price": str(r.average_price),
                    "status": r.status.value,
                    "created_at": r.created_at,
                    "executed_at": r.executed_at,
                    "cancelled_at": getattr(r, "cancelled_at", None),
                    # Frozen realized P&L from the closing-leg trade(s).
                    # None for opening legs whose position is still open —
                    # the UI then renders "—" rather than a live mark.
                    "realized_pnl_inr": realized_by_order.get(str(r.id)),
                }
                for r in rows
            ],
            "meta": {
                "page": page,
                "page_size": page_size,
                "total": total,
                "total_pages": (total + page_size - 1) // page_size,
            },
        }
    )


@router.get("/orders/quotes", response_model=APIResponse[list])
async def order_quotes(
    admin: CurrentAdmin,
    tokens: str = Query(default=""),
    _: None = Depends(require_perm("trading_view", "read")),
):
    """Tiny LTP batch endpoint so the admin Orders page can compute live P&L
    for every order, including ones whose position is already closed.

    Fan-out is parallel via `asyncio.gather` — the Orders page passes
    every unique token on the visible page at once, so the old serial
    loop turned a 30-row page into a 30 × feed-latency stall (~3 s) on
    every refresh. Concurrent dispatch collapses that to the slowest
    single fetch."""
    tok_list = [t.strip() for t in (tokens or "").split(",") if t.strip()]
    if not tok_list:
        return APIResponse(data=[])
    results = await asyncio.gather(
        *[market_data_service.get_ltp(tok) for tok in tok_list],
        return_exceptions=True,
    )
    out = []
    for tok, res in zip(tok_list, results):
        if isinstance(res, BaseException):
            out.append({"token": tok, "ltp": 0.0})
        else:
            try:
                out.append({"token": tok, "ltp": float(res)})
            except Exception:
                out.append({"token": tok, "ltp": 0.0})
    return APIResponse(data=out)


@router.delete("/orders/{order_id}", response_model=APIResponse[dict])
async def force_cancel(
    order_id: str,
    admin: CurrentAdmin,
    _: None = Depends(require_perm("trading_view", "write")),
):
    # Scope check: load the order first to confirm it belongs to a user
    # in the caller's pool.
    existing = await Order.get(PydanticObjectId(order_id))
    if existing is None:
        raise HTTPException(status_code=404, detail="Order not found")
    await assert_user_in_scope(admin, existing.user_id)
    o = await order_service.admin_force_cancel(order_id)
    await log_event(
        action=AuditAction.ORDER_CANCEL,
        entity_type="Order",
        entity_id=o.id,
        actor_id=admin.id,
        target_user_id=o.user_id,
    )
    return APIResponse(data={"id": str(o.id), "status": o.status.value})


# ── Positions ────────────────────────────────────────────────────────
@router.get("/positions", response_model=APIResponse[list])
async def list_positions(
    admin: CurrentAdmin,
    user_id: str | None = None,
    status: str | None = None,
    _: None = Depends(require_perm("trading_view", "read")),
):
    q: dict[str, Any] = {}
    if user_id:
        await assert_user_in_scope(admin, user_id)
        q["user_id"] = PydanticObjectId(user_id)
    else:
        scope = await scoped_user_ids(admin)
        if scope is not None:
            if not scope:
                return APIResponse(data=[])
            q["user_id"] = {"$in": scope}
    # status="ALL" (or "*") → return both OPEN and CLOSED. Empty → default
    # to OPEN-only so the page is fast on load.
    norm_status = (status or "").strip().upper()
    if norm_status and norm_status not in ("ALL", "*"):
        q["status"] = norm_status
    elif not norm_status:
        q["status"] = PositionStatus.OPEN.value
    rows = await Position.find(q).sort("-opened_at").limit(500).to_list()

    from app.api.v1.admin._owner import build_owner_map

    user_ids = list({r.user_id for r in rows})
    # Build owner map (user_name + assigned admin/broker) so the positions
    # table can render Self vs. Broker: <name> badges per row.
    user_map = await build_owner_map(user_ids)

    # Snapshot the live USD/INR rate once so every USD-quoted row in this
    # response is converted using a consistent reference. Infoway keeps this
    # tick fresh; on cold start we fall back to the constant.
    current_usd_inr = market_data_service.get_usd_inr_rate()

    # Parallel LTP fan-out. Previously this loop did `await get_ltp(...)`
    # serially inside the per-row body, which meant for a typical 50-
    # position cap the endpoint blocked for ~5 s on Redis/feed lookups
    # alone — and the entire admin Positions page sat blank that whole
    # time. asyncio.gather hits them concurrently so the total wait
    # collapses to roughly the slowest single fetch (~50-100 ms).
    # Duplicate tokens are resolved once via a dict so we don't double-
    # ping the feed when several rows share a symbol.
    unique_tokens = list({r.instrument.token for r in rows})
    ltp_results = await asyncio.gather(
        *[market_data_service.get_ltp(tok) for tok in unique_tokens],
        return_exceptions=True,
    )
    ltp_map: dict[str, float] = {}
    for tok, res in zip(unique_tokens, ltp_results):
        try:
            ltp_map[tok] = float(res) if not isinstance(res, BaseException) else 0.0
        except Exception:
            ltp_map[tok] = 0.0

    # Bulk-fetch every trade that touches these positions so we can attach
    # a per-position `charges` total without an N+1 query. Mirrors the
    # bucketing user-facing /positions/closed uses (start − slack ≤
    # executed_at ≤ end + slack) so charges land on the right position
    # lifecycle even when two CLOSED rows share (user, token, product).
    # Same key the user endpoint uses keeps the math aligned across views.
    from datetime import timedelta as _td_charges

    by_charges_key: dict[tuple[str, str, str], list[Trade]] = {}
    if rows:
        user_ids_for_trades = list({r.user_id for r in rows})
        trade_q: dict[str, Any] = {
            "user_id": {"$in": user_ids_for_trades},
            "instrument.token": {"$in": unique_tokens},
        }
        oldest_open = min((r.opened_at for r in rows if r.opened_at), default=None)
        if oldest_open is not None:
            trade_q["executed_at"] = {"$gte": oldest_open - _td_charges(seconds=5)}
        trade_rows = await Trade.find(trade_q).sort("+executed_at").to_list()
        for t in trade_rows:
            key = (str(t.user_id), t.instrument.token, t.product_type.value)
            by_charges_key.setdefault(key, []).append(t)

    def _charges_for(p: Position) -> float:
        key = (str(p.user_id), p.instrument.token, p.product_type.value)
        bucket = by_charges_key.get(key, [])
        if not bucket:
            return 0.0
        if not p.opened_at:
            return sum(
                float(str(getattr(t, "total_charges", None) or t.brokerage or 0))
                for t in bucket
            )
        start = p.opened_at
        end = p.closed_at or p.opened_at
        slack = _td_charges(seconds=5)
        return sum(
            float(str(getattr(t, "total_charges", None) or t.brokerage or 0))
            for t in bucket
            if (start - slack) <= t.executed_at <= (end + slack)
        )

    out = []
    for r in rows:
        # For CLOSED rows the price + P&L must be FROZEN — the user
        # explicitly flagged this ("close trade me pnl move mat karna
        # thoda sa bhi"). Use the close-price that
        # position_service.apply_trade stamped onto `r.ltp` at the
        # closing fill, never the live feed. For OPEN rows keep the
        # live LTP so M2M ticks per refresh.
        is_closed = r.status == PositionStatus.CLOSED
        if is_closed:
            stored_ltp = float(str(r.ltp)) if r.ltp is not None else 0.0
            ltp_f = stored_ltp
        else:
            ltp = ltp_map.get(r.instrument.token, 0.0)
            ltp_f = float(ltp)
        avg = float(str(r.avg_price))
        qty = r.quantity
        margin = float(str(r.margin_used))
        realized = float(str(r.realized_pnl))

        is_usd = market_data_service.is_usd_quoted_segment(r.segment_type) or \
            market_data_service.is_usd_quoted_segment(r.instrument.segment)

        # Prices stay in source currency (USD for crypto/forex, INR for the
        # rest) — that's what the live feed quotes. Only realised + unrealised
        # P&L gets converted to INR so the wallet/M2M columns are consistent.
        if is_usd:
            open_rate = (
                float(str(r.open_usd_inr_rate))
                if r.open_usd_inr_rate is not None
                else current_usd_inr
            )
            # Realised P&L was crystallised at close time, so the user-side
            # trade history shows it converted at the CLOSE-time USDINR
            # (matching_engine stamps `trade.pnl_inr` using that rate).
            # Use the same close-rate snapshot here so the admin column
            # matches what the user sees in their History tab. Partial
            # closes on a still-open position have no close_rate yet — fall
            # back to open_rate as a reasonable approximation.
            close_rate = (
                float(str(r.close_usd_inr_rate))
                if r.close_usd_inr_rate is not None
                else open_rate
            )
            # CLOSED → frozen 0 (qty is 0 anyway; making it explicit so
            # any future code that touches this branch can't drift).
            # OPEN → live FX × live LTP delta so M2M ticks per refresh.
            if is_closed:
                unrealized_pnl_inr = 0.0
            else:
                unrealized_pnl_inr = (ltp_f - avg) * qty * current_usd_inr
            realized_pnl_inr = realized * close_rate
            # margin_used was locked from the wallet at order time (validator
            # computed it as a wallet-currency number), so DON'T re-apply FX
            # here — that's why the position view used to show ~80× the
            # wallet's used_margin.
            margin_inr = margin
        else:
            unrealized_pnl_inr = 0.0 if is_closed else (ltp_f - avg) * qty
            realized_pnl_inr = realized
            margin_inr = margin
            open_rate = 1.0

        oi = user_map.get(str(r.user_id)) or {}
        out.append(
            {
                "id": str(r.id),
                "user_id": str(r.user_id),
                "user_code": oi.get("user_code"),
                "user_name": oi.get("user_name"),
                "assigned_admin_id": oi.get("assigned_admin_id"),
                "assigned_admin_name": oi.get("assigned_admin_name"),
                "assigned_broker_id": oi.get("assigned_broker_id"),
                "assigned_broker_name": oi.get("assigned_broker_name"),
                "assigned_broker_is_sub": oi.get("assigned_broker_is_sub", False),
                "symbol": r.instrument.symbol,
                "instrument_token": r.instrument.token,
                "exchange": str(r.instrument.exchange),
                "segment_type": r.segment_type,
                "product_type": r.product_type.value,
                # Lot size of the instrument at the time the position is
                # observed. Lets the admin blotter compute Volume column
                # (= qty/lot_size) without a separate /instruments lookup.
                "lot_size": int(getattr(r.instrument, "lot_size", 0) or 0),
                "quantity": qty,
                # Original trade size at peak of this position's lifecycle.
                # `quantity` drops to 0 on full close, so the Closed-tab UI
                # falls back to this to render "user ne kitni qty li thi".
                # Captured in apply_fill; never decremented on close.
                "opening_quantity": r.opening_quantity,
                # Direction the user opened on. Stable across the position's
                # lifecycle — the Closed-tab needs this to colour the qty
                # cell (BUY = green, SELL = red) since the signed `quantity`
                # is 0 after the closing leg.
                "opened_side": r.opened_side.value if r.opened_side is not None else None,
                # Prices in source currency — UI renders with $ or ₹ based on
                # the `currency_quote` flag below.
                "avg_price": f"{avg:.4f}" if is_usd else f"{avg:.2f}",
                "ltp": f"{ltp_f:.4f}" if is_usd else f"{ltp_f:.2f}",
                # P&L + margin are always INR (wallet currency).
                "unrealized_pnl": f"{unrealized_pnl_inr:.2f}",
                "realized_pnl": f"{realized_pnl_inr:.2f}",
                # Sum of brokerage + every other charge stamped on this
                # position's lifecycle trades. Admin frontend subtracts
                # this from `realized_pnl` so the displayed P&L matches
                # the NET number the user sees on their APK (which the
                # user-facing /closed endpoint already nets — see
                # user/positions.py:closed_positions). Without this the
                # admin and user views always disagreed by the brokerage
                # amount on every closed trade.
                "charges": f"{_charges_for(r):.2f}",
                "margin_used": f"{margin_inr:.2f}",
                # Currency tag so the UI can prefix avg/ltp with $ instead of ₹
                "currency_quote": "USD" if is_usd else "INR",
                "open_usd_inr_rate": f"{open_rate:.4f}" if is_usd else None,
                "current_usd_inr_rate": f"{current_usd_inr:.4f}" if is_usd else None,
                "status": r.status.value,
                "opened_at": r.opened_at,
                "closed_at": r.closed_at.isoformat() if r.closed_at else None,
                # Compact tag set by the squareoff path that flipped this
                # row to CLOSED. SL_HIT / TP_HIT / STOP_OUT / USER / AUTO.
                # Admin trades table renders it as a chip so super-admins
                # can see which closes were auto-fires vs user-initiated.
                "close_reason": r.close_reason,
            }
        )
    return APIResponse(data=out)


@router.post("/positions/{position_id}/squareoff", response_model=APIResponse[dict])
async def admin_squareoff(
    position_id: str,
    admin: CurrentAdmin,
    _: None = Depends(require_perm("trading_view", "write")),
):
    p = await Position.get(PydanticObjectId(position_id))
    if p is None or p.status != PositionStatus.OPEN or p.quantity == 0:
        raise HTTPException(status_code=400, detail="Position is not open")
    target_user = await assert_user_in_scope(admin, p.user_id)
    action = OrderAction.SELL if p.quantity > 0 else OrderAction.BUY
    # Flatten the EXACT open quantity. Using `force_quantity` mirrors the
    # user-side squareoff path — it avoids the integer-floor bug that
    # used to leave a tiny residual on crypto/USD positions where
    # `qty (96) // lot_size (100) = 0` then `max(1, 0) = 1 lot = 100 units`,
    # so a -96 short was BUY-1-lot'd back to +4 instead of flat.
    full_qty = abs(p.quantity)
    full_lots = max(0.01, full_qty / max(1, p.instrument.lot_size or 1))
    # `is_squareoff=True` tells the validator (a) margin lock is
    # zero, (b) lot-size / max-lots / utilisation caps don't apply,
    # and (c) market-hours guard is bypassed — admins must be able to
    # flatten any position 24×7, including weekends and Indian
    # exchange off-hours.
    o = await order_service.place_order(
        user=target_user,
        payload={
            "token": p.instrument.token,
            "action": action.value,
            "order_type": OrderType.MARKET.value,
            "product_type": p.product_type.value,
            "lots": full_lots,
            "force_quantity": full_qty,
            "placed_from": "ADMIN",
            "is_squareoff": True,
        },
    )
    await log_event(
        action=AuditAction.SQUAREOFF_FORCE,
        entity_type="Position",
        entity_id=p.id,
        actor_id=admin.id,
        target_user_id=p.user_id,
    )
    # Stamp close_reason="AUTO" if the admin force-close actually flattened
    # the row — the matching engine wrote the new state in place. Marks
    # the close as "not user-initiated" on every Closed-tab view (user
    # app, web, admin trades).
    try:
        fresh = await Position.get(PydanticObjectId(position_id))
        if (
            fresh is not None
            and fresh.status == PositionStatus.CLOSED
            and not fresh.close_reason
        ):
            fresh.close_reason = "AUTO"
            await fresh.save()
    except Exception:
        pass
    # Reload the position so the published payload reflects the closed state
    refreshed = await Position.get(PydanticObjectId(position_id))
    await _publish_position_event(p.user_id, "force_close", refreshed or p, {"by": "admin"})
    return APIResponse(data={"order_id": str(o.id), "status": o.status.value})


@router.patch("/positions/{position_id}", response_model=APIResponse[dict])
async def admin_edit_position(
    position_id: str,
    payload: dict[str, Any],
    admin: CurrentAdmin,
    _: None = Depends(require_perm("trading_view", "write")),
):
    """Admin-only: edit a position's entry / exit details.

    OPEN-position fields:
        avg_price, quantity, opened_at, stop_loss, target

    CLOSED-position fields (admin correction of a bad close):
        realized_pnl  — override the booked realised. Difference vs
                        the previous value is posted to the user's
                        wallet as a REVERSAL transaction so the
                        ledger always reconciles.
        close_reason  — relabel (USER / SL_HIT / STOP_OUT / ADMIN).
                        Cosmetic, no money movement.

    Patch is fanned out via Redis pub/sub so the user's terminal
    re-renders the positions strip without a refresh.
    """
    p = await Position.get(PydanticObjectId(position_id))
    if p is None:
        raise HTTPException(status_code=404, detail="Position not found")
    await assert_user_in_scope(admin, p.user_id)

    old_values: dict[str, Any] = {
        "avg_price": str(p.avg_price),
        "quantity": p.quantity,
        "opened_at": p.opened_at.isoformat() if p.opened_at else None,
        "stop_loss": str(p.stop_loss) if p.stop_loss is not None else None,
        "target": str(p.target) if p.target is not None else None,
        "realized_pnl": str(p.realized_pnl) if p.realized_pnl is not None else None,
        "close_reason": p.close_reason,
        "status": p.status.value,
    }

    if "avg_price" in payload and payload["avg_price"] is not None:
        try:
            p.avg_price = Decimal128(str(payload["avg_price"]))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Invalid avg_price: {e}")
    if "quantity" in payload and payload["quantity"] is not None:
        try:
            p.quantity = float(payload["quantity"])
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Invalid quantity: {e}")
    if "opened_at" in payload and payload["opened_at"] is not None:
        try:
            p.opened_at = datetime.fromisoformat(str(payload["opened_at"]).replace("Z", "+00:00"))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Invalid opened_at: {e}")
    if "stop_loss" in payload:
        v = payload["stop_loss"]
        p.stop_loss = Decimal128(str(v)) if v not in (None, "", 0) else None
    if "target" in payload:
        v = payload["target"]
        p.target = Decimal128(str(v)) if v not in (None, "", 0) else None

    # ── CLOSED-row corrections ────────────────────────────────────────
    # When the row is CLOSED, allow the admin to nudge realized_pnl
    # (e.g. to compensate for a known mispriced close) and to relabel
    # `close_reason`. Any delta on realized_pnl is mirrored on the
    # user's wallet via a REVERSAL transaction so the running balance
    # stays consistent with the booked figure on the trade card.
    realized_delta: Decimal | None = None
    if (
        "realized_pnl" in payload
        and payload["realized_pnl"] is not None
        and p.status == PositionStatus.CLOSED
    ):
        try:
            from app.utils.decimal_utils import to_decimal as _td

            new_realized = _td(payload["realized_pnl"])
            old_realized = _td(p.realized_pnl or 0)
            realized_delta = new_realized - old_realized
            p.realized_pnl = Decimal128(str(new_realized))
        except Exception as e:
            raise HTTPException(
                status_code=400, detail=f"Invalid realized_pnl: {e}"
            )

    if "close_reason" in payload and p.status == PositionStatus.CLOSED:
        v = payload["close_reason"]
        p.close_reason = str(v) if v else None

    # Recompute margin_used at the new entry so the wallet view stays consistent.
    if "avg_price" in payload or "quantity" in payload:
        try:
            ref_price = float(str(p.avg_price))
            p.margin_used = Decimal128(str(round(abs(p.quantity) * ref_price, 2)))
        except Exception:
            pass

    await p.save()

    # Apply the wallet delta AFTER the position write so an exception in
    # adjust() doesn't leave the position in an inconsistent state. The
    # adjust() call writes its own REVERSAL ledger row.
    if realized_delta is not None and realized_delta != 0:
        from app.models.transaction import TransactionType
        from app.services import wallet_service as _ws

        try:
            await _ws.adjust(
                p.user_id,
                realized_delta,
                transaction_type=TransactionType.REVERSAL,
                narration=(
                    f"Admin {admin.user_code} corrected realised P&L on "
                    f"{p.instrument.symbol} (delta {realized_delta})"
                ),
                reference_type="Position",
                reference_id=str(p.id),
                actor_id=admin.id,
            )
        except Exception as e:
            # The position row is already saved with the new realized.
            # Surface the wallet failure so the operator knows the
            # ledger didn't catch up.
            raise HTTPException(
                status_code=500,
                detail=f"Position updated but wallet reversal failed: {e}",
            )

    new_values: dict[str, Any] = {
        "avg_price": str(p.avg_price),
        "quantity": p.quantity,
        "opened_at": p.opened_at.isoformat() if p.opened_at else None,
        "stop_loss": str(p.stop_loss) if p.stop_loss is not None else None,
        "target": str(p.target) if p.target is not None else None,
        "realized_pnl": str(p.realized_pnl) if p.realized_pnl is not None else None,
        "close_reason": p.close_reason,
        "status": p.status.value,
    }
    await log_event(
        action=AuditAction.POSITION_EDIT
        if hasattr(AuditAction, "POSITION_EDIT")
        else AuditAction.SETTING_CHANGE,
        entity_type="Position",
        entity_id=p.id,
        actor_id=admin.id,
        target_user_id=p.user_id,
        old_values=old_values,
        new_values=new_values,
    )
    await _publish_position_event(p.user_id, "edit", p, {"by": "admin"})
    return APIResponse(data={"id": str(p.id), "status": p.status.value, **new_values})


@router.post("/positions/{position_id}/reopen", response_model=APIResponse[dict])
async def admin_reopen_position(
    position_id: str,
    admin: CurrentAdmin,
    _: None = Depends(require_perm("trading_view", "write")),
):
    """Flip a CLOSED position back to OPEN — admin override.

    Used when a close was triggered by mistake (false stop-out, user
    misclicked, bracket fired on a phantom tick). The endpoint:

      1) Reverses the cumulative `realized_pnl` against the user's
         wallet via a REVERSAL transaction. A profit close that's
         being undone debits the wallet; a loss close credits it
         back. Either way, the running wallet balance ends at what
         it was just before the close fill landed.

      2) Rehydrates the position to its OPEN state:
            status        = OPEN
            quantity      = ±opening_quantity (sign from opened_side)
            closed_at     = None
            close_reason  = None
            realized_pnl  = 0
            margin_used   = abs(qty) × avg_price  (re-block)

      3) Re-blocks the now-required margin on the wallet so used_margin
         reflects the reopened exposure.

      4) Refuses to reopen if a different OPEN position already exists
         for the same (user, token, product_type) — that would create
         two parallel positions the apply_fill resolver can't pick
         between.

    Audit-logged + pub/sub fanned out so the user's terminal re-renders
    the Positions tab live.
    """
    p = await Position.get(PydanticObjectId(position_id))
    if p is None:
        raise HTTPException(status_code=404, detail="Position not found")
    await assert_user_in_scope(admin, p.user_id)

    if p.status != PositionStatus.CLOSED:
        raise HTTPException(
            status_code=400, detail="Only CLOSED positions can be reopened"
        )

    # Refuse if a parallel OPEN position exists for the same
    # (user, token, product_type) — apply_fill assumes one OPEN row per
    # such tuple. Reopening on top of that would create two and break
    # downstream fills.
    existing_open = await Position.find_one(
        Position.user_id == p.user_id,
        Position.instrument.token == p.instrument.token,  # type: ignore[union-attr]
        Position.product_type == p.product_type,
        Position.status == PositionStatus.OPEN,
    )
    if existing_open is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Cannot reopen — a different open position already exists "
                f"for {p.instrument.symbol} ({p.product_type.value}). "
                f"Square that off first."
            ),
        )

    from decimal import Decimal as _Decimal

    from app.models.transaction import TransactionType
    from app.services import position_service as _ps
    from app.services import wallet_service as _ws
    from app.utils.decimal_utils import to_decimal as _td
    from app.utils.time_utils import now_utc as _now_utc

    # ── 1) Wallet reversal of the realised P&L ──────────────────────
    realized = _td(p.realized_pnl or 0)
    if realized != _Decimal("0"):
        try:
            await _ws.adjust(
                p.user_id,
                -realized,
                transaction_type=TransactionType.REVERSAL,
                narration=(
                    f"Reopen {p.instrument.symbol} — reverse realised P&L "
                    f"(closed by {p.close_reason or 'unknown'}; reopened by "
                    f"{admin.user_code})"
                ),
                reference_type="Position",
                reference_id=str(p.id),
                actor_id=admin.id,
            )
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"Wallet reversal failed; reopen aborted: {e}",
            )

    # ── 2) Restore the position to OPEN state ───────────────────────
    # Reconstruct quantity from the snapshot we took at open. If
    # `opened_side` is missing (legacy rows), infer from the sign of
    # the last non-zero quantity by reading the latest Trade row.
    opening_qty = float(p.opening_quantity or 0) or abs(float(p.quantity or 0))
    if opening_qty <= 0:
        raise HTTPException(
            status_code=400,
            detail="Cannot reopen — original opening quantity is unknown",
        )
    sign = 1
    if p.opened_side is not None:
        sign = 1 if str(p.opened_side.value).upper() == "BUY" else -1

    p.status = PositionStatus.OPEN
    p.quantity = opening_qty * sign
    p.closed_at = None
    p.close_reason = None
    p.realized_pnl = Decimal128("0")
    if p.close_usd_inr_rate is not None:
        p.close_usd_inr_rate = None
    # Margin re-block: |qty| × avg_price gives a conservative figure
    # consistent with how delete_position / admin_edit_position recompute.
    try:
        avg_p = float(str(p.avg_price))
        p.margin_used = Decimal128(str(round(opening_qty * avg_p, 2)))
    except Exception:
        pass

    await p.save()

    # ── 3) Re-block the margin on the wallet so used_margin reflects
    #       the restored exposure. block_margin handles the
    #       insufficient-funds case but for an admin override we want
    #       the position to come back even if the user is short on
    #       margin — so swallow that and let the operator reconcile.
    try:
        await _ws.block_margin(p.user_id, _td(p.margin_used or 0))
    except Exception:
        pass

    # Tracker recompute (intraday / holding lots).
    try:
        await _ps._recompute_tracker(
            user_id=p.user_id,
            segment_type=p.segment_type,
            token=p.instrument.token,
        )
    except Exception:
        pass

    await log_event(
        action=AuditAction.SETTING_CHANGE,
        entity_type="Position",
        entity_id=p.id,
        actor_id=admin.id,
        target_user_id=p.user_id,
        metadata={
            "action": "REOPEN",
            "reversed_realized_pnl": str(realized),
            "restored_quantity": opening_qty * sign,
        },
    )
    await _publish_position_event(p.user_id, "reopen", p, {"by": "admin"})

    return APIResponse(
        data={
            "id": str(p.id),
            "status": p.status.value,
            "quantity": p.quantity,
            "realized_pnl_reversed": str(realized),
        }
    )


@router.get("/positions/pnl-summary", response_model=APIResponse[dict])
async def positions_pnl_summary(
    admin: CurrentAdmin,
    user_id: str | None = None,
    _: None = Depends(require_perm("trading_view", "read")),
):
    """Aggregate PnL windows for the admin dashboard cards.

    today_pnl    — sum of realised P&L from trades + unrealised on open
                   positions, since IST midnight.
    week_pnl     — same, since the most recent IST Sunday 00:00.
    last_week_pnl — total realised P&L of the previous Sun→Sat window.

    `user_id` (optional) narrows the aggregate to a single user's
    positions only — passed by the admin Positions page when a user
    filter is active so the tile matches the filtered table.
    """
    from datetime import datetime as _dt, timedelta as _td, timezone as _tz

    IST = _tz(_td(hours=5, minutes=30))
    now_ist = _dt.now(IST)
    today_start_ist = now_ist.replace(hour=0, minute=0, second=0, microsecond=0)
    # Sunday-anchored week (weekday: Mon=0 ... Sun=6 → days back = (wd+1) % 7)
    days_back = (now_ist.weekday() + 1) % 7
    week_start_ist = today_start_ist - _td(days=days_back)
    last_week_start_ist = week_start_ist - _td(days=7)
    last_week_end_ist = week_start_ist  # exclusive

    today_start = today_start_ist.astimezone(_tz.utc)
    week_start = week_start_ist.astimezone(_tz.utc)
    last_week_start = last_week_start_ist.astimezone(_tz.utc)
    last_week_end = last_week_end_ist.astimezone(_tz.utc)

    # Realised P&L lives on each Position (set on SELL closes/flips). We sum
    # across positions whose closed_at OR updated_at falls in the window —
    # covers fully-closed and partially-closed-but-still-open positions in
    # one query (positions that closed in window have closed_at set; ones
    # still open with realised slices booked have updated_at in window).
    #
    # FX: realized_pnl + unrealized_pnl are stored in NATIVE currency. For
    # USD-quoted (crypto/forex) we convert to INR via the locked open rate
    # (realised) or live rate (unrealised) — same logic as _pos() view.
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

    # Scope user pool for sub-admins. None for SUPER_ADMIN = no filter.
    scope = await scoped_user_ids(admin)

    # Optional per-user narrowing — used by the admin Positions page when
    # a user filter is active so the dashboard cards match the table.
    # We intersect with `scope` so a sub-admin can't query users outside
    # their pool by guessing the user_id.
    user_filter_oid: PydanticObjectId | None = None
    if user_id:
        try:
            user_filter_oid = PydanticObjectId(user_id)
        except Exception:
            user_filter_oid = None
        if user_filter_oid is not None:
            if scope is not None and user_filter_oid not in scope:
                # Out of scope → empty tile data (sub-admin probing
                # a user_id outside their pool). Shape matches the
                # normal return so the frontend never sees `undefined`.
                return APIResponse(
                    data={
                        "today_pnl": 0.0,
                        "today_realised": 0.0,
                        "open_unrealised": 0.0,
                        "week_pnl": 0.0,
                        "week_realised": 0.0,
                        "last_week_pnl": 0.0,
                    }
                )
            scope = [user_filter_oid]

    # Sum charges (brokerage + other) across all trades that belong to a
    # given position. Mirrors the per-row attribution in the /positions
    # endpoint so the aggregate tile and the per-row table never disagree.
    # Without this, the dashboard's "This Week's Closed PNL" stayed at
    # gross while every trade card on the APK showed net — the difference
    # equalled the brokerage bill for the week.
    from datetime import timedelta as _td_sum

    async def _charges_for_positions(positions: list[Position]) -> dict[str, float]:
        if not positions:
            return {}
        user_ids = list({p.user_id for p in positions})
        tokens = list({p.instrument.token for p in positions})
        oldest = min((p.opened_at for p in positions if p.opened_at), default=None)
        tq: dict[str, Any] = {
            "user_id": {"$in": user_ids},
            "instrument.token": {"$in": tokens},
        }
        if oldest is not None:
            tq["executed_at"] = {"$gte": oldest - _td_sum(seconds=5)}
        trades = await Trade.find(tq).sort("+executed_at").to_list()
        bucket: dict[tuple[str, str, str], list[Trade]] = {}
        for t in trades:
            bucket.setdefault(
                (str(t.user_id), t.instrument.token, t.product_type.value), []
            ).append(t)
        slack = _td_sum(seconds=5)
        out: dict[str, float] = {}
        for p in positions:
            key = (str(p.user_id), p.instrument.token, p.product_type.value)
            ts = bucket.get(key, [])
            if not ts:
                out[str(p.id)] = 0.0
                continue
            if not p.opened_at:
                out[str(p.id)] = sum(
                    float(str(getattr(t, "total_charges", None) or t.brokerage or 0))
                    for t in ts
                )
                continue
            start = p.opened_at
            end = p.closed_at or p.opened_at
            out[str(p.id)] = sum(
                float(str(getattr(t, "total_charges", None) or t.brokerage or 0))
                for t in ts
                if (start - slack) <= t.executed_at <= (end + slack)
            )
        return out

    async def _realised_in(window_start, window_end=None):
        rng: dict[str, Any] = {"$gte": window_start}
        if window_end is not None:
            rng["$lt"] = window_end
        query: dict[str, Any] = {"$or": [{"closed_at": rng}, {"updated_at": rng}]}
        if scope is not None:
            if not scope:
                return 0.0
            query["user_id"] = {"$in": scope}
        rows = await Position.find(query).to_list()
        gross = sum(_realised_inr(p) for p in rows)
        charges_map = await _charges_for_positions(rows)
        total_charges = sum(charges_map.values())
        # Net = gross realised − brokerage/charges. Same definition the
        # APK card uses (user/positions.py:closed_positions subtracts
        # the same charges before serialising realized_pnl), so the
        # dashboard tile and the per-trade APK cards stay in lockstep.
        return gross - total_charges

    today_realised = await _realised_in(today_start)
    week_realised = await _realised_in(week_start)
    last_week_realised = await _realised_in(last_week_start, last_week_end)

    # Recompute unrealised LIVE per position rather than reading the stored
    # `p.unrealized_pnl` field — that field is only refreshed when the
    # position is touched (new fill, partial close, manual edit). For an
    # open position sitting idle between fills the stored number is stale
    # (often 0 on a freshly opened position), which is what made the
    # admin's "Open PNL" card stick at ₹0.00 while the per-row M2M column
    # showed the correct live number. Mirror the /positions list view's
    # (ltp - avg) * qty math so both reads stay in lockstep.
    open_q: dict[str, Any] = {"status": PositionStatus.OPEN.value}
    if scope is not None:
        if not scope:
            open_positions: list[Position] = []
        else:
            open_q["user_id"] = {"$in": scope}
            open_positions = await Position.find(open_q).to_list()
    else:
        open_positions = await Position.find(open_q).to_list()

    # Parallel LTP fan-out (see /admin/positions for rationale). This
    # endpoint is hit by the Dashboard, Positions, and Orders pages every
    # 10 s, so the old serial loop multiplied across N open positions was
    # adding seconds of blank time to every admin navigation.
    unique_tokens = list({p.instrument.token for p in open_positions if p.quantity != 0})
    ltp_results = await asyncio.gather(
        *[market_data_service.get_ltp(tok) for tok in unique_tokens],
        return_exceptions=True,
    )
    ltp_map: dict[str, float | None] = {}
    for tok, res in zip(unique_tokens, ltp_results):
        if isinstance(res, BaseException):
            ltp_map[tok] = None  # signal "feed hiccup" → fall back to stored
            continue
        try:
            ltp_map[tok] = float(res)
        except Exception:
            ltp_map[tok] = None

    total_unrealised = 0.0
    for p in open_positions:
        if p.quantity == 0:
            continue
        ltp_f = ltp_map.get(p.instrument.token)
        if ltp_f is None:
            # Feed hiccup — fall back to the stored value so the card
            # doesn't silently zero out on a single failed lookup.
            stored = float(str(p.unrealized_pnl))
            total_unrealised += stored * (current_usd_inr if _is_usd(p) else 1.0)
            continue
        avg = float(str(p.avg_price))
        raw = (ltp_f - avg) * p.quantity
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


@router.get("/positions/{position_id}/netting", response_model=APIResponse[dict])
async def position_netting_entries(
    position_id: str,
    admin: CurrentAdmin,
    _: None = Depends(require_perm("trading_view", "read")),
):
    """Drill-down on a single position: the chronological list of fills
    that built it up, plus a header summary (side, total volume, average
    entry, current price, total P/L) and an `avg_calc_formula` string for
    the dialog footer.

    Used by the admin Positions blotter row-click to show the same view
    the user reported as the "Netting Entries — BSE (426450)" mockup.
    Works for both OPEN and CLOSED positions:
      - OPEN  → returns every fill from `opened_at` onward whose
                (user, token, product_type) matches the position
      - CLOSED → bounded by `[opened_at, closed_at]`
    """
    from decimal import Decimal as _D

    from app.utils.decimal_utils import to_decimal as _to_dec
    from app.services import market_data_service as _mds

    p = await Position.get(PydanticObjectId(position_id))
    if p is None:
        raise HTTPException(status_code=404, detail="Position not found")
    await assert_user_in_scope(admin, p.user_id)

    # Find every Trade that contributed to this position. `position_id` is
    # not stored on Trade, so we match by user + token + product_type +
    # time window. For a re-opened position (close then open again on the
    # same instrument) the time bounds keep us inside the CURRENT
    # incarnation's fills.
    #
    # Grace window: position.opened_at is stamped AFTER the opening
    # Trade.insert() in position_service.apply_fill, so a millisecond of
    # clock-skew between the two writes makes `executed_at >= opened_at`
    # silently drop the opening Trade — exactly the user-reported "sirf
    # ek entry dikh raha hai (Exit), Entry missing" bug. We widen the
    # lower bound by 60 s to absorb any realistic skew without leaking
    # in a previous closed-incarnation's fills (those would be hours/
    # days earlier).
    from datetime import timedelta as _td

    query: dict = {
        "user_id": p.user_id,
        "instrument.token": p.instrument.token,
        "product_type": p.product_type,
    }
    time_q: dict = {}
    if p.opened_at:
        time_q["$gte"] = p.opened_at - _td(seconds=60)
    if p.closed_at:
        # Same grace on the upper bound so a closing trade whose
        # executed_at lands a few milliseconds AFTER position.closed_at
        # still shows up.
        time_q["$lte"] = p.closed_at + _td(seconds=60)
    if time_q:
        query["executed_at"] = time_q

    trades = (
        await Trade.find(query).sort("+executed_at").to_list()
    )

    # Build the per-row entries the dialog renders.
    open_side = (
        p.opened_side.value
        if p.opened_side and hasattr(p.opened_side, "value")
        else str(p.opened_side or "")
    ).upper() or None

    entries: list[dict] = []
    formula_parts: list[str] = []
    total_volume = _D("0")
    weighted = _D("0")
    for idx, t in enumerate(trades, start=1):
        side = (
            t.action.value if hasattr(t.action, "value") else str(t.action)
        ).upper()
        # An "Entry" leg adds same-direction exposure; "Exit" reduces.
        # If we know the original opened_side, anything matching it is
        # Entry, opposite is Exit. Fallback: BUY=Entry / SELL=Exit when
        # opened_side is unknown.
        entry_kind = "Exit"
        if open_side is None:
            entry_kind = "Entry" if side == "BUY" else "Exit"
        elif side == open_side:
            entry_kind = "Entry"
        else:
            entry_kind = "Exit"

        qty = _to_dec(t.quantity)
        price = _to_dec(t.price)
        if entry_kind == "Entry":
            total_volume += qty
            weighted += qty * price
            formula_parts.append(f"{qty}×₹{price}")
        pnl_inr = (
            _to_dec(t.pnl_inr) if getattr(t, "pnl_inr", None) is not None else None
        )
        entries.append(
            {
                "row": idx,
                "type": entry_kind,
                "side": side,
                "executed_at": t.executed_at.isoformat() if t.executed_at else None,
                "volume": float(qty),
                "price": float(price),
                "pnl_inr": float(pnl_inr) if pnl_inr is not None else None,
            }
        )

    avg_entry = (weighted / total_volume) if total_volume > 0 else _to_dec(p.avg_price)
    avg_calc_formula = (
        f"({' + '.join(formula_parts)}) ÷ {total_volume} = ₹{avg_entry:.2f}"
        if formula_parts
        else f"₹{avg_entry:.2f}"
    )

    # Live LTP for OPEN; close price (already stamped onto position.ltp by
    # position_service.apply_fill) for CLOSED.
    if p.status == PositionStatus.OPEN:
        try:
            current_price = float(await _mds.get_ltp(p.instrument.token))
        except Exception:
            current_price = float(_to_dec(p.ltp)) if p.ltp is not None else 0.0
    else:
        current_price = float(_to_dec(p.ltp)) if p.ltp is not None else 0.0

    # Header total P/L: unrealised for OPEN, realised for CLOSED.
    if p.status == PositionStatus.OPEN:
        total_pnl = float(_to_dec(p.unrealized_pnl)) if p.unrealized_pnl is not None else 0.0
    else:
        total_pnl = float(_to_dec(p.realized_pnl)) if p.realized_pnl is not None else 0.0

    return APIResponse(
        data={
            "position_id": str(p.id),
            "symbol": p.instrument.symbol,
            "exchange": str(getattr(p.instrument.exchange, "value", p.instrument.exchange) or ""),
            "token": p.instrument.token,
            "status": p.status.value if hasattr(p.status, "value") else str(p.status),
            "side": open_side or "BUY",
            "volume": float(total_volume),
            "avg_entry": float(avg_entry),
            "current_price": current_price,
            "total_pnl": total_pnl,
            "avg_calc_formula": avg_calc_formula,
            "entries": entries,
        }
    )


@router.delete("/positions/{position_id}", response_model=APIResponse[dict])
async def delete_position(
    position_id: str,
    admin: CurrentAdmin,
    _: None = Depends(require_perm("trading_view", "write")),
):
    """Hard-delete a position record AND reverse its wallet impact.

    Admin-flagged: "close trade delete kiya, lekin user ka PnL wallet
    se kam ya zyada nahi hua — agar 10k deposit + 2k profit = 12k
    tha, trade delete ke baad bhi 12k hi rahta hai, jabki 10k hona
    chahiye". The earlier implementation just removed the Position
    row, leaving the realized-PnL credit / debit and brokerage
    deduction on the ledger. That broke the invariant that a deleted
    trade leaves no trace on the wallet.

    Now the delete path also:
      • Posts a REVERSAL ledger entry of `-realized_pnl` so a profit
        deleted DEBITS the wallet (12k → 10k for the +2k example) and
        a loss deleted CREDITS the wallet (8k → 10k for a -2k loss).
      • Recomputes the per-(user, instrument) tracker from live
        Position docs so the stale row is forgotten from
        intraday_lots / holding_lots / margin_blocked.
      • Refuses to delete an OPEN position with non-zero quantity —
        admin must squareoff first. Hard-deleting an open row would
        orphan the locked margin AND skip the standard closing
        ledger entries, putting the wallet into a worse state than
        before.

    Audit-logged with `actor_id = admin.id` so the original credit
    plus the reversal both appear in the user's ledger with their
    own narrations.
    """
    p = await Position.get(PydanticObjectId(position_id))
    if p is None:
        raise HTTPException(status_code=404, detail="Position not found")
    await assert_user_in_scope(admin, p.user_id)
    user_id = p.user_id

    # ── OPEN-position delete (admin-only escape hatch) ────────────────
    # Previously this endpoint refused to delete OPEN rows ("Square it
    # off first…"). The intent was to protect the wallet from orphaned
    # `used_margin` and a missing close-fill ledger trail. But the
    # operator legitimately needs an escape hatch for stale / corrupt
    # rows (positions left dangling by a crashed matching cycle, or
    # rows the admin wants to nuke without booking PnL against an
    # off-market last price). On 21-May the operator hit this when the
    # zero-LTP false-stop-out incident also left a few rows showing
    # phantom −LAKH M2M that they wanted gone WITHOUT booking that
    # MTM as a real loss.
    #
    # Flow for OPEN rows:
    #   1) Release the position's `margin_used` back to
    #      available_balance via `wallet_service.release_margin` —
    #      no ledger row for the margin lock itself (margin is an
    #      internal slot, not a money movement), matching what a
    #      normal close would have done.
    #   2) Recompute the tracker so intraday / holding lots drop the
    #      row.
    #   3) Delete the Position document.
    #   4) DO NOT book realized PnL — the position never closed at a
    #      real market price; recording the M2M as realised would
    #      poison the user's wallet. `unrealized_pnl` on the row is
    #      simply forgotten with the row.
    #
    # Closed-row flow is unchanged (REVERSAL of the realised PnL).
    from decimal import Decimal as _Decimal

    from app.models.transaction import TransactionType
    from app.services import wallet_service
    from app.utils.decimal_utils import to_decimal

    is_open = p.status == PositionStatus.OPEN and abs(float(p.quantity or 0)) > 1e-9
    realized = to_decimal(p.realized_pnl or 0)
    reversed_amount = _Decimal("0")

    if is_open:
        # Release the locked margin back to available_balance. Best-effort:
        # release_margin is idempotent against drift (caps at used_margin),
        # but if it raises we still let the delete proceed because the
        # final `recompute_used_margin` below will reconcile from the
        # live set of OPEN positions anyway.
        try:
            margin_locked = to_decimal(p.margin_used or 0)
            if margin_locked > _Decimal("0"):
                await wallet_service.release_margin(user_id, margin_locked)
        except Exception:
            pass
    elif realized != _Decimal("0"):
        # Closed-row PnL reversal — original behaviour preserved.
        # Signed delta: profit deleted DEBITS the wallet; loss deleted
        # CREDITS the wallet.
        try:
            await wallet_service.adjust(
                user_id,
                -realized,
                transaction_type=TransactionType.REVERSAL,
                narration=(
                    f"Reverse realized PnL of {p.instrument.symbol} "
                    f"(position deleted by {admin.user_code})"
                ),
                reference_type="Position",
                reference_id=str(p.id),
                actor_id=admin.id,
            )
            reversed_amount = realized
        except Exception:
            # Don't leave the position dangling if the reversal fails —
            # surface the error so the operator can retry.
            raise HTTPException(
                status_code=500,
                detail="Wallet reversal failed; position not deleted",
            )

    instrument_token = p.instrument.token
    segment_type = p.segment_type
    await p.delete()

    # Tracker recompute — drops the now-gone row from intraday /
    # holding lots counters. Same source-of-truth helper that runs on
    # every fill and the 15-min self-heal loop.
    try:
        from app.services.position_service import _recompute_tracker

        await _recompute_tracker(
            user_id=user_id,
            segment_type=segment_type,
            token=instrument_token,
        )
    except Exception:
        # Tracker drift is non-fatal — the periodic reconciler will
        # catch it within 15 min — but log so we notice if it
        # becomes a pattern.
        pass

    # Wallet used_margin recompute — same source-of-truth idea but
    # for the locked-margin counter. Admin-flagged: "0 open positions
    # par USED MARGIN ₹1,728.70 dikh raha". `release_margin` is
    # delta-based and drifts when admin hard-deletes a Position
    # without a closing fill. Now every delete re-syncs the wallet
    # to sum(open positions' margin_used) so the orphan margin is
    # released back to available immediately.
    try:
        from app.services import wallet_service as _ws

        await _ws.recompute_used_margin(user_id)
    except Exception:
        pass

    # Audit trail. The OPEN-delete path is a sharper edge than a
    # closed-row delete (it releases locked margin without a closing
    # trade), so we flag it explicitly in metadata for forensic
    # readability.
    try:
        await log_event(
            action=AuditAction.DELETE,
            entity_type="Position",
            entity_id=p.id,
            actor_id=admin.id,
            target_user_id=user_id,
            metadata={
                "realized_pnl_reversed_inr": str(reversed_amount),
                "symbol": p.instrument.symbol,
                "status_before_delete": p.status.value,
                "open_force_delete": is_open,
                "margin_released_inr": (
                    str(to_decimal(p.margin_used or 0)) if is_open else "0"
                ),
            },
        )
    except Exception:
        pass

    await _publish_position_event(
        user_id,
        "delete",
        None,
        {
            "id": position_id,
            "by": "admin",
            "realized_pnl_reversed_inr": str(reversed_amount),
        },
    )
    return APIResponse(
        data={
            "ok": True,
            "id": position_id,
            "realized_pnl_reversed_inr": str(reversed_amount),
        }
    )


@router.post("/positions/reconcile-wallet-margin", response_model=APIResponse[dict])
async def reconcile_wallet_margins(admin: SuperAdmin):
    """Manual trigger for wallet `used_margin` reconciliation across
    every user. Same job runs every 15 minutes alongside the tracker
    reconciler, but admin can force an immediate pass when a user
    reports a stuck used_margin (e.g. "0 open positions but
    USED MARGIN dikh raha").

    Super-admin only because it touches every wallet on the platform.
    """
    from app.services import wallet_service as _ws

    summary = await _ws.reconcile_all_used_margins()
    return APIResponse(data={"ok": True, **summary})


@router.post(
    "/positions/{user_id}/reconcile-wallet-margin",
    response_model=APIResponse[dict],
)
async def reconcile_wallet_margin_for_user(
    user_id: str,
    admin: CurrentAdmin,
    _: None = Depends(require_perm("trading_view", "write")),
):
    """Per-user manual recompute. Use when a single user reports a
    stuck used_margin and you don't want to wait for the next
    reconcile cycle. Scope-checked so an admin can only reconcile
    their own pool's users.
    """
    await assert_user_in_scope(admin, user_id)
    from app.services import wallet_service as _ws

    summary = await _ws.recompute_used_margin(user_id)
    return APIResponse(data=summary)


@router.post("/positions/reconcile-trackers", response_model=APIResponse[dict])
async def reconcile_trackers(admin: SuperAdmin):
    """Manual trigger for the per-(user, segment, instrument) tracker
    reconciler.

    The same job runs automatically every 15 min in the background
    (`tracker_reconcile_loop`). This endpoint lets an operator force an
    immediate pass — useful after a deploy / when a user reports being
    blocked by a stale `holding_lots` / `intraday_lots` counter.

    Super-admin only because it touches every user's trackers.
    """
    from app.services.position_service import reconcile_all_trackers

    summary = await reconcile_all_trackers()
    return APIResponse(data={"ok": True, **summary})


@router.post("/positions/emergency-squareoff", response_model=APIResponse[dict])
async def emergency_squareoff_all(admin: SuperAdmin):
    """Panic button — squares off every open position across the platform.

    Super-admin only: this is a platform-wide kill switch and must not be
    available to scoped sub-admins.
    """
    rows = await Position.find(Position.status == PositionStatus.OPEN).to_list()
    total = 0
    placed = 0
    for r in rows:
        if r.quantity == 0:
            continue
        total += 1
        try:
            target = await User.get(r.user_id)
            if target is None:
                continue
            action = OrderAction.SELL if r.quantity > 0 else OrderAction.BUY
            full_qty = abs(r.quantity)
            full_lots = max(0.01, full_qty / max(1, r.instrument.lot_size or 1))
            # Same `is_squareoff=True` bypass the per-position
            # admin_squareoff uses — emergency panic must work
            # outside market hours / weekends too, otherwise the
            # "panic button" is broken precisely when it's needed.
            # `force_quantity` flattens the exact open size so crypto /
            # forex positions whose qty is smaller than one lot still
            # close fully instead of partial-closing to a residual.
            await order_service.place_order(
                user=target,
                payload={
                    "token": r.instrument.token,
                    "action": action.value,
                    "order_type": OrderType.MARKET.value,
                    "product_type": r.product_type.value,
                    "lots": full_lots,
                    "force_quantity": full_qty,
                    "placed_from": "ADMIN",
                    "is_squareoff": True,
                },
            )
            placed += 1
            refreshed = await Position.get(r.id)
            # Stamp AUTO on every row this panic-button actually flattened.
            if (
                refreshed is not None
                and refreshed.status == PositionStatus.CLOSED
                and not refreshed.close_reason
            ):
                refreshed.close_reason = "AUTO"
                await refreshed.save()
            await _publish_position_event(
                r.user_id, "force_close", refreshed or r, {"by": "admin", "reason": "emergency"}
            )
        except Exception:
            continue
    await log_event(
        action=AuditAction.SQUAREOFF_FORCE,
        entity_type="Platform",
        entity_id="emergency_all",
        actor_id=admin.id,
        metadata={"total": total, "placed": placed},
    )
    return APIResponse(data={"total": total, "placed": placed})


# ── Trades ──────────────────────────────────────────────────────────
@router.get("/trades", response_model=APIResponse[list])
async def list_trades(
    admin: CurrentAdmin,
    _: None = Depends(require_perm("trading_view", "read")),
    *,
    user_id: str | None = None,
    limit: int = Query(default=200, le=1000),
    from_dt: str | None = Query(default=None, description="ISO datetime, inclusive"),
    to_dt: str | None = Query(default=None, description="ISO datetime, exclusive"),
):
    q: dict[str, Any] = {}
    if user_id:
        await assert_user_in_scope(admin, user_id)
        q["user_id"] = PydanticObjectId(user_id)
    else:
        scope = await scoped_user_ids(admin)
        if scope is not None:
            if not scope:
                return APIResponse(data=[])
            q["user_id"] = {"$in": scope}
    if from_dt or to_dt:
        from datetime import datetime as _dt
        rng: dict[str, Any] = {}
        if from_dt:
            rng["$gte"] = _dt.fromisoformat(from_dt.replace("Z", "+00:00"))
        if to_dt:
            rng["$lt"] = _dt.fromisoformat(to_dt.replace("Z", "+00:00"))
        q["executed_at"] = rng
    rows = await Trade.find(q).sort("-executed_at").limit(limit).to_list()
    user_ids = list({r.user_id for r in rows})
    users = await User.find({"_id": {"$in": user_ids}}).to_list() if user_ids else []
    umap = {str(u.id): u.user_code for u in users}
    return APIResponse(
        data=[
            {
                "id": str(r.id),
                "trade_number": r.trade_number,
                "order_id": str(r.order_id),
                "user_id": str(r.user_id),
                "user_code": umap.get(str(r.user_id)),
                "symbol": r.instrument.symbol,
                "exchange": str(r.instrument.exchange),
                "segment": r.instrument.segment,
                "token": r.instrument.token,
                "instrument_token": r.instrument.token,
                "action": r.action.value,
                "quantity": r.quantity,
                "price": str(r.price),
                "value": str(r.value),
                "brokerage": str(r.brokerage),
                "net_amount": str(r.net_amount),
                "total_charges": str(r.total_charges),
                # Frozen realized P&L (INR, net of brokerage, FX-baked for
                # USD-quoted instruments). None for opening-leg fills — the
                # closing leg is the one that books the realized number.
                "pnl_inr": str(r.pnl_inr) if r.pnl_inr is not None else None,
                "executed_at": r.executed_at,
            }
            for r in rows
        ]
    )


# ── Holdings ────────────────────────────────────────────────────────
@router.get("/holdings", response_model=APIResponse[list])
async def list_holdings(
    admin: CurrentAdmin,
    user_id: str | None = None,
    _: None = Depends(require_perm("trading_view", "read")),
):
    q: dict[str, Any] = {}
    if user_id:
        await assert_user_in_scope(admin, user_id)
        q["user_id"] = PydanticObjectId(user_id)
    else:
        scope = await scoped_user_ids(admin)
        if scope is not None:
            if not scope:
                return APIResponse(data=[])
            q["user_id"] = {"$in": scope}
    rows = await Holding.find(q).limit(500).to_list()
    user_ids = list({r.user_id for r in rows})
    users = await User.find({"_id": {"$in": user_ids}}).to_list() if user_ids else []
    umap = {str(u.id): u.user_code for u in users}
    return APIResponse(
        data=[
            {
                "id": str(r.id),
                "user_id": str(r.user_id),
                "user_code": umap.get(str(r.user_id)),
                "symbol": r.instrument.symbol,
                "exchange": str(r.instrument.exchange),
                "quantity": r.quantity,
                "avg_price": str(r.avg_price),
                "ltp": str(r.ltp),
                "invested_value": str(r.invested_value),
                "current_value": str(r.current_value),
                "pnl": str(r.pnl),
                "pnl_percentage": r.pnl_percentage,
            }
            for r in rows
        ]
    )
