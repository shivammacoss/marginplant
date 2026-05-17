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

from app.services import market_data_service

logger = logging.getLogger(__name__)
router = APIRouter()


@router.websocket("/ws/marketdata")
async def market_ws(ws: WebSocket) -> None:
    await ws.accept()
    subscribed: set[str] = set()
    pump_task: asyncio.Task | None = None

    async def pump():
        # 250 ms pump — the underlying Zerodha tick cache typically refreshes
        # 2–4 times per second per active instrument, so 250 ms is the
        # sweet spot: any faster and we'd be re-broadcasting identical
        # snapshots; any slower (the old 1 s) and the position panel's
        # CURRENT visibly trails the order panel's BUY/SELL strip.
        #
        # Quotes are fetched in parallel via `asyncio.gather`. Previously
        # a sequential for-loop awaited each `get_quote` one-by-one —
        # with 80 subscribed tokens (Market page after a search) and any
        # single token hitting Zerodha REST fallback (~200-2000 ms), the
        # pump cycle stretched to 4-16 seconds. Net effect: prices on
        # the Market list "loaded in slow motion". Gather'd it's bounded
        # by the SLOWEST single overlay, not the sum — typically
        # 50-150 ms total for the full set since Zerodha / Infoway hits
        # are in-memory cache lookups on the happy path.
        try:
            while True:
                if subscribed:
                    tokens_now = list(subscribed)
                    results = await asyncio.gather(
                        *(market_data_service.get_quote(t) for t in tokens_now),
                        return_exceptions=True,
                    )
                    snapshots = [
                        r for r in results if isinstance(r, dict)
                    ]
                    if snapshots:
                        await ws.send_text(json.dumps({"type": "tick", "payload": snapshots}, default=str))
                await asyncio.sleep(0.25)
        except (WebSocketDisconnect, asyncio.CancelledError):
            return
        except Exception as e:  # pragma: no cover
            logger.exception("market_ws_pump_failed", extra={"error": str(e)})

    try:
        # Send an initial hello
        await ws.send_text(json.dumps({"type": "hello", "message": "market_ws_connected"}))
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
                tokens = list(msg.get("tokens") or [])
                subscribed.update(tokens)
                market_data_service.subscribe(tokens)
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
                tokens = list(msg.get("tokens") or [])
                subscribed.difference_update(tokens)
                market_data_service.unsubscribe(tokens)
            elif t == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
            else:
                await ws.send_text(json.dumps({"type": "error", "message": "unknown_type"}))

    except WebSocketDisconnect:
        pass
    finally:
        if pump_task is not None:
            pump_task.cancel()
        market_data_service.unsubscribe(list(subscribed))
