"""Audit log — every admin action, money movement, status change.

TTL: 1 year retention by default (configurable via index recreation).
For high-volume deployments switch to MongoDB time-series collection.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from enum import Enum

from beanie import PydanticObjectId
from pydantic import Field
from pymongo import ASCENDING, DESCENDING, IndexModel

from app.models._base import StrEnum, TimestampMixin
from app.utils.time_utils import now_utc


class AuditAction(StrEnum):
    CREATE = "CREATE"
    UPDATE = "UPDATE"
    DELETE = "DELETE"
    LOGIN = "LOGIN"
    LOGOUT = "LOGOUT"
    LOGIN_FAILED = "LOGIN_FAILED"
    BLOCK = "BLOCK"
    UNBLOCK = "UNBLOCK"
    PASSWORD_CHANGE = "PASSWORD_CHANGE"
    PASSWORD_RESET = "PASSWORD_RESET"
    IMPERSONATE = "IMPERSONATE"
    APPROVE = "APPROVE"
    REJECT = "REJECT"
    WALLET_ADJUST = "WALLET_ADJUST"
    SETTING_CHANGE = "SETTING_CHANGE"
    ORDER_PLACE = "ORDER_PLACE"
    ORDER_CANCEL = "ORDER_CANCEL"
    ORDER_MODIFY = "ORDER_MODIFY"
    ORDER_REJECT = "ORDER_REJECT"
    SQUAREOFF = "SQUAREOFF"
    SQUAREOFF_FORCE = "SQUAREOFF_FORCE"
    EOD_RESET = "EOD_RESET"
    BACKUP = "BACKUP"
    RESTORE = "RESTORE"
    SUB_ADMIN_CREATE = "SUB_ADMIN_CREATE"
    SUB_ADMIN_UPDATE = "SUB_ADMIN_UPDATE"
    SUB_ADMIN_PERMS_UPDATE = "SUB_ADMIN_PERMS_UPDATE"
    SUB_ADMIN_PNL_SHARE_UPDATE = "SUB_ADMIN_PNL_SHARE_UPDATE"
    USER_REASSIGN = "USER_REASSIGN"
    SETTLEMENT_COMPUTE = "SETTLEMENT_COMPUTE"
    SETTLEMENT_FINALIZE = "SETTLEMENT_FINALIZE"
    SETTLEMENT_PAY = "SETTLEMENT_PAY"
    BROKER_CREATE = "BROKER_CREATE"
    BROKER_UPDATE = "BROKER_UPDATE"
    BROKER_PERMS_UPDATE = "BROKER_PERMS_UPDATE"
    BROKER_PNL_SHARE_UPDATE = "BROKER_PNL_SHARE_UPDATE"
    USER_REASSIGN_TO_BROKER = "USER_REASSIGN_TO_BROKER"
    BROKER_SETTLEMENT_COMPUTE = "BROKER_SETTLEMENT_COMPUTE"
    BROKER_SETTLEMENT_FINALIZE = "BROKER_SETTLEMENT_FINALIZE"
    BROKER_SETTLEMENT_PAY = "BROKER_SETTLEMENT_PAY"


class AuditLog(TimestampMixin):
    user_id: PydanticObjectId | None = None  # actor (None for system actions)
    target_user_id: PydanticObjectId | None = None  # subject when actor != target
    action: AuditAction
    entity_type: str  # "User", "Order", "Wallet", "SegmentSettings", ...
    entity_id: str | None = None

    old_values: dict | None = None
    new_values: dict | None = None
    metadata: dict = Field(default_factory=dict)

    ip_address: str | None = None
    user_agent: str | None = None
    request_id: str | None = None

    # Auto-expire field; 1y TTL via index below
    expires_at: datetime = Field(
        default_factory=lambda: now_utc() + timedelta(days=365)
    )

    class Settings:
        name = "audit_logs"
        indexes = [
            IndexModel([("user_id", ASCENDING), ("created_at", DESCENDING)]),
            IndexModel([("target_user_id", ASCENDING), ("created_at", DESCENDING)]),
            IndexModel([("entity_type", ASCENDING), ("entity_id", ASCENDING)]),
            IndexModel([("action", ASCENDING), ("created_at", DESCENDING)]),
            IndexModel([("created_at", DESCENDING)]),
            # TTL — Mongo deletes when expires_at passes
            IndexModel([("expires_at", ASCENDING)], expireAfterSeconds=0),
        ]
