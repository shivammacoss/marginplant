"""User-side segment-settings preview.

The order panel calls this when the user picks an instrument so the UI can
show the EXACT lot/quantity/value/margin/brokerage the server is going to
enforce — same numbers the validator and matching engine resolve. Surfacing
them up-front means users see what's enforced before they submit, instead of
discovering it when their order gets rejected.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app.core.dependencies import CurrentUser
from app.schemas.common import APIResponse
from app.services import instrument_service, netting_service

router = APIRouter(prefix="/segment-settings", tags=["user-segment-settings"])


@router.get("/effective", response_model=APIResponse[dict])
async def get_effective_for_instrument(
    user: CurrentUser,
    token: str = Query(..., description="Instrument token"),
    action: str = Query(default="BUY", regex="^(BUY|SELL)$"),
    product_type: str = Query(default="MIS", regex="^(MIS|NRML|CNC)$"),
):
    """Resolve the same netting/segment-settings stack the server will apply
    when an order with these inputs is placed. Returns lot limits, the
    margin % that'll actually be charged, the commission scheme, and the
    static caps (per-order qty, per-order value, max-each-lot, etc.)."""
    # Try MongoDB first, then auto-create from Zerodha cache (same helper
    # the instrument-detail endpoint uses).
    from app.api.v1.user.instruments import _find_or_create_from_zerodha

    instrument = await _find_or_create_from_zerodha(token)
    if instrument is None:
        raise HTTPException(status_code=404, detail=f"Instrument {token} not found")

    option_type = (
        instrument.option_type.value
        if instrument.option_type and hasattr(instrument.option_type, "value")
        else None
    )

    resolved: dict[str, Any] = await netting_service.get_effective_settings(
        user.id,  # type: ignore[arg-type]
        instrument.segment,
        action=action,
        option_type=option_type,
        product_type=product_type,
        symbol=instrument.symbol,
    )

    s = resolved["settings"]

    # Lot size resolution — canonical tables win over whatever's on the
    # Instrument row. Two sources depending on segment family:
    #   • Index F&O (CE/PE/FUT)  → `index_lots.get_index_lot_size`
    #       (NIFTY=75, BANKNIFTY=35, SENSEX=20 …; revises quarterly)
    #   • Infoway-fed instruments (crypto / forex / spot metals /
    #     spot energy)         → `infoway_lots.get_infoway_lot_size`
    #       (BTCUSD=100, EURUSD=100000, XAUUSD=100, USOIL=1000 …)
    #
    # Previously only the F&O branch ran, so the `lot_size` returned for
    # crypto/forex was whatever stale value sat on Instrument (often 1
    # for legacy auto-created rows). That left the APK's LOT⇄QTY toggle
    # as a no-op on BTCUSD / EURUSD because conversion read this field
    # and got `1`. Now both paths resolve so the toggle has a real
    # multiplier to work with.
    from app.models._base import InstrumentType
    from app.services.index_lots import get_index_lot_size
    from app.services.infoway_lots import get_infoway_lot_size
    from app.services.market_data_service import is_infoway_lot_segment

    canonical_lot: int | None = None
    if instrument.instrument_type in (InstrumentType.CE, InstrumentType.PE, InstrumentType.FUT):
        canonical_lot = get_index_lot_size(instrument.symbol, instrument.name)
    elif is_infoway_lot_segment(instrument.segment):
        canonical_lot = get_infoway_lot_size(
            instrument.symbol, instrument.segment
        )
    effective_lot_size = canonical_lot or instrument.lot_size or 1

    # Lazy self-heal: if the stored lot is wrong, persist the canonical
    # value so subsequent reads (order placement, positions enrichment,
    # admin views) all see the right number without depending on the
    # startup backfill having run.
    if canonical_lot and int(instrument.lot_size or 0) != canonical_lot:
        try:
            instrument.lot_size = canonical_lot
            await instrument.save()
        except Exception:
            pass

    # Trim down to the fields the OrderPanel actually displays — keeps the
    # response payload small for a 3× / second poll.
    out = {
        "segment_type": instrument.segment,
        "lot_size": effective_lot_size,
        "allow": s.get("allow"),
        # Lot limits
        "min_lot": s.get("min_lot"),
        "max_lot": s.get("max_lot"),
        "order_lot": s.get("order_lot"),
        "intraday_lot_limit": s.get("intraday_lot_limit"),
        "holding_lot_limit": s.get("holding_lot_limit"),
        "max_each_lot": s.get("max_each_lot"),
        "otm_max_each_lot": s.get("otm_max_each_lot"),
        # Quantity caps (mainly for equity)
        "min_qty": s.get("min_qty"),
        "per_order_qty": s.get("per_order_qty"),
        "max_qty_per_script": s.get("max_qty_per_script"),
        # Notional caps
        "max_value": s.get("max_value"),
        # Margin / leverage that'll actually be charged for this side+product
        "margin_percentage": s.get("margin_percentage"),
        "leverage": s.get("leverage"),
        # Mode + flat-rupees-per-lot drive the OrderPanel's margin tile.
        # When mode is "fixed" and fixed_margin_per_lot > 0, the UI shows
        # the flat value directly and skips its lot_size × price math.
        "margin_calc_mode": s.get("margin_calc_mode"),
        "fixed_margin_per_lot": s.get("fixed_margin_per_lot"),
        # Carry-forward (overnight) equivalents — let the OrderPanel show
        # both Intraday + Carry-forward margin tiles side-by-side without
        # the frontend having to guess (the old hardcoded `intraday × 1.4`
        # was wrong for every non-NSE-equity segment). For intraday-only
        # segments (Forex / Crypto / spot Commodity) these match the
        # intraday numbers — see netting_service for the source-of-truth
        # rules.
        "overnight_margin_percentage": s.get("overnight_margin_percentage"),
        "overnight_leverage": s.get("overnight_leverage"),
        "overnight_fixed_margin_per_lot": s.get("overnight_fixed_margin_per_lot"),
        # Commission preview
        "commission_type": s.get("commission_type"),
        "commission_value": s.get("commission_value"),
        "min_brokerage": s.get("min_brokerage"),
        "charge_on": s.get("charge_on"),
        # Risk gates
        "limit_percentage": s.get("limit_percentage"),
        "stop_loss_mandatory": s.get("stop_loss_mandatory"),
        "selling_overnight": s.get("selling_overnight"),
        # Source attribution so the UI can show "Override applied"
        "sources": resolved.get("sources", {}),
        # ── Diagnostic: prove which build/resolution is running ───────
        # Lets the user (or us) inspect in DevTools whether the backend
        # actually applied the Times-mode-symmetric-leverage patch. If
        # `times_mode_symmetric_leverage` is missing from the payload, the
        # running process is on an OLD build — frontend reload alone won't
        # fix the margin, the Python service has to be restarted.
        "_resolver_build": "times_mode_symmetric_leverage_v2",
    }
    return APIResponse(data=out)


@router.get("/inactive", response_model=APIResponse[list[str]])
async def list_inactive_admin_rows(user: CurrentUser):
    """Names of admin-matrix rows currently flagged `Block → isActive = No`.

    The user-side InstrumentsPanel uses this to hide whole asset-class
    chips (NSE EQ, MCX FUT, …) for segments the broker has paused — so
    the trader never even sees the chip, let alone an empty results
    list. Cached in netting_service for 30 s so this endpoint is cheap.
    """
    rows = await netting_service.inactive_admin_rows()
    return APIResponse(data=sorted(rows))
