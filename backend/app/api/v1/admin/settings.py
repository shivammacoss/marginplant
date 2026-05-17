"""Admin platform settings + holidays + backup/EOD + audit logs."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, Query

from app.core.dependencies import CurrentAdmin
from app.models._base import Exchange
from app.models.audit_log import AuditAction, AuditLog
from app.models.holiday import TradingHoliday
from app.models.platform_setting import PlatformSetting, SettingType
from app.schemas.admin.common import UpdatePlatformSettingRequest
from app.schemas.common import APIResponse
from app.services.audit_service import log_event

router = APIRouter(tags=["admin-settings"])


# ── Platform settings ────────────────────────────────────────────────
@router.get("/settings/platform", response_model=APIResponse[list])
async def list_platform_settings(admin: CurrentAdmin, category: str | None = None):
    q: dict[str, Any] = {}
    if category:
        q["category"] = category
    rows = await PlatformSetting.find(q).sort("category", "setting_key").to_list()
    return APIResponse(
        data=[
            {
                "key": r.setting_key,
                "value": r.setting_value,
                "type": r.setting_type.value,
                "description": r.description,
                "category": r.category,
                "is_public": r.is_public,
            }
            for r in rows
        ]
    )


@router.put("/settings/platform/{key:path}", response_model=APIResponse[dict])
async def update_platform_setting(key: str, payload: UpdatePlatformSettingRequest, admin: CurrentAdmin):
    s = await PlatformSetting.find_one(PlatformSetting.setting_key == key)
    if s is None:
        raise HTTPException(status_code=404, detail="Setting not found")
    s.setting_value = payload.setting_value
    await s.save()
    await log_event(
        action=AuditAction.SETTING_CHANGE,
        entity_type="PlatformSetting",
        entity_id=key,
        actor_id=admin.id,
        new_values={"value": payload.setting_value},
    )
    return APIResponse(data={"ok": True})


# ── Holidays ────────────────────────────────────────────────────────
@router.get("/holidays", response_model=APIResponse[list])
async def list_holidays(admin: CurrentAdmin, year: int | None = None):
    q: dict[str, Any] = {}
    if year:
        q["holiday_date"] = {"$gte": date(year, 1, 1), "$lte": date(year, 12, 31)}
    rows = await TradingHoliday.find(q).sort("holiday_date").to_list()
    return APIResponse(
        data=[
            {
                "id": str(h.id),
                "holiday_date": h.holiday_date.isoformat(),
                "exchange": str(h.exchange),
                "description": h.description,
                "is_full_day": h.is_full_day,
                "is_muhurat": h.is_muhurat,
            }
            for h in rows
        ]
    )


@router.post("/holidays", response_model=APIResponse[dict])
async def create_holiday(payload: dict, admin: CurrentAdmin):
    h = TradingHoliday(
        holiday_date=date.fromisoformat(payload["holiday_date"]),
        exchange=Exchange(payload.get("exchange", "NSE")),
        description=payload.get("description", "Holiday"),
        is_full_day=bool(payload.get("is_full_day", True)),
        is_muhurat=bool(payload.get("is_muhurat", False)),
    )
    await h.insert()
    return APIResponse(data={"id": str(h.id)})


@router.delete("/holidays/{holiday_id}", response_model=APIResponse[dict])
async def delete_holiday(holiday_id: str, admin: CurrentAdmin):
    h = await TradingHoliday.get(PydanticObjectId(holiday_id))
    if h is None:
        raise HTTPException(status_code=404, detail="Holiday not found")
    await h.delete()
    return APIResponse(data={"ok": True})


# ── Audit ───────────────────────────────────────────────────────────
@router.get("/audit/logs", response_model=APIResponse[dict])
async def list_audit(
    admin: CurrentAdmin,
    user_id: str | None = None,
    target_user_id: str | None = None,
    involving_user_id: str | None = None,
    action: str | None = None,
    entity_type: str | None = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, le=200),
):
    q: dict[str, Any] = {}
    if user_id:
        q["user_id"] = PydanticObjectId(user_id)
    if target_user_id:
        q["target_user_id"] = PydanticObjectId(target_user_id)
    if involving_user_id:
        # Surface events where this user is EITHER the actor or the
        # subject — drives the user-detail "Activity" view, which used
        # to filter on target_user_id alone and miss every event the
        # user themselves initiated (logins, order placements, etc).
        oid = PydanticObjectId(involving_user_id)
        q["$or"] = [{"user_id": oid}, {"target_user_id": oid}]
    if action:
        q["action"] = action
    if entity_type:
        q["entity_type"] = entity_type
    total = await AuditLog.find(q).count()
    rows = (
        await AuditLog.find(q).sort("-created_at").skip((page - 1) * page_size).limit(page_size).to_list()
    )
    return APIResponse(
        data={
            "items": [
                {
                    "id": str(r.id),
                    "user_id": str(r.user_id) if r.user_id else None,
                    "target_user_id": str(r.target_user_id) if r.target_user_id else None,
                    "action": r.action.value,
                    "entity_type": r.entity_type,
                    "entity_id": r.entity_id,
                    "old_values": r.old_values,
                    "new_values": r.new_values,
                    "metadata": r.metadata,
                    "ip_address": r.ip_address,
                    "user_agent": r.user_agent,
                    "created_at": r.created_at,
                }
                for r in rows
            ],
            "meta": {
                "page": page,
                "page_size": page_size,
                "total": total,
                "total_pages": (total + page_size - 1) // page_size,
            },
        }
    )


# ── Backup / EOD ────────────────────────────────────────────────────
@router.get("/backup/list", response_model=APIResponse[list])
async def list_backups(admin: CurrentAdmin):
    # Phase 7 ships actual S3-backed backups; for now we return audit-log entries marked as BACKUP
    rows = await AuditLog.find(AuditLog.action == AuditAction.BACKUP).sort("-created_at").limit(50).to_list()
    return APIResponse(
        data=[
            {
                "id": str(r.id),
                "created_at": r.created_at,
                "metadata": r.metadata,
                "actor_id": str(r.user_id) if r.user_id else None,
            }
            for r in rows
        ]
    )


@router.post("/backup/run", response_model=APIResponse[dict])
async def run_backup(admin: CurrentAdmin):
    """Stub — records a backup audit event. Phase 7 wires actual S3 dump."""
    await log_event(
        action=AuditAction.BACKUP,
        entity_type="System",
        entity_id="manual",
        actor_id=admin.id,
        metadata={"trigger": "manual", "ts": datetime.utcnow().isoformat()},
    )
    return APIResponse(data={"ok": True, "queued_at": datetime.utcnow().isoformat()})


@router.post("/backup/eod-reset", response_model=APIResponse[dict])
async def eod_reset(admin: CurrentAdmin):
    """Stub — Phase 7 wires real EOD: squareoff MIS, settle, update holdings, clear day counters.
    For now records the audit event."""
    await log_event(
        action=AuditAction.EOD_RESET,
        entity_type="System",
        entity_id="eod",
        actor_id=admin.id,
        metadata={"ts": datetime.utcnow().isoformat()},
    )
    return APIResponse(data={"ok": True})
