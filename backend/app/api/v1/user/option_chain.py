"""Option chain endpoint — given an underlying (token OR symbol), return the
strikes × expiries grid with live LTPs.

Uses Zerodha's in-memory instrument cache for instant lookups — no MongoDB
round-trips for option data. Prices come from live KiteTicker ticks first,
falling back to a single batch REST /quote call.

Performance: the picker re-fetches every 2 s. Without caching, each call
would (a) re-scan the 50k-row NFO CSV, (b) issue a Kite REST /quote on
100+ keys, and (c) on-demand-subscribe every visible leg — easily 5-15 s
of work per request and a hard freeze when Kite is slow. Two layers of
cache below keep the hot path ≪ 100 ms:

    _CHAIN_CACHE     : full response, keyed by (und, expiry), TTL 2.5 s.
                       Sized for the picker's 2 s polling cadence so back-
                       to-back requests usually hit the cache.
    _CATALOG_FILTER  : the (filtered options + expiries) tuple from
                       get_option_chain_fast, keyed by underlying, TTL
                       300 s. The CSV catalog itself doesn't change
                       intraday so this is safe.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import date, datetime
from typing import Any

from fastapi import APIRouter, Query

from app.core.dependencies import CurrentUser
from app.models.platform_setting import PlatformSetting
from app.schemas.common import APIResponse

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/option-chain", tags=["user-option-chain"])


# Fallback defaults if settings are missing (first-run before seed).
_DEFAULT_UNDERLYINGS = [
    {"label": "Nifty", "symbol": "NIFTY", "color": "emerald"},
    {"label": "BankNifty", "symbol": "BANKNIFTY", "color": "violet"},
    {"label": "Sensex", "symbol": "SENSEX", "color": "rose"},
]
_DEFAULT_STRIKES_AROUND_ATM = 15
_DEFAULT_MAX_EXPIRIES = 6

# Hard cap on the Kite REST batch quote — prevents a slow / hung Kite call
# from blocking the picker. On timeout we serve whatever live ticks are
# already in the in-memory map and the frontend's next 2 s poll picks up
# the rest.
_KITE_BATCH_QUOTE_TIMEOUT_SEC = 3.0

# Settings cache (60s)
_settings_cache: dict[str, tuple[Any, float]] = {}
_SETTINGS_TTL = 60.0

# Full-response cache (2.5s) — sized just above the picker's 2s polling
# cadence so each request lands a hit on the next poll.
_CHAIN_CACHE: dict[str, tuple[dict[str, Any], float]] = {}
_CHAIN_TTL = 2.5

# Catalog filter cache (5 min) — the heavy 50k-row scan. CSV doesn't change
# intraday so this can sit much longer than the price cache.
_CATALOG_FILTER: dict[str, tuple[tuple[list[dict[str, Any]], list[date]], float]] = {}
_CATALOG_TTL = 300.0


async def _read_setting(key: str, default: Any) -> Any:
    cached = _settings_cache.get(key)
    now = time.time()
    if cached and (now - cached[1]) < _SETTINGS_TTL:
        return cached[0]
    s = await PlatformSetting.find_one(PlatformSetting.setting_key == key)
    val = s.setting_value if s is not None else default
    _settings_cache[key] = (val, now)
    return val


async def _cached_catalog(und_key: str):
    """get_option_chain_fast wrapper with a 5-minute cache.

    Why we DON'T cache empty results: if a request lands before Zerodha is
    authenticated (or before the NFO/BFO catalog finishes warming), the
    underlying yields no options and we'd otherwise pin "TCS = []" for the
    next 5 minutes — even after the operator authenticates. By only caching
    non-empty hits, the next call retries the catalog scan and picks up
    fresh data on the same poll the picker is already running.
    """
    now = time.time()
    cached = _CATALOG_FILTER.get(und_key)
    if cached and (now - cached[1]) < _CATALOG_TTL and cached[0][0]:
        return cached[0]
    from app.services.zerodha_service import zerodha as _zerodha
    result = await _zerodha.get_option_chain_fast(und_key)
    if result[0]:
        _CATALOG_FILTER[und_key] = (result, now)
    else:
        # Surface this so operators can see WHY a stock (e.g. TCS) returns
        # no chain — usually Zerodha not authenticated or NFO not yet warmed.
        try:
            status = await _zerodha.get_status()
            logger.warning(
                "option_chain_empty_catalog",
                extra={
                    "underlying": und_key,
                    "zerodha_connected": status.get("isConnected"),
                    "zerodha_configured": status.get("isConfigured"),
                    "ws_status": status.get("wsStatus"),
                },
            )
        except Exception:
            logger.warning("option_chain_empty_catalog", extra={"underlying": und_key})
    return result


def _norm_underlying(s: str) -> str:
    return (s or "").strip().upper().replace(" ", "")


@router.get("/config", response_model=APIResponse[dict])
async def option_chain_config(user: CurrentUser):
    """Public option-chain settings consumed by the picker UI."""
    underlyings = await _read_setting("option_chain.underlyings", _DEFAULT_UNDERLYINGS)
    strikes_around_atm = int(await _read_setting("option_chain.strikes_around_atm", _DEFAULT_STRIKES_AROUND_ATM))
    max_expiries = int(await _read_setting("option_chain.max_expiries", _DEFAULT_MAX_EXPIRIES))
    return APIResponse(
        data={
            "underlyings": underlyings,
            "strikes_around_atm": strikes_around_atm,
            "max_expiries": max_expiries,
        }
    )


@router.get("", response_model=APIResponse[dict])
async def option_chain(
    user: CurrentUser,
    underlying: str = Query(..., description="Symbol like NIFTY / BANKNIFTY / RELIANCE"),
    expiry: str | None = Query(default=None, description="ISO date; if omitted, nearest expiry"),
):
    und_key = _norm_underlying(underlying)

    # ── Response cache hit? Bail out fast (matches the picker's 2 s poll). ──
    cache_key = f"{und_key}|{(expiry or '').strip()}"
    now_t = time.time()
    cached_resp = _CHAIN_CACHE.get(cache_key)
    if cached_resp and (now_t - cached_resp[1]) < _CHAIN_TTL:
        return APIResponse(data=cached_resp[0])

    # ── Catalog filter (cached 5 min — CSV doesn't change intraday) ──
    options, all_expiry_dates = await _cached_catalog(und_key)
    from app.services.zerodha_service import zerodha as _zerodha

    # Distinct expiries (sorted asc) — capped to admin-configured max
    max_expiries = int(await _read_setting("option_chain.max_expiries", _DEFAULT_MAX_EXPIRIES))
    expiries = all_expiry_dates[: max(1, max_expiries)]
    expiry_iso = [d.isoformat() for d in expiries]

    # Pick effective expiry
    target: date | None = None
    if expiry:
        try:
            target = datetime.strptime(expiry[:10], "%Y-%m-%d").date()
        except Exception:
            target = None
    if target is None and expiries:
        target = expiries[0]

    # Build strike → {ce, pe} grid for the chosen expiry
    by_strike: dict[float, dict[str, Any]] = {}
    for o in options:
        if target is not None and o.get("_expiry_date") != target:
            continue
        strike = float(o["strike"]) if o.get("strike") is not None else None
        if strike is None:
            continue
        cell = by_strike.setdefault(strike, {"strike": strike, "ce": None, "pe": None})
        cell["ce" if o["option_type"] == "CE" else "pe"] = o

    all_rows = sorted(by_strike.values(), key=lambda r: r["strike"])

    # ── Strike-far cap (admin matrix → Options → Max % from underlying) ──
    # Hide every strike outside ±strikeFarPercent of the underlying's spot
    # so the chain dialog only shows tradeable strikes (the validator
    # rejects anything farther anyway). Underlying admin row is derived
    # from the option exchange — NFO → NSE_OPT, BFO → BSE_OPT, MCX → MCX_OPT.
    # Zero from admin = no cap, full chain renders.
    if all_rows:
        sample = all_rows[0].get("ce") or all_rows[0].get("pe") or {}
        opt_exch = (sample.get("exchange") or "").upper()
        admin_row = {
            "NFO": "NSE_OPT",
            "BFO": "BSE_OPT",
            "MCX": "MCX_OPT",
        }.get(opt_exch)
        if admin_row:
            from app.services.netting_service import resolve_strike_far

            far_pct = await resolve_strike_far(admin_row)
            if far_pct > 0:
                # Underlying spot: take from any cached LTP on the option
                # legs (CE − PE parity gives a working spot proxy for the
                # ATM row), fall back to the median strike. Avoids a
                # blocking Kite REST call on the chain hot path.
                spot_guess: float | None = None
                # Quick proxy: scan rows for both-side LTPs and pick the
                # parity-derived spot at the strike with smallest CE−PE.
                with_both = []
                for idx, r in enumerate(all_rows):
                    ce_ltp = _row_cached_ltp(r, "ce") if False else None  # see below
                    # _row_cached_ltp is defined further down in this file;
                    # inline a tiny version here to avoid forward-reference.
                    cell_ce = r.get("ce")
                    cell_pe = r.get("pe")
                    if not (cell_ce and cell_pe):
                        continue
                    try:
                        tc = int(cell_ce.get("token") or 0)
                        tp = int(cell_pe.get("token") or 0)
                    except (TypeError, ValueError):
                        continue
                    ce_live = _zerodha.ticks_by_token.get(tc) if tc else None
                    pe_live = _zerodha.ticks_by_token.get(tp) if tp else None
                    ce_ltp = float(ce_live.get("ltp") or 0) if ce_live else 0.0
                    pe_ltp = float(pe_live.get("ltp") or 0) if pe_live else 0.0
                    if ce_ltp > 0 and pe_ltp > 0:
                        with_both.append((idx, ce_ltp - pe_ltp, r["strike"]))
                if with_both:
                    # ATM = smallest |CE−PE|; spot ≈ strike + (CE−PE).
                    best = min(with_both, key=lambda x: abs(x[1]))
                    spot_guess = best[2] + best[1]
                if spot_guess is None and all_rows:
                    spot_guess = float(all_rows[len(all_rows) // 2]["strike"])

                if spot_guess and spot_guess > 0:
                    lo_bound = spot_guess * (1 - far_pct / 100.0)
                    hi_bound = spot_guess * (1 + far_pct / 100.0)
                    all_rows = [
                        r for r in all_rows
                        if lo_bound <= float(r["strike"]) <= hi_bound
                    ]

    # ── Trim BEFORE we touch Kite ────────────────────────────────────
    # Two-stage ATM detection so we can shrink the work BEFORE doing the
    # expensive subscribe + quote step:
    #   1. Use any cached LTP from the in-memory ticker map to find a real
    #      ATM (parity-derived spot ≈ strike where |CE-PE| is smallest).
    #   2. If no LTPs are cached yet (cold start), fall back to the median
    #      strike — close enough for the first paint; the next 2 s poll
    #      will have real LTPs and recentre.
    strikes_around_atm = int(await _read_setting("option_chain.strikes_around_atm", _DEFAULT_STRIKES_AROUND_ATM))

    def _row_cached_ltp(row: dict[str, Any], side: str) -> float | None:
        cell = row.get(side)
        if not cell:
            return None
        try:
            tok_int = int(cell.get("token") or 0)
        except (TypeError, ValueError):
            tok_int = 0
        live = _zerodha.ticks_by_token.get(tok_int) if tok_int else None
        if live is None:
            sym = cell.get("symbol")
            if sym:
                live = _zerodha.ticks_by_symbol.get(sym)
        if live is None:
            return None
        try:
            return float(live.get("ltp") or 0) or None
        except (TypeError, ValueError):
            return None

    pre_atm_idx = len(all_rows) // 2
    if all_rows:
        with_both = [
            (i, abs(c - p))
            for i, r in enumerate(all_rows)
            if (c := _row_cached_ltp(r, "ce")) is not None
            and (p := _row_cached_ltp(r, "pe")) is not None
        ]
        if with_both:
            pre_atm_idx = min(with_both, key=lambda x: x[1])[0]

    if all_rows and strikes_around_atm > 0:
        lo = max(0, pre_atm_idx - strikes_around_atm)
        hi = min(len(all_rows), pre_atm_idx + strikes_around_atm + 1)
        rows = all_rows[lo:hi]
    else:
        rows = all_rows

    # ── Enrich ONLY the visible window with live prices ──────────────
    batch_keys: list[str] = []
    tokens_for_ws: list[int] = []
    sym_map_for_ws: dict[int, dict[str, str]] = {}
    for r in rows:
        for side in ("ce", "pe"):
            cell = r.get(side)
            if cell and cell.get("exchange") and cell.get("symbol"):
                batch_keys.append(f"{cell['exchange']}:{cell['symbol']}")
                try:
                    t = int(cell["token"])
                    tokens_for_ws.append(t)
                    sym_map_for_ws[t] = {"symbol": cell["symbol"], "exchange": cell["exchange"]}
                except (TypeError, ValueError):
                    pass

    # On-demand subscribe ONLY the visible window. Don't await on it (fire-
    # and-forget) so a slow WS spawn can't block the response.
    if tokens_for_ws:
        try:
            asyncio.create_task(
                _zerodha.subscribe_tokens_on_demand(tokens_for_ws, sym_map_for_ws)
            )
        except Exception:
            pass

    # Hard timeout on Kite REST batch — at worst the user sees stale or
    # missing prices for one tick; the picker re-polls in 2 s and tries again.
    batch_snapshots: dict[str, dict[str, Any]] = {}
    batch_error: str | None = None
    if batch_keys:
        try:
            batch_snapshots, batch_error = await asyncio.wait_for(
                _zerodha.get_quotes_batch_snapshot(batch_keys),
                timeout=_KITE_BATCH_QUOTE_TIMEOUT_SEC,
            )
        except asyncio.TimeoutError:
            batch_error = f"Kite /quote timed out after {_KITE_BATCH_QUOTE_TIMEOUT_SEC}s"
        except Exception as e:
            batch_error = str(e)

    def enrich(leg: dict[str, Any] | None) -> dict[str, Any] | None:
        if leg is None:
            return None

        token = leg.get("token")
        symbol = leg.get("symbol")
        exchange = leg.get("exchange")

        # 1) Live tick (KiteTicker push)
        live: dict[str, Any] | None = None
        source: str | None = None
        try:
            live = _zerodha.ticks_by_token.get(int(token)) if token else None
            if live is not None:
                source = "live"
        except (TypeError, ValueError):
            live = None
        if live is None and symbol:
            sym_live = _zerodha.ticks_by_symbol.get(symbol)
            if sym_live is not None:
                live = sym_live
                source = "live"

        # 2) REST batch snapshot pre-fetched above
        if live is None and exchange and symbol:
            key = f"{exchange}:{symbol}"
            snap = batch_snapshots.get(key)
            if snap is not None:
                live = snap
                source = "rest"

        if not live:
            return {
                **leg,
                "ltp": None, "bid": None, "ask": None,
                "change_pct": None, "volume": None, "source": None,
            }

        ltp = live.get("ltp")
        prev_close = live.get("close") or live.get("prev_close")
        change_pct = None
        try:
            if ltp is not None and prev_close:
                change_pct = round(((float(ltp) - float(prev_close)) / float(prev_close)) * 100, 2)
        except (TypeError, ValueError, ZeroDivisionError):
            change_pct = None

        return {
            **leg,
            "ltp": float(ltp) if ltp is not None else None,
            "bid": float(live["bid"]) if live.get("bid") is not None else None,
            "ask": float(live["ask"]) if live.get("ask") is not None else None,
            "change_pct": change_pct,
            "volume": int(live["volume"]) if live.get("volume") is not None else None,
            "source": source,
        }

    enriched_rows = [
        {"strike": r["strike"], "ce": enrich(r["ce"]), "pe": enrich(r["pe"])}
        for r in rows
    ]

    # ATM: strike where |CE LTP - PE LTP| is smallest
    atm_strike = None
    atm_spot = None
    if enriched_rows:
        with_both = [r for r in enriched_rows if r["ce"] and r["pe"] and r["ce"].get("ltp") and r["pe"].get("ltp")]
        if with_both:
            best = min(with_both, key=lambda r: abs(r["ce"]["ltp"] - r["pe"]["ltp"]))
            atm_strike = best["strike"]
            atm_spot = best["strike"] + best["ce"]["ltp"] - best["pe"]["ltp"]
        else:
            atm_strike = enriched_rows[len(enriched_rows) // 2]["strike"]

    # No second trim — we already trimmed BEFORE enrichment (above).

    # Aggregate data source
    leg_sources = [
        cell.get("source")
        for r in enriched_rows
        for side in ("ce", "pe")
        if (cell := r.get(side)) and cell.get("source")
    ]
    data_source = "live" if "live" in leg_sources else ("rest" if "rest" in leg_sources else "none")

    from app.utils.time_utils import is_market_open as _is_market_open
    response_data = {
        "underlying": und_key,
        "expiries": expiry_iso,
        "selected_expiry": target.isoformat() if target else None,
        "atm_strike": atm_strike,
        "atm_spot": atm_spot,
        "rows": enriched_rows,
        "data_source": data_source,
        "data_source_error": batch_error,
        # The picker drops the day-change pill when this is False so the
        # strip looks clean after-hours (no big red −20 % numbers on stale
        # ticks). LTP itself is still the last traded price from REST/WS.
        "market_open": _is_market_open(),
    }
    # Cache the full response — next call within _CHAIN_TTL hits the early
    # return above and skips all this work.
    _CHAIN_CACHE[cache_key] = (response_data, time.time())
    return APIResponse(data=response_data)
