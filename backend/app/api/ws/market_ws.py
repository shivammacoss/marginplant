"""Market data WebSocket — clients subscribe to instrument tokens, receive
LTP / depth ticks pushed from the mock feed (or future external feed).

Protocol (JSON messages over a single WS):
    Client → Server:
        {"type":"subscribe","tokens":["..."] }
        {"type":"unsubscribe","tokens":["..."] }
        {"type":"ping"}
    Server → Client:
        {"type":"tick","payload":{...quote...}}
        {"type":"pong"}
        {"type":"error","message":"..."}
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.redis_client import pubsub
from app.services import market_data_service

logger = logging.getLogger(__name__)
router = APIRouter()


@router.websocket("/ws/marketdata")
async def market_ws(ws: WebSocket) -> None:
    await ws.accept()
    subscribed: set[str] = set()
    pump_task: asyncio.Task | None = None
    listener_task: asyncio.Task | None = None

    # ── Realtime forward via Redis pub/sub ─────────────────────────────
    # Previous design (per-token subscribe + listen race): calling
    # `ps.subscribe()` from the receive coroutine while another coroutine
    # was blocked inside `ps.listen()` deadlocked on redis-py asyncio's
    # internal connection lock, dropping forward throughput to ~0.1 tick/sec
    # while the feed itself was publishing 100+/sec (verified end-to-end
    # 19-May with BTCUSDT psubscribe rate at 70/sec, the WS test client
    # received 1 tick in 8s on the same token).
    #
    # New design: psubscribe to the TWO wildcard patterns once, before
    # the listener starts (so the listen-loop has live subscriptions on
    # the very first iteration), then filter incoming messages against
    # the per-client `subscribed` set. No subscribe/unsubscribe call
    # ever happens after the listener begins, so the race is gone. Cost:
    # the listener parses every published tick across the platform, but
    # the filter is an O(1) set lookup on a parsed JSON dict so even
    # with 100+ ticks/sec it's negligible per-connection.
    ps = pubsub()
    await ps.psubscribe("market:tick:*", "infoway:tick:*")

    async def listener():
        """Forwards every pub/sub tick to the client WS in real time."""
        try:
            async for msg in ps.listen():
                if msg.get("type") not in ("pmessage", "message"):
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
                    continue
                if not isinstance(parsed, dict):
                    continue
                # Normalise — APK expects `token` as a string. Infoway
                # publishes with `symbol`; copy it across so the client's
                # `toTick` mapper finds the field it expects.
                tok_raw = parsed.get("token") or parsed.get("symbol")
                if tok_raw is None:
                    continue
                tok = str(tok_raw)
                # Filter — only forward if this client cares about it.
                if tok not in subscribed:
                    continue
                parsed["token"] = tok
                try:
                    await ws.send_text(
                        json.dumps({"type": "tick", "payload": [parsed]}, default=str)
                    )
                except (WebSocketDisconnect, RuntimeError):
                    return
        except (WebSocketDisconnect, asyncio.CancelledError):
            return
        except Exception:  # pragma: no cover
            logger.exception("market_ws_listener_failed")

    async def pump():
        # 5 s heartbeat snapshot. The pub/sub listener above carries the
        # realtime path; this just guarantees eventual consistency if a
        # publish ever gets dropped (Redis reconnect, pool exhaustion,
        # etc.) — the client's stored LTP never drifts more than 5 s
        # from reality even in worst case.
        try:
            while True:
                await asyncio.sleep(5)
                if not subscribed:
                    continue
                tokens_now = list(subscribed)
                results = await asyncio.gather(
                    *(market_data_service.get_quote(t) for t in tokens_now),
                    return_exceptions=True,
                )
                snapshots = [r for r in results if isinstance(r, dict)]
                if snapshots:
                    await ws.send_text(
                        json.dumps({"type": "tick", "payload": snapshots}, default=str)
                    )
        except (WebSocketDisconnect, asyncio.CancelledError):
            return
        except Exception as e:  # pragma: no cover
            logger.exception("market_ws_pump_failed", extra={"error": str(e)})

    try:
        await ws.send_text(json.dumps({"type": "hello", "message": "market_ws_connected"}))
        listener_task = asyncio.create_task(listener())
        pump_task = asyncio.create_task(pump())

        while True:
            data = await ws.receive_text()
            try:
                msg: dict[str, Any] = json.loads(data)
            except json.JSONDecodeError:
                await ws.send_text(json.dumps({"type": "error", "message": "invalid_json"}))
                continue

            t = msg.get("type")
            if t == "subscribe":
                tokens = [str(x) for x in (msg.get("tokens") or []) if x]
                subscribed.update(tokens)
                market_data_service.subscribe(tokens)
                # Initial snapshots — parallel fetch so a freshly-typed
                # search ("G" → 80 results) doesn't block the client for
                # the sum of every quote's overlay latency. Failed quotes
                # are silently dropped so one slow Zerodha REST call can't
                # delay the whole batch. After this, the psubscribe
                # listener above streams every subsequent tick in realtime.
                if tokens:
                    results = await asyncio.gather(
                        *(market_data_service.get_quote(tok) for tok in tokens),
                        return_exceptions=True,
                    )
                    snaps = [r for r in results if isinstance(r, dict)]
                else:
                    snaps = []
                await ws.send_text(json.dumps({"type": "snapshot", "payload": snaps}, default=str))
            elif t == "unsubscribe":
                tokens = [str(x) for x in (msg.get("tokens") or []) if x]
                subscribed.difference_update(tokens)
                market_data_service.unsubscribe(tokens)
                # No pubsub unsubscribe needed — the filter in the
                # listener simply stops matching dropped tokens.
            elif t == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
            else:
                await ws.send_text(json.dumps({"type": "error", "message": "unknown_type"}))

    except WebSocketDisconnect:
        pass
    finally:
        if listener_task is not None:
            listener_task.cancel()
        if pump_task is not None:
            pump_task.cancel()
        try:
            await ps.punsubscribe("market:tick:*", "infoway:tick:*")
            await ps.close()
        except Exception:  # pragma: no cover
            pass
        market_data_service.unsubscribe(list(subscribed))
