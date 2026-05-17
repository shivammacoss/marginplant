"""Broker tier — create/manage brokers (admin → broker, broker → sub-broker).

Mirrors `admin_management_service.py` for the broker layer. Two key
differences vs. sub-admin:

  1. Permissions are TRI-STATE (`PermissionLevel.OFF | VIEW | EDIT`)
     rather than boolean. Every grant is validated against the actor's
     own cap via `max_grantable_perms(actor)`.
  2. Brokers can nest. A broker creating a sub-broker propagates its
     ancestry (`new.broker_ancestry = creator.broker_ancestry + [creator.id]`)
     so a single multikey query on `broker_ancestry` scopes the whole
     subtree.

All mutations write an audit-log entry. Pure data layer — HTTP shaping
lives in `app/api/v1/admin/brokers.py`.
"""

from __future__ import annotations

import re
from decimal import Decimal
from typing import Any

from beanie import PydanticObjectId

from app.core.dependencies import (
    assert_broker_in_scope,
    max_grantable_perms,
)
from app.core.exceptions import (
    ConflictError,
    NotFoundError,
    ValidationFailedError,
)
from app.models._base import PermissionLevel
from app.models.audit_log import AuditAction
from app.models.user import (
    BrokerPermissions,
    User,
    UserRole,
    UserStatus,
)
from app.services import user_service
from app.services.audit_service import log_event
from app.utils.decimal_utils import to_decimal, to_decimal128


# ── Validation helpers ───────────────────────────────────────────────
def _validate_permissions_against_cap(
    requested: BrokerPermissions, cap: dict[str, PermissionLevel]
) -> None:
    """Raises if any requested level exceeds the actor's cap.

    Cap comparison uses ordering OFF < VIEW < EDIT defined on
    PermissionLevel. Used both at create and at update time.
    """
    for key in BrokerPermissions.model_fields:
        want_raw = getattr(requested, key, PermissionLevel.OFF)
        want = (
            want_raw if isinstance(want_raw, PermissionLevel)
            else PermissionLevel(want_raw)
        )
        max_level = cap.get(key, PermissionLevel.OFF)
        if not PermissionLevel.at_least(max_level, want):
            raise ValidationFailedError(
                f"Permission '{key}' = {want.value} exceeds your cap of {max_level.value}"
            )


def _clip_to_cap(
    current: BrokerPermissions, cap: dict[str, PermissionLevel]
) -> tuple[BrokerPermissions, list[str]]:
    """Returns a copy of `current` with every key clipped to the cap, plus
    the list of keys actually clipped. Used by the cascade after a parent
    downgrade so descendant permissions stay <= their new parent's cap."""
    changes: list[str] = []
    data = current.model_dump()
    for key in BrokerPermissions.model_fields:
        actual_raw = data.get(key, PermissionLevel.OFF.value)
        actual = (
            actual_raw if isinstance(actual_raw, PermissionLevel)
            else PermissionLevel(actual_raw)
        )
        ceiling = cap.get(key, PermissionLevel.OFF)
        if not PermissionLevel.at_least(ceiling, actual):
            data[key] = ceiling.value
            changes.append(key)
    return BrokerPermissions(**data), changes


def _resolve_creator_chain(creator: User) -> tuple[PydanticObjectId | None, list[PydanticObjectId]]:
    """Returns ``(assigned_admin_id, broker_ancestry)`` to stamp on a newly
    created broker, given the creator's role.

      - SUPER_ADMIN → ``(None, [])`` — top broker in platform pool.
      - ADMIN       → ``(admin.id, [])`` — top broker under that admin.
      - BROKER      → ``(creator.assigned_admin_id,
                          creator.broker_ancestry + [creator.id])`` — sub-broker.
    """
    if creator.role == UserRole.SUPER_ADMIN:
        return None, []
    if creator.role == UserRole.ADMIN:
        return creator.id, []
    if creator.role == UserRole.BROKER:
        return (
            creator.assigned_admin_id,
            list(creator.broker_ancestry or []) + [creator.id],
        )
    raise ValidationFailedError("Cannot create brokers from this role")


# ── CRUD ─────────────────────────────────────────────────────────────
async def create_broker(
    *,
    creator: User,
    email: str,
    mobile: str,
    password: str,
    full_name: str,
    permissions: BrokerPermissions,
    pnl_share_pct: Decimal,
) -> User:
    """Mints a new BROKER row. Validates permission cap, sets the ownership
    chain, and writes an audit log.

    Allowed creators: ADMIN (creates a top-level broker in their pool) or
    BROKER (creates a sub-broker in their subtree). Super-admin is rejected
    — super-admin manages admins, admins manage brokers.
    """
    if pnl_share_pct < 0 or pnl_share_pct > 100:
        raise ValidationFailedError("pnl_share_pct must be between 0 and 100")

    if creator.role == UserRole.SUPER_ADMIN:
        raise ValidationFailedError(
            "Super-admin cannot create brokers. Brokers are created by admins."
        )

    cap = max_grantable_perms(creator)
    _validate_permissions_against_cap(permissions, cap)

    assigned_admin_id, ancestry = _resolve_creator_chain(creator)

    new = await user_service.create_user(
        email=email,
        mobile=mobile,
        password=password,
        full_name=full_name,
        role=UserRole.BROKER,
        status=UserStatus.ACTIVE,
        created_by=creator.id,
        assigned_admin_id=assigned_admin_id,
        assigned_broker_id=creator.id if creator.role == UserRole.BROKER else None,
        broker_ancestry=ancestry,
    )
    new.broker_permissions = permissions
    new.broker_pnl_share_pct = to_decimal128(pnl_share_pct)
    await new.save()

    await log_event(
        action=AuditAction.BROKER_CREATE,
        entity_type="User",
        entity_id=new.id,
        actor_id=creator.id,
        target_user_id=new.id,
        new_values={
            "permissions": permissions.model_dump(),
            "pnl_share_pct": str(pnl_share_pct),
            "broker_ancestry": [str(x) for x in ancestry],
        },
    )
    return new


async def get_broker_or_404(broker_id: str | PydanticObjectId) -> User:
    try:
        oid = PydanticObjectId(broker_id)
    except Exception as e:
        raise ValidationFailedError("Invalid broker id") from e
    b = await User.get(oid)
    if b is None or b.role != UserRole.BROKER:
        raise NotFoundError("Broker not found")
    return b


async def update_broker(
    actor: User,
    broker_id: str | PydanticObjectId,
    *,
    full_name: str | None,
) -> User:
    b = await assert_broker_in_scope(actor, broker_id)
    changes: dict[str, Any] = {}
    if full_name is not None and full_name.strip() and full_name != b.full_name:
        changes["full_name"] = full_name.strip()
        b.full_name = full_name.strip()
    if changes:
        await b.save()
        await log_event(
            action=AuditAction.BROKER_UPDATE,
            entity_type="User",
            entity_id=b.id,
            actor_id=actor.id,
            target_user_id=b.id,
            new_values=changes,
        )
    return b


async def update_broker_permissions(
    actor: User,
    broker_id: str | PydanticObjectId,
    new_perms: BrokerPermissions,
) -> tuple[User, list[dict]]:
    """Replaces the broker's permissions. After saving, cascade-clips any
    descendant sub-broker whose grant now exceeds this broker's cap so
    privilege never escalates beyond what the parent currently grants.

    Returns ``(broker, cascaded_changes)`` — `cascaded_changes` is a list
    of {"id", "user_code", "changes": [...keys clipped]} for the audit
    surface so the admin UI can show what got auto-downgraded.
    """
    b = await assert_broker_in_scope(actor, broker_id)
    cap = max_grantable_perms(actor)
    _validate_permissions_against_cap(new_perms, cap)

    old = b.broker_permissions.model_dump() if b.broker_permissions else None
    b.broker_permissions = new_perms
    await b.save()
    await log_event(
        action=AuditAction.BROKER_PERMS_UPDATE,
        entity_type="User",
        entity_id=b.id,
        actor_id=actor.id,
        target_user_id=b.id,
        old_values={"permissions": old},
        new_values={"permissions": new_perms.model_dump()},
    )

    # Cascade-clip descendants — anyone with broker_ancestry containing b.id
    # AND role == BROKER. Use the broker's new perms as the new descendant cap.
    descendant_cap: dict[str, PermissionLevel] = {
        k: (
            getattr(new_perms, k)
            if isinstance(getattr(new_perms, k), PermissionLevel)
            else PermissionLevel(getattr(new_perms, k))
        )
        for k in BrokerPermissions.model_fields
    }
    cascaded: list[dict] = []
    descendants = await User.find(
        {"role": UserRole.BROKER.value, "broker_ancestry": b.id}
    ).to_list()
    for sub in descendants:
        if sub.broker_permissions is None:
            continue
        clipped, keys_changed = _clip_to_cap(sub.broker_permissions, descendant_cap)
        if keys_changed:
            sub.broker_permissions = clipped
            await sub.save()
            await log_event(
                action=AuditAction.BROKER_PERMS_UPDATE,
                entity_type="User",
                entity_id=sub.id,
                actor_id=actor.id,
                target_user_id=sub.id,
                metadata={
                    "kind": "CASCADE_CLIP",
                    "clipped_keys": keys_changed,
                    "from_broker_id": str(b.id),
                },
            )
            cascaded.append(
                {
                    "id": str(sub.id),
                    "user_code": sub.user_code,
                    "changes": keys_changed,
                }
            )
    return b, cascaded


async def set_broker_pnl_share(
    actor: User,
    broker_id: str | PydanticObjectId,
    pct: Decimal,
) -> User:
    pct_dec = to_decimal(pct)
    if pct_dec < 0 or pct_dec > 100:
        raise ValidationFailedError("pct must be between 0 and 100")
    b = await assert_broker_in_scope(actor, broker_id)
    old = str(b.broker_pnl_share_pct) if b.broker_pnl_share_pct is not None else None
    b.broker_pnl_share_pct = to_decimal128(pct_dec)
    await b.save()
    await log_event(
        action=AuditAction.BROKER_PNL_SHARE_UPDATE,
        entity_type="User",
        entity_id=b.id,
        actor_id=actor.id,
        target_user_id=b.id,
        old_values={"pnl_share_pct": old},
        new_values={"pnl_share_pct": str(pct_dec)},
    )
    return b


async def block_broker(actor: User, broker_id: str | PydanticObjectId) -> User:
    b = await assert_broker_in_scope(actor, broker_id)
    b.status = UserStatus.BLOCKED
    await b.save()
    await log_event(
        action=AuditAction.BLOCK,
        entity_type="User",
        entity_id=b.id,
        actor_id=actor.id,
        target_user_id=b.id,
        metadata={"kind": "BROKER"},
    )
    return b


async def unblock_broker(actor: User, broker_id: str | PydanticObjectId) -> User:
    b = await assert_broker_in_scope(actor, broker_id)
    b.status = UserStatus.ACTIVE
    b.failed_login_count = 0
    b.locked_until = None
    await b.save()
    await log_event(
        action=AuditAction.UNBLOCK,
        entity_type="User",
        entity_id=b.id,
        actor_id=actor.id,
        target_user_id=b.id,
        metadata={"kind": "BROKER"},
    )
    return b


# ── Listing ──────────────────────────────────────────────────────────
async def list_brokers_for(
    actor: User,
    *,
    status: str | None = None,
    q: str | None = None,
    page: int = 1,
    page_size: int = 20,
) -> tuple[list[User], int]:
    """Returns brokers visible to the actor.

      - SUPER_ADMIN → top brokers in platform pool (no assigned_admin_id)
      - ADMIN       → brokers in their pool (assigned_admin_id == admin.id)
        and NO parent broker (top brokers under the admin)
      - BROKER      → their direct sub-brokers (assigned_broker_id == self.id)
    """
    query: dict[str, Any] = {"role": UserRole.BROKER.value}

    if actor.role == UserRole.SUPER_ADMIN:
        query["assigned_admin_id"] = None
        query["assigned_broker_id"] = None
    elif actor.role == UserRole.ADMIN:
        query["assigned_admin_id"] = actor.id
        query["assigned_broker_id"] = None
    elif actor.role == UserRole.BROKER:
        query["assigned_broker_id"] = actor.id
    else:
        return [], 0

    if status:
        query["status"] = status
    if q:
        regex = re.compile(re.escape(q.strip()), re.IGNORECASE)
        query["$or"] = [
            {"email": regex},
            {"mobile": regex},
            {"user_code": regex},
            {"full_name": regex},
        ]
    total = await User.find(query).count()
    rows = (
        await User.find(query)
        .sort("-created_at")
        .skip((page - 1) * page_size)
        .limit(page_size)
        .to_list()
    )
    return rows, total


async def count_assigned_users(broker_id: PydanticObjectId) -> int:
    """Direct clients of this broker — broker_ancestry's last element is
    the immediate broker. We use a positional match for that."""
    coll = User.get_motor_collection()
    return await coll.count_documents(
        {
            "role": {"$nin": [UserRole.SUPER_ADMIN.value, UserRole.ADMIN.value, UserRole.BROKER.value]},
            "assigned_broker_id": broker_id,
        }
    )


async def count_subtree_users(broker_id: PydanticObjectId) -> int:
    """Whole subtree client count (descendants of any depth)."""
    coll = User.get_motor_collection()
    return await coll.count_documents(
        {
            "role": {"$nin": [UserRole.SUPER_ADMIN.value, UserRole.ADMIN.value, UserRole.BROKER.value]},
            "broker_ancestry": broker_id,
        }
    )


async def list_subtree_clients(
    broker_id: str | PydanticObjectId,
    *,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[User], int]:
    """Whole subtree clients (every CLIENT/MASTER/DEALER with broker_id in
    their broker_ancestry)."""
    try:
        oid = PydanticObjectId(broker_id)
    except Exception as e:
        raise ValidationFailedError("Invalid broker id") from e
    query = {
        "role": {"$nin": [UserRole.SUPER_ADMIN.value, UserRole.ADMIN.value, UserRole.BROKER.value]},
        "broker_ancestry": oid,
    }
    total = await User.find(query).count()
    rows = (
        await User.find(query)
        .sort("-created_at")
        .skip((page - 1) * page_size)
        .limit(page_size)
        .to_list()
    )
    return rows, total


# ── Reassignment ─────────────────────────────────────────────────────
async def reassign_user_to_broker(
    actor: User,
    user_id: str | PydanticObjectId,
    new_broker_id: str | PydanticObjectId | None,
) -> User:
    """Move a client into a broker's pool, or back out (None ⇒ admin pool).

    Re-stamps `assigned_admin_id`, `assigned_broker_id`, and
    `broker_ancestry` so existing scope queries continue to find them.
    Actor must own both source (existing pool) and destination (new
    broker) — enforced via the existing `assert_*_in_scope` helpers.
    """
    from app.core.dependencies import assert_user_in_scope as _assert_user

    target = await _assert_user(actor, user_id)
    if target.role in {UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.BROKER}:
        raise ConflictError("Cannot reassign an admin/broker-tier user")

    new_broker: User | None = None
    if new_broker_id is not None:
        new_broker = await assert_broker_in_scope(actor, new_broker_id)

    old = {
        "assigned_admin_id": str(target.assigned_admin_id) if target.assigned_admin_id else None,
        "assigned_broker_id": str(target.assigned_broker_id) if target.assigned_broker_id else None,
        "broker_ancestry": [str(x) for x in (target.broker_ancestry or [])],
    }

    if new_broker is None:
        # Return to admin/platform pool — clear broker linkage but keep
        # assigned_admin_id (drops back to actor's pool).
        if actor.role == UserRole.ADMIN:
            target.assigned_admin_id = actor.id
        elif actor.role == UserRole.SUPER_ADMIN:
            target.assigned_admin_id = None
        target.assigned_broker_id = None
        target.broker_ancestry = []
    else:
        target.assigned_admin_id = new_broker.assigned_admin_id
        target.assigned_broker_id = new_broker.id
        target.broker_ancestry = list(new_broker.broker_ancestry or []) + [new_broker.id]

    await target.save()
    await log_event(
        action=AuditAction.USER_REASSIGN_TO_BROKER,
        entity_type="User",
        entity_id=target.id,
        actor_id=actor.id,
        target_user_id=target.id,
        old_values=old,
        new_values={
            "assigned_admin_id": str(target.assigned_admin_id) if target.assigned_admin_id else None,
            "assigned_broker_id": str(target.assigned_broker_id) if target.assigned_broker_id else None,
            "broker_ancestry": [str(x) for x in (target.broker_ancestry or [])],
        },
    )
    return target


async def bulk_reassign_to_broker(
    actor: User,
    user_ids: list[str],
    new_broker_id: str | PydanticObjectId | None,
) -> dict[str, Any]:
    moved = 0
    failed: list[dict[str, str]] = []
    for uid in user_ids:
        try:
            await reassign_user_to_broker(actor, uid, new_broker_id)
            moved += 1
        except Exception as e:
            failed.append({"user_id": uid, "error": str(e)})
    return {"moved": moved, "failed": failed}
