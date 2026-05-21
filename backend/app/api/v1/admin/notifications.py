"""Admin notification bell — list / unread-count / mark-read.

Backed by the `admin_notifications` collection (model:
`app.models.notification.AdminNotification`). Every row is scoped to a
single recipient admin, so all endpoints here filter by
``recipient_admin_id = current_admin.id`` — no extra ACL plumbing
needed beyond the standard `CurrentAdmin` dependency.
"""

from __future__ import annotations

from typing import Any

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, Query

from app.core.dependencies import CurrentAdmin
from app.models.notification import AdminNotification
from app.schemas.common import APIResponse
from app.utils.time_utils import now_utc

router = APIRouter(prefix="/notifications", tags=["admin-notifications"])


def _serialise(n: AdminNotification) -> dict[str, Any]:
    return {
        "id": str(n.id),
        "event_type": n.event_type.value,
        "level": n.level.value,
        "title": n.title,
        "message": n.message,
        "link": n.link,
        "reference_type": n.reference_type,
        "reference_id": n.reference_id,
        "data": n.data,
        "is_read": n.is_read,
        "read_at": n.read_at,
        "created_at": n.created_at,
        "source_user_id": str(n.source_user_id),
    }


@router.get("", response_model=APIResponse[list])
async def list_notifications(
    admin: CurrentAdmin,
    only_unread: bool = False,
    limit: int = Query(default=50, ge=1, le=200),
):
    """Bell-panel feed. Defaults to "everything in the last 50 rows"
    sorted newest-first; `?only_unread=true` narrows to PENDING items.
    """
    q: dict[str, Any] = {"recipient_admin_id": admin.id}
    if only_unread:
        q["is_read"] = False
    rows = (
        await AdminNotification.find(q)
        .sort("-created_at")
        .limit(limit)
        .to_list()
    )
    return APIResponse(data=[_serialise(n) for n in rows])


@router.get("/unread-count", response_model=APIResponse[dict])
async def unread_count(admin: CurrentAdmin):
    """O(1) badge counter for the bell icon. Hit every few seconds /
    on every WS `notification_created` event."""
    count = await AdminNotification.find(
        AdminNotification.recipient_admin_id == admin.id,
        AdminNotification.is_read == False,  # noqa: E712 — beanie equality
    ).count()
    return APIResponse(data={"count": int(count)})


@router.post("/{notification_id}/read", response_model=APIResponse[dict])
async def mark_read(notification_id: str, admin: CurrentAdmin):
    """Mark a single notification read. Only the recipient admin
    themselves can flip their own copy — a broker can't clear an event
    from the super-admin's bell."""
    try:
        oid = PydanticObjectId(notification_id)
    except Exception:
        raise HTTPException(status_code=404, detail="Notification not found")
    n = await AdminNotification.get(oid)
    if n is None or n.recipient_admin_id != admin.id:
        raise HTTPException(status_code=404, detail="Notification not found")
    if not n.is_read:
        n.is_read = True
        n.read_at = now_utc()
        await n.save()
    return APIResponse(data=_serialise(n))


@router.post("/mark-all-read", response_model=APIResponse[dict])
async def mark_all_read(admin: CurrentAdmin):
    """Bulk-flip every unread row for this admin to read in one
    Mongo update. Used by the "Mark all read" link in the bell panel."""
    coll = AdminNotification.get_motor_collection()
    res = await coll.update_many(
        {"recipient_admin_id": admin.id, "is_read": False},
        {"$set": {"is_read": True, "read_at": now_utc()}},
    )
    return APIResponse(data={"marked": int(res.modified_count)})
