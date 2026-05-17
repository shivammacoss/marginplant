"""In-app notifications — TTL 90 days after creation."""

from __future__ import annotations

from datetime import datetime, timedelta
from enum import Enum

from beanie import PydanticObjectId
from pydantic import Field
from pymongo import ASCENDING, DESCENDING, IndexModel

from app.models._base import StrEnum, TimestampMixin
from app.utils.time_utils import now_utc


class NotificationType(StrEnum):
    ORDER = "ORDER"
    TRADE = "TRADE"
    POSITION = "POSITION"
    WALLET = "WALLET"
    DEPOSIT = "DEPOSIT"
    WITHDRAWAL = "WITHDRAWAL"
    PRICE_ALERT = "PRICE_ALERT"
    SYSTEM = "SYSTEM"
    MARGIN = "MARGIN"
    SQUAREOFF = "SQUAREOFF"
    SECURITY = "SECURITY"


class NotificationLevel(StrEnum):
    INFO = "INFO"
    SUCCESS = "SUCCESS"
    WARNING = "WARNING"
    DANGER = "DANGER"


class Notification(TimestampMixin):
    user_id: PydanticObjectId
    type: NotificationType
    level: NotificationLevel = NotificationLevel.INFO
    title: str
    message: str
    is_read: bool = False
    read_at: datetime | None = None
    data: dict = Field(default_factory=dict)

    expires_at: datetime = Field(default_factory=lambda: now_utc() + timedelta(days=90))

    class Settings:
        name = "notifications"
        indexes = [
            IndexModel(
                [
                    ("user_id", ASCENDING),
                    ("is_read", ASCENDING),
                    ("created_at", DESCENDING),
                ]
            ),
            IndexModel([("user_id", ASCENDING), ("created_at", DESCENDING)]),
            IndexModel([("type", ASCENDING)]),
            IndexModel([("expires_at", ASCENDING)], expireAfterSeconds=0),
        ]
