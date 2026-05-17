"""User & UserSegment documents.

A single User collection holds clients, dealers, masters, admins, super-admin
— role-based filtering keeps query plans simple. Hierarchical relationships
(master → dealer → client) are modelled via `parent_id`.
"""

from __future__ import annotations

from datetime import date, datetime
from enum import Enum

from beanie import Indexed, Link, PydanticObjectId
from bson import Decimal128
from pydantic import BaseModel, EmailStr, Field
from pymongo import ASCENDING, DESCENDING, IndexModel

from app.models._base import PermissionLevel, StrEnum, TimestampMixin
from app.utils.time_utils import now_utc


class UserRole(StrEnum):
    SUPER_ADMIN = "SUPER_ADMIN"
    ADMIN = "ADMIN"
    MASTER = "MASTER"
    DEALER = "DEALER"
    CLIENT = "CLIENT"
    # New tier: a broker sits under an admin and manages their own client
    # pool. Brokers can also create sub-brokers (nested, via broker_ancestry).
    BROKER = "BROKER"


class UserStatus(StrEnum):
    ACTIVE = "ACTIVE"
    BLOCKED = "BLOCKED"
    PENDING = "PENDING"
    CLOSED = "CLOSED"


class AccountType(StrEnum):
    LIVE = "LIVE"
    DEMO = "DEMO"


# ── Embedded sub-documents ──────────────────────────────────────────
class KycInfo(BaseModel):
    pan: str | None = None
    aadhaar: str | None = None  # store hashed/last-4 in production
    dob: date | None = None
    address_line1: str | None = None
    address_line2: str | None = None
    city: str | None = None
    state: str | None = None
    pincode: str | None = None
    country: str = "India"
    is_verified: bool = False
    verified_at: datetime | None = None


class UserPermissions(BaseModel):
    can_place_orders: bool = True
    can_modify_orders: bool = True
    can_cancel_orders: bool = True
    can_withdraw: bool = True
    can_deposit: bool = True
    can_view_charts: bool = True
    api_access: bool = False
    algo_trading: bool = False


class TradingHours(BaseModel):
    login_start: str = "00:00"  # HH:MM, IST
    login_end: str = "23:59"
    ip_whitelist: list[str] = Field(default_factory=list)


class RiskProfile(BaseModel):
    max_daily_loss: float = 0.0  # 0 = no limit
    max_position_value: float = 0.0
    max_open_positions: int = 0
    auto_squareoff_enabled: bool = True
    m2m_squareoff_percent: float = 80.0  # squareoff at -80% of margin


class CommunicationPrefs(BaseModel):
    email_alerts: bool = True
    sms_alerts: bool = True
    whatsapp_alerts: bool = False
    push_alerts: bool = True


# Section toggles for sub-admins (role == ADMIN). One boolean per admin nav
# section; SUPER_ADMIN ignores this object entirely. Adding a new section
# means: append a field here, gate it in admin endpoints with
# require_admin_permission(<name>), and surface a toggle in the
# `frontend-admin/management` page.
class AdminPermissions(BaseModel):
    users: bool = False
    kyc: bool = False
    deposits: bool = False
    withdrawals: bool = False
    segment_settings: bool = False
    risk: bool = False
    netting: bool = False
    trading_view: bool = False
    ledger: bool = False
    reports: bool = False
    brokerage: bool = False
    # Gates access to /management/brokers — admin needs this ON to create
    # brokers under their pool. Super-admin always has it.
    brokers: bool = False
    # Gates the Bank Accounts tab on the Payments page (list/create/edit/
    # delete of CompanyBankAccount rows in the admin's own pool). Default
    # True so existing admins keep their bank-management capability —
    # super-admin can turn it OFF per sub-admin to lock down.
    banks: bool = True


# Tri-state permissions granted by an admin to a broker (or by a broker to
# a sub-broker). Each key mirrors a section in the admin nav; the level
# decides what the broker sees and can do on that page:
#   OFF  → section hidden from sidebar; backend rejects all calls with 403
#   VIEW → page loads, list/details readable; mutation buttons disabled,
#          backend rejects writes with 403
#   EDIT → full access (read + write)
# The `sub_brokers` key here is the broker-level equivalent of admin's
# `brokers` flag — gates the broker's ability to mint sub-brokers.
class BrokerPermissions(BaseModel):
    users: PermissionLevel = PermissionLevel.OFF
    kyc: PermissionLevel = PermissionLevel.OFF
    deposits: PermissionLevel = PermissionLevel.OFF
    withdrawals: PermissionLevel = PermissionLevel.OFF
    segment_settings: PermissionLevel = PermissionLevel.OFF
    risk: PermissionLevel = PermissionLevel.OFF
    netting: PermissionLevel = PermissionLevel.OFF
    trading_view: PermissionLevel = PermissionLevel.OFF
    ledger: PermissionLevel = PermissionLevel.OFF
    reports: PermissionLevel = PermissionLevel.OFF
    brokerage: PermissionLevel = PermissionLevel.OFF
    sub_brokers: PermissionLevel = PermissionLevel.OFF
    # Bank Accounts tab — VIEW lets broker see existing banks in their pool,
    # EDIT lets them add / update / delete banks for their own users.
    banks: PermissionLevel = PermissionLevel.OFF


# ── User document ───────────────────────────────────────────────────
class User(TimestampMixin):
    user_code: Indexed(str, unique=True)  # type: ignore[valid-type]
    email: Indexed(EmailStr, unique=True)  # type: ignore[valid-type]
    mobile: Indexed(str, unique=True)  # type: ignore[valid-type]
    password_hash: str
    full_name: str
    photo_url: str | None = None

    role: UserRole = UserRole.CLIENT
    status: UserStatus = UserStatus.PENDING
    account_type: AccountType = AccountType.LIVE
    is_demo: bool = False

    parent_id: PydanticObjectId | None = None  # hierarchy

    kyc: KycInfo = Field(default_factory=KycInfo)
    permissions: UserPermissions = Field(default_factory=UserPermissions)
    trading_hours: TradingHours = Field(default_factory=TradingHours)
    risk: RiskProfile = Field(default_factory=RiskProfile)
    communication: CommunicationPrefs = Field(default_factory=CommunicationPrefs)

    # Brokerage plan (FK to brokerage_plans, optional → uses default)
    brokerage_plan_id: PydanticObjectId | None = None

    # 2FA
    two_fa_enabled: bool = False
    two_fa_secret: str | None = None
    two_fa_backup_codes: list[str] = Field(default_factory=list)

    # Login telemetry
    last_login_at: datetime | None = None
    last_login_ip: str | None = None
    failed_login_count: int = 0
    locked_until: datetime | None = None
    password_changed_at: datetime | None = None
    must_change_password: bool = False

    created_by: PydanticObjectId | None = None

    # Sub-admin ownership (CLIENT/DEALER/MASTER → which ADMIN owns them).
    # NULL ⇒ owned by super-admin (the platform itself).
    assigned_admin_id: PydanticObjectId | None = None

    # Sub-admin profile — only populated for role == ADMIN.
    admin_permissions: AdminPermissions | None = None
    pnl_share_pct: Decimal128 | None = None  # 0..100

    # Immediate broker owner. For BROKER role: their parent broker (NULL for
    # a top-level broker created by an admin/super-admin). For CLIENT role:
    # the broker that minted them (NULL when client belongs to admin pool).
    assigned_broker_id: PydanticObjectId | None = None

    # Materialised broker ancestry, root-first, NOT including self. Lets us
    # scope an entire subtree in O(1) via a single multikey index lookup:
    #     User.find({"broker_ancestry": broker.id})
    # matches every descendant (sub-brokers + their clients) since the array
    # contains the broker.id at any depth. Top broker under an admin: [].
    # Sub-broker: [top_broker.id]. Sub-sub-broker: [top_broker.id, parent.id].
    broker_ancestry: list[PydanticObjectId] = Field(default_factory=list)

    # Broker profile — only meaningful when role == BROKER.
    broker_permissions: BrokerPermissions | None = None
    broker_pnl_share_pct: Decimal128 | None = None  # 0..100

    class Settings:
        name = "users"
        use_state_management = True
        indexes = [
            IndexModel([("email", ASCENDING)], unique=True),
            IndexModel([("mobile", ASCENDING)], unique=True),
            IndexModel([("user_code", ASCENDING)], unique=True),
            IndexModel([("parent_id", ASCENDING)]),
            IndexModel([("role", ASCENDING), ("status", ASCENDING)]),
            IndexModel([("created_at", DESCENDING)]),
            IndexModel([("kyc.pan", ASCENDING)]),
            IndexModel([("assigned_admin_id", ASCENDING), ("role", ASCENDING)]),
            IndexModel([("assigned_broker_id", ASCENDING), ("role", ASCENDING)]),
            # Multikey index — Mongo creates one entry per element of the
            # array, so {"broker_ancestry": <id>} matches in O(log n).
            IndexModel([("broker_ancestry", ASCENDING)]),
        ]

    def is_admin(self) -> bool:
        # BROKER role is considered admin-tier for purposes of the admin
        # login endpoint + admin-side JWT audience. Permission gating then
        # narrows behavior down via require_admin_permission /
        # require_broker_permission.
        return self.role in {
            UserRole.SUPER_ADMIN,
            UserRole.ADMIN,
            UserRole.BROKER,
        }

    def is_internal(self) -> bool:
        return self.role in {
            UserRole.SUPER_ADMIN,
            UserRole.ADMIN,
            UserRole.BROKER,
            UserRole.MASTER,
            UserRole.DEALER,
        }

    def record_successful_login(self, ip: str) -> None:
        self.last_login_at = now_utc()
        self.last_login_ip = ip
        self.failed_login_count = 0
        self.locked_until = None


# ── User segment toggle (which segments this user may even *see*) ────
class UserSegment(TimestampMixin):
    user_id: PydanticObjectId
    segment: str  # SegmentType.value
    enabled: bool = True

    class Settings:
        name = "user_segments"
        indexes = [
            IndexModel([("user_id", ASCENDING), ("segment", ASCENDING)], unique=True),
        ]
