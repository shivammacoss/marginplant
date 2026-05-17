"""Orders collection — embedded instrument snapshot + applied-settings snapshot.

We snapshot both the instrument (so renaming a symbol later doesn't rewrite
history) AND the resolved segment settings at order-placement time (auditable).

Shard key (when sharded): user_id + created_at compound for hot range queries.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum

from beanie import Indexed, PydanticObjectId
from bson import Decimal128
from pydantic import BaseModel, Field
from pymongo import ASCENDING, DESCENDING, IndexModel

from app.models._base import (
    Exchange,
    OrderAction,
    OrderType,
    ProductType,
    StrEnum,
    TimestampMixin,
    Validity,
)
from app.models._types import Money


def _zero() -> Decimal128:
    return Decimal128("0")


class OrderStatus(StrEnum):
    PENDING = "PENDING"  # not yet validated
    OPEN = "OPEN"  # accepted, awaiting trigger/fill
    PARTIAL = "PARTIAL"  # partially filled
    EXECUTED = "EXECUTED"
    CANCELLED = "CANCELLED"
    REJECTED = "REJECTED"
    EXPIRED = "EXPIRED"


# ── Embedded sub-documents ──────────────────────────────────────────
class InstrumentRef(BaseModel):
    token: str
    symbol: str
    trading_symbol: str | None = None
    exchange: Exchange
    segment: str
    lot_size: int = 1
    tick_size: Money = Field(default_factory=lambda: Decimal128("0.05"))


class AppliedSettings(BaseModel):
    """Snapshot of effective segment settings at order time. Written for audit.
    Mirrors the 22 fields but all optional to keep the snapshot minimal."""

    segment_type: str
    margin_percentage: float | None = None
    leverage: float | None = None
    commission_type: str | None = None
    commission_value: float | None = None
    min_brokerage: float | None = None
    limit_percentage: float | None = None
    stop_loss_mandatory: bool | None = None
    auto_squareoff_time: str | None = None
    m2m_squareoff_percent: float | None = None


# ── Order document ──────────────────────────────────────────────────
class Order(TimestampMixin):
    order_number: Indexed(str, unique=True)  # type: ignore[valid-type]
    user_id: PydanticObjectId

    instrument: InstrumentRef
    action: OrderAction
    order_type: OrderType
    product_type: ProductType
    validity: Validity = Validity.DAY

    lots: float  # fractional for crypto/forex (e.g. 0.01 BTC)
    quantity: float
    filled_quantity: float = 0
    pending_quantity: float = 0

    price: Money = Field(default_factory=_zero)  # 0 for MARKET
    trigger_price: Money = Field(default_factory=_zero)  # 0 if not SL
    average_price: Money = Field(default_factory=_zero)

    margin_blocked: Money = Field(default_factory=_zero)
    brokerage: Money = Field(default_factory=_zero)
    other_charges: Money = Field(default_factory=_zero)

    status: OrderStatus = OrderStatus.PENDING
    rejection_reason: str | None = None
    rejection_code: str | None = None

    is_amo: bool = False
    parent_order_id: PydanticObjectId | None = None  # for bracket / GTT children
    bracket_target: Money | None = None
    bracket_stop_loss: Money | None = None

    applied_settings: AppliedSettings | None = None

    placed_by: PydanticObjectId  # user OR dealer who placed on behalf
    placed_from: str = "WEB"  # WEB / MOBILE / API / ADMIN
    client_ip: str | None = None
    idempotency_key: str | None = None

    executed_at: datetime | None = None
    cancelled_at: datetime | None = None

    class Settings:
        name = "orders"
        indexes = [
            IndexModel([("order_number", ASCENDING)], unique=True),
            IndexModel([("user_id", ASCENDING), ("status", ASCENDING)]),
            IndexModel([("user_id", ASCENDING), ("created_at", DESCENDING)]),
            IndexModel([("status", ASCENDING), ("created_at", ASCENDING)]),
            IndexModel([("instrument.token", ASCENDING), ("status", ASCENDING)]),
            IndexModel([("idempotency_key", ASCENDING)], sparse=True),
            IndexModel([("placed_by", ASCENDING), ("created_at", DESCENDING)]),
            IndexModel([("created_at", DESCENDING)]),
        ]
