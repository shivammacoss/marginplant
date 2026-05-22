"""Celery tasks for the white-label branding subsystem.

Currently a single task: ``provision_ssl(admin_id)`` runs
``certbot --nginx`` for the admin's custom domain (apex + www) and
flips the User row's ``custom_domain_status`` to READY / FAILED.

Server prerequisites (see ``deploy/README.md``):

* ``certbot`` and ``python3-certbot-nginx`` installed.
* The backend's OS user has passwordless sudo for ``/usr/bin/certbot``
  and ``/usr/sbin/nginx`` (via ``/etc/sudoers.d/marginplant``).
* ``settings.PLATFORM_PUBLIC_IP`` set in ``.env`` — admins point
  their A records here.

If ANY of the above is missing, the task gracefully marks the row
FAILED with a human-readable error instead of crashing.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
import subprocess
from typing import Final

from app.workers.celery_app import celery_app

logger = logging.getLogger(__name__)


CERTBOT_TIMEOUT_SEC: Final[int] = 180
CERTBOT_EMAIL_DEFAULT: Final[str] = "ops@marginplant.com"


@celery_app.task(
    name="app.workers.branding_tasks.provision_ssl",
    bind=True,
    autoretry_for=(),  # explicit no-auto-retry — we manage status ourselves
    max_retries=0,
)
def provision_ssl(self, admin_id: str) -> dict:
    """Run certbot for an admin's custom_domain and flip status.

    Returns a small dict the result backend can serialize so an
    operator inspecting `celery events` sees what happened.
    """
    from app.core.database import close_database, init_database
    from app.models.user import User
    from app.services import branding_service
    from beanie import PydanticObjectId

    async def _run() -> dict:
        await init_database()
        try:
            user = await User.get(PydanticObjectId(admin_id))
            if user is None:
                return {"ok": False, "error": "admin_not_found"}

            # Idempotency: if status is already READY / not PROVISIONING,
            # bail without touching certbot.
            if user.custom_domain_status != branding_service.STATUS_PROVISIONING:
                return {
                    "ok": False,
                    "error": f"unexpected_status={user.custom_domain_status}",
                }

            domain = user.custom_domain
            if not domain:
                await branding_service.mark_domain_failed(
                    user.id, "custom_domain unset on row"
                )
                return {"ok": False, "error": "no_domain"}

            # Sanity: certbot binary present?
            if shutil.which("certbot") is None:
                await branding_service.mark_domain_failed(
                    user.id,
                    "certbot is not installed on this host. "
                    "Run `apt install certbot python3-certbot-nginx`.",
                )
                return {"ok": False, "error": "certbot_missing"}

            cmd = [
                "sudo",
                "-n",  # never prompt for a password — fail fast if sudoers is wrong
                "certbot",
                "--nginx",
                "-d",
                domain,
                "-d",
                f"www.{domain}",
                "--non-interactive",
                "--agree-tos",
                "-m",
                CERTBOT_EMAIL_DEFAULT,
                "--redirect",
            ]

            logger.info(
                "branding_provision_ssl_start admin_id=%s domain=%s", admin_id, domain
            )
            try:
                result = subprocess.run(  # noqa: S603 — controlled args
                    cmd,
                    timeout=CERTBOT_TIMEOUT_SEC,
                    capture_output=True,
                    text=True,
                )
            except subprocess.TimeoutExpired:
                await branding_service.mark_domain_failed(
                    user.id,
                    f"certbot timed out after {CERTBOT_TIMEOUT_SEC}s. "
                    "Check the worker can reach Let's Encrypt.",
                )
                return {"ok": False, "error": "timeout"}
            except FileNotFoundError:
                await branding_service.mark_domain_failed(
                    user.id, "sudo or certbot not found in PATH"
                )
                return {"ok": False, "error": "binary_missing"}

            if result.returncode != 0:
                stderr = (result.stderr or "").strip()
                stdout = (result.stdout or "").strip()
                err = (stderr or stdout or "certbot failed without output")[:500]
                logger.warning(
                    "branding_provision_ssl_failed admin_id=%s rc=%d err=%s",
                    admin_id,
                    result.returncode,
                    err,
                )
                await branding_service.mark_domain_failed(user.id, err)
                return {"ok": False, "error": "certbot_failed", "rc": result.returncode}

            # Belt-and-braces: certbot --nginx normally reloads nginx
            # after patching its config, but a stale process listing
            # has been seen on Ubuntu 22 — explicit reload is cheap.
            try:
                subprocess.run(  # noqa: S603
                    ["sudo", "-n", "nginx", "-s", "reload"],
                    timeout=15,
                    capture_output=True,
                    text=True,
                )
            except Exception:  # pragma: no cover
                logger.exception(
                    "branding_nginx_reload_failed admin_id=%s", admin_id
                )

            await branding_service.mark_domain_ready(user.id)

            # Best-effort admin-events ping so an open admin UI sees
            # the live status flip without polling.
            try:
                from app.services.admin_events import publish_admin_event

                await publish_admin_event(
                    "branding_domain_ready",
                    {"admin_id": str(user.id), "domain": domain},
                )
            except Exception:  # pragma: no cover
                pass

            logger.info(
                "branding_provision_ssl_ready admin_id=%s domain=%s", admin_id, domain
            )
            return {"ok": True, "domain": domain}
        finally:
            await close_database()

    return asyncio.run(_run())
