"""Async Redis client + helpers (cache, pub/sub, sliding-window rate limiter)."""

from __future__ import annotations

import json
import logging
from typing import Any

import asyncio

import redis.asyncio as redis_asyncio
from redis.asyncio import ConnectionPool, Redis

from app.core.config import settings
from app.core.resilience import redis_retry

logger = logging.getLogger(__name__)

_pool: ConnectionPool | None = None
_client: Redis | None = None

# ── Publish circuit breaker ────────────────────────────────────────────
# When the connection pool is briefly exhausted under a tick burst,
# `publish()` previously dropped the message silently and returned 0.
# Subscribers (every connected user's WS) lost that tick forever.
#
# New behaviour: failed publishes are pushed onto an in-memory bounded
# queue and a single drainer task retries them once the pool frees up.
# The queue is hard-capped so a sustained outage cannot blow the
# process heap; oldest entries are dropped when the cap is hit and a
# Prometheus counter (`redis_publish_dropped_total`) records each drop
# so SREs can alert on it.
_PUBLISH_QUEUE_MAX = 2000
_publish_queue: asyncio.Queue[tuple[str, str]] | None = None
_drain_task: asyncio.Task | None = None

# Optional Prometheus counters — module imports cleanly without prom_client.
_pub_dropped_counter = None
_pub_enqueued_counter = None
_pub_drained_counter = None
try:  # pragma: no cover - optional dep
    from prometheus_client import Counter as _Counter

    _pub_dropped_counter = _Counter(
        "redis_publish_dropped_total",
        "Pub/sub messages dropped because the queue was full or drain repeatedly failed",
    )
    _pub_enqueued_counter = _Counter(
        "redis_publish_enqueued_total",
        "Pub/sub messages parked in the in-memory queue after a direct publish failed",
    )
    _pub_drained_counter = _Counter(
        "redis_publish_drained_total",
        "Pub/sub messages successfully drained from the queue on retry",
    )
except Exception:  # pragma: no cover
    pass


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
    # Start the publish-circuit-breaker drainer. Bounded queue + single
    # drainer means at most one extra connection is consumed for retries,
    # and the drainer auto-backs-off when the pool is still saturated.
    global _publish_queue, _drain_task
    _publish_queue = asyncio.Queue(maxsize=_PUBLISH_QUEUE_MAX)
    _drain_task = asyncio.create_task(_publish_drain_loop())
    logger.info("redis_connected")


async def close_redis() -> None:
    global _pool, _client, _drain_task, _publish_queue
    # Cancel the drainer first so it can't try to use the client mid-shutdown.
    if _drain_task is not None:
        _drain_task.cancel()
        try:
            await _drain_task
        except (asyncio.CancelledError, Exception):  # pragma: no cover
            pass
        _drain_task = None
    _publish_queue = None
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
# All four helpers are wrapped in `redis_retry` so a single transient
# connection / timeout error surfaces as a brief retry instead of a
# 500 to the user. They are idempotent: SET / GET / DEL / SCAN+DEL all
# converge to the same end state regardless of how many attempts run.
# Non-idempotent paths (`publish`, `idempotency_check_and_set`,
# `sliding_window_check`) are intentionally NOT wrapped because a retry
# after a partial server-side success could change semantics.
@redis_retry(name="cache_set")
async def cache_set(key: str, value: Any, ttl_sec: int | None = None) -> None:
    payload = json.dumps(value, default=str)
    if ttl_sec is not None:
        await get_redis().setex(key, ttl_sec, payload)
    else:
        await get_redis().set(key, payload)


@redis_retry(name="cache_get")
async def cache_get(key: str) -> Any | None:
    raw = await get_redis().get(key)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


@redis_retry(name="cache_delete")
async def cache_delete(*keys: str) -> int:
    if not keys:
        return 0
    return int(await get_redis().delete(*keys))


@redis_retry(name="cache_delete_pattern")
async def cache_delete_pattern(pattern: str) -> int:
    """Delete keys by pattern using SCAN to avoid blocking."""
    r = get_redis()
    deleted = 0
    async for key in r.scan_iter(match=pattern, count=500):
        deleted += int(await r.delete(key))
    return deleted


# ── Pub/Sub (used by ws_manager.pubsub for cross-instance fanout) ─────
def _drop_oldest() -> None:
    """Pop one item to make room when the queue is full. Counts the drop."""
    if _publish_queue is None:
        return
    try:
        _publish_queue.get_nowait()
        _publish_queue.task_done()
    except asyncio.QueueEmpty:  # pragma: no cover
        return
    if _pub_dropped_counter is not None:
        try:
            _pub_dropped_counter.inc()
        except Exception:  # pragma: no cover
            pass


def _enqueue_publish(channel: str, payload_str: str) -> None:
    """Best-effort enqueue. Drops oldest if full so the newest tick wins
    — stale tick data is worse than missing tick data."""
    if _publish_queue is None:
        # Pre-init or post-close — nothing we can do, count as dropped.
        if _pub_dropped_counter is not None:
            try:
                _pub_dropped_counter.inc()
            except Exception:  # pragma: no cover
                pass
        return
    try:
        _publish_queue.put_nowait((channel, payload_str))
    except asyncio.QueueFull:
        _drop_oldest()
        try:
            _publish_queue.put_nowait((channel, payload_str))
        except asyncio.QueueFull:  # pragma: no cover
            if _pub_dropped_counter is not None:
                try:
                    _pub_dropped_counter.inc()
                except Exception:
                    pass
            return
    if _pub_enqueued_counter is not None:
        try:
            _pub_enqueued_counter.inc()
        except Exception:  # pragma: no cover
            pass


async def _publish_drain_loop() -> None:
    """Single-task drainer: pops queued publishes and retries them. Uses
    its own exponential backoff when the pool is still saturated so it
    doesn't tight-loop and worsen the contention."""
    backoff = 0.05
    while True:
        try:
            if _publish_queue is None:
                # Lost reference during shutdown.
                return
            channel, payload_str = await _publish_queue.get()
        except asyncio.CancelledError:
            return
        try:
            await get_redis().publish(channel, payload_str)
            backoff = 0.05
            if _pub_drained_counter is not None:
                try:
                    _pub_drained_counter.inc()
                except Exception:  # pragma: no cover
                    pass
        except redis_asyncio.ConnectionError as e:
            msg = str(e).lower()
            if "too many connections" in msg:
                # Pool still saturated. Re-park the message at the back
                # of the queue (or drop oldest if it's full again) and
                # back off so we don't burn CPU.
                _enqueue_publish(channel, payload_str)
            else:
                # Genuine connection failure — drop and log; we'd loop
                # forever otherwise.
                logger.warning(
                    "redis_publish_drain_dropped channel=%s err=%s", channel, e
                )
                if _pub_dropped_counter is not None:
                    try:
                        _pub_dropped_counter.inc()
                    except Exception:  # pragma: no cover
                        pass
            try:
                await asyncio.sleep(min(backoff, 1.0))
            except asyncio.CancelledError:
                return
            backoff = min(backoff * 2.0, 1.0)
        except asyncio.CancelledError:
            return
        except Exception as e:
            # Unknown failure — drop and continue. Never let the drainer die.
            logger.exception("redis_publish_drain_unexpected channel=%s", channel)
            if _pub_dropped_counter is not None:
                try:
                    _pub_dropped_counter.inc()
                except Exception:  # pragma: no cover
                    pass
        finally:
            if _publish_queue is not None:
                try:
                    _publish_queue.task_done()
                except ValueError:  # pragma: no cover — shouldn't happen
                    pass


async def publish(channel: str, payload: Any) -> int:
    """Pub/sub publish with a circuit breaker.

    Fast path: direct publish on the shared client. On transient pool
    exhaustion ("Too many connections" under a tick burst), the message
    is parked on a bounded in-memory queue and a background drainer
    retries it once the pool frees up. This is a pure resilience
    improvement — callers see no behavioural difference on the success
    path, and the previous silent-drop on pool exhaustion is replaced
    by a best-effort retry. Genuine connection errors (Redis down,
    bad creds) still re-raise so the caller can surface them.
    """
    payload_str = json.dumps(payload, default=str)
    try:
        return int(await get_redis().publish(channel, payload_str))
    except redis_asyncio.ConnectionError as e:
        msg = str(e).lower()
        if "too many connections" in msg:
            logger.warning("redis_publish_pool_exhausted channel=%s queued=1", channel)
            _enqueue_publish(channel, payload_str)
            return 0
        raise


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
