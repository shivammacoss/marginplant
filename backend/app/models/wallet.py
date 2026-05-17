"""Wallet — single document per user holding all balance figures.

Money is stored as Decimal128. Updates must occur inside MongoDB transactions
(see services/wallet_service.py).
"""

from __future__ import annotations

from beanie import Indexed, PydanticObjectId
from bson import Decimal128
from pydantic import Field
from pymongo import ASCENDING, IndexModel

from app.models._base import TimestampMixin
from app.models._types import Money


def _zero() -> Decimal128:
    return Decimal128("0")


class Wallet(TimestampMixin):
    user_id: Indexed(PydanticObjectId, unique=True)  # type: ignore[valid-type]

    available_balance: Money = Field(default_factory=_zero)
    used_margin: Money = Field(default_factory=_zero)
    realized_pnl: Money = Field(default_factory=_zero)
    unrealized_pnl: Money = Field(default_factory=_zero)
    credit_limit: Money = Field(default_factory=_zero)

    total_deposits: Money = Field(default_factory=_zero)
    total_withdrawals: Money = Field(default_factory=_zero)
    total_brokerage: Money = Field(default_factory=_zero)
    total_charges: Money = Field(default_factory=_zero)

    # Optimistic-locking version. Increment on each financial mutation.
    version: int = 0

    class Settings:
        name = "wallets"
        indexes = [IndexModel([("user_id", ASCENDING)], unique=True)]
