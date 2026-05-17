"""Admin WebSocket channel — pushes platform-wide events live.

Auth: query params `?token=<admin_jwt>&key=<admin_api_key>` because
browsers can't add custom headers on a WebSocket handshake (so we mirror
the X-Admin-Api-Key check from `get_current_admin` via the query string).

Once authenticated the socket subscribes to a single global pub/sub
channel:

    admin:events   — every admin-relevant event across the platform
                     (position close, order fill, deposit submit/approve,
                     withdrawal submit/approve, KYC submit, etc.)

Any message published on that channel is forwarded as-is to the browser,
which then invalidates the right React Query cache and re-renders the
affected admin page without anyone hitting F5.

A single shared channel (rather than per-admin) keeps the publish path
cheap — emitters fire one message no matter how many admins are watching.
"""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from app.core.config import settings
from app.core.redis_client import pubsub
from app.core.security import decode_token
from app.models.user import User, UserRole

logger = logging.getLogger(__name__)
router = APIRouter()


ADMIN_CHANNEL = "admin:events"

# Roles that are allowed to attach to the admin WS. Mirrors the
# `ADMIN_ROLES` set used by `get_current_admin`. Kept local so a future
# scoped-broker view (only sees their users' events) can be added without
# touching the HTTP dependency.
_ADMIN_ROLES = {UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.BROKER}


@router.websocket("/ws/admin")
async def admin_ws(
    ws: WebSocket,
    token: str = Query(...),
    key: str = Query(..., description="Admin API key — same value as the X-Admin-Api-Key header"),
):
    # ── Auth ────────────────────────────────────────────────────────
    # 1) API-key gate (same value the HTTP dependency checks). Without
    #    this the admin role check below would be the only barrier — and
    #    the HTTP layer enforces both, so the WS should match.
    expected = settings.ADMIN_API_KEY.get_secret_value()
    if not expected or key != expected:
        await ws.close(code=4401)
        return

    # 2) JWT — admin access token, same shape as the HTTP bearer.
    try:
        payload = decode_token(token, expected_type="access")
        user_id = payload.get("sub")
    except Exception:
        await ws.close(code=4401)
        return
    if not user_id:
        await ws.close(code=4401)
        return

    # 3) Admin role gate (DB lookup so a freshly-demoted account can't
    #    keep a stale socket open). Beanie is initialised by the lifespan
    #    so a direct `.get` is safe here.
    try:
        from beanie import PydanticObjectId

        user = await User.get(PydanticObjectId(user_id))
    except Exception:
        await ws.close(code=4401)
        return
    if user is None or user.role not in _ADMIN_ROLES:
        await ws.close(code=4403)
        return

    await ws.accept()
    await ws.send_text(
        json.dumps({"type": "hello", "user_id": str(user.id), "role": user.role.value})
    )

    ps = pubsub()
    try:
        await ps.subscribe(ADMIN_CHANNEL)
    except Exception as e:  # pragma: no cover
        logger.warning("admin_ws_subscribe_failed", extra={"error": str(e)})
        await ws.close(code=4500)
        return

    async def heartbeat():
        try:
            while True:
                await asyncio.sleep(25)
                await ws.send_text(json.dumps({"type": "heartbeat"}))
        except (WebSocketDisconnect, asyncio.CancelledError):
            return
        except Exception:  # pragma: no cover
            return

    hb_task = asyncio.create_task(heartbeat())

    try:
        async for msg in ps.listen():
            if msg.get("type") != "message":
                continue
            raw = msg.get("data")
            if isinstance(raw, bytes):
                try:
                    raw = raw.decode("utf-8")
                except UnicodeDecodeError:
                    continue
            try:
                parsed = json.loads(raw) if raw else None
            except (ValueError, TypeError):
                parsed = {"data": raw}
            await ws.send_text(
                json.dumps(parsed if parsed is not None else {"data": raw})
            )
    except WebSocketDisconnect:
        return
    except Exception as e:  # pragma: no cover
        logger.warning("admin_ws_failed", extra={"error": str(e)})
    finally:
        hb_task.cancel()
        try:
            await ps.unsubscribe(ADMIN_CHANNEL)
            await ps.close()
        except Exception:  # pragma: no cover
            pass
