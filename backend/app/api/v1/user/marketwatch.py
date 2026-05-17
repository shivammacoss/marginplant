"""Watchlist CRUD."""

from __future__ import annotations

import logging

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException

from app.core.dependencies import CurrentUser
from app.core.redis_client import publish
from app.models._base import Exchange
from app.models.watchlist import Watchlist, WatchlistItem
from app.schemas.common import APIResponse
from app.schemas.trading import WatchlistAddItem, WatchlistCreate
from app.services import instrument_service, market_data_service

logger = logging.getLogger(__name__)


async def _notify_marketwatch_changed(
    user_id: PydanticObjectId, action: str, payload: dict | None = None,
) -> None:
    """Fan a `marketwatch` event to every open WS session of this user so
    the other client (apk / web / mobile-web) invalidates its watchlist
    cache instantly — no waiting for the next REST poll. Best-effort: a
    Redis hiccup never rolls back the DB write that just succeeded.
    """
    try:
        await publish(
            f"user:{user_id}:marketwatch",
            {"type": "marketwatch", "payload": {"action": action, **(payload or {})}},
        )
    except Exception:  # noqa: BLE001 — best-effort
        logger.warning("watchlist_publish_failed", extra={"user_id": str(user_id)})


async def _zerodha_subscribe(token: str, symbol: str, exchange: str) -> None:
    """Best-effort: subscribe one instrument to the live Zerodha ticker. Only
    runs for numeric Kite tokens (Indian segments); skips Infoway-mirrored
    forex/crypto/metal tokens which are handled separately."""
    try:
        token_int = int(token)
    except (TypeError, ValueError):
        return  # Infoway / synthetic token — Zerodha doesn't know it
    try:
        from app.services.zerodha_service import zerodha
        await zerodha.subscribe_tokens_on_demand(
            [token_int],
            symbols={token_int: {"symbol": symbol, "exchange": exchange}},
        )
    except Exception:
        logger.warning("watchlist_zerodha_subscribe_failed", extra={"token": token})


async def _zerodha_unsubscribe_if_orphan(token: str) -> None:
    """Unsubscribe from Zerodha only if NO user has this instrument in any
    watchlist anymore — saves WS slots without breaking other traders."""
    try:
        token_int = int(token)
    except (TypeError, ValueError):
        return
    still_used = await WatchlistItem.find_one(WatchlistItem.instrument_token == token)
    if still_used is not None:
        return  # someone else still wants ticks for this instrument
    try:
        from app.services.zerodha_service import zerodha
        await zerodha.unsubscribe_tokens_on_demand([token_int])
    except Exception:
        logger.warning("watchlist_zerodha_unsubscribe_failed", extra={"token": token})

router = APIRouter(prefix="/marketwatch", tags=["user-marketwatch"])

MAX_WATCHLISTS = 10

# Default watchlist content — populated on first login so new users see
# something useful in "Favorites" instead of an empty list. Order matters:
# top of the list = first row in the panel.
_DEFAULT_FAVORITES = [
    "NIFTY", "BANKNIFTY", "SENSEX",
    "RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK", "SBIN",
    "XAUUSD",
    "BTCUSD",
    "ETHUSD",
    "EURUSD",
]


async def _seed_default_favorites(wl: Watchlist) -> int:
    """Best-effort seed of a freshly-created watchlist with the popular
    instruments listed in `_DEFAULT_FAVORITES`. Idempotent — skips any
    symbol whose Instrument row doesn't yet exist (e.g. XAUUSD before
    Infoway has mirrored, BTCUSDT before the crypto channel is up). Returns
    the count actually inserted. Failure to insert any one item never
    blocks the rest."""
    from app.models.instrument import Instrument

    inserted = 0
    for idx, sym in enumerate(_DEFAULT_FAVORITES):
        inst = await Instrument.find_one(Instrument.symbol == sym)
        if inst is None:
            continue
        existing = await WatchlistItem.find_one(
            WatchlistItem.watchlist_id == wl.id,
            WatchlistItem.instrument_token == inst.token,
        )
        if existing is not None:
            continue
        try:
            item = WatchlistItem(
                watchlist_id=wl.id,
                instrument_token=inst.token,
                symbol=inst.symbol,
                exchange=Exchange(inst.exchange),
                sort_order=idx,
            )
            await item.insert()
            inserted += 1
            await _zerodha_subscribe(inst.token, inst.symbol, str(inst.exchange))
        except Exception:
            logger.warning(
                "default_favorite_insert_failed",
                extra={"symbol": sym, "watchlist": str(wl.id)},
            )
    if inserted:
        logger.info("seeded_default_favorites", extra={"count": inserted, "user": str(wl.user_id)})
    return inserted


# ── Per-segment managed instrument lists ──────────────────────────────
# Indian-segment chips (NSE EQ / NSE FUT / NSE OPT / BSE * / MCX *) are
# user-managed: instead of showing every Kite-cached instrument under the
# chip, the panel only shows what THIS user has explicitly added. We reuse
# the Watchlist model with a reserved name convention ``__seg_<NAME>`` so
# the regular favourites watchlist list isn't polluted with system rows.
_SEG_WL_PREFIX = "__seg_"

# Whitelist of admin-row names that can have a managed list. Keeps a user
# from creating an arbitrary watchlist under any string.
_ALLOWED_SEG_NAMES = frozenset(
    {
        "NSE_EQ", "NSE_FUT", "NSE_OPT",
        "BSE_EQ", "BSE_FUT", "BSE_OPT",
        "MCX_FUT", "MCX_OPT",
    }
)


async def _get_or_create_segment_watchlist(
    user_id: PydanticObjectId, segment_name: str
) -> Watchlist:
    """Auto-create the system watchlist for this user×segment. Idempotent."""
    name = _SEG_WL_PREFIX + segment_name
    wl = await Watchlist.find_one(
        Watchlist.user_id == user_id, Watchlist.name == name
    )
    if wl is not None:
        return wl
    wl = Watchlist(user_id=user_id, name=name, sort_order=999, is_default=False)
    await wl.insert()
    return wl


@router.get("/segment/{segment_name}/items", response_model=APIResponse[list])
async def list_segment_items(segment_name: str, user: CurrentUser):
    """Return only the instruments THIS user has explicitly added under
    the given Indian-segment chip (NSE_EQ, MCX_OPT, etc.). Empty list on
    first access — the user adds items via the search-and-add flow."""
    seg = segment_name.upper()
    if seg not in _ALLOWED_SEG_NAMES:
        raise HTTPException(status_code=400, detail=f"Unsupported segment: {segment_name}")
    wl = await _get_or_create_segment_watchlist(user.id, seg)
    items = (
        await WatchlistItem.find(WatchlistItem.watchlist_id == wl.id)
        .sort("sort_order")
        .to_list()
    )
    return APIResponse(
        data=[
            {
                "id": str(it.id),
                "instrument_token": it.instrument_token,
                "symbol": it.symbol,
                "exchange": str(it.exchange),
            }
            for it in items
        ]
    )


@router.post("/segment/{segment_name}/items", response_model=APIResponse[dict])
async def add_segment_item(
    segment_name: str, payload: WatchlistAddItem, user: CurrentUser
):
    seg = segment_name.upper()
    if seg not in _ALLOWED_SEG_NAMES:
        raise HTTPException(status_code=400, detail=f"Unsupported segment: {segment_name}")
    wl = await _get_or_create_segment_watchlist(user.id, seg)
    inst = await instrument_service.get_by_token(payload.token)
    existing = await WatchlistItem.find_one(
        WatchlistItem.watchlist_id == wl.id,
        WatchlistItem.instrument_token == inst.token,
    )
    if existing is not None:
        return APIResponse(data={"id": str(existing.id), "duplicate": True})
    count = await WatchlistItem.find(WatchlistItem.watchlist_id == wl.id).count()
    item = WatchlistItem(
        watchlist_id=wl.id,
        instrument_token=inst.token,
        symbol=inst.symbol,
        exchange=Exchange(inst.exchange),
        sort_order=count,
    )
    await item.insert()
    await _zerodha_subscribe(inst.token, inst.symbol, str(inst.exchange))
    await _notify_marketwatch_changed(
        user.id, "segment_add", {"segment": seg, "token": inst.token},
    )
    return APIResponse(data={"id": str(item.id)})


@router.delete(
    "/segment/{segment_name}/items/{token}", response_model=APIResponse[dict]
)
async def remove_segment_item(segment_name: str, token: str, user: CurrentUser):
    seg = segment_name.upper()
    if seg not in _ALLOWED_SEG_NAMES:
        raise HTTPException(status_code=400, detail=f"Unsupported segment: {segment_name}")
    wl = await _get_or_create_segment_watchlist(user.id, seg)
    item = await WatchlistItem.find_one(
        WatchlistItem.watchlist_id == wl.id,
        WatchlistItem.instrument_token == token,
    )
    if item is None:
        raise HTTPException(status_code=404, detail="Item not found")
    await item.delete()
    await _zerodha_unsubscribe_if_orphan(token)
    await _notify_marketwatch_changed(
        user.id, "segment_remove", {"segment": seg, "token": token},
    )
    return APIResponse(data={"ok": True})


@router.get("", response_model=APIResponse[list])
async def list_watchlists(user: CurrentUser):
    # Filter out system segment watchlists — they're served by the
    # /segment/* endpoints above and shouldn't pollute the regular
    # favourites list rendering.
    wls = (
        await Watchlist.find(
            Watchlist.user_id == user.id,
            {"name": {"$not": {"$regex": f"^{_SEG_WL_PREFIX}"}}},
        )
        .sort("sort_order", "name")
        .to_list()
    )
    if not wls:
        # Auto-create a default + seed with the popular instruments so a new
        # user lands in the panel and instantly sees NIFTY / BANKNIFTY /
        # RELIANCE / BTCUSD / XAUUSD streaming, instead of an empty list.
        wl = Watchlist(user_id=user.id, name="My Watchlist", sort_order=0, is_default=True)
        await wl.insert()
        await _seed_default_favorites(wl)
        wls = [wl]
    else:
        # Back-fill: if the first watchlist was auto-created before the
        # default-favorites seed existed AND the user hasn't added anything
        # to it yet, populate it now. Skipped the moment the user adds even
        # one item of their own, so we never overwrite a deliberately empty
        # list.
        first = wls[0]
        if first.is_default:
            existing_count = await WatchlistItem.find(
                WatchlistItem.watchlist_id == first.id
            ).count()
            if existing_count == 0:
                await _seed_default_favorites(first)
    out = []
    for wl in wls:
        items = await WatchlistItem.find(WatchlistItem.watchlist_id == wl.id).sort("sort_order").to_list()
        out.append(
            {
                "id": str(wl.id),
                "name": wl.name,
                "sort_order": wl.sort_order,
                "is_default": wl.is_default,
                "items": [
                    {
                        "id": str(it.id),
                        "instrument_token": it.instrument_token,
                        "symbol": it.symbol,
                        "exchange": str(it.exchange),
                    }
                    for it in items
                ],
            }
        )
    return APIResponse(data=out)


@router.post("", response_model=APIResponse[dict])
async def create(payload: WatchlistCreate, user: CurrentUser):
    count = await Watchlist.find(Watchlist.user_id == user.id).count()
    if count >= MAX_WATCHLISTS:
        raise HTTPException(status_code=400, detail=f"Limit of {MAX_WATCHLISTS} watchlists reached")
    wl = Watchlist(user_id=user.id, name=payload.name.strip(), sort_order=count)
    await wl.insert()
    return APIResponse(data={"id": str(wl.id), "name": wl.name})


@router.delete("/{watchlist_id}", response_model=APIResponse[dict])
async def delete(watchlist_id: str, user: CurrentUser):
    wl = await Watchlist.get(PydanticObjectId(watchlist_id))
    if wl is None or wl.user_id != user.id:
        raise HTTPException(status_code=404, detail="Watchlist not found")
    items = await WatchlistItem.find(WatchlistItem.watchlist_id == wl.id).to_list()
    tokens = [it.instrument_token for it in items]
    await WatchlistItem.find(WatchlistItem.watchlist_id == wl.id).delete()
    await wl.delete()
    # Try to free WS slots for every removed instrument that nobody else holds.
    for tok in tokens:
        await _zerodha_unsubscribe_if_orphan(tok)
    return APIResponse(data={"ok": True})


@router.post("/{watchlist_id}/items", response_model=APIResponse[dict])
async def add_item(watchlist_id: str, payload: WatchlistAddItem, user: CurrentUser):
    wl = await Watchlist.get(PydanticObjectId(watchlist_id))
    if wl is None or wl.user_id != user.id:
        raise HTTPException(status_code=404, detail="Watchlist not found")
    inst = await instrument_service.get_by_token(payload.token)
    existing = await WatchlistItem.find_one(
        WatchlistItem.watchlist_id == wl.id, WatchlistItem.instrument_token == inst.token
    )
    if existing is not None:
        return APIResponse(data={"id": str(existing.id), "duplicate": True})
    count = await WatchlistItem.find(WatchlistItem.watchlist_id == wl.id).count()
    item = WatchlistItem(
        watchlist_id=wl.id,
        instrument_token=inst.token,
        symbol=inst.symbol,
        exchange=Exchange(inst.exchange),
        sort_order=count,
    )
    await item.insert()
    # On-demand Zerodha subscribe — fire ticks for this instrument now that
    # someone wants them. No-op for Infoway-quoted symbols.
    await _zerodha_subscribe(inst.token, inst.symbol, str(inst.exchange))
    await _notify_marketwatch_changed(
        user.id, "add", {"watchlist_id": str(wl.id), "token": inst.token},
    )
    return APIResponse(data={"id": str(item.id)})


@router.delete("/{watchlist_id}/items/{item_id}", response_model=APIResponse[dict])
async def remove_item(watchlist_id: str, item_id: str, user: CurrentUser):
    wl = await Watchlist.get(PydanticObjectId(watchlist_id))
    if wl is None or wl.user_id != user.id:
        raise HTTPException(status_code=404, detail="Watchlist not found")
    item = await WatchlistItem.get(PydanticObjectId(item_id))
    if item is None:
        raise HTTPException(status_code=404, detail="Item not found")
    token = item.instrument_token
    await item.delete()
    # If no other user still has this instrument in any watchlist, free up
    # the Zerodha WS slot.
    await _zerodha_unsubscribe_if_orphan(token)
    await _notify_marketwatch_changed(
        user.id, "remove", {"watchlist_id": str(wl.id), "token": token},
    )
    return APIResponse(data={"ok": True})


@router.get("/{watchlist_id}/quotes", response_model=APIResponse[list])
async def quotes(watchlist_id: str, user: CurrentUser):
    wl = await Watchlist.get(PydanticObjectId(watchlist_id))
    if wl is None or wl.user_id != user.id:
        raise HTTPException(status_code=404, detail="Watchlist not found")
    items = await WatchlistItem.find(WatchlistItem.watchlist_id == wl.id).to_list()
    quotes = await market_data_service.get_quotes([it.instrument_token for it in items])
    return APIResponse(
        data=[
            {
                "instrument_token": it.instrument_token,
                "symbol": it.symbol,
                "exchange": str(it.exchange),
                **q,
            }
            for it, q in zip(items, quotes)
        ]
    )
