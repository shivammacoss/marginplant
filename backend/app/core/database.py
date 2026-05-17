"""MongoDB connection lifecycle (Motor + Beanie).

`init_database()` is called from FastAPI's lifespan handler. It opens the
Motor client, registers every Beanie Document model, and ensures indexes.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from beanie import init_beanie
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase
from pymongo.errors import ServerSelectionTimeoutError

from app.core.config import settings

if TYPE_CHECKING:
    from beanie import Document

logger = logging.getLogger(__name__)

_client: AsyncIOMotorClient | None = None
_db: AsyncIOMotorDatabase | None = None


def get_client() -> AsyncIOMotorClient:
    if _client is None:
        raise RuntimeError("MongoDB client not initialized — call init_database() first")
    return _client


def get_db() -> AsyncIOMotorDatabase:
    if _db is None:
        raise RuntimeError("MongoDB not initialized — call init_database() first")
    return _db


def _document_models() -> list[type["Document"]]:
    # Imported lazily so this module can be imported before models are written.
    from app.models.admin_settlement import AdminSettlement
    from app.models.broker_settlement import BrokerSettlement
    from app.models.alert import PriceAlert
    from app.models.audit_log import AuditLog
    from app.models.bank_account import CompanyBankAccount, UserBankAccount
    from app.models.brokerage_plan import BrokeragePlan
    from app.models.holding import Holding
    from app.models.holiday import TradingHoliday
    from app.models.instrument import Instrument
    from app.models.kyc import KycSubmission
    from app.models.notification import Notification
    from app.models.order import Order
    from app.models.platform_setting import PlatformSetting
    from app.models.position import Position, UserPositionTracker
    from app.models.netting import (
        BrokerRiskSettings,
        BrokerSegmentOverride,
        NettingScriptOverride,
        NettingSegment,
        RiskSettings,
        SubAdminRiskSettings,
        SubAdminSegmentOverride,
        SuperAdminRiskSettings,
        SuperAdminSegmentOverride,
        UserRiskSettings,
        UserSegmentOverride,
    )
    from app.models.trade import Trade
    from app.models.transaction import (
        DepositRequest,
        WalletTransaction,
        WdRule,
        WithdrawalRequest,
    )
    from app.models.user import User, UserSegment
    from app.models.wallet import Wallet
    from app.models.watchlist import Watchlist, WatchlistItem
    from app.models.zerodha_settings import ZerodhaSettings

    return [
        # Users / segments
        User,
        UserSegment,
        # Risk + Netting
        RiskSettings,
        UserRiskSettings,
        SubAdminRiskSettings,
        SuperAdminRiskSettings,
        BrokerRiskSettings,
        NettingSegment,
        NettingScriptOverride,
        SubAdminSegmentOverride,
        SuperAdminSegmentOverride,
        BrokerSegmentOverride,
        UserSegmentOverride,
        # Market
        Instrument,
        # Wallet / money
        Wallet,
        WalletTransaction,
        DepositRequest,
        WithdrawalRequest,
        WdRule,
        CompanyBankAccount,
        UserBankAccount,
        BrokeragePlan,
        # Trading
        Order,
        Trade,
        Position,
        Holding,
        UserPositionTracker,
        Watchlist,
        WatchlistItem,
        # Ops
        AuditLog,
        KycSubmission,
        Notification,
        PriceAlert,
        PlatformSetting,
        TradingHoliday,
        AdminSettlement,
        BrokerSettlement,
        # Integrations
        ZerodhaSettings,
    ]


async def init_database() -> None:
    """Open Motor client, register Beanie documents, ensure indexes."""
    global _client, _db

    kwargs: dict[str, object] = {
        "maxPoolSize": settings.MONGODB_MAX_POOL_SIZE,
        "minPoolSize": settings.MONGODB_MIN_POOL_SIZE,
        "serverSelectionTimeoutMS": 5000,
        "uuidRepresentation": "standard",
        # Return tz-aware (UTC) datetimes from MongoDB instead of naive ones,
        # so Pydantic serializes them with a `+00:00` offset and JS clients
        # parse them as UTC (not local time).
        "tz_aware": True,
    }
    if settings.MONGODB_REPLICA_SET:
        kwargs["replicaSet"] = settings.MONGODB_REPLICA_SET

    _client = AsyncIOMotorClient(settings.MONGODB_URL, **kwargs)
    _db = _client[settings.MONGODB_DB_NAME]

    try:
        await _client.admin.command("ping")
    except ServerSelectionTimeoutError as e:  # pragma: no cover
        logger.error("mongodb_unreachable", extra={"error": str(e)})
        raise

    await init_beanie(database=_db, document_models=_document_models())
    logger.info("mongodb_connected", extra={"db": settings.MONGODB_DB_NAME})


async def close_database() -> None:
    global _client, _db
    if _client is not None:
        _client.close()
        _client = None
        _db = None
        logger.info("mongodb_disconnected")


async def healthcheck() -> bool:
    try:
        await get_client().admin.command("ping")
        return True
    except Exception:  # pragma: no cover
        return False
