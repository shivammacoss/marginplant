"""P&L Sharing API — agreements (Phase A).

Settlements + reports endpoints will be added in subsequent tasks.

All endpoints under /api/v1/admin/pnl-sharing/*. Role scoping enforced inside
each handler:
  - SUPER_ADMIN: god mode (sees and edits all)
  - ADMIN: own agreements only
  - BROKER: own agreement only, read-only
"""

from __future__ import annotations

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, Query, status

from app.core.dependencies import CurrentAdmin
from app.models.pnl_sharing import (
    AgreementStatus,
    PnlSharingAgreement,
)
from app.models.user import User, UserRole
from app.schemas.common import APIResponse
from app.schemas.pnl_sharing import (
    AgreementDTO,
    CreateAgreementRequest,
    UpdateAgreementRequest,
)
from app.services import pnl_sharing_service as svc

router = APIRouter(prefix="/pnl-sharing", tags=["pnl-sharing"])


def _can_edit(actor: User, agreement: PnlSharingAgreement) -> bool:
    if actor.role == UserRole.SUPER_ADMIN:
        return True
    if actor.role == UserRole.ADMIN and agreement.admin_id == actor.id:
        return True
    return False


def _can_view(actor: User, agreement: PnlSharingAgreement) -> bool:
    if actor.role == UserRole.SUPER_ADMIN:
        return True
    if actor.role == UserRole.ADMIN and agreement.admin_id == actor.id:
        return True
    if actor.role == UserRole.BROKER and agreement.broker_id == actor.id:
        return True
    return False


async def _serialize_agreement(a: PnlSharingAgreement) -> AgreementDTO:
    admin = await User.get(a.admin_id)
    broker = await User.get(a.broker_id)
    return AgreementDTO(
        id=str(a.id),
        admin_id=str(a.admin_id),
        admin_name=admin.full_name if admin else None,
        admin_user_code=admin.user_code if admin else None,
        broker_id=str(a.broker_id),
        broker_name=broker.full_name if broker else None,
        broker_user_code=broker.user_code if broker else None,
        share_pct=str(a.share_pct),
        settlement_mode=a.settlement_mode,
        settlement_cadence=a.settlement_cadence,
        status=a.status,
        effective_from=a.effective_from,
        effective_until=a.effective_until,
        created_at=a.created_at,
        updated_at=a.updated_at,
    )


@router.get("/agreements", response_model=APIResponse[list[AgreementDTO]])
async def list_agreements(
    actor: CurrentAdmin,
    status_filter: AgreementStatus | None = Query(default=None, alias="status"),
    admin_id: PydanticObjectId | None = Query(default=None),
    broker_id: PydanticObjectId | None = Query(default=None),
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=200),
):
    rows = await svc.list_agreements_for_actor(
        actor=actor, status=status_filter,
        admin_id=admin_id, broker_id=broker_id,
        skip=skip, limit=limit,
    )
    dtos = [await _serialize_agreement(a) for a in rows]
    return APIResponse(data=dtos)


@router.post("/agreements", response_model=APIResponse[AgreementDTO])
async def create_agreement(body: CreateAgreementRequest, actor: CurrentAdmin):
    if actor.role == UserRole.ADMIN and body.admin_id != actor.id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "cannot create for another admin"
        )
    if actor.role == UserRole.BROKER:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "broker cannot create agreement")
    try:
        a = await svc.create_agreement(
            actor=actor,
            admin_id=body.admin_id,
            broker_id=body.broker_id,
            share_pct=body.share_pct,
            settlement_mode=body.settlement_mode,
            settlement_cadence=body.settlement_cadence,
        )
    except svc.AgreementConflict as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e))
    except svc.AgreementValidationError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    return APIResponse(data=await _serialize_agreement(a))


@router.get("/agreements/{agreement_id}", response_model=APIResponse[AgreementDTO])
async def get_agreement(agreement_id: PydanticObjectId, actor: CurrentAdmin):
    a = await PnlSharingAgreement.get(agreement_id)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "agreement not found")
    if not _can_view(actor, a):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no access")
    return APIResponse(data=await _serialize_agreement(a))


@router.patch("/agreements/{agreement_id}", response_model=APIResponse[AgreementDTO])
async def update_agreement_endpoint(
    agreement_id: PydanticObjectId,
    body: UpdateAgreementRequest,
    actor: CurrentAdmin,
):
    a = await PnlSharingAgreement.get(agreement_id)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "agreement not found")
    if not _can_edit(actor, a):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no edit access")
    try:
        updated = await svc.update_agreement(
            actor=actor,
            agreement_id=agreement_id,
            share_pct=body.share_pct,
            settlement_mode=body.settlement_mode,
            settlement_cadence=body.settlement_cadence,
        )
    except svc.AgreementValidationError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    return APIResponse(data=await _serialize_agreement(updated))


@router.post("/agreements/{agreement_id}/pause", response_model=APIResponse[AgreementDTO])
async def pause_endpoint(agreement_id: PydanticObjectId, actor: CurrentAdmin):
    a = await PnlSharingAgreement.get(agreement_id)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "agreement not found")
    if not _can_edit(actor, a):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no edit access")
    try:
        updated = await svc.pause_agreement(actor=actor, agreement_id=agreement_id)
    except svc.AgreementValidationError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    return APIResponse(data=await _serialize_agreement(updated))


@router.post("/agreements/{agreement_id}/resume", response_model=APIResponse[AgreementDTO])
async def resume_endpoint(agreement_id: PydanticObjectId, actor: CurrentAdmin):
    a = await PnlSharingAgreement.get(agreement_id)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "agreement not found")
    if not _can_edit(actor, a):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no edit access")
    try:
        updated = await svc.resume_agreement(actor=actor, agreement_id=agreement_id)
    except svc.AgreementValidationError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    return APIResponse(data=await _serialize_agreement(updated))


@router.post("/agreements/{agreement_id}/end", response_model=APIResponse[AgreementDTO])
async def end_endpoint(agreement_id: PydanticObjectId, actor: CurrentAdmin):
    a = await PnlSharingAgreement.get(agreement_id)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "agreement not found")
    if not _can_edit(actor, a):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no edit access")
    try:
        updated = await svc.end_agreement(actor=actor, agreement_id=agreement_id)
    except svc.AgreementValidationError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    return APIResponse(data=await _serialize_agreement(updated))
