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

    # Direct Redis pub/sub forward — gives the client every tick the moment
    # zerodha_service / infoway_service publishes it. Previously this
    # endpoint only ran a 250 ms polling pump (`get_quote()` for every
    # subscribed token), which capped delivery at 4 fps and made the APK's
    # P/L visibly trail the web terminal (which already consumes pub/sub
    # directly). Subscribing per-token to both feeds means each individual
    # tick arrives in ~10 ms instead of waiting for the next pump cycle.
    ps = pubsub()

    def _channels_for(tok: str) -> list[str]:
        # Don't know upfront whether a token is Zerodha (numeric) or
        # Infoway (e.g. "BTCUSDT"). Subscribe to BOTH channel patterns;
        # whichever feed actually owns this token will be the only one
        # that ever publishes — cheap.
        return [f"market:tick:{tok}", f"infoway:tick:{tok}"]

    async def listener():
        """Forwards every pub/sub tick to the client WS in real time."""
        try:
            async for msg in ps.listen():
                if msg.get("type") not in ("message", "pmessage"):
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
                tok = parsed.get("token") or parsed.get("symbol")
                if tok is not None:
                    parsed["token"] = str(tok)
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
        # Reduced from 250 ms → 5 s heartbeat snapshot. The pub/sub
        # listener above carries the realtime path; this just guarantees
        # eventual consistency if a publish ever gets dropped (Redis
        # reconnect, pool exhaustion, etc.) — the client's stored LTP
        # never drifts more than 5 s from reality even in worst case.
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
                new_tokens = [tok for tok in tokens if tok not in subscribed]
                subscribed.update(new_tokens)
                market_data_service.subscribe(tokens)
                # Wire up the pub/sub listener for the new tokens.
                if new_tokens:
                    channels: list[str] = []
                    for tok in new_tokens:
                        channels.extend(_channels_for(tok))
                    try:
                        await ps.subscribe(*channels)
                    except Exception:  # pragma: no cover
                        logger.warning(
                            "market_ws_pubsub_subscribe_failed",
                            extra={"count": len(channels)},
                        )
                # Initial snapshots — parallel fetch so a freshly-typed
                # search ("G" → 80 results) doesn't block the client for
                # the sum of every quote's overlay latency. Failed quotes
                # are silently dropped so one slow Zerodha REST call can't
                # delay the whole batch.
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
                drop = [tok for tok in tokens if tok in subscribed]
                subscribed.difference_update(drop)
                market_data_service.unsubscribe(tokens)
                if drop:
                    channels = []
                    for tok in drop:
                        channels.extend(_channels_for(tok))
                    try:
                        await ps.unsubscribe(*channels)
                    except Exception:  # pragma: no cover
                        pass
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
            if subscribed:
                channels = []
                for tok in subscribed:
                    channels.extend(_channels_for(tok))
                await ps.unsubscribe(*channels)
            await ps.close()
        except Exception:  # pragma: no cover
            pass
        market_data_service.unsubscribe(list(subscribed))
