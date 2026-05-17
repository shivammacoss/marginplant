"""Real market-data service — Zerodha (Indian) + Infoway (forex/crypto/etc).

NO mock/random-walk price generation. When no real feed is connected for
a token (Zerodha WS not subscribed AND Infoway not subscribed AND REST
snapshot unavailable), this service returns a zero-valued quote so the
UI clearly shows "—" for bid/ask/LTP instead of inventing fake prices.

Background tick loop publishes ticks ONLY when a real overlay updates
the cached quote — the loop no longer steps prices itself.

The service exposes:
    • get_ltp(token) → current price (Decimal); returns 0 if no feed
    • get_quote(token) → full quote shape (zeros when no feed)
    • subscribe(tokens) / unsubscribe(tokens) — in-memory tracking
    • tick_loop — publishes per-token ticks to Redis pub/sub for WS fanout.
"""

from __future__ import annotations

import asyncio
import logging
from decimal import Decimal
from typing import Any

from app.core.redis_client import publish
from app.models.instrument import Instrument  # noqa: F401 — kept for downstream imports
from app.utils.decimal_utils import quantize_money, to_decimal

logger = logging.getLogger(__name__)

# In-memory state: token → quote dict
_state: dict[str, dict[str, Any]] = {}
_subscribed: set[str] = set()
_running: bool = False


def _empty_quote(token: str) -> dict[str, Any]:
    """Zero-valued quote skeleton. Overlays (Zerodha / Infoway) fill in
    real numbers if the instrument is subscribed; otherwise the UI sees
    zeros and renders "—" placeholders instead of fake prices.
    """
    return {
        "token": token,
        "ltp": 0.0,
        "open": 0.0,
        "high": 0.0,
        "low": 0.0,
        "prev_close": 0.0,
        "change": 0.0,
        "change_pct": 0.0,
        "volume": 0,
        "bid": 0.0,
        "ask": 0.0,
        "depth": {"bids": [], "asks": []},
        "ts": 0,
    }


async def _ensure_quote(token: str) -> dict[str, Any]:
    """Return the in-memory quote slot for `token`, creating an empty one
    if needed. NEVER fabricates a price — the slot stays at zero until a
    real overlay (Zerodha tick / Infoway tick / Kite REST snapshot)
    fills it in."""
    if token in _state:
        return _state[token]
    _state[token] = _empty_quote(token)
    return _state[token]


async def _zerodha_overlay(token: str, base_quote: dict[str, Any]) -> dict[str, Any]:
    """If Zerodha is streaming this instrument, replace the mock LTP / bid /
    ask / OHLC / volume / depth with live exchange data. Falls through silently
    on any error so the UI stays usable in dev."""
    try:
        from app.services.zerodha_service import zerodha

        # 1) Direct token lookup — mirrored Zerodha subscriptions store the
        #    Kite instrument_token as Instrument.token, so this is the fast path.
        live: dict[str, Any] | None = None
        try:
            live = zerodha.ticks_by_token.get(int(token))
        except (TypeError, ValueError):
            live = None

        # 2) Resolve symbol + exchange so we can hit symbol cache and REST fallback.
        instr = None
        sym: str | None = None
        ex_str: str | None = None
        if live is None:
            instr = await Instrument.find_one(Instrument.token == token)
            if instr is not None and instr.symbol:
                sym = instr.symbol
                ex_attr = getattr(instr, "exchange", None)
                if ex_attr is not None:
                    ex_str = ex_attr.value if hasattr(ex_attr, "value") else str(ex_attr)

            # If the local Instrument is missing (option contracts subscribed
            # before mirror existed, etc.), look the same token up in the
            # Zerodha subscribed list — it carries symbol + exchange too.
            if sym is None:
                from app.models.zerodha_settings import ZerodhaSettings

                zsettings = await ZerodhaSettings.find_one()
                if zsettings is not None:
                    try:
                        token_int = int(token)
                    except (TypeError, ValueError):
                        token_int = None
                    sub = None
                    if token_int is not None:
                        sub = next((i for i in zsettings.subscribedInstruments if i.token == token_int), None)
                    if sub is None:
                        sub = next(
                            (i for i in zsettings.subscribedInstruments if str(i.token) == token),
                            None,
                        )
                    if sub is not None:
                        sym = sub.symbol
                        ex_str = sub.exchange

            # Last-resort lookup: scan the Zerodha in-memory instruments
            # cache itself. This unlocks live data for EVERY Kite-listed
            # symbol the user can see in the instruments panel — without
            # needing an explicit admin subscribe or a MongoDB mirror. The
            # cache is keyed per exchange and is warmed at startup, so the
            # scan is in-process and fast. With sym + ex_str resolved here,
            # `get_quote_snapshot` (REST) and `subscribe_tokens_on_demand`
            # (WS) downstream do the rest.
            if sym is None:
                try:
                    token_int = int(token)
                except (TypeError, ValueError):
                    token_int = None
                if token_int is not None:
                    for ex_key, cache in zerodha._instruments_cache.items():
                        match = next(
                            (r for r in cache if int(r.get("token") or 0) == token_int),
                            None,
                        )
                        if match is not None:
                            sym = match.get("symbol")
                            ex_str = (match.get("exchange") or ex_key).upper()
                            break

        # 3) Symbol-keyed live tick (covers seeded NSE_EQ_RELIANCE-style tokens
        #    where the local token is text but the live tick is keyed by symbol).
        if live is None and sym:
            live = zerodha.ticks_by_symbol.get(sym)

        # 4) REST `/quote` fallback — when the ticker has no recent push for
        #    this instrument (weekends, pre-open, fresh subscribe before the
        #    first tick arrives) we still want real exchange data, not mock.
        if not live and sym and ex_str:
            snap = await zerodha.get_quote_snapshot(ex_str, sym)
            if snap:
                live = snap

        if not live:
            return base_quote

        merged = dict(base_quote)
        merged["ltp"] = live.get("ltp", merged["ltp"])
        merged["open"] = live.get("open", merged["open"])
        merged["high"] = live.get("high", merged["high"])
        merged["low"] = live.get("low", merged["low"])
        merged["prev_close"] = live.get("close", merged["prev_close"])
        merged["volume"] = live.get("volume", merged["volume"])

        # 5-level depth — Kite ticks expose depth.buy/depth.sell when
        # subscribed in MODE_FULL. Translate to our schema (bids/asks) and
        # ALSO derive top-of-book bid/ask from it.
        depth = live.get("depth")
        best_bid_from_depth: float | None = None
        best_ask_from_depth: float | None = None
        if isinstance(depth, dict):
            bids = depth.get("buy") or []
            asks = depth.get("sell") or []
            if bids or asks:
                merged["depth"] = {
                    "bids": [
                        {
                            "price": float(b.get("price") or 0),
                            "qty": int(b.get("quantity") or 0),
                            "orders": int(b.get("orders") or 0),
                        }
                        for b in bids[:5]
                    ],
                    "asks": [
                        {
                            "price": float(a.get("price") or 0),
                            "qty": int(a.get("quantity") or 0),
                            "orders": int(a.get("orders") or 0),
                        }
                        for a in asks[:5]
                    ],
                }
                try:
                    if bids and float(bids[0].get("price") or 0) > 0:
                        best_bid_from_depth = float(bids[0]["price"])
                    if asks and float(asks[0].get("price") or 0) > 0:
                        best_ask_from_depth = float(asks[0]["price"])
                except (TypeError, ValueError, KeyError):
                    pass

        # Bid / ask resolution — ONLY real exchange data:
        #   1. Explicit `live.bid` / `live.ask` (set by REST snapshot
        #      or MODE_FULL pushes)
        #   2. Top of Kite depth book (MODE_FULL ticks)
        #   No synthesised fallback — when no real bid/ask is available
        #   we collapse them to the LTP so the admin's segment spread
        #   setting becomes the single source of bid/ask separation.
        live_bid = float(live.get("bid") or 0)
        live_ask = float(live.get("ask") or 0)
        ltp_f = float(merged.get("ltp") or 0)
        if live_bid > 0:
            merged["bid"] = live_bid
        elif best_bid_from_depth and best_bid_from_depth > 0:
            merged["bid"] = best_bid_from_depth
        else:
            merged["bid"] = ltp_f
        if live_ask > 0:
            merged["ask"] = live_ask
        elif best_ask_from_depth and best_ask_from_depth > 0:
            merged["ask"] = best_ask_from_depth
        else:
            merged["ask"] = ltp_f

        if merged["prev_close"]:
            merged["change"] = round(merged["ltp"] - merged["prev_close"], 2)
            merged["change_pct"] = round((merged["change"] / merged["prev_close"]) * 100, 2)
        merged["source"] = "zerodha"
        return merged
    except Exception:
        return base_quote


async def _infoway_overlay(token: str, base_quote: dict[str, Any]) -> dict[str, Any]:
    """Overlay live Infoway tick (forex / crypto / metals / energy). Infoway
    is keyed by SYMBOL (BTCUSDT, EURUSD, XAUUSD…); we resolve via the
    Instrument doc.

    Don't gate on `infoway.is_connected` — that property reaches into the
    websockets client object whose API changed between library versions and
    can throw / return False even while ticks are still in the cache. The
    cache itself is the source of truth: if there's a fresh tick keyed by
    this symbol, use it.
    """
    try:
        from app.services.infoway_service import infoway

        instr = await Instrument.find_one(Instrument.token == token)
        if instr is None or not instr.symbol:
            return base_quote
        sym = instr.symbol.upper()
        live = infoway.get_tick(sym) or infoway.get_tick(sym + "T")
        if not live:
            return base_quote
        ltp = float(live.get("ltp") or 0)
        if ltp <= 0:
            return base_quote
        merged = dict(base_quote)
        merged["ltp"] = ltp
        # Real best-bid / best-ask from Infoway depth book — collapse to
        # the LTP when no real bid/ask is pushed. Admin's segment spread
        # setting is the single source of bid/ask separation, no
        # synthesised micro-spread fallback.
        live_bid = float(live.get("bid") or 0)
        live_ask = float(live.get("ask") or 0)
        merged["bid"] = live_bid if live_bid > 0 else ltp
        merged["ask"] = live_ask if live_ask > 0 else ltp
        merged["volume"] = float(live.get("volume") or merged.get("volume") or 0)
        if live.get("close_24h"):
            merged["prev_close"] = float(live["close_24h"])
        merged["change"] = float(live.get("change") or merged.get("change") or 0)
        merged["change_pct"] = float(live.get("change_pct") or merged.get("change_pct") or 0)
        # Overlay real depth too if Infoway has a book for this symbol
        depth = infoway.depth.get(sym) or infoway.depth.get(sym + "T")
        if depth and depth.get("bids") and depth.get("asks"):
            merged["depth"] = {"bids": depth["bids"], "asks": depth["asks"]}
        merged["source"] = "infoway"
        # USD/INR snapshot so the frontend can show margin in real INR
        # rather than displaying the USD number with a ₹ symbol (which is
        # how users end up trying to place orders worth 80× their wallet).
        merged["fx_rate"] = get_usd_inr_rate()
        return merged
    except Exception:
        logger.exception("infoway_overlay_failed token=%s", token)
        return base_quote


async def _overlay_all(token: str, base: dict[str, Any]) -> dict[str, Any]:
    """Apply Infoway first (forex/crypto/metals/energy), then Zerodha (Indian).
    Whichever provider has live data wins.

    Both overlays may hit external services — Infoway reads from a local
    in-memory tick map (fast) but the Zerodha fallback issues a Kite REST
    `/quote` call that can stall when Kite is slow / TCP RST'd. We hard-cap
    each overlay at 2 seconds so a hung external service can NEVER freeze
    callers like `order_service.place_order` → `matching_engine.execute_market_order`
    → `get_ltp`. On timeout the overlay falls back to the cached base quote
    (last-known real value or zero) — never a fabricated price.

    After both feed overlays run, the admin's per-segment spread (Fixed /
    Floating + spread_pips) is applied as the final pass. This is the
    "money changer" markup — bid moves down half-spread, ask moves up
    half-spread, around the live LTP. Cached resolution per
    `(segment, symbol)` for 30 s so the 250 ms WS pump doesn't go to
    Mongo on every tick.
    """
    try:
        after_infoway = await asyncio.wait_for(_infoway_overlay(token, base), timeout=2.0)
    except asyncio.TimeoutError:
        logger.warning("infoway_overlay_timeout", extra={"token": token})
        after_infoway = base
    except Exception:
        logger.exception("infoway_overlay_failed", extra={"token": token})
        after_infoway = base
    if after_infoway.get("source") == "infoway":
        return await _apply_admin_spread(token, after_infoway)
    try:
        zerodha_quote = await asyncio.wait_for(_zerodha_overlay(token, base), timeout=2.0)
    except asyncio.TimeoutError:
        logger.warning("zerodha_overlay_timeout", extra={"token": token})
        zerodha_quote = base
    except Exception:
        logger.exception("zerodha_overlay_failed", extra={"token": token})
        zerodha_quote = base
    return await _apply_admin_spread(token, zerodha_quote)


# Token → segment cache so the spread step doesn't re-fetch the Instrument
# doc on every tick. Segment is essentially immutable for a token (changes
# only via admin edit), so a 5-min TTL is plenty. Misses fall through to
# Mongo and re-cache. Falsy values aren't cached (an instrument that doesn't
# exist yet might be mirrored on the next call).
_SEGMENT_FOR_TOKEN_TTL = 300
_SEGMENT_FOR_TOKEN_PREFIX = "spread_seg:"


async def _segment_for_token(token: str) -> tuple[str, str] | None:
    """Return `(segment_type, symbol_upper)` for a token, or None if the
    instrument isn't in our collection."""
    cache_key = f"{_SEGMENT_FOR_TOKEN_PREFIX}{token}"
    try:
        from app.core.redis_client import cache_get, cache_set

        cached = await cache_get(cache_key)
        if cached is not None:
            return (cached.get("seg") or "", cached.get("sym") or "")
    except Exception:
        cache_set = None  # type: ignore[assignment]

    instr = await Instrument.find_one(Instrument.token == token)
    if instr is None:
        return None
    seg_value = getattr(instr.segment, "value", instr.segment)
    sym = (instr.symbol or "").upper()
    payload = {"seg": str(seg_value), "sym": sym}
    try:
        if cache_set is not None:
            await cache_set(cache_key, payload, ttl_sec=_SEGMENT_FOR_TOKEN_TTL)
    except Exception:
        pass
    return (str(seg_value), sym)


async def _apply_admin_spread(token: str, quote: dict[str, Any]) -> dict[str, Any]:
    """Final overlay: apply the admin-configured spread to the live quote.

    Fixed mode  → bid = ltp − pips/2, ask = ltp + pips/2 every tick. The
                  exchange spread is ignored entirely (broker-set markup).
    Floating    → keep the live (ask − bid), but widen symmetrically around
                  ltp when it falls below `spread_pips`. Implements the
                  "real spread, but never less than minimum" rule.

    `spread_pips` is interpreted as PRICE UNITS for that instrument (admin
    sees the same units they'd see on the chart — 0.0002 for EURUSD,
    0.50 for XAUUSD, 5 for NIFTY). Zero or negative → no spread mod.

    Skipped when `spread_pips <= 0` so admin can opt out by leaving the
    field blank.
    """
    try:
        ltp = float(quote.get("ltp") or 0)
        if ltp <= 0:
            return quote

        seg_sym = await _segment_for_token(token)
        if seg_sym is None:
            return quote
        seg_type, symbol = seg_sym

        # Translate instrument segment → admin row name (NSE_EQ / FOREX /
        # CRYPTO / …) the way the rest of the resolver stack does.
        from app.services.netting_service import _SEGMENT_NAME_MAP, resolve_spread

        admin_row = _SEGMENT_NAME_MAP.get(seg_type, seg_type)
        cfg = await resolve_spread(admin_row, symbol)
        pips = float(cfg.get("spread_pips") or 0)
        if pips <= 0:
            return quote
        mode = str(cfg.get("spread_type") or "fixed").lower()

        half = pips / 2.0
        live_bid = float(quote.get("bid") or 0)
        live_ask = float(quote.get("ask") or 0)
        live_spread = (live_ask - live_bid) if (live_bid > 0 and live_ask > 0) else 0.0

        if mode == "fixed":
            merged = dict(quote)
            merged["bid"] = ltp - half
            merged["ask"] = ltp + half
            return merged

        # Floating: keep market spread until it's tighter than the minimum,
        # then widen to the minimum around the LTP midpoint.
        if live_spread < pips:
            merged = dict(quote)
            merged["bid"] = ltp - half
            merged["ask"] = ltp + half
            return merged
        return quote
    except Exception:
        logger.exception("admin_spread_overlay_failed", extra={"token": token})
        return quote


# ── USD → INR conversion (forex / crypto P&L is reported in INR) ─────
USD_INR_FALLBACK = 83.0  # used only if Infoway hasn't pushed a USDINR tick yet


def get_usd_inr_rate() -> float:
    """Live USD/INR conversion rate. Infoway subscribes to USDINR by default,
    so this is the rate at which crypto / forex P&L gets translated for
    Indian wallets. Falls back to a sensible constant on a cold start."""
    try:
        from app.services.infoway_service import infoway

        for sym in ("USDINR", "USDINR=X", "USD/INR"):
            tick = infoway.get_tick(sym)
            if tick:
                ltp = float(tick.get("ltp") or 0)
                if ltp > 0:
                    return ltp
    except Exception:  # noqa: BLE001
        pass
    return USD_INR_FALLBACK


def is_infoway_lot_segment(segment: str | None) -> bool:
    """Whether the segment is sourced from the Infoway feed for lot-table
    resolution purposes. STOCKS / INDICES / CRYPTO / FOREX / COMMODITIES /
    CDS — every segment that does NOT come from the Zerodha-fed NSE / BSE
    / MCX / NFO / BFO lot tables.

    This is the segment classifier the ORDER PLACEMENT path uses to pick
    between `infoway_lots.get_infoway_lot_size` and the canonical Indian
    lot tables. It is intentionally separate from `is_usd_quoted_segment`
    below: that flag now governs *FX conversion* of P&L / margin only, and
    has been disabled per the broker's spec ("treat the Infoway feed price
    as INR directly"). Without this split, disabling FX conversion would
    also break lot-size resolution for forex/crypto/etc.
    """
    s = (segment or "").upper()
    if s in ("STOCKS", "INDICES"):
        return True
    return (
        "CRYPTO" in s
        or "FOREX" in s
        or "FX" in s
        or "CDS" in s
        or "COMMODITIES" in s
    )


def is_usd_quoted_segment(segment: str | None) -> bool:
    """Whether the segment's P&L / margin needs USD→INR conversion.

    Per the broker's spec, Infoway-feed prices (forex / crypto / spot
    metals / energy / international stocks & indices) are now treated as
    INR directly — there is no live USD→INR multiplication on P&L, no
    margin scaling, and the UI renders these prices with ₹ rather than $.
    So this helper always returns False; every legacy call site that gated
    FX conversion on it becomes a no-op without further changes.

    For Infoway lot-table selection use ``is_infoway_lot_segment`` above.
    """
    # Reference the parameter so linters don't flag it unused — the
    # signature is kept stable for every existing caller.
    _ = segment
    return False


# Short in-process overlay cache (token → (timestamp_ms, payload)). The
# overlay pipeline blocks on Zerodha + Infoway sequentially with a 2 s
# timeout each — when the chart datafeed, the OrderPanel, the
# MobileQuickTradeBar, and the positions overlay all call get_quote for
# the same token within ~500 ms, the user paid for that overlay 4 times.
# A 700 ms TTL is short enough that a stale price never lingers visibly
# (the WS pump runs every 1 s anyway) but kills the duplicate-fanout cost.
import time as _t

_QUOTE_CACHE_TTL_MS = 700
_quote_cache: dict[str, tuple[int, dict[str, Any]]] = {}


async def get_quote(token: str) -> dict[str, Any]:
    now_ms = int(_t.time() * 1000)
    cached = _quote_cache.get(token)
    if cached and (now_ms - cached[0]) < _QUOTE_CACHE_TTL_MS:
        return cached[1]
    q = await _ensure_quote(token)
    out = await _overlay_all(token, q)
    _quote_cache[token] = (now_ms, out)
    return out


async def get_ltp(token: str) -> Decimal:
    q = await get_quote(token)
    return quantize_money(to_decimal(q["ltp"]))


async def get_quotes(tokens: list[str]) -> list[dict[str, Any]]:
    # Previously this looped serially — each token's `_overlay_all` blocked
    # on Zerodha + Infoway timeouts (~2 s each) BEFORE moving to the next
    # token. With 5 instruments on the OrderPanel that was a ~10 s worst-
    # case for a single batch request. asyncio.gather fans them out in
    # parallel so the total wait drops to the slowest single overlay.
    async def _one(t: str) -> dict[str, Any]:
        q = await _ensure_quote(t)
        return await _overlay_all(t, q)

    return list(await asyncio.gather(*[_one(t) for t in tokens]))


def subscribe(tokens: list[str]) -> None:
    _subscribed.update(tokens)


def unsubscribe(tokens: list[str]) -> None:
    for t in tokens:
        _subscribed.discard(t)


# ── Background tick loop ────────────────────────────────────────────
async def tick_loop(interval_sec: float = 1.0) -> None:
    """Fan out subscribed instrument ticks to Redis pub/sub.

    No price generation here — the loop only mirrors whatever the real
    overlays (Zerodha WS / Infoway WS / Kite REST snapshot) have already
    written into `_state`. Tokens with LTP = 0 are skipped so we don't
    spam consumers with zero-priced ticks for instruments that have no
    real feed yet.
    """
    global _running
    if _running:
        return
    _running = True
    logger.info("market_tick_loop_started")
    try:
        import time

        while _running:
            try:
                now_ms = int(time.time() * 1000)
                # Collect subscribed (token, base) pairs first so we can
                # fan the overlays out in parallel. The old code awaited
                # `_overlay_all` per-token in a serial for-loop — with
                # N subscribed instruments each taking the worst-case
                # Zerodha REST overlay (~200-2000 ms), one iteration
                # could stretch into multiple seconds and starve the
                # 250 ms tick-loop cadence.
                pending = [
                    (token, q)
                    for token, q in list(_state.items())
                    if token in _subscribed
                ]
                if pending:
                    results = await asyncio.gather(
                        *(_overlay_all(token, base) for token, base in pending),
                        return_exceptions=True,
                    )
                    for (token, base), overlaid in zip(pending, results):
                        if isinstance(overlaid, Exception):
                            q = base
                        else:
                            q = overlaid
                            _state[token] = q
                        q["ts"] = now_ms
                        # Skip tokens that still have no real feed — don't
                        # broadcast zero-priced ticks.
                        if float(q.get("ltp") or 0) <= 0:
                            continue
                        await publish(
                            f"market:tick:{token}",
                            {
                                "token": token,
                                "ltp": q["ltp"],
                                "change": q["change"],
                                "change_pct": q["change_pct"],
                                "volume": q["volume"],
                                "bid": q["bid"],
                                "ask": q["ask"],
                                "ts": q["ts"],
                            },
                        )
                await asyncio.sleep(interval_sec)
            except Exception as e:  # pragma: no cover
                logger.exception("market_tick_loop_iter_failed", extra={"error": str(e)})
                await asyncio.sleep(2.0)
    finally:
        _running = False
        logger.info("market_tick_loop_stopped")


def stop_tick_loop() -> None:
    global _running
    _running = False
