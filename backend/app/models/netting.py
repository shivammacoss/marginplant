"""Netting Segment + Risk Management models.

Replaces the old `segment_settings` family. Built from the bharat_indian_funded
admin panel as the reference, adapted for FastAPI + Beanie.

Hierarchy:
    NettingSegment (one row per segment, e.g. NSE_EQ, NSE_FUT, FOREX, ...)
        ↓
    NettingScriptOverride (per-symbol override within a segment; null = inherit)
        ↓
    UserSegmentOverride (per-user override; null = inherit)

Plus:
    RiskSettings        — global default risk controls
    UserRiskSettings    — per-user risk overrides (null = inherit)
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from beanie import Indexed, PydanticObjectId
from pydantic import BaseModel, Field
from pymongo import ASCENDING, IndexModel

from app.models._base import TimestampMixin


# ── Risk Management ────────────────────────────────────────────────
class RiskSettingsBase(BaseModel):
    """Per-user override layer — every field nullable, missing = inherit
    global default. Five knobs total:

      • stopOutWarningPercent — notify user when (-total_pnl) / balance
        crosses this %. Balance = available + used_margin + credit_limit.
      • stopOutPercent        — force-close ALL open positions when the
        same ratio crosses this %.
      • exitOnlyMode          — when True, validator rejects every order
        that would open / increase a position; closing trades pass.
      • profitTradeHoldMinSeconds — minimum seconds a winning trade must
        be held before a user-initiated close is allowed.
      • lossTradeHoldMinSeconds   — same, for losing trades.

    Removed by simplification request: ledgerBalanceClose, marginCallLevel
    (old equity/used-margin formula), stopOutLevel (old formula),
    blockLimitAboveBelowHighLow, blockLimitBetweenHighLow.
    """

    stopOutWarningPercent: float | None = None  # % of balance
    stopOutPercent: float | None = None  # % of balance
    exitOnlyMode: bool | None = None
    profitTradeHoldMinSeconds: int | None = None
    lossTradeHoldMinSeconds: int | None = None


class RiskSettingsRequired(BaseModel):
    """Global default — all required, sane fallbacks. Pair with
    RiskSettingsBase via inheritance below."""

    # 0 here means "feature off" — no warning is sent regardless of P&L.
    # Same for the stop-out: 0 disables the auto-flatten.
    stopOutWarningPercent: float = 0.0
    stopOutPercent: float = 0.0
    exitOnlyMode: bool = False
    profitTradeHoldMinSeconds: int = 0
    lossTradeHoldMinSeconds: int = 0


class RiskSettings(TimestampMixin, RiskSettingsRequired):
    type: Indexed(str, unique=True) = "global"  # type: ignore[valid-type]

    class Settings:
        name = "risk_settings"
        indexes = [IndexModel([("type", ASCENDING)], unique=True)]


class UserRiskSettings(TimestampMixin, RiskSettingsBase):
    user_id: PydanticObjectId

    class Settings:
        name = "user_risk_settings"
        indexes = [IndexModel([("user_id", ASCENDING)], unique=True)]


class SubAdminRiskSettings(TimestampMixin, RiskSettingsBase):
    """Per-sub-admin "global default" risk knobs.

    Layered between the platform `RiskSettings` (super-admin's global) and
    `UserRiskSettings` (per-user override). Each sub-admin gets at most
    one row keyed by their user `_id`. Null fields inherit from the
    platform global; populated fields override it for every user assigned
    to this sub-admin (unless that user has their own override).
    """

    sub_admin_id: PydanticObjectId

    class Settings:
        name = "sub_admin_risk_settings"
        indexes = [IndexModel([("sub_admin_id", ASCENDING)], unique=True)]


class SuperAdminRiskSettings(TimestampMixin, RiskSettingsBase):
    """Super-admin's pool-default risk knobs.

    Symmetric to SubAdminRiskSettings but for the super-admin's pool
    (users with `assigned_admin_id is None`). Decouples super-admin's
    pool risk settings from the platform-wide `RiskSettings` defaults so
    super-admin's edits no longer cascade into admin / broker pools.
    """

    super_admin_id: PydanticObjectId

    class Settings:
        name = "super_admin_risk_settings"
        indexes = [IndexModel([("super_admin_id", ASCENDING)], unique=True)]


class BrokerRiskSettings(TimestampMixin, RiskSettingsBase):
    """Per-broker "pool default" risk knobs.

    Layered between platform RiskSettings and UserRiskSettings for users
    in a broker's pool. Sub-broker chains do NOT cascade — each broker's
    risk settings are independent of their parent broker.
    """

    broker_id: PydanticObjectId

    class Settings:
        name = "broker_risk_settings"
        indexes = [IndexModel([("broker_id", ASCENDING)], unique=True)]


# ── Netting Segment matrix ─────────────────────────────────────────
SEGMENT_CODES = [
    "NSE_EQ", "NSE_FUT", "NSE_OPT",
    "BSE_EQ", "BSE_FUT", "BSE_OPT",
    "MCX_FUT", "MCX_OPT",
    "FOREX", "STOCKS",
    "INDICES", "COMMODITIES",
    "CRYPTO",
]


class NettingFieldsBase(BaseModel):
    """All editable fields, all nullable for override layers."""

    # Lot
    minLots: float | None = None
    orderLots: float | None = None
    maxLots: float | None = None
    maxExchangeLots: float | None = None
    # Quantity
    minQty: float | None = None
    perOrderQty: float | None = None
    maxQtyPerScript: float | None = None
    # Value
    maxValue: float | None = None
    # Fixed Margin
    marginCalcMode: Literal["fixed", "times", "percent"] | None = None
    intradayMargin: float | None = None
    overnightMargin: float | None = None
    optionBuyIntraday: float | None = None
    optionBuyOvernight: float | None = None
    optionSellIntraday: float | None = None
    optionSellOvernight: float | None = None
    # Options — single % cap that applies to BOTH buy and sell side.
    # Replaces the old `buyingStrikeFarPercent` / `sellingStrikeFarPercent`
    # pair (admin spec: one column for option segments). Also drives the
    # option-chain dialog — strikes outside ±strikeFarPercent of the spot
    # are hidden from the table.
    strikeFarPercent: float | None = None
    # Brokerage
    commissionType: Literal["per_lot", "per_crore"] | None = None
    commission: float | None = None
    optionBuyCommission: float | None = None
    optionSellCommission: float | None = None
    chargeOn: Literal["open", "close", "both"] | None = None
    # Limit away
    limitAwayPercent: float | None = None
    # Spread
    spreadType: Literal["fixed", "floating"] | None = None
    spreadPips: float | None = None
    swapType: Literal["points", "percentage"] | None = None
    swapLong: float | None = None
    swapShort: float | None = None
    swapTime: str | None = None  # HH:MM IST
    # Block
    isActive: bool | None = None
    tradingEnabled: bool | None = None
    allowOvernight: bool | None = None
    # Expiry day
    expiryProfitHoldMinSeconds: int | None = None
    expiryLossHoldMinSeconds: int | None = None
    expiryDayIntradayMargin: float | None = None
    expiryDayOptionBuyMargin: float | None = None
    expiryDayOptionSellMargin: float | None = None
    # When ON the three expiry-day margin values above are interpreted as
    # % of notional (just like the regular `marginCalcMode = percent` path).
    # When OFF they're flat ₹/lot — same shape as Fixed margin mode. Lets
    # admin pick the units for expiry day independently from the rest of
    # the segment (e.g. percent during normal trading but a punitive flat
    # ₹ on expiry day to discourage last-minute carries).
    expiryDayMarginAsPercent: bool | None = None


class NettingFieldsRequired(BaseModel):
    """Defaults applied to every newly-seeded segment."""

    # Lot
    minLots: float = 1.0
    orderLots: float = 1.0
    maxLots: float = 100.0
    maxExchangeLots: float = 1000.0
    # Quantity
    minQty: float = 1.0
    perOrderQty: float = 1.0
    maxQtyPerScript: float = 100000.0
    # Value
    maxValue: float = 0.0  # 0 = no cap
    # Fixed Margin
    # Default = None so the resolver's defensive inference path kicks in
    # (sniffs intradayMargin > 100 → Times, else Fixed). Picking "percent"
    # here used to silently lock fresh seeds into legacy percent mode,
    # which then ignored Times intent from the admin matrix unless the
    # admin explicitly re-clicked the dropdown. None lets admin's typed
    # number drive the inference automatically.
    marginCalcMode: Literal["fixed", "times", "percent"] | None = None
    intradayMargin: float = 100.0
    overnightMargin: float = 100.0
    # Option-specific columns default to None = inherit from segment-wide
    # intradayMargin / overnightMargin. Previously seeded to 100 / 15
    # which silently overrode the segment when admin set NSE_OPT
    # intradayMargin = 300 expecting all options to use 300. Now the
    # admin must explicitly type a number to override; blank/null means
    # "use whatever the segment says".
    optionBuyIntraday: float | None = None
    optionBuyOvernight: float | None = None
    optionSellIntraday: float | None = None
    optionSellOvernight: float | None = None
    # Options
    strikeFarPercent: float = 10.0
    # Brokerage
    commissionType: Literal["per_lot", "per_crore"] = "per_lot"
    commission: float = 20.0
    optionBuyCommission: float = 20.0
    optionSellCommission: float = 20.0
    chargeOn: Literal["open", "close", "both"] = "both"
    # Limit away
    limitAwayPercent: float = 10.0
    # Spread
    spreadType: Literal["fixed", "floating"] = "fixed"
    spreadPips: float = 0.0
    swapType: Literal["points", "percentage"] = "points"
    swapLong: float = 0.0
    swapShort: float = 0.0
    swapTime: str = "22:30"
    # Block
    isActive: bool = True
    tradingEnabled: bool = True
    allowOvernight: bool = True
    # Expiry day
    expiryProfitHoldMinSeconds: int = 0
    expiryLossHoldMinSeconds: int = 0
    expiryDayIntradayMargin: float = 100.0
    expiryDayOptionBuyMargin: float = 100.0
    expiryDayOptionSellMargin: float = 50.0
    expiryDayMarginAsPercent: bool = True


class NettingSegment(TimestampMixin, NettingFieldsRequired):
    """One row per segment code."""

    name: Indexed(str, unique=True)  # type: ignore[valid-type]  # e.g. "NSE_EQ"
    displayName: str  # "NSE EQ"
    # UI cell-gating flags
    lotApplies: bool = True
    qtyApplies: bool = False
    optionApplies: bool = False
    expiryHoldApplies: bool = False
    futureApplies: bool = False

    class Settings:
        name = "netting_segments"
        indexes = [IndexModel([("name", ASCENDING)], unique=True)]


class NettingScriptOverride(TimestampMixin, NettingFieldsBase):
    """Per-symbol override within a segment — null fields inherit from segment."""

    segment_id: PydanticObjectId
    segment_name: str  # denormalised for filter queries
    symbol: str
    tradingSymbol: str | None = None
    instrumentToken: int | None = None
    lotSize: float = 1.0

    class Settings:
        name = "netting_script_overrides"
        indexes = [
            IndexModel(
                [("segment_name", ASCENDING), ("symbol", ASCENDING)], unique=True
            ),
        ]


class UserSegmentOverride(TimestampMixin, NettingFieldsBase):
    """Per-user override on a segment (or specific symbol within segment)."""

    user_id: PydanticObjectId
    segment_name: str
    symbol: str | None = None  # None = applies to entire segment

    class Settings:
        name = "user_segment_overrides"
        indexes = [
            IndexModel(
                [("user_id", ASCENDING), ("segment_name", ASCENDING), ("symbol", ASCENDING)],
                unique=True,
            ),
        ]


class SubAdminSegmentOverride(TimestampMixin, NettingFieldsBase):
    """Per-sub-admin "global default" segment override.

    Layered between `NettingScriptOverride` (platform per-symbol) and
    `UserSegmentOverride` (per-user) in the resolver. Null fields inherit
    from the platform segment; populated fields apply to every user in
    this sub-admin's pool unless that user has their own override.

    Symbol-level scope is intentionally NOT supported here — that lives
    on the per-user override layer. Sub-admin defaults are segment-wide.
    """

    sub_admin_id: PydanticObjectId
    segment_name: str

    class Settings:
        name = "sub_admin_segment_overrides"
        indexes = [
            IndexModel(
                [("sub_admin_id", ASCENDING), ("segment_name", ASCENDING)],
                unique=True,
            ),
        ]


class SuperAdminSegmentOverride(TimestampMixin, NettingFieldsBase):
    """Super-admin's pool-default segment override.

    Symmetric to SubAdminSegmentOverride but for the super-admin's pool
    (users with `assigned_admin_id is None`). Decouples super-admin's
    "their pool" settings from the platform-wide `NettingSegment` seed
    defaults, so super-admin's edits no longer cascade into admin / broker
    pools as a shared fallback. Keyed by `super_admin_id` so the model
    supports multiple super-admin accounts in the future without a schema
    change. Null fields inherit from `NettingSegment` seeds.
    """

    super_admin_id: PydanticObjectId
    segment_name: str

    class Settings:
        name = "super_admin_segment_overrides"
        indexes = [
            IndexModel(
                [("super_admin_id", ASCENDING), ("segment_name", ASCENDING)],
                unique=True,
            ),
        ]


class BrokerSegmentOverride(TimestampMixin, NettingFieldsBase):
    """Per-broker "pool default" segment override.

    Layered above NettingScriptOverride and below UserSegmentOverride for
    users in a broker's pool (immediate broker = `broker_ancestry[-1]`).
    Sub-broker chains do NOT cascade — each broker's settings are
    independent of their parent broker. Null fields inherit from the
    NettingSegment seed (same as sub-admin override semantics).
    """

    broker_id: PydanticObjectId
    segment_name: str

    class Settings:
        name = "broker_segment_overrides"
        indexes = [
            IndexModel(
                [("broker_id", ASCENDING), ("segment_name", ASCENDING)],
                unique=True,
            ),
        ]
