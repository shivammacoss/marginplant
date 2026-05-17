"""Async Redis client + helpers (cache, pub/sub, sliding-window rate limiter)."""

from __future__ import annotations

import json
import logging
from typing import Any

import redis.asyncio as redis_asyncio
from redis.asyncio import ConnectionPool, Redis

from app.core.config import settings

logger = logging.getLogger(__name__)

_pool: ConnectionPool | None = None
_client: Redis | None = None


async def init_redis() -> None:
    global _pool, _client
    # Hard socket timeouts are critical on Windows: when the OS tears down a
    # connection ("network name no longer available", WinError 10054) without
    # sending FIN/RST, redis-py blocks indefinitely on the next .get/.set.
    # 2 s is generous for a localhost cache while still failing fast enough
    # that order placement (which calls cache_get inside the validator) can
    # surface the failure to the user instead of hanging the request.
    _pool = ConnectionPool.from_url(
        settings.REDIS_URL,
        max_connections=settings.REDIS_MAX_CONNECTIONS,
        decode_responses=True,
        socket_connect_timeout=2,
        socket_timeout=2,
        socket_keepalive=True,
        retry_on_timeout=True,
        health_check_interval=15,
    )
    _client = Redis(connection_pool=_pool)
    await _client.ping()
    logger.info("redis_connected")


async def close_redis() -> None:
    global _pool, _client
    if _client is not None:
        await _client.aclose()
        _client = None
    if _pool is not None:
        await _pool.aclose()
        _pool = None
    logger.info("redis_disconnected")


def get_redis() -> Redis:
    if _client is None:
        raise RuntimeError("Redis not initialized — call init_redis() first")
    return _client


async def healthcheck() -> bool:
    try:
        return bool(await get_redis().ping())
    except Exception:  # pragma: no cover
        return False


# ── JSON helpers ──────────────────────────────────────────────────────
async def cache_set(key: str, value: Any, ttl_sec: int | None = None) -> None:
    payload = json.dumps(value, default=str)
    if ttl_sec is not None:
        await get_redis().setex(key, ttl_sec, payload)
    else:
        await get_redis().set(key, payload)


async def cache_get(key: str) -> Any | None:
    raw = await get_redis().get(key)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


async def cache_delete(*keys: str) -> int:
    if not keys:
        return 0
    return int(await get_redis().delete(*keys))


async def cache_delete_pattern(pattern: str) -> int:
    """Delete keys by pattern using SCAN to avoid blocking."""
    r = get_redis()
    deleted = 0
    async for key in r.scan_iter(match=pattern, count=500):
        deleted += int(await r.delete(key))
    return deleted


# ── Pub/Sub (used by ws_manager.pubsub for cross-instance fanout) ─────
async def publish(channel: str, payload: Any) -> int:
    return int(await get_redis().publish(channel, json.dumps(payload, default=str)))


def pubsub() -> redis_asyncio.client.PubSub:
    return get_redis().pubsub()


# ── Sliding-window rate limit ─────────────────────────────────────────
async def sliding_window_check(
    key: str,
    *,
    max_requests: int,
    window_sec: int,
) -> tuple[bool, int]:
    """Return (allowed, current_count). Atomic via Lua."""
    lua = """
    local key = KEYS[1]
    local now = tonumber(ARGV[1])
    local window = tonumber(ARGV[2])
    local maxr = tonumber(ARGV[3])
    redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
    local count = redis.call('ZCARD', key)
    if count >= maxr then
      return {0, count}
    end
    redis.call('ZADD', key, now, now .. ':' .. math.random())
    redis.call('EXPIRE', key, window)
    return {1, count + 1}
    """
    import time

    now_ms = int(time.time() * 1000)
    res = await get_redis().eval(  # type: ignore[no-untyped-call]
        lua, 1, key, now_ms, window_sec * 1000, max_requests
    )
    allowed = bool(int(res[0]))
    count = int(res[1])
    return allowed, count


# ── Idempotency keys (orders, deposits, withdrawals) ──────────────────
async def idempotency_check_and_set(key: str, ttl_sec: int = 3600) -> bool:
    """Return True if key was newly set (caller should proceed); False if duplicate."""
    return bool(await get_redis().set(key, "1", ex=ttl_sec, nx=True))
