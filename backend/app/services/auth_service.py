"""Authentication service — login, refresh, logout, 2FA flows.

Refresh tokens are stored as a Redis allow-list keyed by JTI; logout deletes
the JTI; rotation issues a new JTI and revokes the old one. This gives us
revocability without per-request DB hits.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
from typing import Literal

from app.core.config import settings
from app.core.exceptions import (
    AccountBlockedError,
    AccountInactiveError,
    InvalidCredentialsError,
    TokenInvalidError,
    TwoFAInvalidError,
    TwoFARequiredError,
)
from app.core.redis_client import cache_set, get_redis
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    generate_totp_secret,
    hash_password,
    needs_rehash,
    refresh_jti_key,
    session_key,
    totp_provisioning_uri,
    verify_password,
    verify_totp,
)
from app.models.user import User, UserRole, UserStatus
from app.schemas.auth import AuthUserOut, TokenPair
from app.services import user_service
from app.utils.time_utils import now_utc

logger = logging.getLogger(__name__)

ADMIN_ROLES: set[UserRole] = {UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.BROKER}

LoginAudience = Literal["user", "admin"]

# Lockout feature is OFF — increment-only counter kept for audit / future
# re-enable. To re-introduce brute-force protection, set the constants
# below to positive values and uncomment the lock check in `authenticate`.
MAX_FAILED_ATTEMPTS = 0  # 0 = never lock
LOCKOUT_MINUTES = 0


# ── Failed-login tracking (lockout disabled) ─────────────────────────
async def _register_failed_attempt(user: User) -> None:
    user.failed_login_count = (user.failed_login_count or 0) + 1
    # Intentionally NOT setting locked_until — lockout disabled per project
    # decision (UX over brute-force-protection on the admin login).
    await user.save()


def _is_locked(_user: User) -> bool:
    # Lockout disabled — always returns False so authenticate() never
    # rejects with "Account temporarily locked". The field stays in the
    # model so admin-side unlock tooling and existing data still work.
    return False


# ── Login ────────────────────────────────────────────────────────────
async def authenticate(
    *,
    identifier: str,
    password: str,
    two_fa_code: str | None,
    audience: LoginAudience,
    ip: str,
    user_agent: str | None,
) -> TokenPair:
    user = await user_service.find_by_identifier(identifier)
    if user is None:
        raise InvalidCredentialsError()

    if user.status == UserStatus.BLOCKED:
        raise AccountBlockedError()
    if user.status != UserStatus.ACTIVE:
        raise AccountInactiveError()

    if _is_locked(user):
        raise AccountBlockedError(
            "Account temporarily locked due to too many failed attempts. Try again later."
        )

    # Audience guard — admin endpoint only allows admin roles
    if audience == "admin" and user.role not in ADMIN_ROLES:
        raise InvalidCredentialsError()

    # Password
    if not verify_password(password, user.password_hash):
        await _register_failed_attempt(user)
        raise InvalidCredentialsError()

    # Re-hash if the bcrypt cost has been raised
    if needs_rehash(user.password_hash):
        user.password_hash = hash_password(password)

    # 2FA — only enforced when the user has explicitly enabled it on their account.
    # (Spec previously required mandatory 2FA for admins; relaxed per project decision.)
    if user.two_fa_enabled:
        if not two_fa_code:
            raise TwoFARequiredError()
        if not user.two_fa_secret or not verify_totp(user.two_fa_secret, two_fa_code):
            await _register_failed_attempt(user)
            raise TwoFAInvalidError()

    # Mint tokens
    access = create_access_token(user_id=user.id, role=user.role.value)
    refresh, jti = create_refresh_token(user_id=user.id, role=user.role.value)

    # Store JTI in Redis (allow-list) + session record + bump user's
    # last-login fields — all three are independent writes, so run them
    # concurrently instead of awaiting one-by-one. The refresh-token JTI
    # write is the only one that MUST land before we return (otherwise the
    # next request can't refresh); the session/audit row and user.save are
    # nice-to-have audit metadata.
    user.record_successful_login(ip)
    await asyncio.gather(
        cache_set(
            refresh_jti_key(str(user.id), jti),
            {"user_id": str(user.id), "audience": audience, "ip": ip, "ua": user_agent},
            ttl_sec=settings.JWT_REFRESH_TTL_DAYS * 86400,
        ),
        cache_set(
            session_key(str(user.id), jti),
            {"audience": audience, "ip": ip, "ua": user_agent, "issued_at": now_utc().isoformat()},
            ttl_sec=settings.JWT_REFRESH_TTL_DAYS * 86400,
        ),
        user.save(),
    )

    return TokenPair(
        access_token=access,
        refresh_token=refresh,
        expires_in=settings.JWT_ACCESS_TTL_MIN * 60,
        user=_user_to_auth_out(user),
    )


def _user_to_auth_out(user: User) -> AuthUserOut:
    return AuthUserOut(
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
        admin_permissions=user.admin_permissions,
        pnl_share_pct=(
            str(user.pnl_share_pct) if user.pnl_share_pct is not None else None
        ),
        broker_permissions=user.broker_permissions,
        assigned_broker_id=(
            str(user.assigned_broker_id) if user.assigned_broker_id else None
        ),
    )


# ── Refresh ──────────────────────────────────────────────────────────
async def refresh_tokens(refresh_token: str) -> TokenPair:
    payload = decode_token(refresh_token, expected_type="refresh")
    user_id = payload.get("sub")
    jti = payload.get("jti")
    if not user_id or not jti:
        raise TokenInvalidError()

    r = get_redis()
    key = refresh_jti_key(user_id, jti)
    if not await r.exists(key):
        raise TokenInvalidError("Refresh token has been revoked")

    # Rotate: delete the old jti, mint a new one
    await r.delete(key, session_key(user_id, jti))

    user = await user_service.get_user_or_404(user_id)
    if user.status != UserStatus.ACTIVE:
        raise AccountInactiveError()

    access = create_access_token(user_id=user.id, role=user.role.value)
    new_refresh, new_jti = create_refresh_token(user_id=user.id, role=user.role.value)
    await cache_set(
        refresh_jti_key(str(user.id), new_jti),
        {"user_id": str(user.id), "rotated_from": jti},
        ttl_sec=settings.JWT_REFRESH_TTL_DAYS * 86400,
    )

    return TokenPair(
        access_token=access,
        refresh_token=new_refresh,
        expires_in=settings.JWT_ACCESS_TTL_MIN * 60,
        user=_user_to_auth_out(user),
    )


# ── Logout ───────────────────────────────────────────────────────────
async def logout(*, refresh_token: str | None, user_id: str | None = None) -> None:
    """Revoke the JTI tied to this refresh token (if provided), else all of user's sessions."""
    r = get_redis()
    if refresh_token:
        try:
            payload = decode_token(refresh_token, expected_type="refresh")
            jti = payload.get("jti")
            sub = payload.get("sub")
            if jti and sub:
                await r.delete(refresh_jti_key(sub, jti), session_key(sub, jti))
                return
        except Exception:
            pass
    if user_id:
        # Best-effort: scan-delete all of this user's sessions. Detach into a
        # background task so the /logout response returns immediately instead
        # of waiting on Redis SCAN cursors (was adding ~50-150ms on users
        # with multiple active devices).
        async def _purge() -> None:
            try:
                async for key in r.scan_iter(match=f"refresh_jti:{user_id}:*", count=200):
                    await r.delete(key)
                async for key in r.scan_iter(match=f"session:{user_id}:*", count=200):
                    await r.delete(key)
            except Exception:  # noqa: BLE001 — best-effort cleanup
                logger.exception("session purge failed for user %s", user_id)

        asyncio.create_task(_purge())


# ── 2FA setup ─────────────────────────────────────────────────────────
async def begin_2fa_setup(user: User) -> tuple[str, str]:
    secret = generate_totp_secret()
    user.two_fa_secret = secret
    user.two_fa_enabled = False
    await user.save()
    uri = totp_provisioning_uri(secret, account_name=user.email, issuer="SetupFX Broker")
    return secret, uri


async def confirm_2fa(user: User, code: str) -> list[str]:
    if not user.two_fa_secret:
        raise TwoFAInvalidError("2FA setup has not been started")
    if not verify_totp(user.two_fa_secret, code):
        raise TwoFAInvalidError()
    user.two_fa_enabled = True
    user.two_fa_backup_codes = [secrets.token_hex(4).upper() for _ in range(8)]
    await user.save()
    return user.two_fa_backup_codes


async def disable_2fa(user: User, *, password: str, code: str) -> None:
    if not verify_password(password, user.password_hash):
        raise InvalidCredentialsError()
    if user.role in ADMIN_ROLES:
        raise InvalidCredentialsError("Admin accounts may not disable 2FA")
    if not user.two_fa_secret or not verify_totp(user.two_fa_secret, code):
        raise TwoFAInvalidError()
    user.two_fa_enabled = False
    user.two_fa_secret = None
    user.two_fa_backup_codes = []
    await user.save()


# ── Password change / reset ──────────────────────────────────────────
async def change_password(user: User, *, current: str, new: str) -> None:
    if not verify_password(current, user.password_hash):
        raise InvalidCredentialsError()
    user.password_hash = hash_password(new)
    user.password_changed_at = now_utc()
    user.must_change_password = False
    await user.save()


async def reset_password(user: User, *, new_password: str) -> None:
    user.password_hash = hash_password(new_password)
    user.password_changed_at = now_utc()
    user.must_change_password = False
    user.failed_login_count = 0
    user.locked_until = None
    await user.save()
    # Invalidate all existing sessions
    await logout(refresh_token=None, user_id=str(user.id))
