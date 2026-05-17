"""User profile endpoint — /api/v1/user/users/me."""

from __future__ import annotations

from fastapi import APIRouter

from app.core.dependencies import CurrentUser
from app.schemas.common import APIResponse
from app.schemas.user import UpdateProfileRequest, UserMeOut

router = APIRouter(prefix="/users", tags=["user-profile"])


@router.get("/me", response_model=APIResponse[UserMeOut])
async def get_me(user: CurrentUser):
    return APIResponse(data=_user_to_me(user))


@router.put("/me", response_model=APIResponse[UserMeOut])
async def update_me(payload: UpdateProfileRequest, user: CurrentUser):
    if payload.full_name is not None:
        user.full_name = payload.full_name
    if payload.photo_url is not None:
        user.photo_url = payload.photo_url
    if payload.communication is not None:
        user.communication = payload.communication
    if payload.kyc is not None:
        # Only allow updating non-verified KYC fields
        if not user.kyc.is_verified:
            user.kyc = payload.kyc
    await user.save()
    return APIResponse(data=_user_to_me(user))


def _user_to_me(user) -> UserMeOut:
    return UserMeOut(
        id=str(user.id),
        user_code=user.user_code,
        email=user.email,
        mobile=user.mobile,
        full_name=user.full_name,
        photo_url=user.photo_url,
        role=user.role,
        status=user.status,
        account_type=user.account_type,
        is_demo=user.is_demo,
        parent_id=str(user.parent_id) if user.parent_id else None,
        kyc=user.kyc,
        permissions=user.permissions,
        trading_hours=user.trading_hours,
        risk=user.risk,
        communication=user.communication,
        two_fa_enabled=user.two_fa_enabled,
        last_login_at=user.last_login_at,
        created_at=user.created_at,
    )
