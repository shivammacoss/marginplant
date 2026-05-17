"""User auth endpoints — register, login, refresh, logout, 2FA, password reset."""

from __future__ import annotations

from fastapi import APIRouter, Request, status

from app.core.dependencies import CurrentUser
from app.core.exceptions import (
    InvalidCredentialsError,
    NotFoundError,
    ValidationFailedError,
)
from app.core.rate_limit import rate_limit
from app.models.audit_log import AuditAction
from app.models.user import UserStatus
from app.schemas.auth import (
    AuthUserOut,
    ChangePasswordRequest,
    ForgotPasswordRequest,
    LoginRequest,
    LogoutRequest,
    OtpRequest,
    OtpVerifyRequest,
    RefreshRequest,
    RegisterRequest,
    ResetPasswordRequest,
    TokenPair,
    TwoFADisableRequest,
    TwoFAEnableRequest,
    TwoFASetupResponse,
)
from app.schemas.common import APIResponse, OkResponse
from app.services import auth_service, user_service
from app.services.audit_service import log_event
from app.utils.otp import issue_otp, verify_otp

router = APIRouter(prefix="/auth", tags=["user-auth"])


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "0.0.0.0"


@router.post(
    "/register",
    response_model=APIResponse[AuthUserOut],
    status_code=status.HTTP_201_CREATED,
    dependencies=[rate_limit("auth")],
)
async def register(payload: RegisterRequest, request: Request):
    user = await user_service.create_user(
        email=payload.email,
        mobile=payload.mobile,
        password=payload.password,
        full_name=payload.full_name,
        status=UserStatus.ACTIVE,  # for self-register; admin flow can set PENDING
    )
    await log_event(
        action=AuditAction.CREATE,
        entity_type="User",
        entity_id=user.id,
        actor_id=user.id,
        ip_address=_client_ip(request),
        user_agent=request.headers.get("user-agent"),
    )
    return APIResponse(
        data=AuthUserOut(
            id=str(user.id),
            user_code=user.user_code,
            email=user.email,
            mobile=user.mobile,
            full_name=user.full_name,
            role=user.role.value,
            status=user.status.value,
            is_demo=user.is_demo,
            two_fa_enabled=user.two_fa_enabled,
            must_change_password=user.must_change_password,
        ),
        message="Registered successfully. Please log in.",
    )


@router.post(
    "/login",
    response_model=APIResponse[TokenPair],
    dependencies=[rate_limit("auth")],
)
async def login(payload: LoginRequest, request: Request):
    pair = await auth_service.authenticate(
        identifier=payload.identifier,
        password=payload.password,
        two_fa_code=payload.two_fa_code,
        audience="user",
        ip=_client_ip(request),
        user_agent=request.headers.get("user-agent"),
    )
    await log_event(
        action=AuditAction.LOGIN,
        entity_type="User",
        entity_id=pair.user.id,
        actor_id=pair.user.id,
        ip_address=_client_ip(request),
        user_agent=request.headers.get("user-agent"),
    )
    return APIResponse(data=pair)


@router.post("/refresh", response_model=APIResponse[TokenPair])
async def refresh(payload: RefreshRequest):
    pair = await auth_service.refresh_tokens(payload.refresh_token)
    return APIResponse(data=pair)


@router.post("/logout", response_model=APIResponse[OkResponse])
async def logout(payload: LogoutRequest, user: CurrentUser, request: Request):
    await auth_service.logout(refresh_token=payload.refresh_token, user_id=str(user.id))
    await log_event(
        action=AuditAction.LOGOUT,
        entity_type="User",
        entity_id=user.id,
        actor_id=user.id,
        ip_address=_client_ip(request),
    )
    return APIResponse(data=OkResponse(message="Logged out"))


# ── OTP (used by register, forgot-password) ──────────────────────────
@router.post(
    "/otp/request",
    response_model=APIResponse[OkResponse],
    dependencies=[rate_limit("auth")],
)
async def request_otp(payload: OtpRequest):
    if payload.purpose not in {"register", "login", "reset_password", "withdrawal"}:
        raise ValidationFailedError("Invalid OTP purpose")
    code = await issue_otp(payload.purpose, payload.identifier.lower().strip())  # type: ignore[arg-type]
    # In production this would be sent via SMS/email. We return it for dev only.
    return APIResponse(
        data=OkResponse(message=f"OTP sent (dev: {code})"),  # remove in prod
    )


@router.post(
    "/otp/verify",
    response_model=APIResponse[OkResponse],
    dependencies=[rate_limit("auth")],
)
async def verify_otp_endpoint(payload: OtpVerifyRequest):
    ok = await verify_otp(payload.purpose, payload.identifier.lower().strip(), payload.code)  # type: ignore[arg-type]
    if not ok:
        raise InvalidCredentialsError("Invalid or expired OTP")
    return APIResponse(data=OkResponse(message="OTP verified"))


# ── Forgot / reset ────────────────────────────────────────────────────
@router.post(
    "/forgot-password",
    response_model=APIResponse[OkResponse],
    dependencies=[rate_limit("auth")],
)
async def forgot_password(payload: ForgotPasswordRequest):
    user = await user_service.find_by_identifier(payload.identifier)
    # Don't reveal whether the account exists
    if user:
        await issue_otp("reset_password", user.email)
    return APIResponse(data=OkResponse(message="If an account exists, a reset code has been sent"))


@router.post(
    "/reset-password",
    response_model=APIResponse[OkResponse],
    dependencies=[rate_limit("auth")],
)
async def reset_password(payload: ResetPasswordRequest, request: Request):
    user = await user_service.find_by_identifier(payload.identifier)
    if user is None:
        raise NotFoundError("Account not found")
    ok = await verify_otp("reset_password", user.email, payload.otp)
    if not ok:
        raise InvalidCredentialsError("Invalid or expired reset code")
    await auth_service.reset_password(user, new_password=payload.new_password)
    await log_event(
        action=AuditAction.PASSWORD_RESET,
        entity_type="User",
        entity_id=user.id,
        actor_id=user.id,
        ip_address=_client_ip(request),
    )
    return APIResponse(data=OkResponse(message="Password updated"))


@router.post("/change-password", response_model=APIResponse[OkResponse])
async def change_password(payload: ChangePasswordRequest, user: CurrentUser, request: Request):
    await auth_service.change_password(user, current=payload.current_password, new=payload.new_password)
    await log_event(
        action=AuditAction.PASSWORD_CHANGE,
        entity_type="User",
        entity_id=user.id,
        actor_id=user.id,
        ip_address=_client_ip(request),
    )
    return APIResponse(data=OkResponse(message="Password updated"))


# ── 2FA ───────────────────────────────────────────────────────────────
@router.post("/2fa/setup", response_model=APIResponse[TwoFASetupResponse])
async def two_fa_setup(user: CurrentUser):
    secret, uri = await auth_service.begin_2fa_setup(user)
    return APIResponse(data=TwoFASetupResponse(secret=secret, provisioning_uri=uri))


@router.post("/2fa/enable", response_model=APIResponse[OkResponse])
async def two_fa_enable(payload: TwoFAEnableRequest, user: CurrentUser):
    backup = await auth_service.confirm_2fa(user, payload.code)
    return APIResponse(
        data=OkResponse(message=f"2FA enabled. Backup codes: {', '.join(backup)}"),
    )


@router.post("/2fa/disable", response_model=APIResponse[OkResponse])
async def two_fa_disable(payload: TwoFADisableRequest, user: CurrentUser):
    await auth_service.disable_2fa(user, password=payload.password, code=payload.code)
    return APIResponse(data=OkResponse(message="2FA disabled"))
