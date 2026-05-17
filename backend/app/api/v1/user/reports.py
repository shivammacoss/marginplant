"""User reports — P&L, tradebook, brokerage, tax, margin (JSON + PDF)."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from app.core.dependencies import CurrentUser
from app.models.trade import Trade
from app.schemas.common import APIResponse
from app.services import report_pdf_service
from app.utils.time_utils import now_utc

router = APIRouter(prefix="/reports", tags=["user-reports"])


# Shared payload builders so JSON + PDF endpoints stay byte-identical.
# (Avoids drift where the PDF says one number and the JSON another.)


async def _pnl_payload(user, from_date: datetime | None, to_date: datetime | None) -> dict:
    f = from_date or (now_utc() - timedelta(days=30))
    t = to_date or now_utc()
    trades = await Trade.find(
        Trade.user_id == user.id,
        Trade.executed_at >= f,
        Trade.executed_at <= t,
    ).sort("+executed_at").to_list()

    total_buy = 0.0
    total_sell = 0.0
    total_charges = 0.0
    by_symbol: dict[str, dict[str, Any]] = {}
    for tr in trades:
        sym = tr.instrument.symbol
        v = float(str(tr.value))
        c = float(str(tr.total_charges))
        total_charges += c
        agg = by_symbol.setdefault(
            sym,
            {
                "symbol": sym,
                "buy_qty": 0,
                "sell_qty": 0,
                "buy_value": 0.0,
                "sell_value": 0.0,
                "charges": 0.0,
            },
        )
        if tr.action.value == "BUY":
            agg["buy_qty"] += tr.quantity
            agg["buy_value"] += v
            total_buy += v
        else:
            agg["sell_qty"] += tr.quantity
            agg["sell_value"] += v
            total_sell += v
        agg["charges"] += c
        agg["pnl"] = agg["sell_value"] - agg["buy_value"] - agg["charges"]

    realized = round(total_sell - total_buy, 2)
    charges = round(total_charges, 2)
    net = round(realized - charges, 2)
    by_symbol_rows = list(by_symbol.values())
    return {
        "from": f,
        "to": t,
        "total_trades": len(trades),
        # Legacy + PDF-builder field names (do NOT remove — report_pdf_service
        # reads these directly).
        "total_buy_value": round(total_buy, 2),
        "total_sell_value": round(total_sell, 2),
        "total_charges": charges,
        "net_pnl": net,
        "by_symbol": by_symbol_rows,
        # APK-facing field names — match the PnlReport TypeScript schema in
        # setupfx-ind_apk/src/features/reports/api/reports.api.ts. Without
        # these the mobile P&L screen reads `undefined` for every total
        # and renders all ₹0.00 even when trades exist.
        "rows": [
            {
                "symbol": r["symbol"],
                "net_pnl": round(float(r.get("pnl") or 0), 2),
                "realized_pnl": round(
                    float(r.get("sell_value") or 0)
                    - float(r.get("buy_value") or 0),
                    2,
                ),
                "brokerage": round(float(r.get("charges") or 0), 2),
                "trades": int((r.get("buy_qty") or 0) + (r.get("sell_qty") or 0) > 0)
                + 0,  # at least 1 if any qty
            }
            for r in by_symbol_rows
        ],
        "total_realized": realized,
        "total_unrealized": 0.0,
        "total_brokerage": charges,
        "total_taxes": 0.0,
        "total_net": net,
    }


async def _tradebook_payload(
    user, from_date: datetime | None, to_date: datetime | None, limit: int,
) -> list[dict]:
    q: dict[str, Any] = {"user_id": user.id}
    if from_date or to_date:
        q["executed_at"] = {}
        if from_date:
            q["executed_at"]["$gte"] = from_date
        if to_date:
            q["executed_at"]["$lte"] = to_date
    rows = await Trade.find(q).sort("-executed_at").limit(limit).to_list()
    return [
        {
            "id": str(t.id),
            "trade_number": t.trade_number,
            "order_id": str(t.order_id),
            "symbol": t.instrument.symbol,
            "exchange": str(t.instrument.exchange),
            "action": t.action.value,
            "quantity": t.quantity,
            "price": str(t.price),
            "value": str(t.value),
            "brokerage": str(t.brokerage),
            "total_charges": str(t.total_charges),
            "executed_at": t.executed_at,
        }
        for t in rows
    ]


async def _brokerage_payload(
    user, from_date: datetime | None, to_date: datetime | None,
) -> dict:
    f = from_date or (now_utc() - timedelta(days=30))
    t = to_date or now_utc()
    trades = await Trade.find(
        Trade.user_id == user.id, Trade.executed_at >= f, Trade.executed_at <= t,
    ).to_list()
    totals = {"brokerage": 0.0, "total": 0.0}
    for tr in trades:
        totals["brokerage"] += float(str(tr.brokerage))
        totals["total"] += float(str(tr.total_charges))
    return {
        "from": f,
        "to": t,
        "totals": {k: round(v, 2) for k, v in totals.items()},
        "trade_count": len(trades),
    }


async def _tax_payload(user) -> dict:
    """Simplified Indian tax-pnl bucketization. Real CG calc would consider
    FIFO holding period etc."""
    trades = await Trade.find(Trade.user_id == user.id).to_list()
    buckets = {"intraday_speculative": 0.0, "stcg": 0.0, "ltcg": 0.0, "fno": 0.0}
    for tr in trades:
        seg = (tr.instrument.segment or "").upper()
        v = float(str(tr.value))
        if "FUTURE" in seg or "OPTION" in seg:
            buckets["fno"] += v if tr.action.value == "SELL" else -v
        else:
            buckets["stcg"] += v if tr.action.value == "SELL" else -v
    return {"buckets": {k: round(v, 2) for k, v in buckets.items()}}


# ── JSON endpoints (existing contract) ───────────────────────────────


@router.get("/pnl", response_model=APIResponse[dict])
async def pnl_report(
    user: CurrentUser,
    from_date: datetime | None = None,
    to_date: datetime | None = None,
):
    return APIResponse(data=await _pnl_payload(user, from_date, to_date))


@router.get("/tradebook", response_model=APIResponse[list])
async def tradebook(
    user: CurrentUser,
    from_date: datetime | None = None,
    to_date: datetime | None = None,
    limit: int = Query(default=500, le=2000),
):
    return APIResponse(data=await _tradebook_payload(user, from_date, to_date, limit))


@router.get("/brokerage", response_model=APIResponse[dict])
async def brokerage_summary(
    user: CurrentUser,
    from_date: datetime | None = None,
    to_date: datetime | None = None,
):
    return APIResponse(data=await _brokerage_payload(user, from_date, to_date))


@router.get("/tax", response_model=APIResponse[dict])
async def tax_pnl(user: CurrentUser):
    return APIResponse(data=await _tax_payload(user))


@router.get("/margin", response_model=APIResponse[dict])
async def margin_report(user: CurrentUser):
    from app.services import wallet_service
    s = await wallet_service.summary(user.id)
    return APIResponse(data=s)


# ── PDF endpoints ────────────────────────────────────────────────────
# Each PDF endpoint reuses the same payload-building helper as its JSON
# sibling, then hands the payload to report_pdf_service to render an
# in-memory PDF. Streamed back as application/pdf with a Content-Disposition
# that defaults the filename in both browsers and Expo's
# FileSystem.downloadAsync. No filesystem writes — payload lives in memory.


def _pdf_response(data: bytes, filename: str) -> StreamingResponse:
    return StreamingResponse(
        iter([data]),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(len(data)),
            # Expose Content-Disposition so the web JS download flow can
            # respect the server-suggested filename across CORS (browsers
            # hide non-simple headers from fetch by default).
            "Access-Control-Expose-Headers": "Content-Disposition",
        },
    )


@router.get("/pnl/pdf")
async def pnl_report_pdf(
    user: CurrentUser,
    from_date: datetime | None = None,
    to_date: datetime | None = None,
):
    payload = await _pnl_payload(user, from_date, to_date)
    pdf = report_pdf_service.build_pnl_pdf(user, payload)
    stamp = datetime.now().strftime("%Y%m%d")
    return _pdf_response(pdf, f"setupfx_pnl_{stamp}.pdf")


@router.get("/tradebook/pdf")
async def tradebook_pdf(
    user: CurrentUser,
    from_date: datetime | None = None,
    to_date: datetime | None = None,
    limit: int = Query(default=500, le=2000),
):
    rows = await _tradebook_payload(user, from_date, to_date, limit)
    pdf = report_pdf_service.build_tradebook_pdf(user, rows)
    stamp = datetime.now().strftime("%Y%m%d")
    return _pdf_response(pdf, f"setupfx_tradebook_{stamp}.pdf")


@router.get("/brokerage/pdf")
async def brokerage_pdf(
    user: CurrentUser,
    from_date: datetime | None = None,
    to_date: datetime | None = None,
):
    payload = await _brokerage_payload(user, from_date, to_date)
    pdf = report_pdf_service.build_brokerage_pdf(user, payload)
    stamp = datetime.now().strftime("%Y%m%d")
    return _pdf_response(pdf, f"setupfx_brokerage_{stamp}.pdf")


@router.get("/tax/pdf")
async def tax_pdf(user: CurrentUser):
    payload = await _tax_payload(user)
    pdf = report_pdf_service.build_tax_pdf(user, payload)
    stamp = datetime.now().strftime("%Y%m%d")
    return _pdf_response(pdf, f"setupfx_tax_{stamp}.pdf")


@router.get("/margin/pdf")
async def margin_pdf(user: CurrentUser):
    from app.services import wallet_service
    s = await wallet_service.summary(user.id)
    if hasattr(s, "model_dump"):
        s = s.model_dump(mode="json")
    pdf = report_pdf_service.build_margin_pdf(user, s)
    stamp = datetime.now().strftime("%Y%m%d")
    return _pdf_response(pdf, f"setupfx_margin_{stamp}.pdf")
