"""Super-admin operations on sub-admins and user assignment.

All mutations write an audit log entry. Pure data-layer; HTTP shaping lives
in [app.api.v1.admin.management](../api/v1/admin/management.py).
"""

from __future__ import annotations

import re
from decimal import Decimal
from typing import Any

from beanie import PydanticObjectId

from app.core.exceptions import ConflictError, NotFoundError, ValidationFailedError
from app.models.audit_log import AuditAction
from app.models.user import (
    AdminPermissions,
    User,
    UserRole,
    UserStatus,
)
from app.services import user_service
from app.services.audit_service import log_event
from app.utils.decimal_utils import to_decimal, to_decimal128


async def _get_sub_admin_or_404(sub_admin_id: str | PydanticObjectId) -> User:
    try:
        oid = PydanticObjectId(sub_admin_id)
    except Exception as e:
        raise ValidationFailedError("Invalid sub-admin id") from e
    sa = await User.get(oid)
    if sa is None or sa.role != UserRole.ADMIN:
        raise NotFoundError("Sub-admin not found")
    return sa


async def create_sub_admin(
    *,
    email: str,
    mobile: str,
    password: str,
    full_name: str,
    permissions: AdminPermissions,
    pnl_share_pct: Decimal,
    created_by: PydanticObjectId,
) -> User:
    if pnl_share_pct < 0 or pnl_share_pct > 100:
        raise ValidationFailedError("pnl_share_pct must be between 0 and 100")

    sa = await user_service.create_user(
        email=email,
        mobile=mobile,
        password=password,
        full_name=full_name,
        role=UserRole.ADMIN,
        status=UserStatus.ACTIVE,
        created_by=created_by,
        # Sub-admin themselves are not assigned to anyone.
        assigned_admin_id=None,
    )
    sa.admin_permissions = permissions
    sa.pnl_share_pct = to_decimal128(pnl_share_pct)
    await sa.save()

    await log_event(
        action=AuditAction.SUB_ADMIN_CREATE,
        entity_type="User",
        entity_id=sa.id,
        actor_id=created_by,
        target_user_id=sa.id,
        new_values={
            "permissions": permissions.model_dump(),
            "pnl_share_pct": str(pnl_share_pct),
        },
    )
    return sa


async def update_sub_admin(
    sub_admin_id: str | PydanticObjectId,
    *,
    full_name: str | None,
    actor_id: PydanticObjectId,
) -> User:
    sa = await _get_sub_admin_or_404(sub_admin_id)
    changes: dict[str, Any] = {}
    if full_name is not None and full_name.strip() and full_name != sa.full_name:
        changes["full_name"] = full_name.strip()
        sa.full_name = full_name.strip()
    if changes:
        await sa.save()
        await log_event(
            action=AuditAction.SUB_ADMIN_UPDATE,
            entity_type="User",
            entity_id=sa.id,
            actor_id=actor_id,
            target_user_id=sa.id,
            new_values=changes,
        )
    return sa


async def update_permissions(
    sub_admin_id: str | PydanticObjectId,
    permissions: AdminPermissions,
    actor_id: PydanticObjectId,
) -> User:
    sa = await _get_sub_admin_or_404(sub_admin_id)
    old = sa.admin_permissions.model_dump() if sa.admin_permissions else None
    sa.admin_permissions = permissions
    await sa.save()
    await log_event(
        action=AuditAction.SUB_ADMIN_PERMS_UPDATE,
        entity_type="User",
        entity_id=sa.id,
        actor_id=actor_id,
        target_user_id=sa.id,
        old_values={"permissions": old},
        new_values={"permissions": permissions.model_dump()},
    )
    return sa


async def set_pnl_share(
    sub_admin_id: str | PydanticObjectId,
    pct: Decimal,
    actor_id: PydanticObjectId,
) -> User:
    pct_dec = to_decimal(pct)
    if pct_dec < 0 or pct_dec > 100:
        raise ValidationFailedError("pct must be between 0 and 100")
    sa = await _get_sub_admin_or_404(sub_admin_id)
    old = str(sa.pnl_share_pct) if sa.pnl_share_pct is not None else None
    sa.pnl_share_pct = to_decimal128(pct_dec)
    await sa.save()
    await log_event(
        action=AuditAction.SUB_ADMIN_PNL_SHARE_UPDATE,
        entity_type="User",
        entity_id=sa.id,
        actor_id=actor_id,
        target_user_id=sa.id,
        old_values={"pnl_share_pct": old},
        new_values={"pnl_share_pct": str(pct_dec)},
    )
    return sa


async def block_sub_admin(
    sub_admin_id: str | PydanticObjectId, actor_id: PydanticObjectId
) -> User:
    sa = await _get_sub_admin_or_404(sub_admin_id)
    sa.status = UserStatus.BLOCKED
    await sa.save()
    await log_event(
        action=AuditAction.BLOCK,
        entity_type="User",
        entity_id=sa.id,
        actor_id=actor_id,
        target_user_id=sa.id,
        metadata={"kind": "SUB_ADMIN"},
    )
    return sa


async def unblock_sub_admin(
    sub_admin_id: str | PydanticObjectId, actor_id: PydanticObjectId
) -> User:
    sa = await _get_sub_admin_or_404(sub_admin_id)
    sa.status = UserStatus.ACTIVE
    sa.failed_login_count = 0
    sa.locked_until = None
    await sa.save()
    await log_event(
        action=AuditAction.UNBLOCK,
        entity_type="User",
        entity_id=sa.id,
        actor_id=actor_id,
        target_user_id=sa.id,
        metadata={"kind": "SUB_ADMIN"},
    )
    return sa


async def list_sub_admins(
    *, status: str | None = None, q: str | None = None, page: int = 1, page_size: int = 20
) -> tuple[list[User], int]:
    query: dict[str, Any] = {"role": UserRole.ADMIN.value}
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


async def count_assigned_users(sub_admin_id: PydanticObjectId) -> int:
    return await User.find({"assigned_admin_id": sub_admin_id}).count()


async def list_assigned_users(
    sub_admin_id: str | PydanticObjectId,
    *,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[User], int]:
    try:
        oid = PydanticObjectId(sub_admin_id)
    except Exception as e:
        raise ValidationFailedError("Invalid sub-admin id") from e
    query = {"assigned_admin_id": oid}
    total = await User.find(query).count()
    rows = (
        await User.find(query)
        .sort("-created_at")
        .skip((page - 1) * page_size)
        .limit(page_size)
        .to_list()
    )
    return rows, total


async def reassign_user(
    user_id: str | PydanticObjectId,
    new_sub_admin_id: str | PydanticObjectId | None,
    actor_id: PydanticObjectId,
) -> User:
    """Move a user into a sub-admin's pool, or back to super-admin (None)."""
    target = await user_service.get_user_or_404(user_id)
    if target.role in {UserRole.SUPER_ADMIN, UserRole.ADMIN}:
        raise ConflictError("Cannot reassign an admin-role user")

    new_oid: PydanticObjectId | None = None
    if new_sub_admin_id is not None:
        sa = await _get_sub_admin_or_404(new_sub_admin_id)
        new_oid = sa.id

    old = str(target.assigned_admin_id) if target.assigned_admin_id else None
    target.assigned_admin_id = new_oid
    await target.save()
    await log_event(
        action=AuditAction.USER_REASSIGN,
        entity_type="User",
        entity_id=target.id,
        actor_id=actor_id,
        target_user_id=target.id,
        old_values={"assigned_admin_id": old},
        new_values={"assigned_admin_id": str(new_oid) if new_oid else None},
    )
    return target


async def bulk_reassign(
    user_ids: list[str],
    new_sub_admin_id: str | PydanticObjectId | None,
    actor_id: PydanticObjectId,
) -> dict[str, Any]:
    moved = 0
    failed: list[dict[str, str]] = []
    for uid in user_ids:
        try:
            await reassign_user(uid, new_sub_admin_id, actor_id)
            moved += 1
        except Exception as e:
            failed.append({"user_id": uid, "error": str(e)})
    return {"moved": moved, "failed": failed}
