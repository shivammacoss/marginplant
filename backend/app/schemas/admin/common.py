"""Admin-side request/response schemas."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class CreateUserRequest(BaseModel):
    full_name: str
    email: str
    mobile: str
    password: str = Field(min_length=8)
    role: str = "CLIENT"
    parent_id: str | None = None
    is_demo: bool = False
    initial_balance: float = 0
    credit_limit: float = 0
    pan: str | None = None


class WalletAdjustRequest(BaseModel):
    amount: float
    narration: str
    transaction_type: str = "ADJUSTMENT"  # ADJUSTMENT / BONUS / PENALTY / PROMO


class BlockUserRequest(BaseModel):
    reason: str | None = None


class UpdateGlobalSettingRequest(BaseModel):
    patch: dict[str, Any]


class UpsertUserOverrideRequest(BaseModel):
    patch: dict[str, Any]


class ApproveDepositRequest(BaseModel):
    admin_remark: str | None = None


class RejectDepositRequest(BaseModel):
    admin_remark: str


class ApproveWithdrawalRequest(BaseModel):
    utr_number: str | None = None
    admin_remark: str | None = None


class RejectWithdrawalRequest(BaseModel):
    rejection_reason: str


class UpdatePlatformSettingRequest(BaseModel):
    setting_value: Any
