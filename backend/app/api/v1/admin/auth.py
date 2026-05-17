"""Admin auth endpoint — login + refresh + logout (with mandatory 2FA, API-key + IP guard).

Note: the API-key + IP guard is enforced by `get_current_admin` for protected
routes. The login endpoint itself is intentionally accessible without a key —
otherwise no one could log in. We rely on rate-limiting + correct credentials
+ mandatory 2FA + audit logging to harden it.
"""

from __future__ import annotations

from fastapi import APIRouter, Request, status

from app.core.dependencies import CurrentAdmin
from app.core.exceptions import InvalidCredentialsError
from app.core.rate_limit import rate_limit
from app.models.audit_log import AuditAction
from app.models.user import User, UserRole
from app.schemas.admin.auth import AdminLoginRequest, AdminTokenPair, AdminUserOut
from app.schemas.auth import LogoutRequest, RefreshRequest, TokenPair
from app.schemas.common import APIResponse, OkResponse
from app.services import auth_service

router = APIRouter(prefix="/auth", tags=["admin-auth"])


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "0.0.0.0"


@router.post(
    "/login",
    response_model=APIResponse[AdminTokenPair],
    status_code=status.HTTP_200_OK,
    dependencies=[rate_limit("auth")],
)
async def admin_login(payload: AdminLoginRequest, request: Request):
    pair: TokenPair = await auth_service.authenticate(
        identifier=payload.identifier,
        password=payload.password,
        two_fa_code=payload.two_fa_code,
        audience="admin",
        ip=_client_ip(request),
        user_agent=request.headers.get("user-agent"),
    )
    if pair.user.role not in {
        UserRole.SUPER_ADMIN.value,
        UserRole.ADMIN.value,
        UserRole.BROKER.value,
    }:
        raise InvalidCredentialsError()

    admin_user = await User.get(pair.user.id)
    if admin_user is None:
        raise InvalidCredentialsError()

    return APIResponse(
        data=AdminTokenPair(
            access_token=pair.access_token,
            refresh_token=pair.refresh_token,
            expires_in=pair.expires_in,
            admin=AdminUserOut(
                id=pair.user.id,
                user_code=pair.user.user_code,
                email=pair.user.email,
                full_name=pair.user.full_name,
                role=pair.user.role,
                last_login_at=None,
                admin_permissions=admin_user.admin_permissions,
                pnl_share_pct=(
                    str(admin_user.pnl_share_pct)
                    if admin_user.pnl_share_pct is not None
                    else None
                ),
                broker_permissions=admin_user.broker_permissions,
                assigned_broker_id=(
                    str(admin_user.assigned_broker_id)
                    if admin_user.assigned_broker_id
                    else None
                ),
            ),
        )
    )


@router.post("/refresh", response_model=APIResponse[AdminTokenPair])
async def admin_refresh(payload: RefreshRequest):
    pair = await auth_service.refresh_tokens(payload.refresh_token)
    if pair.user.role not in {
        UserRole.SUPER_ADMIN.value,
        UserRole.ADMIN.value,
        UserRole.BROKER.value,
    }:
        raise InvalidCredentialsError()
    admin_user = await User.get(pair.user.id)
    if admin_user is None:
        raise InvalidCredentialsError()
    return APIResponse(
        data=AdminTokenPair(
            access_token=pair.access_token,
            refresh_token=pair.refresh_token,
            expires_in=pair.expires_in,
            admin=AdminUserOut(
                id=pair.user.id,
                user_code=pair.user.user_code,
                email=pair.user.email,
                full_name=pair.user.full_name,
                role=pair.user.role,
                admin_permissions=admin_user.admin_permissions,
                pnl_share_pct=(
                    str(admin_user.pnl_share_pct)
                    if admin_user.pnl_share_pct is not None
                    else None
                ),
                broker_permissions=admin_user.broker_permissions,
                assigned_broker_id=(
                    str(admin_user.assigned_broker_id)
                    if admin_user.assigned_broker_id
                    else None
                ),
            ),
        )
    )


@router.post("/logout", response_model=APIResponse[OkResponse])
async def admin_logout(payload: LogoutRequest, admin: CurrentAdmin):
    from app.services.audit_service import log_event

    await auth_service.logout(refresh_token=payload.refresh_token, user_id=str(admin.id))
    await log_event(action=AuditAction.LOGOUT, entity_type="User", entity_id=admin.id, actor_id=admin.id)
    return APIResponse(data=OkResponse(message="Admin logged out"))


@router.get("/me", response_model=APIResponse[AdminUserOut])
async def admin_me(admin: CurrentAdmin):
    return APIResponse(
        data=AdminUserOut(
            id=str(admin.id),
            user_code=admin.user_code,
            email=admin.email,
            full_name=admin.full_name,
            role=admin.role.value,
            last_login_at=admin.last_login_at.isoformat() if admin.last_login_at else None,
            admin_permissions=admin.admin_permissions,
            broker_permissions=admin.broker_permissions,
            pnl_share_pct=(
                str(admin.pnl_share_pct) if admin.pnl_share_pct is not None else None
            ),
            assigned_broker_id=(
                str(admin.assigned_broker_id) if admin.assigned_broker_id else None
            ),
        )
    )
