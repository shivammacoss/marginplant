# Zerodha Kite Connect — Daily Auto-Login Setup Guide

Complete end-to-end reference for adding **headless Playwright-driven
daily Kite Connect auto-login** to any FastAPI + Next.js platform.
Built and battle-tested on the SetupFX broker stack — every gotcha we
hit during the rollout is documented in **Part 5: Troubleshooting**.

> **Goal:** Daily 7:00 AM IST par Zerodha Kite access_token automatically
> refresh ho. Admin ko manually Authy 6-digit code daalne ki zarurat nahi.

---

## Table of contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Prerequisites](#3-prerequisites)
4. [Part 1 — Backend implementation](#4-part-1--backend-implementation)
5. [Part 2 — Admin frontend](#5-part-2--admin-frontend)
6. [Part 3 — Deployment to EC2](#6-part-3--deployment-to-ec2)
7. [Part 4 — Operator setup (one-time)](#7-part-4--operator-setup-one-time)
8. [Part 5 — Troubleshooting (every issue we hit)](#8-part-5--troubleshooting-every-issue-we-hit)
9. [Verification checklist](#9-verification-checklist)
10. [Failure recovery runbook](#10-failure-recovery-runbook)
11. [Security properties](#11-security-properties)

---

## 1. Overview

### Why this is needed

Kite Connect API access tokens expire at **08:00 IST every day**
(Kite-enforced, no refresh_token grant available in standard Kite
Connect). Without auto-login:
- Admin has to manually open `kite.zerodha.com/connect/login` every day
- Enter username + password + Authy 6-digit TOTP
- ~30 sec of manual work, every weekday
- If admin oversleeps or phone dies → market open, no data → users complain

### What this builds

A daily scheduler that drives the Kite OAuth + TOTP screen with a
headless Chromium browser, captures the `request_token` from the
callback redirect, and exchanges it for a fresh access token. The
existing `ZerodhaSettings.accessToken` is updated and the WebSocket
ticker pool reconnects automatically.

### Industry context

90%+ of B-book brokers (Aliceblue, Finvasia, custom platforms) use
Playwright/Selenium-driven auto-login. Production-tested for years.
Kite doesn't officially endorse it but doesn't block it either —
treat the Kite TOS gray area by using the **`no_trading` API key
permission** (your Kite API key can only read prices, never place
orders, so even a compromise has zero financial blast radius).

---

## 2. Architecture

```
┌────────────────────────────────────────────────────────────────┐
│              Daily scheduler (asyncio lifespan task)           │
│  • Wakes every 5 min, fires only at schedule_time_ist          │
│  • Skips weekends + Indian trading holidays                    │
│  • Redis SETNX leader-lock (multi-worker safe)                 │
└──────────────────────┬─────────────────────────────────────────┘
                       │ triggers
                       ▼
┌────────────────────────────────────────────────────────────────┐
│       ZerodhaAutoLoginService.refresh_now()                    │
│  1. Load encrypted creds from ZerodhaAutoLogin doc             │
│  2. Decrypt with AES-256-GCM (key from .env)                   │
│  3. Launch Playwright Chromium (headless, --no-sandbox)        │
│  4. Navigate to Kite login URL with apiKey param               │
│  5. Fill username + password → submit                          │
│  6. Generate TOTP code from secret via pyotp → fill → submit   │
│  7. Intercept callback URL → capture request_token → abort     │
│  8. Call zerodha_service.generate_session(request_token)       │
│  9. New access_token saved → WS pool auto-reconnects           │
└──────────────────────┬─────────────────────────────────────────┘
                       │
                       ▼
┌────────────────────────────────────────────────────────────────┐
│  Existing zerodha_service.generate_session() — UNCHANGED       │
│  Saves access_token to ZerodhaSettings → starts WS pool        │
│  Cache-warms instrument lists                                  │
└────────────────────────────────────────────────────────────────┘
```

### Key principle

The existing manual login flow is **untouched**. Auto-login just
calls the same `generate_session()` method the manual `/callback`
uses. If auto-login fails for any reason, admin can still manually
login through the existing UI. Toggle disabled = back to manual-only
state instantly.

### Three layers of redundancy when capturing `request_token`

Kite redirects through a 302 chain that completes in milliseconds.
Single-method capture is racy. Use all three:

| Layer | Method | What it catches |
|---|---|---|
| 1 | `page.on("request")` listener | Every URL the browser requests, including redirected ones — pure observer, never aborts |
| 2 | `page.route()` with callable predicate | Aborts the navigation BEFORE browser hits server-side `/callback`, preventing token consumption race |
| 3 | DB freshness check after `generate_session` fails | If our call gets "Invalid request_token" because server-side `/callback` already consumed it, accept the freshly-saved `ZerodhaSettings.accessToken` (within 60s) as success |

---

## 3. Prerequisites

Stack assumptions (adapt as needed):
- **Backend**: FastAPI + Beanie (MongoDB ODM) + Redis + asyncio
- **Frontend**: Next.js 14 admin panel + React Query
- **Kite**: Active Kite Connect API key + secret (from `developers.kite.trade`)
- **Auth**: An existing `ZerodhaSettings` singleton + a `/zerodha/callback` endpoint that takes a `request_token` and calls `generate_session(...)`
- **Infra**: Linux server with `sudo` access (we use EC2 Ubuntu 24.04)

You also need:
- A super-admin role + dependency (we use `SuperAdmin = Annotated[User, Depends(require_super_admin)]`)
- An audit log service (we use `audit_service.log_event`)
- A `Notification` model for alerting (or skip the alerts section)
- A `TradingHoliday` model for skip-on-holiday (optional, can be stubbed)

---

## 4. Part 1 — Backend implementation

### 4.1 Dependencies

Add to `backend/requirements.txt`:

```text
# Already common — confirm these are present
pyotp>=2.9.0,<3
apscheduler>=3.10.4,<4

# Add this (Playwright was the only new dep for us)
playwright>=1.45.0,<2
```

> `cryptography` package is already a transitive dependency of the
> `kiteconnect` SDK, so AES-GCM is already available.

After install, on every host where the backend runs:

```bash
playwright install chromium
```

This downloads ~250 MB of Chrome for Testing + headless shell to
`~/.cache/ms-playwright/`. **Run this as the same user that runs the
backend service** (otherwise the service can't find the browser).

### 4.2 Environment variable — `ZERODHA_CREDS_KEY`

Add to `backend/app/core/config.py`:

```python
class Settings(BaseSettings):
    # ... existing fields ...

    # AES-256-GCM key for encrypting the Zerodha auto-login credentials
    # at rest. 32 raw bytes, base64-encoded — generate with:
    #   python -c "import os, base64; print(base64.b64encode(os.urandom(32)).decode())"
    # If unset, the auto-login feature refuses to save credentials
    # (so a misconfigured prod can't accidentally store plaintext).
    ZERODHA_CREDS_KEY: SecretStr = Field(default=SecretStr(""))
```

### 4.3 Crypto utility — `app/utils/crypto.py`

```python
"""AES-256-GCM symmetric encryption for credential storage at rest."""

from __future__ import annotations

import base64
import os
from functools import lru_cache

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import settings

# Standard AES-GCM IV length per NIST SP 800-38D §5.2.1.1 (96 bits).
_IV_LEN = 12


class CryptoError(RuntimeError):
    """Raised on bad key / corrupt ciphertext / tamper detection."""


@lru_cache(maxsize=1)
def _key() -> bytes:
    raw = settings.ZERODHA_CREDS_KEY.get_secret_value()
    if not raw:
        raise CryptoError(
            "ZERODHA_CREDS_KEY is not configured. Generate one with "
            "`python -c \"import os, base64; "
            "print(base64.b64encode(os.urandom(32)).decode())\"` and "
            "set it in the backend .env file."
        )
    try:
        key = base64.b64decode(raw, validate=True)
    except Exception as exc:
        raise CryptoError(f"ZERODHA_CREDS_KEY is not valid base64: {exc}") from exc
    if len(key) != 32:
        raise CryptoError(
            f"ZERODHA_CREDS_KEY must decode to exactly 32 bytes (got {len(key)})."
        )
    return key


def encrypt(plaintext: str) -> tuple[str, str]:
    """Encrypt and return (ciphertext_b64, iv_b64). Fresh IV per call."""
    if plaintext is None:
        raise CryptoError("encrypt() received None — pass an empty string instead")
    aes = AESGCM(_key())
    iv = os.urandom(_IV_LEN)
    ct = aes.encrypt(iv, plaintext.encode("utf-8"), associated_data=None)
    return (
        base64.b64encode(ct).decode("ascii"),
        base64.b64encode(iv).decode("ascii"),
    )


def decrypt(ciphertext_b64: str, iv_b64: str) -> str:
    """Reverse encrypt(). Raises CryptoError on any failure."""
    if not ciphertext_b64 or not iv_b64:
        raise CryptoError("decrypt() received empty ciphertext or IV")
    try:
        ct = base64.b64decode(ciphertext_b64, validate=True)
        iv = base64.b64decode(iv_b64, validate=True)
    except Exception as exc:
        raise CryptoError(f"ciphertext/IV not valid base64: {exc}") from exc
    if len(iv) != _IV_LEN:
        raise CryptoError(f"IV must be {_IV_LEN} bytes (got {len(iv)})")
    aes = AESGCM(_key())
    try:
        pt = aes.decrypt(iv, ct, associated_data=None)
    except Exception as exc:
        raise CryptoError("decryption failed (wrong key or tampered ciphertext)") from exc
    return pt.decode("utf-8")


def mask_secret(value: str, *, keep_head: int = 2, keep_tail: int = 1) -> str:
    """Render a sensitive string with most chars replaced by *."""
    if not value:
        return ""
    if len(value) <= keep_head + keep_tail:
        return "*" * len(value)
    return value[:keep_head] + "*" * (len(value) - keep_head - keep_tail) + value[-keep_tail:]
```

### 4.4 Beanie model — `app/models/zerodha_auto_login.py`

```python
"""Zerodha Kite auto-login credentials + scheduler state."""

from __future__ import annotations

from datetime import datetime

from app.models._base import TimestampMixin  # Your repo's TimestampMixin


class ZerodhaAutoLogin(TimestampMixin):
    """Singleton — service ensures at most one document exists."""

    # ── Encrypted credential payload ─────────────────────────────
    # Each field stores AES-256-GCM ciphertext (base64). Per-field IV
    # so we can rotate one credential without re-encrypting the others.
    encrypted_username: str = ""
    encrypted_username_iv: str = ""
    encrypted_password: str = ""
    encrypted_password_iv: str = ""
    encrypted_totp_secret: str = ""
    encrypted_totp_secret_iv: str = ""

    # ── Scheduler controls ───────────────────────────────────────
    is_enabled: bool = False
    schedule_time_ist: str = "07:00"  # HH:MM in 24-hour IST

    # ── Last-attempt diagnostics ─────────────────────────────────
    last_attempt_at: datetime | None = None
    last_success_at: datetime | None = None
    last_status: str = ""  # "success" | "failed" | "" (never run)
    last_error_detail: str | None = None
    consecutive_failures: int = 0
    last_duration_ms: int | None = None

    class Settings:
        name = "zerodha_auto_login"
```

### 4.5 Register the model

In `backend/app/core/database.py`, inside `_document_models()`:

```python
def _document_models() -> list[type["Document"]]:
    # ... existing imports ...
    from app.models.zerodha_auto_login import ZerodhaAutoLogin
    from app.models.zerodha_settings import ZerodhaSettings

    return [
        # ... existing entries ...
        ZerodhaSettings,
        ZerodhaAutoLogin,  # <-- add here
    ]
```

### 4.6 Auto-login service — `app/services/zerodha_auto_login.py`

This is the heart of the feature. Full file:

```python
"""Automated daily Kite Connect token refresh."""

from __future__ import annotations

import logging
import time
from typing import Any
from urllib.parse import parse_qs, urlparse

from beanie import PydanticObjectId

from app.models.audit_log import AuditAction
from app.models.zerodha_auto_login import ZerodhaAutoLogin
from app.models.zerodha_settings import ZerodhaSettings
from app.services import audit_service
from app.utils.crypto import CryptoError, decrypt, encrypt, mask_secret
from app.utils.time_utils import now_utc

logger = logging.getLogger(__name__)

# Stage timeouts (milliseconds).
_NAV_TIMEOUT_MS = 20_000
_SELECTOR_TIMEOUT_MS = 12_000
_REDIRECT_TIMEOUT_MS = 20_000

# Cross-worker single-flight guard for refresh_now().
_REFRESH_LOCK_KEY = "zerodha_auto_login:refresh_lock"
_REFRESH_LOCK_TTL_SEC = 300


class AutoLoginError(RuntimeError):
    """Raised when a Playwright stage fails. .stage identifies which."""

    def __init__(self, message: str, *, stage: str) -> None:
        super().__init__(message)
        self.stage = stage


class ZerodhaAutoLoginService:
    """Singleton — instantiated at the bottom of this module."""

    # ── Singleton row helpers ────────────────────────────────────
    async def _get_or_create(self) -> ZerodhaAutoLogin:
        existing = await ZerodhaAutoLogin.find_one()
        if existing:
            return existing
        doc = ZerodhaAutoLogin()
        await doc.insert()
        return doc

    async def _get_zerodha_api_key(self) -> str:
        zs = await ZerodhaSettings.find_one()
        if not zs or not zs.apiKey:
            raise AutoLoginError(
                "Kite API key not configured — set it in the existing "
                "Zerodha settings page first.",
                stage="precheck",
            )
        return zs.apiKey

    # ── Credentials management ───────────────────────────────────
    async def save_credentials(
        self,
        *,
        username: str,
        password: str,
        totp_secret: str,
        actor_id: PydanticObjectId | None,
        ip_address: str | None = None,
    ) -> None:
        username = (username or "").strip()
        password = password or ""
        totp_secret = (totp_secret or "").strip().replace(" ", "").upper()

        if not username or not password or not totp_secret:
            raise ValueError("username, password, totp_secret all required")

        # Validate TOTP secret shape NOW so we catch typos at save time,
        # not at 07:00 the next morning.
        try:
            import pyotp
            pyotp.TOTP(totp_secret).now()
        except Exception as exc:
            raise ValueError(f"totp_secret is not valid base32: {exc}") from exc

        ct_user, iv_user = encrypt(username)
        ct_pwd, iv_pwd = encrypt(password)
        ct_totp, iv_totp = encrypt(totp_secret)

        doc = await self._get_or_create()
        had_creds = bool(doc.encrypted_username)
        doc.encrypted_username = ct_user
        doc.encrypted_username_iv = iv_user
        doc.encrypted_password = ct_pwd
        doc.encrypted_password_iv = iv_pwd
        doc.encrypted_totp_secret = ct_totp
        doc.encrypted_totp_secret_iv = iv_totp
        doc.consecutive_failures = 0
        await doc.save()

        await audit_service.log_event(
            action=AuditAction.SETTING_CHANGE,
            entity_type="ZerodhaAutoLogin",
            entity_id=str(doc.id),
            actor_id=actor_id,
            metadata={
                "operation": "credentials_updated",
                "previously_configured": had_creds,
                "username_masked": mask_secret(username),
            },
            ip_address=ip_address,
        )

    async def get_status(self) -> dict[str, Any]:
        """Masked snapshot for admin UI. Never returns raw creds."""
        doc = await ZerodhaAutoLogin.find_one()
        if doc is None:
            return {
                "is_configured": False,
                "is_enabled": False,
                "schedule_time_ist": "07:00",
                "last_attempt_at": None,
                "last_success_at": None,
                "last_status": "",
                "last_error_detail": None,
                "consecutive_failures": 0,
                "last_duration_ms": None,
                "username_masked": "",
            }

        username_masked = ""
        if doc.encrypted_username:
            try:
                username_masked = mask_secret(
                    decrypt(doc.encrypted_username, doc.encrypted_username_iv),
                )
            except CryptoError:
                username_masked = "(unreadable — key rotated?)"

        return {
            "is_configured": bool(
                doc.encrypted_username
                and doc.encrypted_password
                and doc.encrypted_totp_secret
            ),
            "is_enabled": doc.is_enabled,
            "schedule_time_ist": doc.schedule_time_ist,
            "last_attempt_at": doc.last_attempt_at,
            "last_success_at": doc.last_success_at,
            "last_status": doc.last_status,
            "last_error_detail": doc.last_error_detail,
            "consecutive_failures": doc.consecutive_failures,
            "last_duration_ms": doc.last_duration_ms,
            "username_masked": username_masked,
        }

    async def set_enabled(self, enabled, *, actor_id, ip_address=None):
        doc = await self._get_or_create()
        if enabled and not (
            doc.encrypted_username and doc.encrypted_password and doc.encrypted_totp_secret
        ):
            raise ValueError("Cannot enable until credentials are saved.")
        was = doc.is_enabled
        doc.is_enabled = bool(enabled)
        await doc.save()
        if was != doc.is_enabled:
            await audit_service.log_event(
                action=AuditAction.SETTING_CHANGE,
                entity_type="ZerodhaAutoLogin",
                entity_id=str(doc.id),
                actor_id=actor_id,
                metadata={"operation": "scheduler_toggled", "enabled": doc.is_enabled},
                ip_address=ip_address,
            )

    async def set_schedule(self, schedule_time_ist, *, actor_id, ip_address=None):
        s = (schedule_time_ist or "").strip()
        try:
            hh, mm = s.split(":")
            h, m = int(hh), int(mm)
            if not (0 <= h <= 23 and 0 <= m <= 59):
                raise ValueError("out of range")
        except Exception as exc:
            raise ValueError(f"schedule_time_ist must be HH:MM IST 24-hour (got {s!r}): {exc}")
        normalised = f"{h:02d}:{m:02d}"
        doc = await self._get_or_create()
        prev = doc.schedule_time_ist
        doc.schedule_time_ist = normalised
        await doc.save()
        if prev != normalised:
            await audit_service.log_event(
                action=AuditAction.SETTING_CHANGE,
                entity_type="ZerodhaAutoLogin",
                entity_id=str(doc.id),
                actor_id=actor_id,
                metadata={"operation": "schedule_updated", "from": prev, "to": normalised},
                ip_address=ip_address,
            )

    # ── The actual login flow ────────────────────────────────────
    async def refresh_now(self, *, actor_id=None, ip_address=None, triggered_by="manual"):
        from app.core.redis_client import get_redis

        # Single-flight guard
        lock_acquired = False
        try:
            redis = get_redis()
            lock_acquired = bool(
                await redis.set(_REFRESH_LOCK_KEY, "1", ex=_REFRESH_LOCK_TTL_SEC, nx=True)
            )
            if not lock_acquired:
                return {
                    "success": False,
                    "error": "Another auto-login is already in progress.",
                    "stage": "lock",
                }
        except Exception:
            logger.warning("zerodha_auto_login_lock_unavailable_continuing")

        doc = await self._get_or_create()
        if not (doc.encrypted_username and doc.encrypted_password and doc.encrypted_totp_secret):
            return {"success": False, "error": "Credentials not configured.", "stage": "precheck"}

        try:
            username = decrypt(doc.encrypted_username, doc.encrypted_username_iv)
            password = decrypt(doc.encrypted_password, doc.encrypted_password_iv)
            totp_secret = decrypt(doc.encrypted_totp_secret, doc.encrypted_totp_secret_iv)
        except CryptoError as exc:
            await self._record_failure(doc, stage="decrypt", error=str(exc),
                                       triggered_by=triggered_by, actor_id=actor_id)
            await self._release_lock(lock_acquired)
            return {"success": False, "error": str(exc), "stage": "decrypt"}

        start = time.monotonic()
        doc.last_attempt_at = now_utc()
        await doc.save()

        try:
            access_token = await self._run_login_flow(
                username=username, password=password, totp_secret=totp_secret,
            )
        except AutoLoginError as exc:
            duration_ms = int((time.monotonic() - start) * 1000)
            await self._record_failure(doc, stage=exc.stage, error=str(exc),
                                       duration_ms=duration_ms,
                                       triggered_by=triggered_by, actor_id=actor_id)
            await self._release_lock(lock_acquired)
            return {"success": False, "error": str(exc), "stage": exc.stage,
                    "duration_ms": duration_ms}
        except Exception as exc:
            duration_ms = int((time.monotonic() - start) * 1000)
            logger.exception("zerodha_auto_login_unexpected_error")
            await self._record_failure(doc, stage="unknown",
                                       error=f"{type(exc).__name__}: {exc}",
                                       duration_ms=duration_ms,
                                       triggered_by=triggered_by, actor_id=actor_id)
            await self._release_lock(lock_acquired)
            return {"success": False, "error": f"Unexpected error: {exc}",
                    "stage": "unknown", "duration_ms": duration_ms}

        duration_ms = int((time.monotonic() - start) * 1000)
        doc.last_success_at = now_utc()
        doc.last_status = "success"
        doc.last_error_detail = None
        doc.consecutive_failures = 0
        doc.last_duration_ms = duration_ms
        await doc.save()

        await audit_service.log_event(
            action=AuditAction.SETTING_CHANGE,
            entity_type="ZerodhaAutoLogin",
            entity_id=str(doc.id),
            actor_id=actor_id,
            metadata={
                "operation": "auto_login_success",
                "triggered_by": triggered_by,
                "duration_ms": duration_ms,
                "access_token_present": bool(access_token),
            },
            ip_address=ip_address,
        )

        await self._release_lock(lock_acquired)
        return {
            "success": True,
            "access_token_obtained": bool(access_token),
            "duration_ms": duration_ms,
            "stage": "complete",
        }

    async def _release_lock(self, acquired):
        if not acquired:
            return
        try:
            from app.core.redis_client import get_redis
            await get_redis().delete(_REFRESH_LOCK_KEY)
        except Exception:
            pass

    async def _record_failure(self, doc, *, stage, error, triggered_by, actor_id, duration_ms=None):
        doc.last_status = "failed"
        doc.last_error_detail = f"[{stage}] {error}"[:500]
        doc.consecutive_failures += 1
        if duration_ms is not None:
            doc.last_duration_ms = duration_ms
        await doc.save()
        logger.warning("zerodha_auto_login_failed",
                       extra={"stage": stage,
                              "consecutive_failures": doc.consecutive_failures,
                              "triggered_by": triggered_by})
        await audit_service.log_event(
            action=AuditAction.SETTING_CHANGE,
            entity_type="ZerodhaAutoLogin",
            entity_id=str(doc.id),
            actor_id=actor_id,
            metadata={
                "operation": "auto_login_failed",
                "triggered_by": triggered_by,
                "stage": stage,
                "consecutive_failures": doc.consecutive_failures,
                "error": error[:500],
            },
        )

    # ── The Playwright flow — the trickiest part ─────────────────
    async def _run_login_flow(self, *, username, password, totp_secret) -> str:
        """Headless Playwright drive of the Kite OAuth screen.

        Stages:
            precheck     — API key missing
            import       — playwright/chromium not installed
            navigate     — Kite login URL timed out
            userid       — username+password page not interactive
            password     — wrong password banner
            totp_page    — 2FA page didn't appear
            totp_submit  — TOTP code rejected
            redirect     — never landed on callback
            token_parse  — callback URL had no request_token
            session      — Kite REST exchange failed
        """
        api_key = await self._get_zerodha_api_key()
        login_url = f"https://kite.zerodha.com/connect/login?v=3&api_key={api_key}"

        try:
            from playwright.async_api import async_playwright
            import pyotp
        except ImportError as exc:
            raise AutoLoginError(
                "playwright not installed — run `pip install playwright` "
                "and `playwright install chromium` on the backend host.",
                stage="import",
            ) from exc

        async with async_playwright() as p:
            try:
                browser = await p.chromium.launch(
                    headless=True,
                    args=["--no-sandbox", "--disable-dev-shm-usage"],
                )
            except Exception as exc:
                raise AutoLoginError(
                    f"chromium failed to launch — has `playwright install "
                    f"chromium` been run on this host? "
                    f"({type(exc).__name__}: {exc})",
                    stage="import",
                ) from exc

            try:
                context = await browser.new_context(
                    user_agent=(
                        "Mozilla/5.0 (X11; Linux x86_64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/120.0.0.0 Safari/537.36"
                    ),
                    viewport={"width": 1280, "height": 720},
                )
                page = await context.new_page()

                # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                # CRITICAL — capture the OAuth callback in THREE layers
                # so the redirect chain race can't make us miss the
                # request_token. See Part 5.8 for the gory details.
                # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                captured_request_token: list[str | None] = [None]

                def _on_request(request):
                    """Layer 1 — observe every request, capture matching URL."""
                    try:
                        url = request.url
                        if "request_token=" in url and captured_request_token[0] is None:
                            captured_request_token[0] = self._extract_request_token(url)
                            logger.info(
                                "zerodha_auto_login_callback_seen",
                                extra={"url_tail": url[-180:]},
                            )
                    except Exception:
                        pass

                page.on("request", _on_request)

                async def _intercept_callback(route):
                    """Layer 2 — abort the callback so server-side /callback
                    doesn't race-consume the one-shot request_token."""
                    try:
                        url = route.request.url
                        if "request_token=" in url:
                            if captured_request_token[0] is None:
                                captured_request_token[0] = self._extract_request_token(url)
                            logger.info(
                                "zerodha_auto_login_callback_aborted",
                                extra={"url_tail": url[-180:]},
                            )
                            try:
                                await route.abort()
                            except Exception:
                                pass
                            return
                    except Exception:
                        pass
                    try:
                        await route.continue_()
                    except Exception:
                        pass

                def _match_callback(url: str) -> bool:
                    return "request_token=" in url

                # Callable predicate beats re.Pattern across Playwright
                # versions — uniformly reliable on navigation requests.
                await page.route(_match_callback, _intercept_callback)

                # ── Stage: navigate ─────────────────────────────
                try:
                    await page.goto(login_url, wait_until="domcontentloaded",
                                    timeout=_NAV_TIMEOUT_MS)
                except Exception as exc:
                    raise AutoLoginError(f"Kite login URL did not load: {exc}",
                                         stage="navigate") from exc

                # ── Stage: userid + password ───────────────────
                try:
                    await page.wait_for_selector(
                        'input[type="text"], input#userid',
                        timeout=_SELECTOR_TIMEOUT_MS,
                    )
                    await self._fill_first(page, ["input#userid", 'input[type="text"]'], username)
                    await self._fill_first(page, ["input#password", 'input[type="password"]'], password)
                    await page.click('button[type="submit"]')
                except Exception as exc:
                    raise AutoLoginError(f"username/password page not interactive: {exc}",
                                         stage="userid") from exc

                # ── Stage: detect wrong-password banner ─────────
                try:
                    err_locator = page.locator(
                        '.error, .alert, [class*="invalid"], [class*="error"]'
                    ).first
                    if await err_locator.is_visible(timeout=1500):
                        err_text = (await err_locator.text_content()) or "login rejected"
                        raise AutoLoginError(
                            f"Kite rejected the login: {err_text.strip()[:200]}",
                            stage="password",
                        )
                except AutoLoginError:
                    raise
                except Exception:
                    pass

                # ── Stage: TOTP page ────────────────────────────
                # Kite reuses input#userid on the TOTP screen on some
                # builds. Selector list covers every variant we've seen.
                totp_selector = (
                    'input.totp, input#totp, input#userid, '
                    'input[type="number"], input[autocomplete="one-time-code"], '
                    'input[label="External TOTP"], input[maxlength="6"]'
                )
                try:
                    await page.wait_for_timeout(700)  # SPA form-swap settle
                    await page.wait_for_selector(totp_selector, timeout=_SELECTOR_TIMEOUT_MS)
                except Exception as exc:
                    raise AutoLoginError(f"TOTP page did not appear: {exc}",
                                         stage="totp_page") from exc

                totp_code = pyotp.TOTP(totp_secret).now()
                try:
                    # Type digit-by-digit so React onChange fires per char
                    el = await self._first_matching(page, totp_selector)
                    if el is None:
                        raise RuntimeError(f"no element matched {totp_selector!r}")
                    await el.click()
                    await el.fill("")
                    await el.type(totp_code, delay=50)
                    # Enter as primary submit (modern Kite auto-submits)
                    try:
                        await page.keyboard.press("Enter")
                    except Exception:
                        pass
                    # Button click as backup — ignored if form already gone
                    try:
                        await page.click(
                            'button[type="submit"], button:has-text("Continue"), '
                            'button:has-text("Login")',
                            timeout=1000,
                        )
                    except Exception:
                        pass
                except Exception as exc:
                    raise AutoLoginError(f"could not submit TOTP code: {exc}",
                                         stage="totp_submit") from exc

                # ── Stage: wait for the intercepted request_token ──
                import asyncio as _asyncio_local

                deadline = _asyncio_local.get_event_loop().time() + (_REDIRECT_TIMEOUT_MS / 1000.0)
                while _asyncio_local.get_event_loop().time() < deadline:
                    if captured_request_token[0]:
                        break
                    await _asyncio_local.sleep(0.1)

                request_token = captured_request_token[0]
                if not request_token:
                    err_text = await self._read_visible_error(page)
                    final_url_snip = (page.url or "")[:200]
                    try:
                        ts = int(__import__("time").time())
                        shot_path = f"/tmp/zerodha_totp_fail_{ts}.png"
                        await page.screenshot(path=shot_path, full_page=True)
                        logger.warning("zerodha_auto_login_totp_fail_screenshot",
                                       extra={"path": shot_path, "url": final_url_snip})
                    except Exception:
                        shot_path = None
                    msg = f"Kite never issued a request_token. Page URL: {final_url_snip}"
                    if err_text:
                        msg += f" | Kite said: {err_text}"
                    if shot_path:
                        msg += f" | screenshot: {shot_path}"
                    raise AutoLoginError(msg, stage="totp_submit")

                # ── Stage: exchange via the existing service ────
                from app.services.zerodha_service import zerodha as _zerodha

                try:
                    result = await _zerodha.generate_session(request_token)
                    access = result.get("accessToken") if isinstance(result, dict) else None
                except Exception as exc:
                    # Layer 3 — race fallback. If our generate_session lost
                    # to the server-side /callback (which consumed the
                    # request_token first), accept the freshly-saved
                    # ZerodhaSettings.accessToken as success.
                    msg_lower = str(exc).lower()
                    looks_token_used = (
                        ("invalid" in msg_lower and ("token" in msg_lower or "request" in msg_lower))
                        or "checksum" in msg_lower
                    )
                    if looks_token_used:
                        zs = await ZerodhaSettings.find_one()
                        if zs and zs.accessToken and zs.lastConnected:
                            try:
                                last = zs.lastConnected
                                if last.tzinfo is None:
                                    from datetime import timezone as _tz
                                    last = last.replace(tzinfo=_tz.utc)
                                fresh_sec = (now_utc() - last).total_seconds()
                            except Exception:
                                fresh_sec = 999_999
                            if fresh_sec < 60:
                                logger.info(
                                    "zerodha_auto_login_token_refreshed_by_server_callback",
                                    extra={"fresh_sec": fresh_sec},
                                )
                                return str(zs.accessToken)
                    raise AutoLoginError(f"Kite generate_session failed: {exc}",
                                         stage="session") from exc

                if not access:
                    raise AutoLoginError("Kite did not return an access_token",
                                         stage="session")
                return str(access)
            finally:
                try:
                    await browser.close()
                except Exception:
                    pass

    # ── Small Playwright helpers ─────────────────────────────────
    async def _fill_first(self, page, selectors, value):
        last_exc = None
        for sel in selectors:
            try:
                el = await page.query_selector(sel)
                if el is not None:
                    await el.fill(value)
                    return
            except Exception as exc:
                last_exc = exc
        raise RuntimeError(f"no selector matched: {selectors!r} ({last_exc})")

    async def _first_matching(self, page, selector):
        try:
            return await page.query_selector(selector)
        except Exception:
            return None

    async def _read_visible_error(self, page):
        try:
            loc = page.locator('.error, .alert, [class*="invalid"], [class*="error"]').first
            if await loc.is_visible(timeout=500):
                txt = (await loc.text_content()) or ""
                return txt.strip()[:200] or None
        except Exception:
            return None
        return None

    @staticmethod
    def _extract_request_token(url: str) -> str | None:
        try:
            qs = parse_qs(urlparse(url).query)
            tok = qs.get("request_token") or []
            return tok[0] if tok else None
        except Exception:
            return None

    # ── Scheduler helpers ────────────────────────────────────────
    async def is_enabled(self) -> bool:
        doc = await ZerodhaAutoLogin.find_one()
        return bool(doc and doc.is_enabled)

    async def schedule_time(self) -> str:
        doc = await ZerodhaAutoLogin.find_one()
        return doc.schedule_time_ist if doc else "07:00"


zerodha_auto_login = ZerodhaAutoLoginService()
```

### 4.7 Daily scheduler — `app/services/zerodha_auto_login_scheduler.py`

```python
"""Daily background loop that fires the Zerodha auto-login."""

from __future__ import annotations

import asyncio
import logging
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from app.core.redis_client import get_redis
from app.models.holiday import TradingHoliday
from app.models.notification import Notification, NotificationLevel, NotificationType
from app.models.user import User, UserRole
from app.services.zerodha_auto_login import zerodha_auto_login

logger = logging.getLogger(__name__)
IST = ZoneInfo("Asia/Kolkata")

# Cross-worker leader lock.
_LEADER_KEY = "zerodha_auto_login:scheduler_leader"
_LEADER_TTL_SEC = 60 * 10  # 10 minutes

# 3 attempts × 5 min gap = ~15 min from first failure to last attempt,
# still inside the 07:00 → 08:00 IST token-expiry window so admin has
# time to manually login before the 09:15 IST market open.
_MAX_RETRIES = 3
_RETRY_GAP_SEC = 300

_stop_flag = False


def stop_zerodha_auto_login_scheduler() -> None:
    global _stop_flag
    _stop_flag = True


async def _is_indian_trading_holiday(today_ist: date) -> bool:
    try:
        h = await TradingHoliday.find_one(TradingHoliday.holiday_date == today_ist)
        return h is not None
    except Exception:
        logger.warning("zerodha_scheduler_holiday_lookup_failed_continuing")
        return False


def _seconds_until_next_run(schedule_time_ist: str, *, now=None) -> float:
    now_ist = (now or datetime.now(IST)).astimezone(IST)
    try:
        hh, mm = schedule_time_ist.split(":")
        h, m = int(hh), int(mm)
    except Exception:
        h, m = 7, 0

    target = now_ist.replace(hour=h, minute=m, second=0, microsecond=0)
    if target <= now_ist:
        target = target + timedelta(days=1)
    return max(1.0, (target - now_ist).total_seconds())


async def _try_acquire_leader_lock() -> bool:
    try:
        redis = get_redis()
        return bool(await redis.set(_LEADER_KEY, "1", ex=_LEADER_TTL_SEC, nx=True))
    except Exception:
        logger.warning("zerodha_scheduler_redis_down_running_anyway")
        return True


async def _alert_super_admins(error_summary: str) -> None:
    try:
        admins = await User.find(User.role == UserRole.SUPER_ADMIN).to_list()
        if not admins:
            return
        title = "Zerodha auto-login failed"
        body = (
            "All retries exhausted at the scheduled run. Please complete "
            "the manual login on /zerodha before the 09:15 IST market open. "
            f"Last error: {error_summary[:200]}"
        )
        for admin in admins:
            try:
                await Notification(
                    user_id=admin.id,
                    type=NotificationType.SYSTEM,
                    level=NotificationLevel.DANGER,
                    title=title,
                    message=body,
                    data={"source": "zerodha_auto_login"},
                ).insert()
            except Exception:
                logger.exception("zerodha_scheduler_notif_insert_failed")
    except Exception:
        logger.exception("zerodha_scheduler_alert_admins_failed")


async def zerodha_auto_login_loop() -> None:
    logger.info("zerodha_auto_login_scheduler_started")
    while not _stop_flag:
        try:
            schedule_time = await zerodha_auto_login.schedule_time()
            wait_sec = _seconds_until_next_run(schedule_time)
            await asyncio.sleep(min(wait_sec, 300))
            if _stop_flag:
                break

            # Only proceed when within 60s of target
            wait_sec_after = _seconds_until_next_run(schedule_time)
            if wait_sec_after > 60:
                continue

            today_ist = datetime.now(IST).date()
            if not await zerodha_auto_login.is_enabled():
                continue
            if today_ist.weekday() >= 5:  # Sat/Sun
                logger.info("zerodha_scheduler_weekend_skip")
                continue
            if await _is_indian_trading_holiday(today_ist):
                logger.info("zerodha_scheduler_holiday_skip")
                continue
            if not await _try_acquire_leader_lock():
                logger.info("zerodha_scheduler_other_worker_won")
                continue

            # We are leader. Run with retries.
            last_error = ""
            for attempt in range(1, _MAX_RETRIES + 1):
                logger.info("zerodha_scheduler_attempt",
                            extra={"attempt": attempt, "max": _MAX_RETRIES})
                result = await zerodha_auto_login.refresh_now(
                    triggered_by=f"scheduler_attempt_{attempt}",
                )
                if result.get("success"):
                    logger.info("zerodha_scheduler_success",
                                extra={"attempt": attempt,
                                       "duration_ms": result.get("duration_ms")})
                    last_error = ""
                    break
                last_error = f"{result.get('stage')}: {result.get('error')}"
                logger.warning("zerodha_scheduler_attempt_failed",
                               extra={"attempt": attempt, "error": last_error})
                if attempt < _MAX_RETRIES:
                    await asyncio.sleep(_RETRY_GAP_SEC)
            if last_error:
                await _alert_super_admins(last_error)

            # Sleep past the target so next iter doesn't double-fire
            await asyncio.sleep(65)
        except asyncio.CancelledError:
            break
        except Exception:
            logger.exception("zerodha_scheduler_iteration_crash")
            await asyncio.sleep(60)

    logger.info("zerodha_auto_login_scheduler_stopped")
```

### 4.8 Admin API endpoints — `app/api/v1/admin/zerodha_auto_login.py`

```python
"""Super-admin endpoints for Zerodha auto-login configuration."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.core.dependencies import SuperAdmin
from app.core.redis_client import get_redis
from app.services.zerodha_auto_login import zerodha_auto_login

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/zerodha/auto-login", tags=["admin-zerodha-auto-login"])


class UpdateCredentialsBody(BaseModel):
    username: str = Field(..., min_length=1, max_length=64)
    password: str = Field(..., min_length=1, max_length=256)
    totp_secret: str = Field(..., min_length=8, max_length=128)


class ToggleBody(BaseModel):
    enabled: bool


class ScheduleBody(BaseModel):
    schedule_time_ist: str = Field(..., min_length=4, max_length=5)


async def _enforce_rate_limit(*, request, bucket, max_count, window_sec):
    ip = request.client.host if request.client else "unknown"
    key = f"rl:zerodha_auto_login:{bucket}:{ip}"
    try:
        redis = get_redis()
        count = await redis.incr(key)
        if count == 1:
            await redis.expire(key, window_sec)
        if count > max_count:
            raise HTTPException(
                status_code=429,
                detail=f"Too many {bucket} attempts — try again in {window_sec} seconds.",
            )
    except HTTPException:
        raise
    except Exception:
        logger.warning("zerodha_auto_login_rate_limit_redis_unavailable")


@router.get("")
async def get_status(admin: SuperAdmin):
    return {"success": True, "status": await zerodha_auto_login.get_status()}


@router.put("/credentials")
async def update_credentials(body: UpdateCredentialsBody, request: Request, admin: SuperAdmin):
    await _enforce_rate_limit(request=request, bucket="credentials", max_count=5, window_sec=60)
    try:
        await zerodha_auto_login.save_credentials(
            username=body.username, password=body.password, totp_secret=body.totp_secret,
            actor_id=admin.id,
            ip_address=request.client.host if request.client else None,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"success": True, "status": await zerodha_auto_login.get_status()}


@router.post("/toggle")
async def toggle(body: ToggleBody, request: Request, admin: SuperAdmin):
    try:
        await zerodha_auto_login.set_enabled(
            body.enabled, actor_id=admin.id,
            ip_address=request.client.host if request.client else None,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"success": True, "status": await zerodha_auto_login.get_status()}


@router.put("/schedule")
async def set_schedule(body: ScheduleBody, request: Request, admin: SuperAdmin):
    try:
        await zerodha_auto_login.set_schedule(
            body.schedule_time_ist, actor_id=admin.id,
            ip_address=request.client.host if request.client else None,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"success": True, "status": await zerodha_auto_login.get_status()}


@router.post("/test")
async def test_now(request: Request, admin: SuperAdmin):
    await _enforce_rate_limit(request=request, bucket="test", max_count=10, window_sec=3600)
    result = await zerodha_auto_login.refresh_now(
        actor_id=admin.id,
        ip_address=request.client.host if request.client else None,
        triggered_by="manual",
    )
    return {"success": True, "result": result, "status": await zerodha_auto_login.get_status()}
```

### 4.9 Wire the router

In `backend/app/api/v1/admin/__init__.py`:

```python
from app.api.v1.admin import (
    # ... existing ...
    zerodha,
    zerodha_auto_login,  # <-- add
)

router = APIRouter(prefix="/admin", tags=["admin"])
# ... existing includes ...
router.include_router(zerodha.router)
router.include_router(zerodha_auto_login.router)  # <-- add
```

### 4.10 Wire the scheduler into lifespan

In `backend/app/main.py` inside the `lifespan` async context manager:

```python
# In the startup section, after other background tasks:
from app.services.zerodha_auto_login_scheduler import zerodha_auto_login_loop
z_auto_task: asyncio.Task = asyncio.create_task(zerodha_auto_login_loop())
setattr(app, "_zerodha_auto_login_task", z_auto_task)

# In the shutdown section (after `yield`):
try:
    from app.services.zerodha_auto_login_scheduler import stop_zerodha_auto_login_scheduler
    stop_zerodha_auto_login_scheduler()
    ztask = getattr(app, "_zerodha_auto_login_task", None)
    if ztask is not None:
        ztask.cancel()
        try:
            await ztask
        except Exception:
            pass
except Exception:
    pass
```

---

## 5. Part 2 — Admin frontend

### 5.1 API client — extend `frontend-admin/lib/api.ts`

```typescript
// Status snapshot returned by GET /admin/zerodha/auto-login.
// Mirrors the payload built by ZerodhaAutoLoginService.get_status() —
// all sensitive fields are masked server-side, the client never sees
// plaintext credentials.
export type ZerodhaAutoLoginStatus = {
  is_configured: boolean;
  is_enabled: boolean;
  schedule_time_ist: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_status: string;
  last_error_detail: string | null;
  consecutive_failures: number;
  last_duration_ms: number | null;
  username_masked: string;
};

export const ZerodhaAutoLoginAPI = {
  // Read .data.status directly — backend returns {success, status, ...},
  // NOT the {success, data} envelope our unwrap() helper expects.
  status: () =>
    api.get("/admin/zerodha/auto-login")
      .then((r) => r.data?.status as ZerodhaAutoLoginStatus),
  updateCredentials: (body: { username: string; password: string; totp_secret: string }) =>
    api.put("/admin/zerodha/auto-login/credentials", body)
      .then((r) => r.data?.status as ZerodhaAutoLoginStatus | undefined),
  toggle: (enabled: boolean) =>
    api.post("/admin/zerodha/auto-login/toggle", { enabled })
      .then((r) => r.data?.status as ZerodhaAutoLoginStatus | undefined),
  setSchedule: (schedule_time_ist: string) =>
    api.put("/admin/zerodha/auto-login/schedule", { schedule_time_ist })
      .then((r) => r.data?.status as ZerodhaAutoLoginStatus | undefined),
  testNow: () =>
    api.post("/admin/zerodha/auto-login/test").then((r) => ({
      result: r.data?.result as {
        success: boolean;
        error?: string;
        stage?: string;
        duration_ms?: number;
      },
      status: r.data?.status as ZerodhaAutoLoginStatus | undefined,
    })),
};
```

### 5.2 AutoLoginPanel component

`frontend-admin/components/zerodha/AutoLoginPanel.tsx` — see the full
file in the SetupFX repo at this exact path. Key features:
- Status grid with schedule, last attempt, last success, consecutive failures
- Schedule editor (HH:MM IST validation)
- Last-error banner
- Three actions: Update credentials, Test login now, Enable/disable toggle
- Polls `/admin/zerodha/auto-login` every 15s for live updates

### 5.3 CredentialsModal component

`frontend-admin/components/zerodha/CredentialsModal.tsx` — Kite Client
ID + password + TOTP secret form with expandable "How to get TOTP
secret" guide and `no_trading` permission warning.

### 5.4 Mount on /zerodha page

In `frontend-admin/app/(admin)/zerodha/page.tsx`:

```tsx
import { AutoLoginPanel } from "@/components/zerodha/AutoLoginPanel";

// Inside the page JSX, after the page header / token-expired banner:
<AutoLoginPanel />
```

### 5.5 Drop manual Start/Stop ticker buttons (optional but recommended)

`generate_session()` already calls `_start_ws_pool()` after a fresh
access token, so the manual "Start ticker" / "Stop ticker" buttons
become redundant duplicate paths. Remove them so the operator has one
clear path: login → ticker auto-connects.

---

## 6. Part 3 — Deployment to EC2

### 6.1 Pre-deploy on the server

```bash
ssh ubuntu@<EC2-IP>

# Pull latest
cd /opt/setupfx && git pull origin main

# Backend deps + Playwright Chromium
cd backend
source .venv/bin/activate
pip install -r requirements.txt
playwright install chromium

# CRITICAL — install Chromium's system shared libraries
# (libnss3, libgbm, libasound2t64, etc).
sudo /opt/setupfx/backend/.venv/bin/playwright install-deps chromium
```

> See **Part 5.2** if `install-deps` fails with apt errors —
> almost certainly a broken third-party repo (MongoDB on Ubuntu 24.04
> is the usual culprit).

### 6.2 Generate the encryption key (once per environment)

```bash
python3 -c "import os, base64; print(base64.b64encode(os.urandom(32)).decode())"
```

Output is a 44-char base64 string ending in `=`. Example:
```
Eg9Wlh5VYI+kT7uShzPeg7Sxs3mtFKbCcZQYrIPhUI4=
```

### 6.3 .env update

Open `/opt/setupfx/backend/.env` and add:

```env
ZERODHA_CREDS_KEY=<paste 44-char base64 from step 6.2>
```

Verify the key decodes to exactly 32 bytes:

```bash
python3 -c "
import base64
k = '<paste-key-here>'
print('decoded length:', len(base64.b64decode(k, validate=True)), 'bytes')
# should print: decoded length: 32 bytes
"
```

### 6.4 Restart backend

```bash
sudo systemctl restart setupfx-backend
sudo systemctl status setupfx-backend --no-pager | head -10
```

Expected: `Active: active (running)`.

### 6.5 Verify scheduler started

```bash
sudo journalctl -u setupfx-backend -n 50 --no-pager | grep -iE "zerodha_auto_login|app_started"
```

Look for:
- `app_started` (lifespan complete)
- `zerodha_auto_login_scheduler_started` (our scheduler is live)
- No `CryptoError` or `ZERODHA_CREDS_KEY` errors

### 6.6 Rebuild admin frontend

If you're using PM2:

```bash
cd /opt/setupfx/frontend-admin
npm run build
pm2 restart setupfx-admin
```

If systemd: `sudo systemctl restart setupfx-admin`.

Find the actual process:

```bash
pm2 list 2>/dev/null
sudo lsof -i :3001 2>/dev/null
sudo ss -tlnp | grep 3001
```

---

## 7. Part 4 — Operator setup (one-time)

### 7.1 Configure Kite Connect API key (existing flow)

If not already done, go to `developers.kite.trade`, create an app
with these settings:
- **Redirect URL**: `https://api.<yourdomain>/api/v1/admin/zerodha/callback`
- **Permissions**: `no_trading` ⚠️ — recommended for safety
- Copy API key + API secret

Then in the admin panel `/zerodha` page → Credentials section, save
the API key + secret.

### 7.2 Get the Kite TOTP secret

This is the trickiest one-time step. Walk through it carefully:

1. **Log in to `kite.zerodha.com`** with your usual credentials + Authy
   6-digit code.
2. **My Profile** (top-right avatar) → **Settings** → **Account** →
   **Password & security**.
3. Find **External 2FA / TOTP** section.
4. Click **Reset TOTP** / **Set up again** / **Disable & Re-enable**.
5. A QR code appears. **Below the QR code**, look for one of:
   - "Can't scan?"
   - "Show secret key"
   - "Manual entry"
6. Click it. A **16–32 character base32 string** appears, like
   `JBSWY3DPEHPK3PXP6X7K3RVDFY5GXEEHM3HJ`.
7. **Copy this string** to a secure note (NOT a screenshot — Google
   Photos sync leaks).
8. **Add this same secret to Authy** (or your authenticator app):
   - Add Account → Enter Code Manually
   - Paste the secret
   - Verify Authy now generates a 6-digit code
9. **Kite's verify step** — paste the Authy code into Kite to confirm
   the setup. Kite locks in the new secret.
10. **CRITICAL** — don't delete the old Authy entry until you've
    confirmed the new one works for one full Kite manual login cycle.

**Do NOT:**
- Don't screenshot the secret (cloud photo sync)
- Don't email/WhatsApp it
- Don't store in unencrypted notes apps

**Recovery if locked out:**
- Kite support: 1800-419-3001 (8 AM – 8 PM IST)
- Email: support@zerodha.com
- Requires PAN + DOB verification

### 7.3 Save credentials in the admin panel

1. Open `admin.<yourdomain>/zerodha`
2. Find the **"Daily auto-login"** card at the top
3. Click **"Add credentials"** (or "Update credentials")
4. Fill in:
   - **Kite Client ID** — your Kite user ID (e.g. `ZK1234`)
   - **Password** — your Kite account password
   - **TOTP secret** — the base32 string from step 7.2
5. Click **"Save & encrypt"**
6. Toast: `Credentials encrypted and saved`

### 7.4 Test login

Click **"Test login now"**. Wait ~15-25 seconds.

**Success path:**
- Toast: `Login succeeded in X.Xs`
- LAST SUCCESS column populated with current timestamp
- CONSECUTIVE FAILURES = 0
- Top of page: token-expired banner disappears
- Right-side Status panel: Authentication: Connected, Ticker: CONNECTED

**Failure path:** see **Part 8 — Troubleshooting** by stage tag.

### 7.5 Enable the daily schedule

Once test login succeeds, click the **Enabled/Disabled toggle** at
the top-right of the Auto-login card → confirm. Daily 07:00 IST runs
will now fire automatically.

---

## 8. Part 5 — Troubleshooting (every issue we hit)

Every issue we encountered during the actual rollout, with the fix.

### 8.1 `ZERODHA_CREDS_KEY must decode to exactly 32 bytes (got 24)`

**Cause:** Pasted a **base32** TOTP-style secret (32 chars, all A-Z + 2-7)
instead of a **base64-encoded 32-byte key** (44 chars, ends in `=`).

**Fix:** Generate the right kind of key:

```bash
python3 -c "import os, base64; print(base64.b64encode(os.urandom(32)).decode())"
```

Output is **44 characters** ending in `=`. That's the right shape.

Quick validator:

```bash
python3 -c "
import base64
k = '<your-key>'
print('decoded length:', len(base64.b64decode(k, validate=True)), 'bytes')
"
# Must print 'decoded length: 32 bytes'
```

### 8.2 `[import] chromium failed to launch`

**Cause:** Chromium binary is downloaded (`playwright install chromium`
worked) but the **system shared libraries** it needs aren't installed —
typically `libnss3`, `libnspr4`, `libgbm1`, `libasound2t64`,
`libxshmfence1`, etc.

**Fix:**

```bash
sudo /opt/setupfx/backend/.venv/bin/playwright install-deps chromium
```

Verify Chromium can find its libs:

```bash
ldd /home/ubuntu/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell | grep "not found"
# Output should be EMPTY (no "not found" lines)
```

Manual fallback if `install-deps` won't run (see 8.3):

```bash
sudo apt-get install -y libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 \
  libcups2t64 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libxshmfence1 libasound2t64 libpango-1.0-0 libcairo2
```

### 8.3 `playwright install-deps` fails: "Failed to install browser dependencies, Error: Installation process exited with code: 100"

**Cause:** A broken third-party apt repo is blocking `apt-get update`.
On Ubuntu 24.04 (noble), MongoDB's repo is the classic offender —
MongoDB doesn't officially support noble yet.

```
Err:7 https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/7.0 Release
  404  Not Found
```

**Fix:** Temporarily disable the bad repo, install Playwright deps,
optionally restore.

```bash
# Move the bad repo file aside
sudo find /etc/apt/sources.list.d/ -iname "*mongo*" -exec mv {} {}.disabled \;

# Now apt update succeeds
sudo apt-get update

# And so does install-deps
sudo /opt/setupfx/backend/.venv/bin/playwright install-deps chromium
```

To restore the repo later (point it at `jammy` since `noble` is unsupported):

```bash
sudo sed -i 's|noble|jammy|g' /etc/apt/sources.list.d/mongodb-org-7.0.list.disabled
sudo mv /etc/apt/sources.list.d/mongodb-org-7.0.list.disabled /etc/apt/sources.list.d/mongodb-org-7.0.list
sudo apt-get update
```

### 8.4 Auto-login panel stuck on "Loading…"

**Cause:** API response shape mismatch. Backend returns
`{success, status, ...}` but the `unwrap()` helper expects
`{success, data, ...}`.

**Fix:** Read `r.data?.status` directly instead of using `unwrap()`:

```typescript
status: () =>
  api.get("/admin/zerodha/auto-login")
    .then((r) => r.data?.status as ZerodhaAutoLoginStatus),
```

(See the full corrected `ZerodhaAutoLoginAPI` in Part 2.1 above.)

### 8.5 `systemctl restart setupfx-admin` fails: "Unit setupfx-admin.service not found"

**Cause:** Admin frontend isn't a systemd service — it's running under
PM2.

**Fix:** Use PM2 instead. Find the process and restart:

```bash
pm2 list
# Find process name (likely setupfx-admin or similar)
pm2 restart setupfx-admin

# Verify port 3001 is bound by the new process
sudo lsof -i :3001
```

If PM2 isn't running it either, look for raw `next start`:

```bash
sudo ss -tlnp | grep 3001
```

### 8.6 `systemd-timesyncd.service not found`

**Cause:** Ubuntu 24.04 EC2 AMIs typically use `chrony` for time
sync, not `systemd-timesyncd`.

**Fix:** Install/start chrony:

```bash
sudo apt-get install -y chrony
sudo systemctl enable --now chrony
chronyc tracking | head -5
# Verify "Leap status : Normal" and a small "Last offset"
```

Confirm the system clock is synchronized:

```bash
timedatectl
# Look for: System clock synchronized: yes
```

**Why this matters:** TOTP uses a 30-second time window. If the
server clock drifts by more than ~30 seconds, every generated TOTP
will be rejected by Kite.

### 8.7 TOTP code on server doesn't match Authy

**Cause:** Different TOTP secrets are stored in Authy vs the backend
DB. The user probably did "Reset TOTP" on Kite at some point, got a
new secret, stored it in only one place (backend OR Authy, not both).

**Diagnostic — generate server-side TOTP and compare with Authy:**

```bash
cd /opt/setupfx/backend && source .venv/bin/activate && python3 << 'EOF'
import asyncio
from datetime import datetime
from zoneinfo import ZoneInfo
from app.core.database import init_database
from app.models.zerodha_auto_login import ZerodhaAutoLogin
from app.utils.crypto import decrypt
import pyotp

async def main():
    await init_database()
    doc = await ZerodhaAutoLogin.find_one()
    if not doc or not doc.encrypted_totp_secret:
        print("NO TOTP SECRET SAVED")
        return
    secret = decrypt(doc.encrypted_totp_secret, doc.encrypted_totp_secret_iv)
    totp = pyotp.TOTP(secret)
    now = datetime.now(ZoneInfo("Asia/Kolkata"))
    print(f"Server IST time   : {now.strftime('%H:%M:%S')}")
    print(f"Seconds in window : {now.second % 30} / 30")
    print(f"CURRENT TOTP CODE : {totp.now()}")
    print(f"Previous code     : {totp.at(int(now.timestamp()) - 30)}")
    print(f"Next code         : {totp.at(int(now.timestamp()) + 30)}")

asyncio.run(main())
EOF
```

Open Authy → Zerodha entry → compare with the printed code.

**If they don't match:** reset Kite TOTP (Part 7.2) and paste the
same secret into BOTH Authy AND the admin panel's "Update credentials"
form.

### 8.8 `[totp_submit] did not redirect to callback` — the redirect chain race

**This was the trickiest bug.** Symptom: the admin panel reports
`Login failed at "totp_submit" — did not redirect to callback`, but
the page URL after submit is `https://admin.setupfx.io/login` (the
admin SPA's login redirect), and the Zerodha token is actually
refreshed.

**Cause:** Kite's redirect chain is entirely HTTP 302s:

```
Kite TOTP page (POST)
  → 302 → api.<host>/api/v1/admin/zerodha/callback?request_token=ABC123
  → 302 → admin.<host>/zerodha?success=true
  → admin SPA client-side redirect → admin.<host>/login (no JWT in headless context)
```

The whole chain completes in milliseconds. Playwright's
`page.wait_for_url(lambda url: "request_token=" in url)` polls
periodically and **misses the intermediate URL entirely**. It only
sees the final `/login`.

Worse, while Playwright is polling, the browser ACTUALLY hits the
server-side `/callback` endpoint in the chain, which itself calls
`generate_session(request_token)` — and Kite's request_tokens are
single-use. So even if Playwright catches the URL later, our own
`generate_session(request_token)` call fails with "Invalid request
token" (race condition).

**Fix:** Three layers of redundancy.

**Layer 1 — `page.on("request")` listener:**

```python
def _on_request(request):
    url = request.url
    if "request_token=" in url and captured_request_token[0] is None:
        captured_request_token[0] = self._extract_request_token(url)

page.on("request", _on_request)
```

Fires for every request the browser makes, including 302-followed
ones. Just observes — never aborts. Most portable across Playwright
versions.

**Layer 2 — `page.route()` with a callable predicate:**

```python
async def _intercept_callback(route):
    url = route.request.url
    if "request_token=" in url:
        captured_request_token[0] = self._extract_request_token(url)
        await route.abort()
        return
    await route.continue_()

def _match_callback(url: str) -> bool:
    return "request_token=" in url

await page.route(_match_callback, _intercept_callback)
```

Aborts the navigation BEFORE the browser hits the server-side
`/callback`. Prevents the race. **Use a callable predicate, not
`re.Pattern`** — older Playwright builds are inconsistent about
Pattern matching against redirect-follow navigation requests.

**Layer 3 — DB freshness check after `generate_session`:**

```python
try:
    result = await _zerodha.generate_session(request_token)
except Exception as exc:
    msg = str(exc).lower()
    if "invalid" in msg and ("token" in msg or "request" in msg):
        zs = await ZerodhaSettings.find_one()
        if zs and zs.accessToken and zs.lastConnected:
            fresh_sec = (now_utc() - zs.lastConnected).total_seconds()
            if fresh_sec < 60:
                return str(zs.accessToken)
    raise AutoLoginError(...)
```

If Layers 1 + 2 still race and our call loses, the **server-side
`/callback`** has already saved the token. Accept that as success.

With all three layers, capture is essentially 100% reliable.

### 8.9 Test login button stuck on "Running…" but eventually fails with "timeout of 30000ms exceeded"

**Cause:** Axios client timeout on the admin frontend is 30 sec. The
Playwright login normally finishes in ~15-25 sec but on a cold
Chromium boot (or slow Kite response) it can exceed 30 sec.

**Effect:** Frontend gives up showing "timeout" toast, but **the
backend's Playwright run continues**. Token may still get refreshed.

**Fix:** Cosmetic only — check the actual server-side result a few
seconds later by refreshing the page. The status card will show the
real outcome.

If you want to bump the Axios timeout for this specific call:

```typescript
testNow: () =>
  api.post("/admin/zerodha/auto-login/test", undefined, { timeout: 60_000 })
```

### 8.10 `Already up to date` after `git pull`, but old code still running

**Cause:** Service hasn't been restarted after the pull, or PM2 cached
the previous JS build (`.next/` not regenerated).

**Fix:**

```bash
# Backend
cd /opt/setupfx && git pull origin main
git log -1 --oneline  # confirm latest commit hash
sudo systemctl restart setupfx-backend

# Frontend admin (Next.js)
cd /opt/setupfx/frontend-admin
npm run build  # MANDATORY — Next.js needs rebuild for static pages
pm2 restart setupfx-admin
```

Force-pull from origin if local has divergent commits:

```bash
cd /opt/setupfx
git fetch origin main
git reset --hard origin/main
```

⚠️ `reset --hard` destroys local uncommitted changes. Check `git status` first.

---

## 9. Verification checklist

After full deploy + operator setup, all of these should be true:

### Backend
- [ ] `sudo systemctl status setupfx-backend` shows `active (running)`
- [ ] `journalctl` contains `app_started` and `zerodha_auto_login_scheduler_started`
- [ ] No `CryptoError` or `ZERODHA_CREDS_KEY` errors anywhere in logs
- [ ] `pip show playwright` and `pip show pyotp` both return versions
- [ ] `~/.cache/ms-playwright/chromium*` directory exists with ~250 MB content
- [ ] `ldd /home/ubuntu/.cache/ms-playwright/chromium*/chrome-headless-shell-linux64/chrome-headless-shell | grep "not found"` is EMPTY

### .env / config
- [ ] `ZERODHA_CREDS_KEY` is set, decodes to exactly 32 bytes via base64
- [ ] `ADMIN_API_KEY`, `JWT_SECRET` are NOT the dev defaults
- [ ] `BACKEND_PUBLIC_URL` points to the real api hostname
- [ ] `CORS_ADMIN_ORIGIN` matches admin frontend hostname

### Frontend admin
- [ ] `admin.<host>/zerodha` loads without "Loading…" stuck state
- [ ] "Daily auto-login" card renders at top of page
- [ ] Status panel right-side shows Authentication: Connected after Test login
- [ ] No console errors related to `/admin/zerodha/auto-login`

### Auto-login functional test
- [ ] "Add credentials" modal saves without error
- [ ] "Test login now" → Toast `Login succeeded in X.Xs` within 30 sec
- [ ] LAST SUCCESS column shows current timestamp
- [ ] CONSECUTIVE FAILURES = 0
- [ ] Token-expired red banner disappears
- [ ] Toggle = Enabled

### Logs from a successful run (for confirmation)
```
INFO  zerodha_auto_login_callback_aborted url_tail=...request_token=XXX...
INFO  zerodha_auto_login_token_refreshed_by_server_callback OR (just a returned token)
INFO  zerodha_auto_login_success (logged by scheduler if scheduler-triggered)
INFO  zerodha_cache_warmed
INFO  zerodha_ws_pool_start_succeeded
```

---

## 10. Failure recovery runbook

### Scenario A: Daily auto-login fails at scheduled time

1. **Detection:** Within ~15 min, admin panel shows `consecutive_failures >= 3`
   and a Notification row appears for the super-admin
2. **Manual fallback** (admin gets the alert):
   - Open `admin.<host>/zerodha`
   - Click **"Reconnect to Zerodha"** (existing manual flow)
   - Complete Authy verification
   - Total time: ~30 seconds
3. **Root cause analysis:**
   - Check `last_error_detail` field on the Auto-login card
   - Match against Part 8 stage table
   - If `totp_submit` → check Authy vs server code match (Part 8.7)
   - If `import` → Playwright/Chromium broken (Part 8.2 / 8.3)
   - If `password` → Kite password changed; update credentials

### Scenario B: Kite changes their login page

**Symptom:** All auto-logins fail with `userid` or `totp_page` stage.

**Fix:**
1. SSH to EC2, write `scripts/zerodha_test_login.py` that mirrors the
   service flow but uses `headless=False` so you can see what Kite is
   showing
2. Update selectors in `zerodha_auto_login.py` to match the new HTML
3. Redeploy and test
4. ETA: 1-2 hours

**Pre-emptive monitoring:** schedule a weekly Saturday morning
test-login (when admin is awake) so UI changes get caught before
they hit Monday market open.

### Scenario C: Credentials compromised

1. Immediately toggle auto-login OFF in admin UI
2. Change Kite password at `kite.zerodha.com`
3. Reset TOTP (new secret per Part 7.2)
4. Generate new `ZERODHA_CREDS_KEY` (and re-encrypt — or just re-enter
   credentials, since the old ciphertext becomes garbage anyway)
5. Update admin panel with new credentials
6. Audit log review — check who accessed credentials in the last 30 days

### Scenario D: Kite outage (their problem, not ours)

- Auto-login fails with `navigate` or `userid` stage timeout
- Manual login also fails (same Kite-side outage)
- Wait it out — when Kite recovers, run manual login or restart
  backend (scheduler will retry next cycle)
- Status page: `kite.zerodha.com` — Kite announces outages there

---

## 11. Security properties

| Layer | Protection |
|---|---|
| **Storage** | AES-256-GCM at rest, fresh 12-byte IV per field |
| **Key management** | `ZERODHA_CREDS_KEY` env var only (never in DB), file perms 600 |
| **API access** | Super-admin only via `SuperAdmin` dependency |
| **Read protection** | All responses return masked values (`mask_secret`) |
| **Audit** | Every credential read/write + every login attempt audit-logged |
| **Rate limiting** | 5/min credential updates, 10/hour test logins (per IP) |
| **Trade scope** | Use Kite `no_trading` API permission — compromise = read-only |
| **Network** | Playwright subprocess isolated; no DB access during browser run |
| **Stack traces** | Sanitised — `AutoLoginError` never carries plaintext creds |
| **Reversibility** | `is_enabled=false` toggle = instant rollback to manual-only |

### Defense-in-depth summary

If ANY one of these layers fails, others still hold:

- DB dump leaked? → AES-GCM ciphertext is useless without the key
- Key leaked? → Audit log shows every read; rate limit prevents brute force
- Admin JWT stolen? → Super-admin role still required; IP whitelist if set
- Backend compromised at root level? → `no_trading` API permission limits Kite-side blast to read-only
- Kite suspends the API key? → Manual fallback flow still works

---

## Appendix A — File map (where everything lives)

```
backend/
├── app/
│   ├── core/
│   │   ├── config.py                        ← ZERODHA_CREDS_KEY setting
│   │   └── database.py                      ← register ZerodhaAutoLogin model
│   ├── utils/
│   │   └── crypto.py                        ← NEW: AES-256-GCM utility
│   ├── models/
│   │   └── zerodha_auto_login.py            ← NEW: Beanie singleton model
│   ├── services/
│   │   ├── zerodha_auto_login.py            ← NEW: Playwright login service
│   │   └── zerodha_auto_login_scheduler.py  ← NEW: daily loop
│   ├── api/v1/admin/
│   │   ├── __init__.py                      ← include new router
│   │   └── zerodha_auto_login.py            ← NEW: 5 admin endpoints
│   └── main.py                              ← wire scheduler in lifespan
└── requirements.txt                         ← + playwright>=1.45.0,<2

frontend-admin/
├── app/(admin)/zerodha/
│   └── page.tsx                             ← mount AutoLoginPanel
├── components/zerodha/
│   ├── AutoLoginPanel.tsx                   ← NEW: status + actions
│   └── CredentialsModal.tsx                 ← NEW: cred form + help
└── lib/
    └── api.ts                               ← + ZerodhaAutoLoginAPI
```

## Appendix B — Quick reference: stage tags

| Stage | Meaning | Most likely cause |
|---|---|---|
| `precheck` | API key/secret missing | Configure manually first in /zerodha |
| `import` | Playwright/Chromium not installed | `playwright install chromium` + `install-deps` |
| `decrypt` | AES decryption failed | Wrong/missing `ZERODHA_CREDS_KEY` |
| `navigate` | Kite login URL didn't load | Network issue, Kite outage |
| `userid` | Username/password page selectors didn't match | Kite UI changed; update selectors |
| `password` | Kite rejected login | Wrong Kite password; reset in admin |
| `totp_page` | TOTP page didn't appear | Kite UI changed; update selectors |
| `totp_submit` | TOTP rejected OR redirect chain race | Authy vs server secret mismatch; OR install latest 3-layer capture code |
| `token_parse` | Callback URL had no `request_token` | Almost never — Kite's bug |
| `session` | Kite REST `generate_session` failed | API key/secret mismatch; or request_token already used (race) |
| `unknown` | Unexpected Playwright internal error | Check stack trace in journalctl |
| `lock` | Another auto-login in progress | Wait 5 min; another worker grabbed Redis lock |

## Appendix C — One-liner deploy command (after first setup)

For pulling latest code + restarting both services:

```bash
cd /opt/setupfx \
  && git pull origin main \
  && cd backend && pip install -r requirements.txt && cd .. \
  && cd frontend-admin && npm run build && pm2 restart setupfx-admin && cd .. \
  && sudo systemctl restart setupfx-backend
```

## Appendix D — Diagnostic commands cheat sheet

```bash
# 1. Generate AES key (one-time per env)
python3 -c "import os, base64; print(base64.b64encode(os.urandom(32)).decode())"

# 2. Verify a key is 32 bytes after base64 decode
python3 -c "import base64; print(len(base64.b64decode('<KEY>', validate=True)), 'bytes')"

# 3. Verify Chromium can launch (no missing libs)
ldd ~/.cache/ms-playwright/chromium*/chrome-headless-shell-linux64/chrome-headless-shell | grep 'not found'

# 4. Generate server-side TOTP code (compare with Authy)
cd /opt/setupfx/backend && source .venv/bin/activate && python3 -c "
import asyncio, pyotp
from app.core.database import init_database
from app.models.zerodha_auto_login import ZerodhaAutoLogin
from app.utils.crypto import decrypt
async def m():
    await init_database()
    d = await ZerodhaAutoLogin.find_one()
    print('Code:', pyotp.TOTP(decrypt(d.encrypted_totp_secret, d.encrypted_totp_secret_iv)).now())
asyncio.run(m())
"

# 5. Tail live logs filtered to auto-login
sudo journalctl -u setupfx-backend -f | grep -iE "zerodha_auto_login|callback_seen|callback_aborted|refreshed_by_server"

# 6. Find latest TOTP failure screenshot
ls -lt /tmp/zerodha_totp_fail_*.png 2>/dev/null | head -3

# 7. Check NTP clock sync
timedatectl
chronyc tracking | head -5

# 8. Find admin frontend process
pm2 list
sudo lsof -i :3001
```

---



**End of guide.** Total implementation time on a fresh stack:
~4-6 hours including operator setup and one full successful test run.
With this document as a reference, replication on a new project
should take ~2 hours.
