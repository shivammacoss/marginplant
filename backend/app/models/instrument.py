"""Master instrument catalogue — equities, futures, options, crypto."""

from __future__ import annotations

from datetime import date

from beanie import Indexed
from bson import Decimal128
from pydantic import Field
from pymongo import ASCENDING, DESCENDING, IndexModel

from app.models._base import Exchange, InstrumentType, OptionType, TimestampMixin
from app.models._types import Money


class Instrument(TimestampMixin):
    token: Indexed(str, unique=True)  # type: ignore[valid-type]
    symbol: str  # e.g., "RELIANCE", "NIFTY24DECFUT"
    trading_symbol: str  # broker-format symbol (NSE: "RELIANCE-EQ")
    name: str  # full company / contract name

    exchange: Exchange
    segment: str  # NSE_EQUITY, NFO_OPT, etc — matches SegmentType where possible
    instrument_type: InstrumentType
    isin: str | None = None

    # Derivatives
    expiry: date | None = None
    strike: Money | None = None
    option_type: OptionType | None = None
    underlying_token: str | None = None  # for derivatives, points to spot

    # Trading params
    lot_size: int = 1
    tick_size: Money = Field(default_factory=lambda: Decimal128("0.05"))
    upper_circuit: Money | None = None
    lower_circuit: Money | None = None

    # Status
    is_active: bool = True
    is_tradable: bool = True
    is_halted: bool = False
    halt_reason: str | None = None

    class Settings:
        name = "instruments"
        indexes = [
            IndexModel([("token", ASCENDING)], unique=True),
            IndexModel([("symbol", ASCENDING)]),
            IndexModel([("exchange", ASCENDING), ("segment", ASCENDING)]),
            IndexModel([("instrument_type", ASCENDING)]),
            IndexModel([("expiry", ASCENDING)]),
            IndexModel([("underlying_token", ASCENDING), ("expiry", ASCENDING)]),
            IndexModel([("is_tradable", ASCENDING), ("is_active", ASCENDING)]),
            IndexModel([("created_at", DESCENDING)]),
            # Text index for search across name + symbol
            IndexModel([("name", "text"), ("symbol", "text"), ("trading_symbol", "text")]),
        ]
