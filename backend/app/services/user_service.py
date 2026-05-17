"""User-domain operations — lookups, code generation, hierarchy walks."""

from __future__ import annotations

import secrets
from typing import Iterable

from beanie import PydanticObjectId
from beanie.operators import Or

from app.core.exceptions import ConflictError, NotFoundError, ValidationFailedError
from app.core.security import hash_password
from app.models._base import ALL_SEGMENTS
from app.models.user import (
    KycInfo,
    User,
    UserPermissions,
    UserRole,
    UserSegment,
    UserStatus,
)
from app.models.wallet import Wallet
from app.utils.validators import is_valid_mobile_in, normalize_mobile_in


def _role_prefix(role: UserRole) -> str:
    return {
        UserRole.SUPER_ADMIN: "SADM",
        UserRole.ADMIN: "ADM",
        UserRole.BROKER: "BRK",
        UserRole.MASTER: "MAS",
        UserRole.DEALER: "DLR",
        UserRole.CLIENT: "CL",
    }.get(role, "USR")


async def generate_user_code(role: UserRole) -> str:
    """Returns a unique user_code like 'CL12345678'. Retries on conflict."""
    prefix = _role_prefix(role)
    for _ in range(10):
        code = f"{prefix}{secrets.randbelow(10**8):08d}"
        existing = await User.find_one(User.user_code == code)
        if existing is None:
            return code
    raise ConflictError("Could not generate a unique user code; please retry")


async def find_by_identifier(identifier: str) -> User | None:
    """Lookup by email OR mobile (10-digit Indian)."""
    ident = identifier.strip().lower()
    if "@" in ident:
        return await User.find_one(User.email == ident)
    mobile = normalize_mobile_in(ident)
    if is_valid_mobile_in(mobile):
        return await User.find_one(User.mobile == mobile)
    # last resort: user_code
    return await User.find_one(User.user_code == ident.upper())


async def email_or_mobile_taken(email: str, mobile: str) -> str | None:
    """Returns the field name that conflicts, or None."""
    existing = await User.find_one(
        Or(User.email == email.lower(), User.mobile == mobile)
    )
    if existing is None:
        return None
    if existing.email == email.lower():
        return "email"
    return "mobile"


async def create_user(
    *,
    email: str,
    mobile: str,
    password: str,
    full_name: str,
    role: UserRole = UserRole.CLIENT,
    status: UserStatus = UserStatus.ACTIVE,
    parent_id: PydanticObjectId | None = None,
    kyc: KycInfo | None = None,
    permissions: UserPermissions | None = None,
    is_demo: bool = False,
    created_by: PydanticObjectId | None = None,
    assigned_admin_id: PydanticObjectId | None = None,
    assigned_broker_id: PydanticObjectId | None = None,
    broker_ancestry: list[PydanticObjectId] | None = None,
) -> User:
    email_l = email.lower().strip()
    mobile_n = normalize_mobile_in(mobile)
    conflict = await email_or_mobile_taken(email_l, mobile_n)
    if conflict:
        raise ConflictError(
            f"A user with this {conflict} already exists",
            details={"field": conflict},
        )

    user = User(
        user_code=await generate_user_code(role),
        email=email_l,
        mobile=mobile_n,
        password_hash=hash_password(password),
        full_name=full_name.strip(),
        role=role,
        status=status,
        parent_id=parent_id,
        kyc=kyc or KycInfo(),
        permissions=permissions or UserPermissions(),
        is_demo=is_demo,
        created_by=created_by,
        assigned_admin_id=assigned_admin_id,
        assigned_broker_id=assigned_broker_id,
        broker_ancestry=broker_ancestry or [],
    )
    await user.insert()

    # Create wallet (one per user) — sequential. An earlier asyncio.gather
    # version raced on Beanie's shared session on cold Mongo connections
    # and surfaced as a 500 from /auth/register, so the micro-optimisation
    # was reverted in favour of reliability.
    wallet = Wallet(user_id=user.id)  # type: ignore[arg-type]
    await wallet.insert()

    # Default segment access — all enabled (admin can prune later).
    await UserSegment.insert_many(
        [
            UserSegment(user_id=user.id, segment=s.value, enabled=True)  # type: ignore[arg-type]
            for s in ALL_SEGMENTS
        ]
    )

    return user


async def get_user_or_404(user_id: str | PydanticObjectId) -> User:
    try:
        oid = PydanticObjectId(user_id)
    except Exception as e:
        raise ValidationFailedError("Invalid user id") from e
    user = await User.get(oid)
    if user is None:
        raise NotFoundError("User not found")
    return user


async def descendants_of(user_id: PydanticObjectId, *, max_depth: int = 6) -> list[User]:
    """BFS through hierarchy. max_depth caps cost; trees deeper than 6 are
    almost certainly a misconfiguration."""
    out: list[User] = []
    frontier: Iterable[PydanticObjectId] = [user_id]
    for _ in range(max_depth):
        next_frontier: list[PydanticObjectId] = []
        if not frontier:
            break
        children = await User.find(User.parent_id.in_(list(frontier))).to_list()  # type: ignore[attr-defined]
        if not children:
            break
        out.extend(children)
        next_frontier = [c.id for c in children]  # type: ignore[misc]
        frontier = next_frontier
    return out
