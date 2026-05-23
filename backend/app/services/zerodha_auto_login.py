"""Automated daily Kite Connect access-token refresh.

Drives the Kite OAuth + TOTP login screen with a headless Playwright
browser, captures the `request_token` from the redirect, and exchanges
it for a fresh access token via the existing `zerodha_service`. The
existing manual login flow is untouched — auto-login just calls the
same `generate_session()` method the manual callback uses, so if the
auto-login fails for any reason, manual fallback still works.

WebSocket safety
----------------
Kite allows only ONE WebSocket per access token. When we issue a new
token, every old `KiteTicker` instance gets a 403 close. To prevent
the existing self-heal loop from racing with our login and producing
duplicate WS attempts on the OLD token, we:

  1. Pause `zerodha._self_heal_paused = True` BEFORE generating the
     new session.
  2. Call `zerodha.disconnect_ws()` to cleanly close every existing
     ticker entry (and clear `_token_to_ws` mappings).
  3. Then run `generate_session()`, which kicks off a fresh WS pool
     on the new token via the existing `_post_login_ws_kickoff` path.
  4. Always re-arm `_self_heal_paused = False` in a finally block so
     even on a partial failure the heal loop can recover.

Request-token race
------------------
Kite's request_token is one-shot. If our Playwright browser navigates
all the way to `/admin/zerodha/callback?request_token=...`, the server-
side endpoint consumes it before our own code can. We defend against
this with THREE layers in `_run_login_flow`:

  1. `page.on("request")` — passive observer, snaps every URL the
     browser tries to fetch including redirects.
  2. `page.route()` with a callable predicate — aborts the navigation
     to `/callback` BEFORE the browser hits our own server.
  3. Post-failure DB freshness check — if `generate_session` raises
     "Invalid request_token", check whether `ZerodhaSettings.accessToken`
     was just refreshed (lastConnected within 60s). If so, the server
     callback handled the token successfully and we accept that.

Cross-worker safety
-------------------
A Redis SETNX lock guards `refresh_now()` so even if the scheduler
fires in multiple uvicorn workers simultaneously, only one drives the
browser. See `_REFRESH_LOCK_KEY`.
"""

from __future__ import annotations

import asyncio
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

# Stage timeouts (milliseconds). Generous for slow EC2 networks but
# short enough that 3 retries with 5-min gaps still complete inside the
# 07:00 → 09:15 IST window before the market opens.
_NAV_TIMEOUT_MS = 20_000
_SELECTOR_TIMEOUT_MS = 12_000
_REDIRECT_TIMEOUT_MS = 20_000

# Cross-worker single-flight guard for refresh_now(). Held for the full
# Playwright run + the few seconds it takes generate_session() to come
# back. 5 minutes is the operator-recovery upper bound — long enough to
# survive a slow Kite login, short enough that a crashed worker doesn't
# block the next attempt forever.
_REFRESH_LOCK_KEY = "zerodha_auto_login:refresh_lock"
_REFRESH_LOCK_TTL_SEC = 300


class AutoLoginError(RuntimeError):
    """Stage-tagged failure. `.stage` identifies which Playwright step blew up."""

    def __init__(self, message: str, *, stage: str) -> None:
        super().__init__(message)
        self.stage = stage


class ZerodhaAutoLoginService:
    """Singleton — instantiated at the bottom of this module."""

    # ── Singleton row helpers ──────────────────────────────────────
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

    # ── Credentials management ─────────────────────────────────────
    async def save_credentials(
        self,
        *,
        username: str,
        password: str,
        totp_secret: str,
        actor_id: PydanticObjectId | str | None,
        ip_address: str | None = None,
    ) -> None:
        username = (username or "").strip()
        password = password or ""
        totp_secret = (totp_secret or "").strip().replace(" ", "").upper()

        if not username or not password or not totp_secret:
            raise ValueError("username, password, totp_secret all required")

        # Fail loudly at save-time on a bad TOTP secret so we don't
        # discover it at 07:00 the next morning when the scheduler fires.
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
        # Reset failure counter — fresh creds get a clean slate.
        doc.consecutive_failures = 0
        doc.last_error_detail = None
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
        """Masked snapshot for the admin UI. Never returns raw creds."""
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
                "last_stage": None,
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
            "last_stage": doc.last_stage,
            "consecutive_failures": doc.consecutive_failures,
            "last_duration_ms": doc.last_duration_ms,
            "username_masked": username_masked,
        }

    async def set_enabled(
        self,
        enabled: bool,
        *,
        actor_id: PydanticObjectId | str | None,
        ip_address: str | None = None,
    ) -> None:
        doc = await self._get_or_create()
        if enabled and not (
            doc.encrypted_username
            and doc.encrypted_password
            and doc.encrypted_totp_secret
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
                metadata={
                    "operation": "scheduler_toggled",
                    "enabled": doc.is_enabled,
                },
                ip_address=ip_address,
            )

    async def set_schedule(
        self,
        schedule_time_ist: str,
        *,
        actor_id: PydanticObjectId | str | None,
        ip_address: str | None = None,
    ) -> None:
        s = (schedule_time_ist or "").strip()
        try:
            hh, mm = s.split(":")
            h, m = int(hh), int(mm)
            if not (0 <= h <= 23 and 0 <= m <= 59):
                raise ValueError("out of range")
        except Exception as exc:
            raise ValueError(
                f"schedule_time_ist must be HH:MM IST 24-hour (got {s!r}): {exc}"
            )
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
                metadata={
                    "operation": "schedule_updated",
                    "from": prev,
                    "to": normalised,
                },
                ip_address=ip_address,
            )

    # ── The actual login flow ──────────────────────────────────────
    async def refresh_now(
        self,
        *,
        actor_id: PydanticObjectId | str | None = None,
        ip_address: str | None = None,
        triggered_by: str = "manual",
    ) -> dict[str, Any]:
        from app.core.redis_client import get_redis

        # Single-flight guard — multi-worker safe.
        lock_acquired = False
        try:
            redis = get_redis()
            lock_acquired = bool(
                await redis.set(
                    _REFRESH_LOCK_KEY, "1", ex=_REFRESH_LOCK_TTL_SEC, nx=True
                )
            )
            if not lock_acquired:
                return {
                    "success": False,
                    "error": "Another auto-login is already in progress.",
                    "stage": "lock",
                }
        except Exception:
            logger.warning(
                "zerodha_auto_login_lock_unavailable_continuing",
                exc_info=True,
            )

        doc = await self._get_or_create()
        if not (
            doc.encrypted_username
            and doc.encrypted_password
            and doc.encrypted_totp_secret
        ):
            await self._release_lock(lock_acquired)
            return {
                "success": False,
                "error": "Credentials not configured.",
                "stage": "precheck",
            }

        try:
            username = decrypt(doc.encrypted_username, doc.encrypted_username_iv)
            password = decrypt(doc.encrypted_password, doc.encrypted_password_iv)
            totp_secret = decrypt(
                doc.encrypted_totp_secret, doc.encrypted_totp_secret_iv
            )
        except CryptoError as exc:
            await self._record_failure(
                doc,
                stage="decrypt",
                error=str(exc),
                triggered_by=triggered_by,
                actor_id=actor_id,
            )
            await self._release_lock(lock_acquired)
            return {"success": False, "error": str(exc), "stage": "decrypt"}

        # ── WebSocket safe handoff ────────────────────────────────
        # Pause self-heal + tear down old WS pool BEFORE we drive the
        # browser. New token will trigger a fresh pool via the existing
        # post-login kickoff in zerodha_service.generate_session().
        from app.services.zerodha_service import zerodha

        prior_heal_state = getattr(zerodha, "_self_heal_paused", False)
        zerodha._self_heal_paused = True
        try:
            try:
                await zerodha.disconnect_ws()
            except Exception:
                logger.warning(
                    "zerodha_auto_login_predisconnect_failed_continuing",
                    exc_info=True,
                )

            start = time.monotonic()
            doc.last_attempt_at = now_utc()
            doc.last_stage = "in_progress"
            await doc.save()

            try:
                access_token = await self._run_login_flow(
                    username=username,
                    password=password,
                    totp_secret=totp_secret,
                )
            except AutoLoginError as exc:
                duration_ms = int((time.monotonic() - start) * 1000)
                await self._record_failure(
                    doc,
                    stage=exc.stage,
                    error=str(exc),
                    duration_ms=duration_ms,
                    triggered_by=triggered_by,
                    actor_id=actor_id,
                )
                return {
                    "success": False,
                    "error": str(exc),
                    "stage": exc.stage,
                    "duration_ms": duration_ms,
                }
            except Exception as exc:
                duration_ms = int((time.monotonic() - start) * 1000)
                logger.exception("zerodha_auto_login_unexpected_error")
                await self._record_failure(
                    doc,
                    stage="unknown",
                    error=f"{type(exc).__name__}: {exc}",
                    duration_ms=duration_ms,
                    triggered_by=triggered_by,
                    actor_id=actor_id,
                )
                return {
                    "success": False,
                    "error": f"Unexpected error: {exc}",
                    "stage": "unknown",
                    "duration_ms": duration_ms,
                }

            duration_ms = int((time.monotonic() - start) * 1000)
            doc.last_success_at = now_utc()
            doc.last_status = "success"
            doc.last_error_detail = None
            doc.last_stage = "complete"
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

            return {
                "success": True,
                "access_token_obtained": bool(access_token),
                "duration_ms": duration_ms,
                "stage": "complete",
            }
        finally:
            # Always re-arm self-heal so the loop can recover even on
            # partial failures. We never restore the prior "paused"
            # state if it was True — admin's explicit disconnect intent
            # is overridden by an explicit auto-login attempt (the
            # admin who pressed Disconnect would not be running the
            # auto-login simultaneously).
            zerodha._self_heal_paused = False
            if prior_heal_state:
                logger.info(
                    "zerodha_auto_login_self_heal_rearmed",
                    extra={"prior_state": prior_heal_state},
                )
            await self._release_lock(lock_acquired)

    async def _release_lock(self, acquired: bool) -> None:
        if not acquired:
            return
        try:
            from app.core.redis_client import get_redis

            await get_redis().delete(_REFRESH_LOCK_KEY)
        except Exception:
            pass

    async def _record_failure(
        self,
        doc: ZerodhaAutoLogin,
        *,
        stage: str,
        error: str,
        triggered_by: str,
        actor_id: PydanticObjectId | str | None,
        duration_ms: int | None = None,
    ) -> None:
        doc.last_status = "failed"
        doc.last_error_detail = f"[{stage}] {error}"[:500]
        doc.last_stage = stage
        doc.consecutive_failures += 1
        if duration_ms is not None:
            doc.last_duration_ms = duration_ms
        await doc.save()
        logger.warning(
            "zerodha_auto_login_failed",
            extra={
                "stage": stage,
                "consecutive_failures": doc.consecutive_failures,
                "triggered_by": triggered_by,
            },
        )
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

    # ── The Playwright flow — the trickiest part ────────────────────
    async def _run_login_flow(
        self,
        *,
        username: str,
        password: str,
        totp_secret: str,
    ) -> str:
        """Headless Playwright drive of the Kite OAuth screen.

        Stages (matches `.stage` on AutoLoginError so the admin UI can
        show "where it broke"):
            precheck     — API key missing
            import       — playwright/chromium not installed
            navigate     — Kite login URL timed out
            userid       — username+password page not interactive
            password     — wrong password banner detected
            totp_page    — 2FA page didn't appear
            totp_submit  — TOTP code rejected / no redirect
            redirect     — never landed on /callback
            token_parse  — callback URL had no request_token
            session      — Kite REST exchange failed
        """
        api_key = await self._get_zerodha_api_key()
        login_url = (
            f"https://kite.zerodha.com/connect/login?v=3&api_key={api_key}"
        )

        try:
            from playwright.async_api import async_playwright
            import pyotp
        except ImportError as exc:
            raise AutoLoginError(
                "playwright or pyotp not installed — run "
                "`pip install playwright pyotp` and "
                "`playwright install chromium` on the backend host.",
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
                    f"chromium failed to launch — has "
                    f"`playwright install chromium` been run on this host? "
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

                # 3-layer request_token capture — see module docstring
                # "Request-token race" for the full reasoning.
                captured_request_token: list[str | None] = [None]

                def _on_request(request) -> None:
                    """Layer 1 — observe every URL the browser requests."""
                    try:
                        url = request.url
                        if (
                            "request_token=" in url
                            and captured_request_token[0] is None
                        ):
                            captured_request_token[0] = (
                                self._extract_request_token(url)
                            )
                            logger.info(
                                "zerodha_auto_login_callback_seen",
                                extra={"url_tail": url[-180:]},
                            )
                    except Exception:
                        pass

                page.on("request", _on_request)

                async def _intercept_callback(route) -> None:
                    """Layer 2 — abort the /callback navigation so the
                    server-side endpoint doesn't race-consume our token."""
                    try:
                        url = route.request.url
                        if "request_token=" in url:
                            if captured_request_token[0] is None:
                                captured_request_token[0] = (
                                    self._extract_request_token(url)
                                )
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

                await page.route(_match_callback, _intercept_callback)

                # ── Stage: navigate ──────────────────────────────
                try:
                    await page.goto(
                        login_url,
                        wait_until="domcontentloaded",
                        timeout=_NAV_TIMEOUT_MS,
                    )
                except Exception as exc:
                    raise AutoLoginError(
                        f"Kite login URL did not load: {exc}",
                        stage="navigate",
                    ) from exc

                # ── Stage: userid + password ─────────────────────
                try:
                    await page.wait_for_selector(
                        'input[type="text"], input#userid',
                        timeout=_SELECTOR_TIMEOUT_MS,
                    )
                    await self._fill_first(
                        page, ['input#userid', 'input[type="text"]'], username
                    )
                    await self._fill_first(
                        page,
                        ['input#password', 'input[type="password"]'],
                        password,
                    )
                    await page.click('button[type="submit"]')
                except Exception as exc:
                    raise AutoLoginError(
                        f"username/password page not interactive: {exc}",
                        stage="userid",
                    ) from exc

                # ── Stage: detect wrong-password banner ──────────
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
                    # is_visible() throws if selector doesn't exist — that's
                    # the happy path; the page moved on to the TOTP screen.
                    pass

                # ── Stage: TOTP page ─────────────────────────────
                # Kite reuses input#userid on the TOTP screen on some
                # builds, hence the long selector union.
                totp_selector = (
                    'input.totp, input#totp, input#userid, '
                    'input[type="number"], input[autocomplete="one-time-code"], '
                    'input[label="External TOTP"], input[maxlength="6"]'
                )
                try:
                    await page.wait_for_timeout(700)  # SPA form-swap settle
                    await page.wait_for_selector(
                        totp_selector, timeout=_SELECTOR_TIMEOUT_MS
                    )
                except Exception as exc:
                    raise AutoLoginError(
                        f"TOTP page did not appear: {exc}", stage="totp_page"
                    ) from exc

                totp_code = pyotp.TOTP(totp_secret).now()
                try:
                    el = await page.query_selector(totp_selector)
                    if el is None:
                        raise RuntimeError(
                            f"no element matched {totp_selector!r}"
                        )
                    await el.click()
                    await el.fill("")
                    # Type per-char so React onChange fires for every digit.
                    await el.type(totp_code, delay=50)
                    # Press Enter — modern Kite auto-submits on the
                    # 6th digit but Enter is a safe belt-and-braces.
                    try:
                        await page.keyboard.press("Enter")
                    except Exception:
                        pass
                    # Button click as backup — ignored if form already gone.
                    try:
                        await page.click(
                            'button[type="submit"], button:has-text("Continue"), '
                            'button:has-text("Login")',
                            timeout=1000,
                        )
                    except Exception:
                        pass
                except Exception as exc:
                    raise AutoLoginError(
                        f"could not submit TOTP code: {exc}",
                        stage="totp_submit",
                    ) from exc

                # ── Stage: wait for the intercepted request_token ──
                deadline = (
                    asyncio.get_event_loop().time()
                    + (_REDIRECT_TIMEOUT_MS / 1000.0)
                )
                while asyncio.get_event_loop().time() < deadline:
                    if captured_request_token[0]:
                        break
                    await asyncio.sleep(0.1)

                request_token = captured_request_token[0]
                if not request_token:
                    err_text = await self._read_visible_error(page)
                    final_url_snip = (page.url or "")[:200]
                    shot_path: str | None = None
                    try:
                        ts = int(time.time())
                        shot_path = f"/tmp/zerodha_totp_fail_{ts}.png"
                        await page.screenshot(path=shot_path, full_page=True)
                        logger.warning(
                            "zerodha_auto_login_totp_fail_screenshot",
                            extra={"path": shot_path, "url": final_url_snip},
                        )
                    except Exception:
                        shot_path = None
                    msg = (
                        f"Kite never issued a request_token. "
                        f"Page URL: {final_url_snip}"
                    )
                    if err_text:
                        msg += f" | Kite said: {err_text}"
                    if shot_path:
                        msg += f" | screenshot: {shot_path}"
                    raise AutoLoginError(msg, stage="totp_submit")

                # ── Stage: exchange via the existing service ────
                from app.services.zerodha_service import zerodha as _zerodha

                try:
                    result = await _zerodha.generate_session(request_token)
                    access = (
                        result.get("accessToken") if isinstance(result, dict)
                        else None
                    )
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
                    raise AutoLoginError(
                        f"Kite generate_session failed: {exc}",
                        stage="session",
                    ) from exc

                if not access:
                    raise AutoLoginError(
                        "Kite did not return an access_token",
                        stage="session",
                    )
                return str(access)
            finally:
                try:
                    await browser.close()
                except Exception:
                    pass

    # ── Small Playwright helpers ───────────────────────────────────
    async def _fill_first(self, page, selectors: list[str], value: str) -> None:
        last_exc: Exception | None = None
        for sel in selectors:
            try:
                el = await page.query_selector(sel)
                if el is not None:
                    await el.fill(value)
                    return
            except Exception as exc:
                last_exc = exc
        raise RuntimeError(
            f"no selector matched: {selectors!r} ({last_exc})"
        )

    async def _read_visible_error(self, page) -> str | None:
        try:
            loc = page.locator(
                '.error, .alert, [class*="invalid"], [class*="error"]'
            ).first
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

    # ── Scheduler helpers ──────────────────────────────────────────
    async def is_enabled(self) -> bool:
        doc = await ZerodhaAutoLogin.find_one()
        return bool(doc and doc.is_enabled)

    async def schedule_time(self) -> str:
        doc = await ZerodhaAutoLogin.find_one()
        return doc.schedule_time_ist if doc else "07:00"


zerodha_auto_login = ZerodhaAutoLoginService()
