"""Admin Zerodha integration endpoints — mirrors the bharat_indian_funded
ZerodhaConnect.jsx contract one-to-one so the same admin UI can drive it."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import RedirectResponse

from app.core.config import settings as app_settings
from app.core.dependencies import CurrentAdmin
from app.services.zerodha_service import zerodha

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/zerodha", tags=["admin-zerodha"])


def _admin_redirect(suffix: str) -> str:
    """Build the post-OAuth admin SPA URL using the configured admin origin
    so a localhost-only dev setup and a deployed admin both work."""
    base = (app_settings.CORS_ADMIN_ORIGIN or "http://localhost:3001").rstrip("/")
    return f"{base}/zerodha{suffix}"


# ─────────────────────────── Settings ────────────────────────────────


@router.get("/settings")
async def get_settings(admin: CurrentAdmin):
    return {"success": True, "settings": await zerodha.get_settings_full()}


@router.post("/settings")
async def update_settings(payload: dict[str, Any], admin: CurrentAdmin):
    await zerodha.update_settings(payload)
    return {"success": True, "settings": await zerodha.get_settings_full()}


@router.get("/status")
async def status(admin: CurrentAdmin):
    return {"success": True, "status": await zerodha.get_status()}


# ─────────────────────────── OAuth flow ──────────────────────────────


@router.get("/login-url")
async def login_url(admin: CurrentAdmin):
    try:
        return {"success": True, "loginUrl": await zerodha.get_login_url()}
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/callback")
async def oauth_callback(request_token: str | None = Query(default=None)):
    """Browser-facing OAuth callback. We accept the request_token, exchange
    it for an access_token, and redirect back to the admin SPA. No JWT here."""
    if not request_token:
        return RedirectResponse(url=_admin_redirect("?error=missing_request_token"))
    try:
        await zerodha.generate_session(request_token)
        return RedirectResponse(url=_admin_redirect("?success=true"))
    except Exception as e:  # pragma: no cover
        logger.exception("zerodha_callback_failed")
        return RedirectResponse(url=_admin_redirect(f"?error={str(e)[:200]}"))


@router.post("/connect-with-token")
async def connect_with_token(payload: dict[str, Any], admin: CurrentAdmin):
    """Manual fallback when the OAuth redirect can't reach the backend —
    paste the request_token from the Kite URL here."""
    rt = (payload.get("request_token") or "").strip()
    if not rt:
        raise HTTPException(status_code=400, detail="request_token is required")
    try:
        result = await zerodha.connect_with_token(rt)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"success": True, "result": result}


@router.post("/logout")
async def logout(admin: CurrentAdmin):
    await zerodha.disconnect()
    return {"success": True}


# ─────────────────────────── WebSocket ──────────────────────────────


@router.post("/connect-ws")
async def connect_ws(admin: CurrentAdmin):
    try:
        await zerodha.connect_ws()
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"success": True, "status": await zerodha.get_status()}


@router.post("/disconnect-ws")
async def disconnect_ws(admin: CurrentAdmin):
    await zerodha.disconnect_ws()
    return {"success": True}


# ─────────────────────────── Instruments ────────────────────────────


@router.get("/instruments/search")
async def search_instruments(
    admin: CurrentAdmin,
    query: str = Query(..., min_length=1),
    segment: str | None = Query(default=None),
):
    try:
        results = await zerodha.search_instruments(query, segment)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"success": True, "instruments": results}


@router.get("/instruments/subscribed")
async def list_subscribed(admin: CurrentAdmin):
    return {"success": True, "instruments": await zerodha.get_subscribed()}


@router.post("/instruments/subscribe-defaults")
async def subscribe_defaults(admin: CurrentAdmin):
    """Bulk-subscribe the curated 600-instrument default set: NSE top 100
    equities + indices + NIFTY/BANKNIFTY/FINNIFTY current+next expiry option
    chains around ATM. Resolved against the local Instrument catalogue so
    lot sizes / tick sizes come straight from the Kite contract file. Safe
    to re-run — `add_subscriptions_bulk` skips already-subscribed tokens."""
    try:
        added = await zerodha._auto_load_default_subscriptions()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Default seed failed: {e}")
    return {"success": True, "added": added, "status": await zerodha.get_status()}


@router.post("/instruments/subscribe-all")
async def subscribe_all(payload: dict[str, Any] | None = None, admin: CurrentAdmin = None):
    """Subscribe ALL instruments from specified exchanges on-demand via
    the multi-WebSocket pool. Instruments are held IN-MEMORY only (not
    saved to MongoDB). New WebSocket connections spawn automatically
    when existing ones hit the 3000-token limit.

    Body (optional): {"exchanges": ["NSE", "NFO", "MCX"]}
    Default: all exchanges (NSE, NFO, BSE, MCX, BFO)."""
    exchanges = None
    if payload and "exchanges" in payload:
        exchanges = payload["exchanges"]
    try:
        result = await zerodha.subscribe_all_instruments(exchanges)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Subscribe all failed: {e}")
    return {
        "success": True,
        **result,
        "ws_pool": zerodha.get_ws_pool_info(),
        "status": await zerodha.get_status(),
    }


@router.get("/ws-pool")
async def ws_pool_info(admin: CurrentAdmin):
    """Return multi-WebSocket pool diagnostics: connections, tokens per
    connection, capacity etc."""
    return {"success": True, "pool": zerodha.get_ws_pool_info()}


@router.get("/instruments/all")
async def list_all_cached(
    admin: CurrentAdmin,
    exchange: str | None = Query(default=None),
):
    return {
        "success": True,
        "instruments": await zerodha.get_all_cached_instruments(exchange),
    }


@router.post("/instruments/sync")
async def sync_instruments(admin: CurrentAdmin):
    """Drop in-memory CSV cache + remove expired subscribed instruments. The
    next search will fetch fresh CSV from Kite."""
    info = await zerodha.sync_instrument_cache()
    return {"success": True, **info}


@router.post("/instruments/clear")
async def clear_instruments(admin: CurrentAdmin):
    """Wipe subscribed instruments and the cache. The ticker is unsubscribed."""
    removed = await zerodha.clear_subscriptions_and_cache()
    return {"success": True, "cleared": removed}


@router.post("/instruments/subscribe")
async def subscribe_instrument(payload: dict[str, Any], admin: CurrentAdmin):
    inst = payload.get("instrument") or payload
    try:
        added = await zerodha.add_subscription(inst)
    except (ValueError, RuntimeError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"success": True, "added": added}


@router.post("/instruments/subscribe-bulk")
async def subscribe_bulk(payload: dict[str, Any], admin: CurrentAdmin):
    instruments = payload.get("instruments") or []
    if not isinstance(instruments, list):
        raise HTTPException(status_code=400, detail="instruments must be a list")
    count = await zerodha.add_subscriptions_bulk(instruments)
    return {"success": True, "count": count}


@router.delete("/instruments/{token}")
async def unsubscribe_instrument(token: int, admin: CurrentAdmin):
    removed = await zerodha.remove_subscription(token)
    if not removed:
        raise HTTPException(status_code=404, detail="Instrument not found in subscriptions")
    return {"success": True}


@router.get("/instruments/exchange/{exchange}")
async def list_for_exchange(exchange: str, admin: CurrentAdmin):
    """Fetch (and cache) every instrument for an exchange — used by the admin
    "Subscribe all from exchange" button."""
    try:
        instruments = await zerodha.fetch_instruments(exchange.upper())
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"success": True, "instruments": instruments}


# ─────────────────────────── Quotes / history ───────────────────────


@router.get("/quote")
async def get_quote(
    admin: CurrentAdmin,
    keys: str = Query(..., description="comma-separated Kite keys e.g. NSE:RELIANCE,NSE:TCS"),
):
    parts = [k.strip() for k in keys.split(",") if k.strip()]
    try:
        return {"success": True, "quotes": await zerodha.get_quote(parts)}
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/historical")
async def get_historical(
    admin: CurrentAdmin,
    token: int,
    interval: str = Query(default="5minute"),
    days: int = Query(default=5, ge=1, le=365),
):
    from datetime import datetime, timedelta, timezone

    to_dt = datetime.now(timezone.utc)
    from_dt = to_dt - timedelta(days=days)
    try:
        candles = await zerodha.get_historical(token, from_dt, to_dt, interval)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"success": True, "candles": candles}


@router.get("/historical/symbol/{symbol}")
async def get_historical_by_symbol(
    symbol: str,
    admin: CurrentAdmin,
    interval: str = Query(default="5minute"),
    days: int = Query(default=5, ge=1, le=365),
):
    """Resolve symbol → instrument_token, then return Kite historical candles."""
    inst = await zerodha.find_instrument_by_symbol(symbol)
    if not inst:
        raise HTTPException(status_code=404, detail=f"Symbol '{symbol}' not found in Zerodha catalogue")

    from datetime import datetime, timedelta, timezone

    to_dt = datetime.now(timezone.utc)
    from_dt = to_dt - timedelta(days=days)
    try:
        candles = await zerodha.get_historical(int(inst["token"]), from_dt, to_dt, interval)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"success": True, "instrument": inst, "candles": candles}


# ─────────────────────────── Debug ──────────────────────────────────


@router.get("/debug-csv")
async def debug_csv(
    admin: CurrentAdmin,
    exchange: str = Query(default="NFO"),
):
    """Quick smoke test: confirms credentials work by pulling one row from the
    instruments CSV. Returns the first parsed instrument."""
    try:
        return {"success": True, **await zerodha.debug_csv_sample(exchange)}
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/diagnose")
async def diagnose(admin: CurrentAdmin):
    """End-to-end pipeline check: credentials, auth, ticker, REST quote, and
    instruments fetch — each graded independently. Use this to pinpoint why
    live data isn't flowing on the user terminal."""
    return {"success": True, "report": await zerodha.diagnose()}
