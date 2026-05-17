"""Wallet transactions, deposit & withdrawal requests, and W/D rules.

`WalletTransaction` is the **immutable ledger** — every credit/debit appends
a new doc; never edit existing ones. balance_before / balance_after make
reconciliation trivial.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum

from beanie import Indexed, PydanticObjectId
from bson import Decimal128
from pydantic import BaseModel, Field
from pymongo import ASCENDING, DESCENDING, IndexModel

from app.models._base import StrEnum, TimestampMixin
from app.models._types import Money


def _zero() -> Decimal128:
    return Decimal128("0")


# ── 16. wallet_transactions ──────────────────────────────────────────
class TransactionType(StrEnum):
    DEPOSIT = "DEPOSIT"
    WITHDRAWAL = "WITHDRAWAL"
    TRADE = "TRADE"
    BROKERAGE = "BROKERAGE"
    CHARGES = "CHARGES"
    PNL = "PNL"
    ADJUSTMENT = "ADJUSTMENT"
    BONUS = "BONUS"
    PENALTY = "PENALTY"
    PROMO = "PROMO"
    INTER_USER = "INTER_USER"
    REVERSAL = "REVERSAL"


class TransactionStatus(StrEnum):
    PENDING = "PENDING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    REVERSED = "REVERSED"


class WalletTransaction(TimestampMixin):
    user_id: PydanticObjectId
    transaction_type: TransactionType
    amount: Money  # signed: + credit, - debit
    balance_before: Money = Field(default_factory=_zero)
    balance_after: Money = Field(default_factory=_zero)

    reference_type: str | None = None  # "ORDER" / "DEPOSIT" / "WITHDRAWAL" / "MANUAL"
    reference_id: str | None = None
    narration: str
    status: TransactionStatus = TransactionStatus.COMPLETED

    created_by: PydanticObjectId | None = None  # admin id for manual entries
    reversal_of: PydanticObjectId | None = None  # link back when reversed

    class Settings:
        name = "wallet_transactions"
        indexes = [
            IndexModel([("user_id", ASCENDING), ("created_at", DESCENDING)]),
            IndexModel([("transaction_type", ASCENDING), ("created_at", DESCENDING)]),
            IndexModel([("reference_type", ASCENDING), ("reference_id", ASCENDING)]),
            IndexModel([("status", ASCENDING)]),
            IndexModel([("created_at", DESCENDING)]),
        ]


# ── 17. deposit_requests ─────────────────────────────────────────────
class DepositStatus(StrEnum):
    PENDING = "PENDING"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    CANCELLED = "CANCELLED"


class PaymentMode(StrEnum):
    BANK_TRANSFER = "BANK_TRANSFER"
    UPI = "UPI"
    NEFT = "NEFT"
    RTGS = "RTGS"
    IMPS = "IMPS"


class DepositRequest(TimestampMixin):
    user_id: PydanticObjectId
    amount: Money
    payment_mode: PaymentMode = PaymentMode.UPI
    utr_number: str | None = None
    screenshot_url: str | None = None
    bank_account_id: PydanticObjectId | None = None  # company bank used

    user_remark: str | None = None
    admin_remark: str | None = None

    status: DepositStatus = DepositStatus.PENDING
    processed_by: PydanticObjectId | None = None
    processed_at: datetime | None = None

    idempotency_key: Indexed(str, unique=True, sparse=True) | None = None  # type: ignore[valid-type]

    class Settings:
        name = "deposit_requests"
        indexes = [
            IndexModel([("status", ASCENDING), ("created_at", DESCENDING)]),
            IndexModel([("user_id", ASCENDING), ("created_at", DESCENDING)]),
            IndexModel([("utr_number", ASCENDING)], sparse=True),
            IndexModel([("idempotency_key", ASCENDING)], unique=True, sparse=True),
        ]


# ── 18. withdrawal_requests ──────────────────────────────────────────
class WithdrawalStatus(StrEnum):
    PENDING = "PENDING"
    APPROVED = "APPROVED"
    PROCESSING = "PROCESSING"
    COMPLETED = "COMPLETED"
    REJECTED = "REJECTED"
    CANCELLED = "CANCELLED"


class BankSnapshot(BaseModel):
    """Where the user wants their withdrawal sent.

    Two channels are supported: bank transfer (name/account/ifsc/holder)
    OR UPI (upi_id, with optional qr_url for admin-side scan). Fields are
    optional individually; the request handler enforces "at least one
    channel populated" so existing bank-only rows stay valid.
    """

    name: str | None = None
    account_number: str | None = None
    ifsc: str | None = None
    holder: str | None = None
    branch: str | None = None
    account_type: str | None = None  # SAVINGS / CURRENT
    upi_id: str | None = None        # VPA, e.g. user@bank
    qr_url: str | None = None        # uploaded QR image (optional)


class WithdrawalRequest(TimestampMixin):
    user_id: PydanticObjectId
    amount: Money
    bank: BankSnapshot
    remarks: str | None = None
    utr_number: str | None = None  # filled by admin after disbursal
    charges: Money = Field(default_factory=_zero)
    net_amount: Money = Field(default_factory=_zero)

    status: WithdrawalStatus = WithdrawalStatus.PENDING
    processed_by: PydanticObjectId | None = None
    processed_at: datetime | None = None
    rejection_reason: str | None = None

    idempotency_key: Indexed(str, unique=True, sparse=True) | None = None  # type: ignore[valid-type]

    class Settings:
        name = "withdrawal_requests"
        indexes = [
            IndexModel([("status", ASCENDING), ("created_at", DESCENDING)]),
            IndexModel([("user_id", ASCENDING), ("created_at", DESCENDING)]),
            IndexModel([("idempotency_key", ASCENDING)], unique=True, sparse=True),
        ]


# ── 22. wd_rules ─────────────────────────────────────────────────────
class WdRuleType(StrEnum):
    DEPOSIT = "DEPOSIT"
    WITHDRAWAL = "WITHDRAWAL"


class AllowedTimeWindow(BaseModel):
    start: str = "09:00"  # HH:MM IST
    end: str = "21:00"


class WdRule(TimestampMixin):
    rule_type: Indexed(str, unique=True)  # type: ignore[valid-type] # one row each
    min_amount: Money = Field(default_factory=_zero)
    max_amount: Money = Field(default_factory=lambda: Decimal128("10000000"))
    daily_limit: Money = Field(default_factory=lambda: Decimal128("1000000"))

    allowed_times: list[AllowedTimeWindow] = Field(default_factory=lambda: [AllowedTimeWindow()])
    charges_flat: Money = Field(default_factory=_zero)
    charges_percent: float = 0.0
    auto_approve_under: Money = Field(default_factory=_zero)
    mandatory_remark: bool = False

    class Settings:
        name = "wd_rules"
        indexes = [IndexModel([("rule_type", ASCENDING)], unique=True)]
