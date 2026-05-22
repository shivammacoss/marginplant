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

from app.api.ws._helpers import is_connected, safe_send_text
from app.core.config import settings
from app.core.ws_hub import market_tick_hub
from app.core.ws_limiter import acquire as ws_limit_acquire
from app.core.ws_limiter import client_ip as ws_client_ip
from app.core.ws_limiter import release as ws_limit_release
from app.services import market_data_service

logger = logging.getLogger(__name__)
router = APIRouter()


@router.websocket("/ws/marketdata")
async def market_ws(ws: WebSocket) -> None:
    """Per-client market-data socket.

    Internal change: realtime ticks now arrive via the process-wide
    ``MarketTickHub`` (one shared Redis pub/sub for the whole worker)
    instead of opening a dedicated pub/sub connection per client. The
    hub maintains an in-memory ``token -> set[WebSocket]`` map and
    fans each tick out to every subscribed socket.

    The wire-level WebSocket protocol the client speaks (subscribe /
    unsubscribe / ping / snapshot / tick frames, message shapes,
    ordering) is completely unchanged — only the routing inside the
    server is consolidated. Both the initial subscribe-time snapshot
    and the 5 s heartbeat-snapshot pump are preserved exactly.
    """
    # Per-IP rate limit — reject before accept() so a flooding client
    # doesn't even get a connection slot. Code 4429 mirrors HTTP 429.
    ip = ws_client_ip(ws)
    if not await ws_limit_acquire(ip, max_per_ip=settings.WS_MAX_CONNECTIONS_PER_IP):
        await ws.close(code=4429)
        return

    await ws.accept()
    subscribed: set[str] = set()
    pump_task: asyncio.Task | None = None

    async def pump():
        # 5 s heartbeat snapshot. The hub carries the realtime path;
        # this just guarantees eventual consistency if a publish ever
        # gets dropped (Redis reconnect, pool exhaustion, etc.) — the
        # client's stored LTP never drifts more than 5 s from reality
        # even in worst case.
        try:
            while True:
                await asyncio.sleep(5)
                if not is_connected(ws):
                    return
                if not subscribed:
                    continue
                tokens_now = list(subscribed)
                results = await asyncio.gather(
                    *(market_data_service.get_quote(t) for t in tokens_now),
                    return_exceptions=True,
                )
                snapshots = [r for r in results if isinstance(r, dict)]
                if snapshots:
                    if not await safe_send_text(
                        ws,
                        json.dumps({"type": "tick", "payload": snapshots}, default=str),
                    ):
                        return
        except (WebSocketDisconnect, asyncio.CancelledError):
            return
        except Exception as e:  # pragma: no cover
            logger.exception("market_ws_pump_failed", extra={"error": str(e)})

    try:
        # Hub is started eagerly in the FastAPI lifespan. ``start()``
        # is idempotent so a stray race here is still safe.
        await market_tick_hub.start()

        await safe_send_text(
            ws, json.dumps({"type": "hello", "message": "market_ws_connected"})
        )
        pump_task = asyncio.create_task(pump())

        while True:
            data = await ws.receive_text()
            try:
                msg: dict[str, Any] = json.loads(data)
            except json.JSONDecodeError:
                await safe_send_text(
                    ws, json.dumps({"type": "error", "message": "invalid_json"})
                )
                continue

            t = msg.get("type")
            if t == "subscribe":
                tokens = [str(x) for x in (msg.get("tokens") or []) if x]
                # Newly-requested tokens go into both the hub (so ticks
                # start flowing immediately) and the upstream feed
                # ref-count (so the underlying provider keeps pulling
                # them). Already-subscribed tokens are skipped to keep
                # the hub map free of duplicate add() noise.
                new_tokens = [tok for tok in tokens if tok not in subscribed]
                # Per-connection subscription cap — refuse the whole
                # batch when accepting it would push the socket past
                # `WS_MAX_SUBSCRIPTIONS_PER_CONN`. Partial-accept would
                # leave the client wondering which symbols streamed and
                # which silently dropped; a clean reject + explicit
                # `subscription_limit` error frame lets the frontend
                # toast the user with an actionable "unsubscribe
                # something first" message. Already-subscribed tokens
                # in the batch are free — they don't count against the
                # quota.
                cap = settings.WS_MAX_SUBSCRIPTIONS_PER_CONN
                if cap > 0 and len(subscribed) + len(new_tokens) > cap:
                    await safe_send_text(
                        ws,
                        json.dumps({
                            "type": "error",
                            "code": "subscription_limit",
                            "limit": cap,
                            "current": len(subscribed),
                            "attempted": len(new_tokens),
                            "message": (
                                f"Subscription limit reached "
                                f"({len(subscribed)}/{cap} active). "
                                f"Unsubscribe some symbols before adding new ones."
                            ),
                        }),
                    )
                    continue
                subscribed.update(tokens)
                for tok in new_tokens:
                    market_tick_hub.add(tok, ws)
                if new_tokens:
                    market_data_service.subscribe(new_tokens)
                # Initial snapshots — parallel fetch so a freshly-typed
                # search ("G" → 80 results) doesn't block the client for
                # the sum of every quote's overlay latency. Failed quotes
                # are silently dropped so one slow Zerodha REST call
                # can't delay the whole batch. After this, the hub
                # streams every subsequent tick in realtime.
                if tokens:
                    results = await asyncio.gather(
                        *(market_data_service.get_quote(tok) for tok in tokens),
                        return_exceptions=True,
                    )
                    snaps = [r for r in results if isinstance(r, dict)]
                else:
                    snaps = []
                await safe_send_text(
                    ws,
                    json.dumps({"type": "snapshot", "payload": snaps}, default=str),
                )
            elif t == "unsubscribe":
                tokens = [str(x) for x in (msg.get("tokens") or []) if x]
                gone = [tok for tok in tokens if tok in subscribed]
                subscribed.difference_update(tokens)
                for tok in gone:
                    market_tick_hub.remove(tok, ws)
                if gone:
                    market_data_service.unsubscribe(gone)
            elif t == "ping":
                await safe_send_text(ws, json.dumps({"type": "pong"}))
            else:
                await safe_send_text(
                    ws, json.dumps({"type": "error", "message": "unknown_type"})
                )

    except WebSocketDisconnect:
        pass
    except Exception:  # pragma: no cover
        logger.exception("market_ws_main_failed")
    finally:
        if pump_task is not None:
            pump_task.cancel()
            try:
                await pump_task
            except (asyncio.CancelledError, Exception):  # pragma: no cover
                pass
        # Detach from every token we registered so the hub's subscriber
        # map doesn't leak. Targeted ``remove()`` per token keeps this
        # O(K_per_client) instead of scanning every token the hub knows
        # about — important under disconnect storms with thousands of
        # tokens platform-wide.
        for tok in list(subscribed):
            try:
                market_tick_hub.remove(tok, ws)
            except Exception:  # pragma: no cover
                pass
        # Tell the upstream feed we no longer need these tokens.
        if subscribed:
            try:
                market_data_service.unsubscribe(list(subscribed))
            except Exception:  # pragma: no cover
                pass
        # Release per-IP connection slot.
        try:
            await ws_limit_release(ip)
        except Exception:  # pragma: no cover
            pass
