"""User WebSocket channel — pushes order/position/wallet events live.

Auth: query param `?token=<jwt>` (browsers can't add custom headers on WS).

Subscribes the authenticated user's socket to two Redis pub/sub channels:
    user:{user_id}:positions   — admin edits / force-close events
    user:{user_id}:orders      — order status changes (fills, rejects)
    user:{user_id}:wallet      — balance / margin changes

Any message published on those channels is forwarded as-is to the browser,
which then invalidates the right React Query cache and re-renders without
a page refresh.
"""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from app.core.redis_client import pubsub
from app.core.security import decode_token

logger = logging.getLogger(__name__)
router = APIRouter()


@router.websocket("/ws/user")
async def user_ws(ws: WebSocket, token: str = Query(...)):
    try:
        payload = decode_token(token, expected_type="access")
        user_id = payload.get("sub")
        if not user_id:
            await ws.close(code=4401)
            return
    except Exception:
        await ws.close(code=4401)
        return

    await ws.accept()
    await ws.send_text(json.dumps({"type": "hello", "user_id": user_id}))

    channels = [
        f"user:{user_id}:positions",
        f"user:{user_id}:orders",
        f"user:{user_id}:wallet",
        f"user:{user_id}:kyc",
    ]
    ps = pubsub()
    try:
        await ps.subscribe(*channels)
    except Exception as e:  # pragma: no cover
        logger.warning("user_ws_subscribe_failed", extra={"error": str(e)})
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
            # Ignore subscribe/unsubscribe acks; only forward real messages.
            if msg.get("type") != "message":
                continue
            raw = msg.get("data")
            if isinstance(raw, bytes):
                try:
                    raw = raw.decode("utf-8")
                except UnicodeDecodeError:
                    continue
            # Best-effort JSON forward — pass through as a `data` string if not JSON.
            try:
                parsed = json.loads(raw) if raw else None
            except (ValueError, TypeError):
                parsed = {"data": raw}
            await ws.send_text(json.dumps(parsed if parsed is not None else {"data": raw}))
    except WebSocketDisconnect:
        return
    except Exception as e:  # pragma: no cover
        logger.warning("user_ws_failed", extra={"error": str(e)})
    finally:
        hb_task.cancel()
        try:
            await ps.unsubscribe(*channels)
            await ps.close()
        except Exception:  # pragma: no cover
            pass
