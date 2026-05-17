"""Instrument service — search, list, get-by-token."""

from __future__ import annotations

import re
from typing import Any

from beanie.operators import Or
from pymongo import ASCENDING

from app.core.exceptions import NotFoundError
from app.models._base import Exchange
from app.models.instrument import Instrument


def infer_instrument_type_from_symbol(symbol: str | None) -> str | None:
    """Best-effort guess of FUT / CE / PE from a Kite-style tradingsymbol.

    Zerodha symbols for derivatives follow the conventions:
        FUT  → "GOLD26JUNFUT", "NIFTY26JANFUT" (ends in "FUT")
        CE   → "NIFTY26JAN22500CE" (digit before "CE")
        PE   → "BANKNIFTY26JAN48000PE" (digit before "PE")
    Returns None when the suffix doesn't match any of those patterns —
    caller should treat it as EQ / unknown.
    """
    s = (symbol or "").upper()
    if not s:
        return None
    if s.endswith("FUT"):
        return "FUT"
    if len(s) >= 3 and s[-3].isdigit():
        if s.endswith("CE"):
            return "CE"
        if s.endswith("PE"):
            return "PE"
    return None


def display_name(
    *,
    instrument_type: Any,
    underlying: str,
    expiry: Any = None,
    strike: Any = None,
) -> str:
    """Build a human-friendly contract name.

    Zerodha's CSV `name` field for derivatives is the bare underlying
    ("GOLDM", "CRUDEOIL", "NIFTY") which renders as a useless duplicate of
    the symbol on listings. For FUT/CE/PE, compose `"{underlying} {expiry}
    [{strike}] {type}"` instead. Equity / index rows pass through.
    """
    it = instrument_type.value if hasattr(instrument_type, "value") else str(instrument_type or "")
    it = (it or "").upper()
    if it not in ("FUT", "CE", "PE"):
        return underlying or ""

    parts: list[str] = [underlying or ""]
    if expiry:
        try:
            parts.append(expiry.strftime("%d-%b-%Y").upper())
        except AttributeError:
            try:
                from datetime import datetime as _dt

                parts.append(_dt.fromisoformat(str(expiry)[:10]).strftime("%d-%b-%Y").upper())
            except Exception:
                pass
    if it in ("CE", "PE") and strike is not None:
        try:
            sv = float(str(strike))
            parts.append(str(int(sv)) if sv == int(sv) else f"{sv:g}")
        except Exception:
            pass
    parts.append(it)
    return " ".join(p for p in parts if p)


async def search(
    q: str | None,
    *,
    exchange: str | None = None,
    segment: str | list[str] | None = None,
    instrument_type: str | list[str] | None = None,
    limit: int = 30,
) -> list[Instrument]:
    """Case-insensitive prefix/contains search on symbol+name.

    `segment` and `instrument_type` accept either a single value or a list —
    the side panel's bucket chips (e.g. "NSE OPT") need to match BOTH
    `NSE_INDEX_OPTION_BUY` and `NSE_INDEX_OPTION_SELL`, so a single string is
    not enough. Lists become `$in` filters in the underlying Mongo query.
    """
    query: dict[str, Any] = {"is_active": True}
    if exchange:
        query["exchange"] = exchange
    if segment:
        query["segment"] = {"$in": list(segment)} if isinstance(segment, list) else segment
    if instrument_type:
        query["instrument_type"] = (
            {"$in": list(instrument_type)} if isinstance(instrument_type, list) else instrument_type
        )

    if q:
        regex = re.compile(re.escape(q), re.IGNORECASE)
        query["$or"] = [{"symbol": regex}, {"trading_symbol": regex}, {"name": regex}, {"token": q}]

    cursor = Instrument.find(query).sort([("symbol", ASCENDING)]).limit(limit)
    return await cursor.to_list()


async def get_by_token(token: str) -> Instrument:
    """Resolve an instrument by token. Falls back to the Zerodha CSV cache
    so that option chain legs (and any other Kite instrument the user clicks
    via search) get auto-mirrored into our `instruments` collection on first
    use — and on-demand-subscribed to the live ticker so prices flow.

    This is what makes "click an option strike → chart opens with live data
    → trades work" possible without admin pre-seeding every contract."""
    inst = await Instrument.find_one(Instrument.token == token)
    if inst is not None:
        return inst

    # Try to mirror from the Zerodha in-memory CSV cache.
    inst = await _mirror_from_zerodha(token)
    if inst is not None:
        return inst

    raise NotFoundError(f"Instrument {token} not found")


async def _mirror_from_zerodha(token: str) -> Instrument | None:
    """Look up `token` across the cached Kite instrument dumps (NSE/NFO/BFO/
    MCX/BSE) and create a local Instrument doc on the fly. Also fires an
    on-demand WS subscribe so the next quote/tick request finds live data.
    Returns None if Zerodha doesn't know this token either."""
    from datetime import datetime

    from bson import Decimal128

    from app.models._base import Exchange, InstrumentType, OptionType
    from app.services.zerodha_service import zerodha

    # Token must be numeric to belong to Zerodha; Infoway/synthetic tokens
    # like "CRYPTO_BTCUSD" should fail loudly via the original NotFoundError.
    try:
        token_int = int(token)
    except (TypeError, ValueError):
        return None

    catalog_row: dict | None = None
    catalog_exchange: str | None = None
    for ex in ("NSE", "NFO", "BFO", "MCX", "BSE"):
        try:
            rows = await zerodha.fetch_instruments(ex)
        except Exception:
            continue
        for row in rows:
            try:
                if int(row.get("token") or 0) == token_int:
                    catalog_row = row
                    catalog_exchange = ex
                    break
            except (TypeError, ValueError):
                continue
        if catalog_row is not None:
            break

    if catalog_row is None:
        return None

    sym = catalog_row.get("symbol") or str(token_int)
    name = catalog_row.get("name") or sym
    exch_str = (catalog_row.get("exchange") or catalog_exchange or "NSE").upper()
    try:
        exchange = Exchange(exch_str)
    except Exception:
        exchange = Exchange.NSE

    it_str = (catalog_row.get("instrumentType") or "EQ").upper()
    if it_str in ("CE", "PE"):
        instrument_type = InstrumentType.CE if it_str == "CE" else InstrumentType.PE
        option_type = OptionType.CE if it_str == "CE" else OptionType.PE
    elif it_str == "FUT":
        instrument_type = InstrumentType.FUT
        option_type = None
    else:
        instrument_type = InstrumentType.EQ
        option_type = None

    # Canonical segment name. The exchange string from Kite's CSV is the
    # exchange CODE ("NFO" / "BFO" / "MCX") — naming the segment after
    # that produces strings (`BFO_FUT`, `BFO_OPT`, `MCX_OPT`) that don't
    # appear anywhere in `_SEGMENT_NAME_MAP`, so the netting resolver
    # falls through to permissive defaults and the admin's row settings
    # are silently ignored. Use the same canonical segment-type table
    # `_auto_create_instrument` uses so all instrument-creation paths
    # agree on the segment naming.
    sym_up = (sym or "").upper()
    _idx_prefixes = ("NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "MIDCAPNIFTY", "SENSEX", "BANKEX")
    is_index_underlying = sym_up.startswith(_idx_prefixes)
    seg_map: dict[str, dict[str, str]] = {
        "NFO": {
            "CE": "NSE_INDEX_OPTION_BUY" if is_index_underlying else "NSE_STOCK_OPTION_BUY",
            "PE": "NSE_INDEX_OPTION_SELL" if is_index_underlying else "NSE_STOCK_OPTION_SELL",
            "FUT": "NSE_INDEX_FUTURE" if is_index_underlying else "NSE_FUTURE",
        },
        "NSE": {"EQ": "NSE_EQUITY", "INDEX": "NSE_EQUITY"},
        "BSE": {"EQ": "BSE_EQUITY"},
        "BFO": {
            "CE": "BSE_OPTION_BUY",
            "PE": "BSE_OPTION_SELL",
            "FUT": "BSE_FUTURE",
        },
        "MCX": {
            "CE": "MCX_OPTION_BUY",
            "PE": "MCX_OPTION_SELL",
            "FUT": "MCX_FUTURE",
        },
        "CDS": {
            "CE": "CDS_OPTION_BUY",
            "PE": "CDS_OPTION_SELL",
            "FUT": "CDS_FUTURE",
        },
    }
    segment = seg_map.get(exch_str, {}).get(it_str, f"{exch_str}_{it_str}")

    expiry_d = None
    exp_raw = catalog_row.get("expiry")
    if exp_raw:
        try:
            expiry_d = datetime.fromisoformat(str(exp_raw).replace("Z", "+00:00")).date()
        except Exception:
            try:
                expiry_d = datetime.strptime(str(exp_raw)[:10], "%Y-%m-%d").date()
            except Exception:
                expiry_d = None

    strike_val = catalog_row.get("strike")
    strike_money = None
    if strike_val is not None:
        try:
            strike_money = Decimal128(str(float(strike_val)))
        except Exception:
            strike_money = None

    tick_size_val = catalog_row.get("tickSize") or 0.05
    try:
        tick_money = Decimal128(str(float(tick_size_val)))
    except Exception:
        tick_money = Decimal128("0.05")

    # Canonical lot table wins over the Zerodha CSV — see index_lots.py.
    # For Indian index F&O, fresh contracts may arrive with lotSize=0 in the
    # cache and stick at 1 forever. For MCX, Zerodha reports lot_size in raw
    # units (kg, g, mmBtu, barrels) which doesn't match `qty = lots ×
    # lot_size`. The canonical table overrides both cases.
    from app.services.index_lots import get_canonical_lot_size

    csv_lot = int(catalog_row.get("lotSize") or 0)
    is_fno = instrument_type in (InstrumentType.CE, InstrumentType.PE, InstrumentType.FUT)
    if is_fno:
        canonical_lot = get_canonical_lot_size(
            sym, name, exchange=exch_str, instrument_type=instrument_type.value
        )
        lot_size_final = canonical_lot or csv_lot or 1
    else:
        # Equity / index spot: 1 share = 1 lot. Don't echo Kite's
        # `marketlot` for ETFs (often 10 or 100) — that would inflate
        # quantity downstream.
        lot_size_final = 1

    friendly_name = display_name(
        instrument_type=instrument_type, underlying=name, expiry=expiry_d, strike=strike_val
    )
    inst = Instrument(
        token=str(token_int),
        symbol=sym,
        trading_symbol=catalog_row.get("tradingSymbol") or sym,
        name=friendly_name,
        exchange=exchange,
        segment=segment,
        instrument_type=instrument_type,
        isin=catalog_row.get("isin"),
        expiry=expiry_d,
        strike=strike_money,
        option_type=option_type,
        lot_size=lot_size_final,
        tick_size=tick_money,
        is_active=True,
        is_tradable=True,
    )
    try:
        await inst.insert()
    except Exception:
        # Race condition: another request mirrored it first. Re-fetch.
        existing = await Instrument.find_one(Instrument.token == str(token_int))
        if existing is not None:
            return existing
        raise

    # Subscribe to ticker so the chart / order panel see live ticks.
    try:
        await zerodha.subscribe_tokens_on_demand(
            [token_int],
            symbols={token_int: {"symbol": sym, "exchange": exch_str}},
        )
    except Exception:
        pass

    return inst


async def list_paginated(
    *, page: int = 1, page_size: int = 50, exchange: str | None = None, segment: str | None = None, q: str | None = None
) -> tuple[list[Instrument], int]:
    query: dict[str, Any] = {}
    if exchange:
        query["exchange"] = exchange
    if segment:
        query["segment"] = segment
    if q:
        regex = re.compile(re.escape(q), re.IGNORECASE)
        query["$or"] = [{"symbol": regex}, {"name": regex}]
    total = await Instrument.find(query).count()
    items = (
        await Instrument.find(query)
        .sort([("exchange", ASCENDING), ("symbol", ASCENDING)])
        .skip((page - 1) * page_size)
        .limit(page_size)
        .to_list()
    )
    return items, total
