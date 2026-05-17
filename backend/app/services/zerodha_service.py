"""Zerodha Kite Connect integration.

Wraps the official `kiteconnect` Python SDK:
  • REST: login URL, generate session, instruments CSV, quotes, historical data
  • WebSocket (KiteTicker): live binary tick stream for subscribed instruments

The service runs as a singleton (`zerodha`). Live ticks are kept in an
in-memory `ticks_cache` dict keyed by symbol AND token, and pushed to Redis
pub/sub channels for WS fanout to user browsers.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from app.core.redis_client import publish
from app.models.zerodha_settings import (
    SubscribedInstrument,
    WsStatus,
    ZerodhaSettings,
)
from app.utils.time_utils import now_utc

logger = logging.getLogger(__name__)
IST = ZoneInfo("Asia/Kolkata")


def _next_kite_expiry_utc() -> datetime:
    """Kite access tokens expire at 08:00 IST every day. Returns a timezone-
    aware UTC datetime so comparisons with `now_utc()` never fail."""
    now_ist = datetime.now(IST)
    target = now_ist.replace(hour=8, minute=0, second=0, microsecond=0)
    if now_ist >= target:
        target = target + timedelta(days=1)
    return target.astimezone(timezone.utc)


def _ensure_aware_utc(dt: datetime | None) -> datetime | None:
    """Coerce a naive datetime to UTC-aware. MongoDB/Beanie occasionally hand
    back naive datetimes for fields stored as aware originally — comparing
    those against `now_utc()` (which is always aware) raises ``TypeError:
    can't compare offset-naive and offset-aware datetimes``. Treat any naive
    expiry as UTC to keep the comparison safe."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


class ZerodhaService:
    """Kite Connect REST + WebSocket wrapper.

    Multi-WebSocket architecture:
    • Zerodha allows max 3000 tokens per single WebSocket connection.
    • We maintain a POOL of KiteTicker instances (self._tickers).
    • Subscriptions are tracked IN-MEMORY only (self._ws_subscriptions) —
      NOT saved to MongoDB to avoid DB bloat. Instruments are subscribed
      on-demand when users request quotes/charts.
    • When a new token needs subscribing, it's assigned to the least-loaded
      connection. If all connections are at capacity, a new one is spawned.
    """

    # Zerodha WebSocket limits:
    #   • Hard ceiling of 3000 tokens per WebSocket connection.
    #   • Only ONE active WS per access_token. The earlier multi-connection
    #     pool architecture spawned WS-2 / WS-3 with the same token and
    #     Kite rejected every retry with `403 Forbidden` on the WS upgrade.
    #     We now cap the pool at 1 connection to match the actual API
    #     contract — anyone needing >3000 tokens has to provision more
    #     accounts (each with its own access_token).
    MAX_TOKENS_PER_WS = 3000
    MAX_WS_CONNECTIONS = 1

    def __init__(self) -> None:
        # Live tick state (populated by KiteTicker callbacks)
        self.ticks_by_token: dict[int, dict[str, Any]] = {}
        self.ticks_by_symbol: dict[str, dict[str, Any]] = {}

        # Per-exchange instrument cache (CSV is huge: ~1MB+)
        self._instruments_cache: dict[str, list[dict[str, Any]]] = {}
        self._instruments_cache_at: float = 0.0
        self._INSTRUMENTS_TTL_SEC = 24 * 60 * 60  # 24h

        # REST `/quote` snapshot cache (used as a fallback when the WebSocket
        # has no live tick for an instrument — e.g. on weekends / pre-market).
        # Keyed by Kite "EXCH:TRADINGSYMBOL", value = (snapshot_dict, fetched_at).
        self._rest_quote_cache: dict[str, tuple[dict[str, Any], float]] = {}
        self._REST_QUOTE_TTL_SEC = 10.0

        # ─── Multi-WebSocket Pool ───────────────────────────────────
        # Each entry: {"ticker": KiteTicker, "tokens": set[int], "connected": bool}
        self._tickers: list[dict[str, Any]] = []
        self._ticker_lock = threading.Lock()

        # Reverse lookup: token → ticker index
        self._token_to_ws: dict[int, int] = {}

        # Symbol lookup for tick callbacks
        self._symbol_by_token: dict[int, dict[str, str]] = {}

        # Legacy compat
        self._ticker: Any = None

        # Loop reference for cross-thread Redis publishes
        self._main_loop: asyncio.AbstractEventLoop | None = None

    # ── Settings helpers ─────────────────────────────────────────────
    async def _get_settings(self) -> ZerodhaSettings:
        s = await ZerodhaSettings.find_one()
        if s is None:
            s = ZerodhaSettings()
            await s.insert()
        return s

    async def get_status(self) -> dict[str, Any]:
        s = await self._get_settings()
        pool = self.get_ws_pool_info()
        return {
            "isConfigured": bool(s.apiKey and s.apiSecret),
            "isConnected": s.isConnected,
            "wsStatus": s.wsStatus.value if hasattr(s.wsStatus, "value") else str(s.wsStatus),
            "lastConnected": s.lastConnected,
            "tokenExpiry": s.tokenExpiry,
            "subscribedCount": pool["total_tokens_subscribed"],
            "dbSubscribedCount": len(s.subscribedInstruments),
            "wsConnections": pool["total_connections"],
            "wsPool": pool,
            "enabledSegments": s.enabledSegments.model_dump(),
            "redirectUrl": s.redirectUrl,
        }

    async def get_settings_full(self) -> dict[str, Any]:
        from app.core.config import settings as app_settings

        s = await self._get_settings()
        token_expiry = _ensure_aware_utc(s.tokenExpiry)
        is_token_expired = bool(token_expiry and now_utc() >= token_expiry)
        default_redirect = app_settings.zerodha_redirect_url
        return {
            "apiKey": s.apiKey,
            "apiSecret": "***" if s.apiSecret else "",
            "apiSecretConfigured": bool(s.apiSecret),
            "isConnected": s.isConnected,
            "isTokenExpired": is_token_expired,
            "lastConnected": s.lastConnected,
            "tokenExpiry": s.tokenExpiry,
            "wsStatus": str(s.wsStatus),
            "wsLastError": s.wsLastError,
            "enabledSegments": s.enabledSegments.model_dump(),
            "subscribedInstruments": [i.model_dump() for i in s.subscribedInstruments],
            "redirectUrl": s.redirectUrl,
            # Canonical backend callback — admin UI uses this to detect/repair
            # mismatched configurations (e.g. someone pasting the frontend URL).
            "defaultRedirectUrl": default_redirect,
            "redirectUrlMismatch": s.redirectUrl != default_redirect,
        }

    async def update_settings(self, payload: dict[str, Any]) -> ZerodhaSettings:
        s = await self._get_settings()
        if "apiKey" in payload:
            s.apiKey = (payload["apiKey"] or "").strip()
        if "apiSecret" in payload and payload["apiSecret"]:
            # Don't overwrite when the UI sends the masked placeholder
            if payload["apiSecret"] != "***":
                s.apiSecret = payload["apiSecret"].strip()
        if "redirectUrl" in payload and payload["redirectUrl"]:
            url = str(payload["redirectUrl"]).strip()
            self._validate_redirect_url(url)
            s.redirectUrl = url
        if "enabledSegments" in payload and isinstance(payload["enabledSegments"], dict):
            for k, v in payload["enabledSegments"].items():
                if hasattr(s.enabledSegments, k):
                    setattr(s.enabledSegments, k, bool(v))
        await s.save()
        return s

    @staticmethod
    def _validate_redirect_url(url: str) -> None:
        """Sanity-check the redirect URL. Both frontends ship a `/api/v1/admin
        /zerodha/callback` proxy that forwards to the backend, so any of
        backend (8000), user-frontend (3000), or admin-frontend (3001) hosts
        are acceptable — but the path must be the right one."""
        from urllib.parse import urlparse

        try:
            parsed = urlparse(url)
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(f"Invalid redirect URL: {e}") from e
        if parsed.scheme not in ("http", "https"):
            raise RuntimeError("Redirect URL must start with http:// or https://")
        if not parsed.netloc:
            raise RuntimeError("Redirect URL is missing a host")
        if not parsed.path.endswith("/admin/zerodha/callback"):
            raise RuntimeError(
                "Redirect URL must end with /admin/zerodha/callback — that's the route Kite hits."
            )

    # ── KiteConnect REST client (lazy, recreated each call) ─────────
    def _kite(self, api_key: str, access_token: str | None = None):
        from kiteconnect import KiteConnect  # imported lazily to keep startup fast

        kc = KiteConnect(api_key=api_key)
        if access_token:
            kc.set_access_token(access_token)
        return kc

    async def _kite_with_token(self):
        s = await self._get_settings()
        if not s.apiKey or not s.accessToken:
            raise RuntimeError("Zerodha is not authenticated. Connect from admin panel.")
        expiry = _ensure_aware_utc(s.tokenExpiry)
        if expiry and now_utc() >= expiry:
            s.isConnected = False
            s.wsStatus = WsStatus.DISCONNECTED
            await s.save()
            raise RuntimeError("Zerodha token has expired (08:00 IST daily). Re-authenticate.")
        return self._kite(s.apiKey, s.accessToken), s

    # ── OAuth login flow ─────────────────────────────────────────────
    async def get_login_url(self) -> str:
        s = await self._get_settings()
        if not s.apiKey:
            raise RuntimeError("Zerodha API key is not configured")
        # KiteConnect.login_url() form
        return f"https://kite.zerodha.com/connect/login?v=3&api_key={s.apiKey}"

    async def generate_session(self, request_token: str) -> dict[str, Any]:
        """Exchange request_token for access_token (called by /callback)."""
        s = await self._get_settings()
        if not s.apiKey or not s.apiSecret:
            raise RuntimeError("API credentials are not configured")

        kc = self._kite(s.apiKey)
        try:
            data = await asyncio.to_thread(kc.generate_session, request_token, s.apiSecret)
        except Exception as e:
            raise RuntimeError(f"Kite session generation failed: {e}") from e

        access = data.get("access_token") if isinstance(data, dict) else None
        refresh = data.get("refresh_token") if isinstance(data, dict) else None
        if not access:
            raise RuntimeError("Kite did not return an access_token")

        s.accessToken = access
        s.refreshToken = refresh
        s.tokenExpiry = _next_kite_expiry_utc()
        s.isConnected = True
        s.lastConnected = now_utc()
        await s.save()

        # Pre-warm the instrument cache so on-demand search/subscribe is instant.
        # No bulk DB save — instruments are subscribed on-demand via WebSocket
        # when users open charts or search.
        try:
            for ex in ("NSE", "NFO", "MCX"):
                instruments = await self.fetch_instruments(ex)
                logger.info("zerodha_cache_warmed", extra={"exchange": ex, "count": len(instruments)})
        except Exception:
            logger.exception("zerodha_cache_warm_failed")

        # Start the WebSocket pool (empty — tokens subscribe on-demand)
        try:
            await self._start_ws_pool()
        except Exception:
            logger.exception("zerodha_ws_pool_start_failed")

        return {"accessToken": access, "tokenExpiry": s.tokenExpiry}

    async def _auto_load_default_subscriptions(self) -> int:
        """Resolve the curated default set against the live Zerodha instruments
        CSV and bulk-subscribe in one call. Fetches NSE/BSE/NFO catalogs
        directly from Kite API so the local DB can be empty. Returns count added."""
        from app.seed.zerodha_defaults import build_default_subscriptions

        defaults = await build_default_subscriptions(fetcher=self.fetch_instruments)
        if not defaults:
            return 0
        return await self.add_subscriptions_bulk(defaults)

    async def subscribe_all_instruments(
        self, exchanges: list[str] | None = None
    ) -> dict[str, Any]:
        """Fetch ALL instruments from Zerodha for specified exchanges and
        subscribe them via the multi-WebSocket pool. IN-MEMORY ONLY —
        nothing is saved to MongoDB.

        Multiple WS connections are spawned automatically (3000 tokens each).
        Default exchanges: NSE, NFO, BSE, MCX, BFO."""
        if exchanges is None:
            exchanges = ["NSE", "NFO", "BSE", "MCX", "BFO"]

        all_tokens: list[int] = []
        sym_map: dict[int, dict[str, str]] = {}
        per_exchange: dict[str, int] = {}

        for exchange in exchanges:
            try:
                instruments = await self.fetch_instruments(exchange)
                count = 0
                for inst in instruments:
                    token = int(inst.get("token") or 0)
                    if not token or token in sym_map:
                        continue
                    all_tokens.append(token)
                    sym_map[token] = {
                        "symbol": inst.get("symbol") or "",
                        "exchange": inst.get("exchange") or exchange,
                    }
                    count += 1
                per_exchange[exchange] = count
                logger.info(
                    "zerodha_subscribe_all_fetched",
                    extra={"exchange": exchange, "count": count},
                )
            except Exception:
                logger.exception("zerodha_subscribe_all_fetch_failed", extra={"exchange": exchange})
                per_exchange[exchange] = 0

        if not all_tokens:
            return {"total": 0, "added": 0, "per_exchange": per_exchange, "connections": 0}

        # Ensure WS pool is started
        s = await self._get_settings()
        if s.apiKey and s.accessToken:
            with self._ticker_lock:
                if not self._tickers:
                    await self._start_ws_pool()

        # Subscribe via multi-WS pool (spawns new connections as needed)
        added = await self.subscribe_tokens_on_demand(all_tokens, sym_map)

        pool_info = self.get_ws_pool_info()
        logger.info(
            "zerodha_subscribe_all_done",
            extra={
                "fetched": len(all_tokens),
                "added": added,
                "total_ws_subscribed": pool_info["total_tokens_subscribed"],
                "connections": pool_info["total_connections"],
            },
        )

        return {
            "fetched": len(all_tokens),
            "added": added,
            "total_ws_subscribed": pool_info["total_tokens_subscribed"],
            "connections": pool_info["total_connections"],
            "per_exchange": per_exchange,
        }

    async def disconnect(self) -> None:
        s = await self._get_settings()
        s.accessToken = None
        s.refreshToken = None
        s.tokenExpiry = None
        s.isConnected = False
        s.wsStatus = WsStatus.DISCONNECTED
        await s.save()
        self._stop_ticker()

    # ── Instruments ─────────────────────────────────────────────────
    async def fetch_instruments(self, exchange: str | None = None) -> list[dict[str, Any]]:
        """Pulls and caches the instruments CSV for a given exchange (NSE / BSE / NFO / MCX / BFO)."""
        cache_key = exchange or "ALL"
        import time as _time

        if (
            cache_key in self._instruments_cache
            and (_time.time() - self._instruments_cache_at) < self._INSTRUMENTS_TTL_SEC
        ):
            return self._instruments_cache[cache_key]

        kc, s = await self._kite_with_token()
        try:
            data = await asyncio.to_thread(kc.instruments, exchange) if exchange else await asyncio.to_thread(kc.instruments)
        except Exception as e:
            raise RuntimeError(f"Kite instruments fetch failed: {e}") from e

        # SDK already returns parsed dicts. Normalise field names so the rest
        # of the code can treat Zerodha and our domain identically.
        normalised: list[dict[str, Any]] = []
        for it in data:
            normalised.append(
                {
                    "token": int(it.get("instrument_token") or 0),
                    "symbol": (it.get("tradingsymbol") or "").strip(),
                    "exchange": (it.get("exchange") or "").strip(),
                    "segment": (it.get("segment") or "").strip(),
                    "name": (it.get("name") or "").strip(),
                    "lotSize": int(it.get("lot_size") or 1),
                    "tickSize": float(it.get("tick_size") or 0.05),
                    "expiry": it.get("expiry").isoformat() if it.get("expiry") else None,
                    "strike": float(it.get("strike")) if it.get("strike") not in (None, "") else None,
                    "instrumentType": (it.get("instrument_type") or "").strip(),
                }
            )
        self._instruments_cache[cache_key] = normalised
        self._instruments_cache_at = _time.time()
        s.instrumentsLastFetched = now_utc()
        await s.save()
        logger.info("zerodha_instruments_fetched", extra={"exchange": cache_key, "count": len(normalised)})
        return normalised

    @staticmethod
    def _segment_to_exchange(segment: str | None) -> str | None:
        return {
            "nseEq": "NSE",
            "bseEq": "BSE",
            "nseFut": "NFO",
            "nseOpt": "NFO",
            "mcxFut": "MCX",
            "mcxOpt": "MCX",
            "bseFut": "BFO",
            "bseOpt": "BFO",
        }.get(segment or "")

    @staticmethod
    def _matches_segment(inst: dict[str, Any], segment: str | None) -> bool:
        if not segment:
            return True
        seg = inst.get("segment") or ""
        ex = inst.get("exchange") or ""
        it = inst.get("instrumentType") or ""
        if segment == "nseEq":
            return seg == "NSE" and (it == "EQ" or not it)
        if segment == "bseEq":
            return seg in ("BSE", "BSE-EQ") and (it == "EQ" or not it)
        if segment == "nseFut":
            return seg == "NFO-FUT" or (ex == "NFO" and it == "FUT")
        if segment == "nseOpt":
            return seg == "NFO-OPT" or (ex == "NFO" and it in ("CE", "PE"))
        if segment == "mcxFut":
            return seg in ("MCX-FUT", "MCX") and it != "OPT" and it not in ("CE", "PE")
        if segment == "mcxOpt":
            return seg == "MCX-OPT" or (ex == "MCX" and it in ("CE", "PE"))
        if segment == "bseFut":
            return seg == "BFO-FUT" or (ex == "BFO" and it == "FUT")
        if segment == "bseOpt":
            return seg == "BFO-OPT" or (ex == "BFO" and it in ("CE", "PE"))
        return True

    async def search_instruments(
        self, query: str, segment: str | None = None, limit: int = 50
    ) -> list[dict[str, Any]]:
        if not query or len(query.strip()) < 2:
            return []
        ex = self._segment_to_exchange(segment)
        try:
            instruments = await self.fetch_instruments(ex) if ex else await self.fetch_instruments()
        except Exception as e:
            logger.warning("zerodha_search_fallback_to_subscribed", extra={"error": str(e)})
            s = await self._get_settings()
            instruments = [i.model_dump() for i in s.subscribedInstruments]

        q = query.strip().lower()
        results = [
            i
            for i in instruments
            if (q in (i.get("symbol") or "").lower() or q in (i.get("name") or "").lower())
            and self._matches_segment(i, segment)
        ]

        # Filter past expiries (IST date)
        today_ist = datetime.now(IST).date()
        results = [
            i
            for i in results
            if not i.get("expiry") or datetime.fromisoformat(i["expiry"]).date() >= today_ist
        ]
        return results[:limit]

    # ── Subscriptions ───────────────────────────────────────────────
    async def add_subscription(self, instrument: dict[str, Any]) -> bool:
        s = await self._get_settings()
        token = int(instrument.get("token") or 0)
        if not token:
            raise ValueError("instrument.token is required")
        if any(i.token == token for i in s.subscribedInstruments):
            return False
        sub = SubscribedInstrument(**instrument)
        s.subscribedInstruments.append(sub)
        await s.save()

        # Mirror into the local Instrument collection so user search / quote /
        # history hooks light up automatically (they all key off Instrument.token).
        try:
            await self._mirror_subscription_to_instrument(sub)
        except Exception:  # noqa: BLE001
            logger.exception("zerodha_mirror_failed", extra={"token": sub.token})

        # Subscribe on the live ticker (or start it if it isn't running yet —
        # admin shouldn't have to click "Start ticker" before data flows).
        try:
            self._ws_subscribe([token])
        except Exception:
            pass
        await self._ensure_ticker_running()
        return True

    async def add_subscriptions_bulk(self, instruments: list[dict[str, Any]]) -> int:
        s = await self._get_settings()
        existing = {i.token for i in s.subscribedInstruments}
        added_subs: list[SubscribedInstrument] = []
        new_tokens: list[int] = []
        for inst in instruments:
            token = int(inst.get("token") or 0)
            if not token or token in existing:
                continue
            sub = SubscribedInstrument(**inst)
            s.subscribedInstruments.append(sub)
            added_subs.append(sub)
            existing.add(token)
            new_tokens.append(token)
        if added_subs:
            await s.save()
            for sub in added_subs:
                try:
                    await self._mirror_subscription_to_instrument(sub)
                except Exception:  # noqa: BLE001
                    logger.exception("zerodha_mirror_failed", extra={"token": sub.token})
            try:
                self._ws_subscribe(new_tokens)
            except Exception:
                pass
            await self._ensure_ticker_running()
        return len(added_subs)

    # ── Mirror Zerodha subscription → local Instrument ──────────────
    async def _mirror_subscription_to_instrument(self, sub: SubscribedInstrument) -> None:
        """Upsert each Zerodha-subscribed instrument into the local
        ``Instrument`` collection so user-side search, quotes, history and
        positions all flow through normal code paths. The Zerodha
        ``instrument_token`` becomes the local ``Instrument.token`` so the
        market-data overlay can look up live ticks by token directly."""
        from datetime import datetime as _dt

        from bson import Decimal128

        from app.models._base import Exchange, InstrumentType, OptionType
        from app.models.instrument import Instrument

        # Exchange — fall back to NSE if Zerodha sends a value we don't model
        try:
            exchange = Exchange((sub.exchange or "").upper())
        except ValueError:
            return  # silently skip unsupported exchange

        # Instrument type. Zerodha subscribe payloads sometimes omit
        # `instrumentType` (or default it to "EQ") for derivative contracts,
        # leaving rows stored as EQ even though the tradingsymbol clearly
        # says FUT / <strike>CE / <strike>PE. When that happens the canonical
        # lot lookup is skipped and the order panel renders "1 lot = 1
        # units" for things like GOLD26JUNFUT. Fall back to symbol-suffix
        # inference whenever the explicit type is missing or contradicts
        # the symbol.
        from app.services.instrument_service import infer_instrument_type_from_symbol

        it_raw = (sub.instrumentType or "").upper()
        inferred = infer_instrument_type_from_symbol(sub.symbol)
        if it_raw not in ("EQ", "FUT", "CE", "PE", "INDEX"):
            it_raw = inferred or "EQ"
        elif it_raw == "EQ" and inferred:
            it_raw = inferred
        try:
            instrument_type = InstrumentType(it_raw)
        except ValueError:
            instrument_type = InstrumentType.EQ

        # Segment — best-effort string for downstream segment-aware logic
        if instrument_type == InstrumentType.EQ:
            segment = f"{exchange.value}_EQUITY"
        elif instrument_type == InstrumentType.FUT:
            segment = f"{exchange.value}_FUTURE"
        elif instrument_type in (InstrumentType.CE, InstrumentType.PE):
            # Option segment: NFO_OPT, BFO_OPT, MCX_OPT
            segment = f"{exchange.value}_OPTION"
        else:
            segment = f"{exchange.value}_EQUITY"

        # Expiry / strike / option_type
        expiry_date = None
        if sub.expiry:
            try:
                expiry_date = _dt.fromisoformat(sub.expiry).date()
            except Exception:
                expiry_date = None

        option_type: OptionType | None = None
        if instrument_type == InstrumentType.CE:
            option_type = OptionType.CE
        elif instrument_type == InstrumentType.PE:
            option_type = OptionType.PE

        token_str = str(sub.token)
        existing = await Instrument.find_one(Instrument.token == token_str)

        tick_size_d = Decimal128(str(sub.tickSize or "0.05"))
        strike_d = Decimal128(str(sub.strike)) if sub.strike else None

        # Resolve lot size: canonical table wins for FUT/CE/PE so MCX rows
        # don't end up at 1 from an empty `sub.lotSize`, and stale Zerodha
        # values for fresh NIFTY/BANKNIFTY contracts get healed.
        from app.services.index_lots import get_canonical_lot_size

        canonical_lot = (
            get_canonical_lot_size(sub.symbol, sub.name, exchange=exchange.value)
            if instrument_type in (InstrumentType.CE, InstrumentType.PE, InstrumentType.FUT)
            else None
        )
        resolved_lot = canonical_lot or (sub.lotSize if sub.lotSize else None) or 1

        # Friendly display name for derivatives — same composition rule as
        # the auto-create path. Stored on the row so search results / order
        # panel headers don't show the bare underlying.
        from app.services.instrument_service import display_name as _display_name

        friendly_name = _display_name(
            instrument_type=instrument_type,
            underlying=sub.name or sub.symbol,
            expiry=expiry_date,
            strike=sub.strike,
        )

        if existing is None:
            inst = Instrument(
                token=token_str,
                symbol=sub.symbol,
                trading_symbol=sub.symbol,
                name=friendly_name,
                exchange=exchange,
                segment=segment,
                instrument_type=instrument_type,
                lot_size=resolved_lot,
                tick_size=tick_size_d,
                expiry=expiry_date,
                strike=strike_d,
                option_type=option_type,
                is_active=True,
                is_tradable=True,
            )
            await inst.insert()
        else:
            existing.symbol = sub.symbol
            existing.trading_symbol = sub.symbol
            existing.name = friendly_name
            existing.exchange = exchange
            existing.segment = segment
            existing.instrument_type = instrument_type
            existing.lot_size = resolved_lot
            existing.tick_size = tick_size_d
            if expiry_date is not None:
                existing.expiry = expiry_date
            if strike_d is not None:
                existing.strike = strike_d
            existing.option_type = option_type
            existing.is_active = True
            existing.is_tradable = True
            await existing.save()

    async def _ensure_ticker_running(self) -> None:
        """Start the KiteTicker pool if no connections are alive; safe no-op otherwise."""
        with self._ticker_lock:
            if any(e.get("connected") for e in self._tickers):
                return
        try:
            await self.connect_ws()
        except Exception:  # noqa: BLE001
            logger.exception("zerodha_auto_start_ticker_failed")

    async def backfill_local_instruments(self) -> int:
        """Idempotent: mirror every existing Zerodha-subscribed instrument into
        the local ``Instrument`` collection. Run on app startup so subscriptions
        made before the mirror feature existed (or in a previous deploy) start
        flowing live data immediately, without admin having to re-subscribe."""
        s = await self._get_settings()
        if not s.subscribedInstruments:
            return 0
        mirrored = 0
        for sub in s.subscribedInstruments:
            try:
                await self._mirror_subscription_to_instrument(sub)
                mirrored += 1
            except Exception:  # noqa: BLE001
                logger.exception("zerodha_backfill_failed", extra={"token": sub.token})
        if mirrored:
            logger.info("zerodha_backfill_done", extra={"count": mirrored})
        return mirrored

    async def remove_subscription(self, token: int) -> bool:
        s = await self._get_settings()
        before = len(s.subscribedInstruments)
        s.subscribedInstruments = [i for i in s.subscribedInstruments if i.token != token]
        if len(s.subscribedInstruments) == before:
            return False
        await s.save()
        try:
            self._ws_unsubscribe([token])
        except Exception:
            pass
        # Forget the cached tick
        self.ticks_by_token.pop(token, None)
        return True

    async def get_subscribed(self) -> list[dict[str, Any]]:
        s = await self._get_settings()
        return [i.model_dump() for i in s.subscribedInstruments]

    async def get_all_cached_instruments(self, exchange: str | None = None) -> list[dict[str, Any]]:
        """Returns previously-fetched instruments (no Kite call). Useful when admin
        wants to see what's loaded in memory without triggering a refresh."""
        if exchange:
            return list(self._instruments_cache.get(exchange, []))
        out: list[dict[str, Any]] = []
        for v in self._instruments_cache.values():
            out.extend(v)
        return out

    async def remove_expired_subscriptions(self) -> int:
        """Drop instruments whose IST expiry is strictly before today (auto-cleanup)."""
        s = await self._get_settings()
        if not s.autoRemoveExpired:
            return 0
        today_ist = datetime.now(IST).date()
        before = len(s.subscribedInstruments)
        kept: list[SubscribedInstrument] = []
        for i in s.subscribedInstruments:
            if not i.expiry:
                kept.append(i)
                continue
            try:
                exp_d = datetime.fromisoformat(i.expiry).date()
            except Exception:
                kept.append(i)
                continue
            if exp_d >= today_ist:
                kept.append(i)
        removed = before - len(kept)
        if removed:
            s.subscribedInstruments = kept
            await s.save()
        return removed

    async def sync_instrument_cache(self) -> dict[str, Any]:
        """Drop the in-memory CSV cache and remove expired subscriptions. The
        next search will trigger a fresh Kite fetch (matches reference behaviour)."""
        self._instruments_cache.clear()
        self._instruments_cache_at = 0.0
        removed = await self.remove_expired_subscriptions()
        return {"cleared_cache": True, "expired_removed": removed}

    async def clear_subscriptions_and_cache(self) -> int:
        """Reset subscribed instruments + drop cache. The ticker is also unsubscribed."""
        s = await self._get_settings()
        tokens = [i.token for i in s.subscribedInstruments]
        s.subscribedInstruments = []
        await s.save()
        self._instruments_cache.clear()
        self._instruments_cache_at = 0.0
        self.ticks_by_token.clear()
        self.ticks_by_symbol.clear()
        if tokens:
            try:
                self._ws_unsubscribe(tokens)
            except Exception:
                pass
        return len(tokens)

    async def find_instrument_by_symbol(self, symbol: str) -> dict[str, Any] | None:
        """Resolve a tradingsymbol via subscribed → cache → on-demand exchange fetch."""
        sym_u = (symbol or "").strip().upper()
        if not sym_u:
            return None

        aliases: dict[str, list[str]] = {
            "NIFTY50": ["NIFTY 50", "NIFTY"],
            "NIFTY": ["NIFTY 50"],
            "BANKNIFTY": ["NIFTY BANK", "BANKNIFTY"],
            "FINNIFTY": ["NIFTY FIN SERVICE", "FINNIFTY"],
            "MIDCPNIFTY": ["NIFTY MID SELECT", "MIDCPNIFTY"],
            "SENSEX": ["SENSEX", "BSE SENSEX"],
            "BANKEX": ["BANKEX", "BSE BANKEX"],
        }
        candidates = {sym_u, sym_u.replace(" ", ""), sym_u.replace("_", " ")}
        for alt in aliases.get(sym_u, []):
            candidates.add(alt.upper())

        def matches(inst: dict[str, Any]) -> bool:
            sym = (inst.get("symbol") or "").strip().upper()
            return sym in candidates or sym.replace(" ", "").replace("_", "") in {
                c.replace(" ", "").replace("_", "") for c in candidates
            }

        s = await self._get_settings()
        for i in s.subscribedInstruments:
            if matches(i.model_dump()):
                return i.model_dump()
        for cached in self._instruments_cache.values():
            for inst in cached:
                if matches(inst):
                    return inst

        # On-demand fetch across the major exchanges
        for ex in ("NSE", "BSE", "NFO", "MCX", "BFO"):
            try:
                lst = await self.fetch_instruments(ex)
                for inst in lst:
                    if matches(inst):
                        return inst
            except Exception as exc:  # noqa: BLE001
                logger.warning("zerodha_find_skip_exchange", extra={"exchange": ex, "error": str(exc)})
        return None

    async def debug_csv_sample(self, exchange: str = "NFO") -> dict[str, Any]:
        """Returns the first instrument from the requested exchange — handy for
        checking that Kite credentials work end-to-end without subscribing."""
        instruments = await self.fetch_instruments(exchange)
        return {
            "exchange": exchange,
            "count": len(instruments),
            "first": instruments[0] if instruments else None,
        }

    async def diagnose(self) -> dict[str, Any]:
        """End-to-end smoke test of the Zerodha pipeline. Each step is graded
        independently so the admin can pinpoint exactly where the data flow
        breaks down (auth · instruments fetch · REST quote · ticker)."""
        s = await self._get_settings()
        report: dict[str, Any] = {
            "credentials": {
                "ok": bool(s.apiKey and s.apiSecret),
                "apiKeySet": bool(s.apiKey),
                "apiSecretSet": bool(s.apiSecret),
            },
            "auth": {
                "isConnected": bool(s.accessToken and s.isConnected),
                "tokenExpiry": s.tokenExpiry.isoformat() if s.tokenExpiry else None,
                "isTokenExpired": (
                    (_aware_expiry := _ensure_aware_utc(s.tokenExpiry)) is not None
                    and now_utc() >= _aware_expiry
                ),
            },
            "subscriptions": {
                "count": len(s.subscribedInstruments),
                "sample": [i.symbol for i in s.subscribedInstruments[:5]],
            },
            "ticker": {
                "status": str(s.wsStatus),
                "lastError": s.wsLastError,
                "liveTicksHeld": len(self.ticks_by_token),
            },
            "restQuote": {"ok": False, "error": None, "sample": None},
            "instrumentsFetch": {"ok": False, "error": None, "sample": None},
        }

        # REST profile call — confirms the token actually works
        try:
            kc, _ = await self._kite_with_token()
            await asyncio.to_thread(kc.profile)
            report["auth"]["profileCall"] = "ok"
        except Exception as e:  # noqa: BLE001
            report["auth"]["profileCall"] = f"failed: {e}"

        # Instruments fetch (uses cache if fresh)
        try:
            inst = await self.fetch_instruments("NSE")
            report["instrumentsFetch"]["ok"] = bool(inst)
            report["instrumentsFetch"]["sample"] = inst[0] if inst else None
            report["instrumentsFetch"]["count"] = len(inst)
        except Exception as e:  # noqa: BLE001
            report["instrumentsFetch"]["error"] = str(e)

        # REST quote — pick a subscribed instrument first, else fall back to RELIANCE
        probe_key = None
        if s.subscribedInstruments:
            inst0 = s.subscribedInstruments[0]
            probe_key = f"{inst0.exchange}:{inst0.symbol}"
        else:
            probe_key = "NSE:RELIANCE"
        try:
            quotes = await self.get_quote([probe_key])
            report["restQuote"]["ok"] = bool(quotes)
            report["restQuote"]["key"] = probe_key
            report["restQuote"]["sample"] = quotes.get(probe_key) if isinstance(quotes, dict) else None
        except Exception as e:  # noqa: BLE001
            report["restQuote"]["error"] = str(e)
            report["restQuote"]["key"] = probe_key

        return report

    async def connect_with_token(self, request_token: str) -> dict[str, Any]:
        """Manual fallback: paste request_token from Kite redirect when the
        OAuth callback can't reach the backend (e.g. mobile / mismatched
        redirect URL). Same as the OAuth path otherwise."""
        return await self.generate_session(request_token)

    # ── Quotes / history ────────────────────────────────────────────
    async def get_quote(self, instrument_keys: list[str]) -> dict[str, Any]:
        """instrument_keys are Kite-format strings like 'NSE:RELIANCE'."""
        kc, _ = await self._kite_with_token()
        try:
            data = await asyncio.to_thread(kc.quote, instrument_keys)
        except Exception as e:
            raise RuntimeError(f"Kite quote failed: {e}") from e
        return data or {}

    async def get_ltp(self, instrument_keys: list[str]) -> dict[str, Any]:
        kc, _ = await self._kite_with_token()
        try:
            return await asyncio.to_thread(kc.ltp, instrument_keys)
        except Exception as e:
            raise RuntimeError(f"Kite ltp failed: {e}") from e

    async def get_quotes_batch_snapshot(self, keys: list[str]) -> tuple[dict[str, dict[str, Any]], str | None]:
        """Single Kite REST `/quote` call for many instruments at once. Writes
        each result through the per-key 10s cache so individual ``get_quote_snapshot``
        callers see them too. Returns ``(snapshots, error)`` — error is a
        human-readable reason when the whole batch failed (token expired,
        network issue), otherwise None."""
        import time as _time

        if not keys:
            return {}, None
        # De-duplicate while preserving order
        unique_keys: list[str] = []
        seen: set[str] = set()
        for k in keys:
            if k and k not in seen:
                seen.add(k)
                unique_keys.append(k)

        out: dict[str, dict[str, Any]] = {}
        try:
            data = await self.get_quote(unique_keys)
        except RuntimeError as e:
            return {}, str(e)
        if not isinstance(data, dict):
            return {}, "Kite /quote returned an unexpected payload"

        now_t = _time.time()
        tokens_to_sub: list[int] = []
        sym_map: dict[int, dict[str, str]] = {}
        for key, snap in data.items():
            if not isinstance(snap, dict):
                continue
            try:
                exchange, symbol = key.split(":", 1)
            except ValueError:
                continue
            ohlc = snap.get("ohlc") or {}
            depth = snap.get("depth") or {}
            ltp = float(snap.get("last_price") or 0)
            normalised: dict[str, Any] = {
                "token": int(snap.get("instrument_token") or 0),
                "ltp": ltp,
                "open": float(ohlc.get("open") or 0),
                "high": float(ohlc.get("high") or 0),
                "low": float(ohlc.get("low") or 0),
                "close": float(ohlc.get("close") or 0),
                "volume": int(snap.get("volume") or 0),
                "change": float(snap.get("net_change") or 0),
                "depth": depth,
                "symbol": symbol,
                "exchange": exchange,
            }
            bids = depth.get("buy") or []
            asks = depth.get("sell") or []
            normalised["bid"] = float(bids[0].get("price") or ltp) if bids else ltp
            normalised["ask"] = float(asks[0].get("price") or ltp) if asks else ltp
            self._rest_quote_cache[key] = (normalised, now_t)
            out[key] = normalised

            # Track token for on-demand subscription
            token_int = normalised.get("token", 0)
            if token_int and token_int not in self._token_to_ws:
                tokens_to_sub.append(token_int)
                sym_map[token_int] = {"symbol": symbol, "exchange": exchange}

        # On-demand: auto-subscribe all tokens from this batch
        if tokens_to_sub:
            try:
                await self.subscribe_tokens_on_demand(tokens_to_sub, sym_map)
            except Exception:
                pass

        return out, None

    async def get_quote_snapshot(self, exchange: str, symbol: str) -> dict[str, Any] | None:
        """Last-trade snapshot from Kite REST `/quote`. Cached for 10s so a busy
        option chain (≈40 legs) doesn't hammer the API. Returns None when not
        connected or Kite rejects the call — overlay then falls back to mock."""
        import time as _time

        if not exchange or not symbol:
            return None
        key = f"{exchange.upper()}:{symbol}"
        cached = self._rest_quote_cache.get(key)
        now_t = _time.time()
        if cached and (now_t - cached[1]) < self._REST_QUOTE_TTL_SEC:
            return cached[0]
        try:
            data = await self.get_quote([key])
        except RuntimeError:
            return None
        snap = data.get(key) if isinstance(data, dict) else None
        if not isinstance(snap, dict):
            return None
        # Normalise to the same shape as `ticks_by_token` so the overlay can
        # treat a REST snapshot and a live tick interchangeably.
        ohlc = snap.get("ohlc") or {}
        depth = snap.get("depth") or {}
        ltp = float(snap.get("last_price") or 0)
        normalised: dict[str, Any] = {
            "token": int(snap.get("instrument_token") or 0),
            "ltp": ltp,
            "open": float(ohlc.get("open") or 0),
            "high": float(ohlc.get("high") or 0),
            "low": float(ohlc.get("low") or 0),
            "close": float(ohlc.get("close") or 0),
            "volume": int(snap.get("volume") or 0),
            "change": float(snap.get("net_change") or 0),
            "depth": depth,
            "symbol": symbol,
            "exchange": exchange,
        }
        # Best bid / ask from depth, fall back to LTP
        bids = depth.get("buy") or []
        asks = depth.get("sell") or []
        normalised["bid"] = float(bids[0].get("price") or ltp) if bids else ltp
        normalised["ask"] = float(asks[0].get("price") or ltp) if asks else ltp
        self._rest_quote_cache[key] = (normalised, now_t)

        # On-demand: auto-subscribe this token for live ticks
        token_int = normalised.get("token", 0)
        if token_int and token_int not in self._token_to_ws:
            try:
                await self.subscribe_tokens_on_demand(
                    [token_int],
                    {token_int: {"symbol": symbol, "exchange": exchange}},
                )
            except Exception:
                pass

        return normalised

    async def get_historical(
        self,
        instrument_token: int,
        from_date: datetime,
        to_date: datetime,
        interval: str = "5minute",
    ) -> list[dict[str, Any]]:
        kc, _ = await self._kite_with_token()
        try:
            data = await asyncio.to_thread(
                kc.historical_data, instrument_token, from_date, to_date, interval
            )
        except Exception as e:
            raise RuntimeError(f"Kite historical failed: {e}") from e
        # SDK returns list of dicts with date/open/high/low/close/volume
        return [
            {
                "time": int(c["date"].timestamp()),
                "open": float(c["open"]),
                "high": float(c["high"]),
                "low": float(c["low"]),
                "close": float(c["close"]),
                "volume": int(c.get("volume") or 0),
            }
            for c in data
        ]

    # ── Fast in-memory instrument search ─────────────────────────────

    async def search_instruments_fast(
        self, q: str, exchange: str | None = None, limit: int = 30,
    ) -> list[dict[str, Any]]:
        """Blazing-fast in-memory search across the Zerodha instrument cache.
        Falls back to MongoDB if the cache is empty. Searches symbol, name,
        and trading_symbol. Results sorted: exact prefix first, then contains."""
        q_upper = (q or "").strip().upper()
        if not q_upper:
            return []

        # Try in-memory cache first (NSE + NFO + MCX + BSE + BFO)
        results: list[tuple[int, dict[str, Any]]] = []
        exchanges_to_search = [exchange.upper()] if exchange else list(self._instruments_cache.keys())

        # Ensure cache is warm
        if not self._instruments_cache:
            for ex in ("NSE", "NFO", "MCX"):
                try:
                    await self.fetch_instruments(ex)
                except Exception:
                    pass

        for ex_key in exchanges_to_search:
            cache = self._instruments_cache.get(ex_key, [])
            for inst in cache:
                sym = (inst.get("symbol") or "").upper()
                name = (inst.get("name") or "").upper()
                tsym = (inst.get("tradingSymbol") or inst.get("trading_symbol") or "").upper()

                # Score: 0 = exact match, 1 = prefix, 2 = contains
                score = -1
                if sym == q_upper or tsym == q_upper:
                    score = 0
                elif sym.startswith(q_upper) or tsym.startswith(q_upper):
                    score = 1
                elif q_upper in sym or q_upper in name or q_upper in tsym:
                    score = 2

                if score >= 0:
                    results.append((score, inst))
                    if len(results) >= limit * 3:  # over-collect for sorting
                        break

        # Sort by score (exact > prefix > contains), then by symbol length (shorter first)
        results.sort(key=lambda x: (x[0], len(x[1].get("symbol") or "")))
        return [r[1] for r in results[:limit]]

    async def get_option_chain_fast(
        self, underlying: str, expiry_date: date | None = None,
    ) -> tuple[list[dict[str, Any]], list[date]]:
        """Fast option chain from in-memory cache. Returns (options_list, expiries).
        No MongoDB, no Python loop over 80K instruments every call — we use
        a pre-filtered approach on the cached CSV."""
        und_key = (underlying or "").strip().upper()
        if not und_key:
            return [], []

        # Determine exchange
        sensex_like = {"SENSEX", "BANKEX"}
        mcx_like = {"CRUDEOIL", "GOLD", "GOLDM", "SILVER", "SILVERM", "NATURALGAS", "COPPER"}
        if und_key in sensex_like:
            exchanges = ["BFO"]
        elif und_key in mcx_like:
            exchanges = ["MCX"]
        else:
            exchanges = ["NFO", "BFO"]

        today = date.today()
        options: list[dict[str, Any]] = []
        expiry_set: set[date] = set()

        for ex in exchanges:
            try:
                catalog = await self.fetch_instruments(ex)
            except Exception as e:
                # Without surfacing this, callers see an empty option chain
                # with no clue why (Zerodha unauthenticated, expired token,
                # network blip). Log once per (underlying, exchange) miss.
                logger.warning(
                    "option_chain_fetch_instruments_failed",
                    extra={"underlying": und_key, "exchange": ex, "error": str(e)[:200]},
                )
                continue
            ex_matches = 0
            for inst in catalog:
                it = (inst.get("instrumentType") or "").upper()
                if it not in ("CE", "PE"):
                    continue
                name = (inst.get("name") or "").upper().replace(" ", "")
                sym = (inst.get("symbol") or "").upper().replace(" ", "")
                # Strict match: name is the underlying name in Kite's CSV, and
                # for stock/index options it's exactly the symbol the user
                # typed (e.g. "TCS", "NIFTY"). A naive substring (`und_key in
                # name`) used to bleed in unrelated options when a shorter
                # ticker was contained in a longer one. Fall back to sym prefix
                # only when the symbol begins with the underlying followed by
                # a digit — that pattern is unique to derivative tradingsymbols
                # ("TCS25NOV4200CE") and won't match unrelated tickers that
                # merely start with the same letters.
                name_match = name == und_key
                sym_match = (
                    sym.startswith(und_key)
                    and len(sym) > len(und_key)
                    and sym[len(und_key)].isdigit()
                )
                if not name_match and not sym_match:
                    continue
                # Parse expiry
                exp_str = inst.get("expiry")
                exp_d = None
                if exp_str:
                    try:
                        exp_d = datetime.fromisoformat(exp_str.replace("Z", "+00:00")).date()
                    except Exception:
                        try:
                            exp_d = datetime.strptime(str(exp_str)[:10], "%Y-%m-%d").date()
                        except Exception:
                            pass
                if exp_d is not None and exp_d < today:
                    continue
                if exp_d is not None:
                    expiry_set.add(exp_d)

                options.append({
                    "token": str(inst.get("token") or 0),
                    "symbol": inst.get("symbol"),
                    "exchange": inst.get("exchange") or ex,
                    "expiry": exp_d.isoformat() if exp_d else None,
                    "strike": inst.get("strike"),
                    "option_type": it,
                    "lot_size": inst.get("lotSize"),
                    "_expiry_date": exp_d,
                })
                ex_matches += 1
            logger.info(
                "option_chain_catalog_scan",
                extra={
                    "underlying": und_key,
                    "exchange": ex,
                    "catalog_size": len(catalog),
                    "matches": ex_matches,
                },
            )

        sorted_expiries = sorted(expiry_set)
        return options, sorted_expiries

    # ── Multi-WebSocket Pool (on-demand subscription) ──────────────

    async def _start_ws_pool(self) -> None:
        """Start the first WebSocket connection (empty). Additional connections
        are spawned automatically when a single WS hits 3000 tokens."""
        s = await self._get_settings()
        if not s.apiKey or not s.accessToken:
            raise RuntimeError("Authenticate with Zerodha before connecting the ticker")

        with self._ticker_lock:
            # Already have live connections
            if any(e.get("connected") for e in self._tickers):
                return

        try:
            self._main_loop = asyncio.get_running_loop()
        except RuntimeError:
            self._main_loop = None

        await self._spawn_ws_connection(s.apiKey, s.accessToken)
        logger.info("zerodha_ws_pool_started", extra={"connections": len(self._tickers)})

    async def _spawn_ws_connection(self, api_key: str, access_token: str) -> int:
        """Create a new KiteTicker connection and add it to the pool.
        Returns the index of the new connection."""
        from kiteconnect import KiteTicker

        idx = len(self._tickers)
        ws_label = f"WS-{idx + 1}"

        kws = KiteTicker(api_key, access_token)
        entry: dict[str, Any] = {
            "ticker": kws,
            "tokens": set(),
            "connected": False,
            # `connecting` lets the capacity check below count this slot
            # while the handshake is in flight, so a concurrent subscribe
            # doesn't spawn a redundant second connection.
            "connecting": True,
            "label": ws_label,
            "api_key": api_key,
            "access_token": access_token,
        }

        def on_connect(ws, response):
            entry["connected"] = True
            entry["connecting"] = False
            logger.info(f"zerodha_{ws_label}_connected")
            # Subscribe any tokens that were queued before connection established
            tokens = list(entry["tokens"])
            if tokens:
                ws.subscribe(tokens)
                ws.set_mode(ws.MODE_FULL, tokens)
                logger.info(f"zerodha_{ws_label}_subscribed_queued", extra={"count": len(tokens)})
            self._update_ws_status(WsStatus.CONNECTED)

        def on_close(ws, code, reason):
            entry["connected"] = False
            entry["connecting"] = False
            # Stash the close reason so connect_ws can surface it in the
            # admin error message (otherwise the admin just sees "didn't
            # complete" with no hint about WHY Kite hung up).
            entry["last_close_reason"] = f"code={code} reason={str(reason or '')[:180]}"
            logger.warning(f"zerodha_{ws_label}_closed", extra={"code": code, "reason": str(reason or "")[:200]})
            # 403 on WS upgrade = Kite rejected this token (most often
            # because another WS is already alive on the same access
            # token). Prune the entry so the next subscribe doesn't keep
            # counting it as "in flight" and refuse to retry. Other
            # close codes (network blip, idle drop) keep the entry —
            # KiteTicker auto-reconnects in those cases.
            should_prune = False
            reason_str = str(reason or "")
            try:
                if "403" in reason_str or (isinstance(code, int) and code == 1006):
                    # 1006 = abnormal closure right after handshake; same
                    # symptom as 403 in practice (server rejected before a
                    # clean close frame).
                    should_prune = True
            except Exception:
                pass
            with self._ticker_lock:
                if should_prune:
                    try:
                        self._tickers.remove(entry)
                    except ValueError:
                        pass
                if not any(e.get("connected") for e in self._tickers):
                    self._update_ws_status(
                        WsStatus.DISCONNECTED,
                        error=f"{ws_label}: {reason_str[:150]}",
                    )

        def on_error(ws, code, reason):
            entry["connecting"] = False
            logger.error(f"zerodha_{ws_label}_error", extra={"code": code, "reason": str(reason or "")[:100]})
            self._update_ws_status(WsStatus.ERROR, error=f"{ws_label}: {str(reason or '')[:150]}")

        def on_ticks(ws, ticks):
            for tick in ticks or []:
                token = int(tick.get("instrument_token") or 0)
                if not token:
                    continue
                ltp = float(tick.get("last_price") or 0)
                bid = ltp
                ask = ltp
                depth = tick.get("depth") or {}
                bids = depth.get("buy") or []
                asks = depth.get("sell") or []
                if bids and asks:
                    bid = float(bids[0].get("price") or ltp)
                    ask = float(asks[0].get("price") or ltp)
                ohlc = tick.get("ohlc") or {}
                payload: dict[str, Any] = {
                    "token": token,
                    "ltp": ltp,
                    "bid": bid,
                    "ask": ask,
                    "open": float(ohlc.get("open") or 0),
                    "high": float(ohlc.get("high") or 0),
                    "low": float(ohlc.get("low") or 0),
                    "close": float(ohlc.get("close") or 0),
                    "volume": int(tick.get("volume_traded") or 0),
                    "change": float(tick.get("change") or 0),
                }
                sym_info = self._symbol_by_token.get(token)
                if sym_info:
                    payload["symbol"] = sym_info.get("symbol", "")
                    payload["exchange"] = sym_info.get("exchange", "")
                    self.ticks_by_symbol[payload["symbol"]] = payload
                self.ticks_by_token[token] = payload

                if self._main_loop is not None:
                    try:
                        asyncio.run_coroutine_threadsafe(
                            publish(f"market:tick:{token}", payload), self._main_loop
                        )
                    except Exception:
                        pass

        kws.on_connect = on_connect
        kws.on_close = on_close
        kws.on_error = on_error
        kws.on_ticks = on_ticks

        with self._ticker_lock:
            self._tickers.append(entry)
            if self._ticker is None:
                self._ticker = kws

        await self._async_set_status(WsStatus.CONNECTING)
        await asyncio.to_thread(kws.connect, True, True)
        return idx

    def _ws_subscribe(self, tokens: list[int]) -> None:
        """Subscribe tokens on-demand — assign to least-loaded WS connection."""
        with self._ticker_lock:
            if not self._tickers:
                return
            for token in tokens:
                if token in self._token_to_ws:
                    continue  # already subscribed

                # Find the least-loaded connected WS with capacity
                best_idx = -1
                best_count = self.MAX_TOKENS_PER_WS + 1
                for i, entry in enumerate(self._tickers):
                    if entry.get("connected") and len(entry["tokens"]) < self.MAX_TOKENS_PER_WS:
                        if len(entry["tokens"]) < best_count:
                            best_count = len(entry["tokens"])
                            best_idx = i

                if best_idx == -1:
                    # All connections full — need a new one (will be spawned async)
                    self._pending_tokens = getattr(self, "_pending_tokens", set())
                    self._pending_tokens.add(token)
                    continue

                entry = self._tickers[best_idx]
                entry["tokens"].add(token)
                self._token_to_ws[token] = best_idx
                ticker = entry["ticker"]
                try:
                    ticker.subscribe([token])
                    ticker.set_mode(ticker.MODE_FULL, [token])
                except Exception:
                    pass

    async def subscribe_tokens_on_demand(self, tokens: list[int], symbols: dict[int, dict[str, str]] | None = None) -> int:
        """Public async method: subscribe a list of tokens on-demand.
        Spawns new WS connections if existing ones are at capacity.
        `symbols` is an optional {token: {"symbol": ..., "exchange": ...}} map.

        Also persists the tokens to ``ZerodhaSettings.subscribedInstruments``
        so they show up in the admin's Zerodha Connect panel and survive a
        server restart (the WS pool re-resolves the list on every reconnect).
        """
        if symbols:
            self._symbol_by_token.update(symbols)

        new_tokens = [t for t in tokens if t not in self._token_to_ws]

        # ── Persist to the admin's subscription list ─────────────────
        # This is what makes "click an option leg → see it in admin's
        # Subscribed list" work. We add even if the WS-pool already has
        # the token (idempotent set semantics).
        try:
            s = await self._get_settings()
            existing_tokens = {i.token for i in s.subscribedInstruments}
            added: list[SubscribedInstrument] = []
            for t in tokens:
                if t in existing_tokens:
                    continue
                meta = (symbols or {}).get(t) or self._symbol_by_token.get(t) or {}
                sub = SubscribedInstrument(
                    token=t,
                    symbol=meta.get("symbol") or str(t),
                    exchange=meta.get("exchange") or "NSE",
                )
                s.subscribedInstruments.append(sub)
                added.append(sub)
                existing_tokens.add(t)
            if added:
                await s.save()
                # Mirror into the local Instrument collection in the
                # background so user search/quote/history endpoints find
                # them without waiting for the next CSV refresh.
                for sub in added:
                    try:
                        asyncio.create_task(self._mirror_subscription_to_instrument(sub))
                    except Exception:
                        pass
        except Exception:
            # Persistence is best-effort — WS subscribe is still useful even
            # if the settings doc can't be written. Don't block live ticks.
            logger.exception("zerodha_on_demand_persist_failed")

        if not new_tokens:
            return 0

        # Capacity check. Count BOTH connected and still-connecting entries
        # toward capacity — without this, a subscribe firing during the WS
        # handshake spawns a second connection that Kite then rejects with
        # 403 (one-WS-per-token rule).
        with self._ticker_lock:
            usable_tickers = [
                e for e in self._tickers if e.get("connected") or e.get("connecting", False)
            ]
            total_capacity = sum(
                self.MAX_TOKENS_PER_WS - len(e["tokens"]) for e in usable_tickers
            )
            need_new_ws = len(new_tokens) > total_capacity
            pool_full = len(self._tickers) >= self.MAX_WS_CONNECTIONS

        if need_new_ws and not pool_full:
            s = await self._get_settings()
            if s.apiKey and s.accessToken:
                slots_available = self.MAX_WS_CONNECTIONS - len(self._tickers)
                connections_needed = min(
                    slots_available,
                    (len(new_tokens) - total_capacity + self.MAX_TOKENS_PER_WS - 1) // self.MAX_TOKENS_PER_WS,
                )
                for _ in range(max(0, connections_needed)):
                    try:
                        await self._spawn_ws_connection(s.apiKey, s.accessToken)
                        await asyncio.sleep(0.5)
                    except Exception:
                        logger.exception("zerodha_spawn_ws_failed")
                        break
        elif need_new_ws and pool_full:
            # Kite caps us at 1 WS — log loudly so the operator knows
            # tokens beyond the first 3000 won't get live ticks until
            # they're rotated through the existing connection.
            logger.warning(
                "zerodha_ws_pool_capped",
                extra={
                    "pool_size": len(self._tickers),
                    "max": self.MAX_WS_CONNECTIONS,
                    "tokens_dropped": len(new_tokens) - total_capacity,
                },
            )

        self._ws_subscribe(new_tokens)

        total_subscribed = sum(len(e["tokens"]) for e in self._tickers)
        logger.info(
            "zerodha_on_demand_subscribed",
            extra={
                "requested": len(new_tokens),
                "total_active": total_subscribed,
                "connections": len(self._tickers),
            },
        )
        return len(new_tokens)

    async def unsubscribe_tokens_on_demand(self, tokens: list[int]) -> int:
        """Public async counterpart to subscribe_tokens_on_demand. Removes
        tokens from any active WS pool entry AND from the admin's persistent
        subscribedInstruments list so the panel reflects reality. Returns the
        count actually unsubscribed from the WS pool."""
        if not tokens:
            return 0
        before = sum(len(e["tokens"]) for e in self._tickers)
        self._ws_unsubscribe(tokens)
        after = sum(len(e["tokens"]) for e in self._tickers)
        removed = max(0, before - after)

        # Best-effort remove from the persistent list — keeps the admin
        # Zerodha Connect panel in sync with what's actually streaming.
        try:
            s = await self._get_settings()
            token_set = set(tokens)
            before_count = len(s.subscribedInstruments)
            s.subscribedInstruments = [
                i for i in s.subscribedInstruments if i.token not in token_set
            ]
            if len(s.subscribedInstruments) != before_count:
                await s.save()
        except Exception:
            logger.exception("zerodha_on_demand_unpersist_failed")

        if removed:
            logger.info(
                "zerodha_on_demand_unsubscribed",
                extra={"requested": len(tokens), "removed": removed, "total_active": after},
            )
        return removed

    def _ws_unsubscribe(self, tokens: list[int]) -> None:
        with self._ticker_lock:
            for token in tokens:
                ws_idx = self._token_to_ws.pop(token, None)
                if ws_idx is not None and ws_idx < len(self._tickers):
                    entry = self._tickers[ws_idx]
                    entry["tokens"].discard(token)
                    ticker = entry["ticker"]
                    if entry.get("connected"):
                        try:
                            ticker.unsubscribe([token])
                        except Exception:
                            pass

    def _stop_ticker(self) -> None:
        with self._ticker_lock:
            for entry in self._tickers:
                try:
                    entry["ticker"].close()
                except Exception:
                    pass
            self._tickers.clear()
            self._token_to_ws.clear()
            self._ticker = None

    async def connect_ws(self, *, force: bool = True) -> None:
        """Start the WebSocket pool. If there are DB-persisted subscriptions
        (admin-pinned), subscribe those. Otherwise just start an empty pool
        for on-demand subscriptions.

        When ``force`` is True (the default — what the admin's "Start ticker"
        button uses), tear down any existing local socket AND wait a few
        seconds before reconnecting. This is the only reliable way to escape
        the 403 "WebSocket connection upgrade failed" loop: Zerodha allows
        exactly ONE active KiteTicker per access_token, and when a process
        crashes / a deploy swaps containers / a stale socket lingers, Kite's
        side keeps the old slot warm for a few seconds longer than ours does.
        Reconnecting too eagerly hits 403; a short sleep lets Kite release.
        """
        s = await self._get_settings()
        if not s.apiKey or not s.accessToken:
            raise RuntimeError("Authenticate with Zerodha before connecting the ticker")

        if not force:
            with self._ticker_lock:
                if any(e.get("connected") for e in self._tickers):
                    return

        # Hard-reset: kill every local socket, blank the WS status to
        # CONNECTING. Sleep ONLY if we actually had a live/connecting
        # socket to tear down — Kite's gateway needs ~5 s to register
        # that the previous holder is gone before it'll accept a new
        # one. On a cold boot with no prior sockets, skip the wait.
        had_live = False
        with self._ticker_lock:
            had_live = any(
                e.get("connected") or e.get("connecting") for e in self._tickers
            )
        self._stop_ticker()
        await self._async_set_status(WsStatus.CONNECTING, error=None)
        if force and had_live:
            await asyncio.sleep(5)

        # Try the connect, and if it fails (typical: still 403 because the
        # old slot hasn't been released yet), back off and retry several
        # times before bubbling up. The retry budget is generous because
        # Kite's gateway can hold a slot for 60-90 s after the previous
        # holder process exits — most "WS won't connect" reports turn out
        # to be a stale slot from a prior deploy / a co-running local
        # backend, and the only fix is patience. 23 s (the old budget)
        # was too tight; ~3 minutes is enough for every real-world case.
        last_error: Exception | None = None
        last_close_reason: str = ""
        for attempt, wait in enumerate((0, 10, 25, 45, 70)):
            if wait:
                logger.info(
                    "zerodha_ws_retry_backoff",
                    extra={"attempt": attempt + 1, "wait_sec": wait},
                )
                await asyncio.sleep(wait)
            try:
                await self._start_ws_pool()
                # Connection enters "connecting" — verify it actually opened
                # within a short window. KiteTicker fires on_connect within
                # ~1-2 s on success; longer means the upgrade was rejected
                # and on_close already pruned the entry.
                for _ in range(32):  # 32 × 0.25 s = 8 s
                    await asyncio.sleep(0.25)
                    with self._ticker_lock:
                        if any(e.get("connected") for e in self._tickers):
                            break
                with self._ticker_lock:
                    if any(e.get("connected") for e in self._tickers):
                        last_error = None
                        break
                last_error = RuntimeError(
                    f"WS upgrade did not complete on attempt {attempt + 1}"
                )
                # Surface the most recent close reason from the rejected
                # entry so the admin sees WHAT Kite said, not just "didn't
                # complete". We capture this before `_stop_ticker()` clears
                # the list below.
                with self._ticker_lock:
                    for e in self._tickers:
                        reason = e.get("last_close_reason")
                        if reason:
                            last_close_reason = str(reason)
                            break
            except Exception as e:  # noqa: BLE001
                last_error = e
            self._stop_ticker()
            logger.warning(
                "zerodha_ws_attempt_failed",
                extra={
                    "attempt": attempt + 1,
                    "error": str(last_error)[:200] if last_error else None,
                    "close_reason": last_close_reason[:200],
                },
            )

        if last_error is not None:
            # Tailor the message: if Kite explicitly closed with 403, name
            # the duplicate-process cause. Other close codes (network / 5xx /
            # malformed token) get a more open-ended hint so the operator
            # doesn't go re-authing when the real fix is a network retry.
            reason_l = last_close_reason.lower()
            looks_like_403 = "403" in reason_l or "forbidden" in reason_l or "1006" in reason_l
            if looks_like_403:
                msg = (
                    "Kite rejected the WebSocket after 5 retries (~3 min). "
                    "Another process is still holding the slot for this "
                    "access_token — check for a duplicate backend instance "
                    "(prod + local both running?), or click Disconnect "
                    "Zerodha + Login again to mint a fresh token."
                )
            else:
                msg = (
                    "WebSocket connect failed after 5 retries. Last close "
                    f"reason: {last_close_reason[:180] or '(none)'}. "
                    "Click Disconnect Zerodha + Login if this persists."
                )
            await self._async_set_status(WsStatus.ERROR, error=msg)
            raise RuntimeError(str(last_error))

        # Subscribe any DB-persisted instruments (admin-pinned / watchlist)
        if s.subscribedInstruments:
            tokens = [i.token for i in s.subscribedInstruments]
            sym_map = {
                i.token: {"symbol": i.symbol, "exchange": i.exchange}
                for i in s.subscribedInstruments
            }
            await self.subscribe_tokens_on_demand(tokens, sym_map)

    def _update_ws_status(self, status: WsStatus, *, error: str | None = None) -> None:
        if self._main_loop is None:
            return
        try:
            asyncio.run_coroutine_threadsafe(self._async_set_status(status, error=error), self._main_loop)
        except Exception:
            pass

    async def _async_set_status(self, status: WsStatus, *, error: str | None = None) -> None:
        s = await self._get_settings()
        s.wsStatus = status
        if error is not None:
            s.wsLastError = error
        if status == WsStatus.CONNECTED:
            s.wsLastError = None
        await s.save()

    async def disconnect_ws(self) -> None:
        self._stop_ticker()
        await self._async_set_status(WsStatus.DISCONNECTED)

    def get_ws_pool_info(self) -> dict[str, Any]:
        """Return current WebSocket pool status for admin diagnostics."""
        with self._ticker_lock:
            connections = []
            for entry in self._tickers:
                connections.append({
                    "label": entry.get("label", "?"),
                    "connected": entry.get("connected", False),
                    "tokens_count": len(entry.get("tokens", set())),
                    "capacity": self.MAX_TOKENS_PER_WS,
                })
            return {
                "total_connections": len(self._tickers),
                "total_tokens_subscribed": sum(len(e.get("tokens", set())) for e in self._tickers),
                "connections": connections,
            }


# Singleton
zerodha = ZerodhaService()
