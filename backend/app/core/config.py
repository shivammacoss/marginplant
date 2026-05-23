"""Application configuration loaded from environment variables.

All settings are validated by Pydantic at startup; invalid config fails fast
rather than crashing later in a request path.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── Application ──────────────────────────────────────────────────
    APP_NAME: str = "SetupFX Broker"
    APP_ENV: Literal["development", "staging", "production"] = "development"
    APP_DEBUG: bool = False
    APP_HOST: str = "0.0.0.0"
    APP_PORT: int = 8000
    APP_BASE_URL: str = "http://localhost:8000"

    # ── MongoDB ──────────────────────────────────────────────────────
    MONGODB_URL: str = "mongodb://localhost:27017/nexbrokers"
    MONGODB_DB_NAME: str = "nexbrokers"
    MONGODB_REPLICA_SET: str = ""
    MONGODB_MAX_POOL_SIZE: int = 100
    MONGODB_MIN_POOL_SIZE: int = 10

    # ── Redis ────────────────────────────────────────────────────────
    REDIS_URL: str = "redis://localhost:6379/0"
    # Bumped from 50 → 300 after the market_tick_loop started raising
    # `ConnectionError: Too many connections` once the Zerodha WS pool
    # crossed ~1500 subscribed tokens. Every 250 ms tick publishes one
    # message per token over pub/sub, plus the order validator + cache
    # helpers all pull from the same pool. Empirical headroom needed
    # ≈ token_count / 20 + steady ~50 for HTTP path; 300 leaves slack
    # for spikes during option-chain expansion.
    REDIS_MAX_CONNECTIONS: int = 300

    # ── WebSocket limits ─────────────────────────────────────────────
    # Hard cap on simultaneous WebSocket connections per client IP,
    # enforced via Redis (see app/core/ws_limiter.py). Generous default
    # so users on shared NAT exits / corporate proxies aren't penalised;
    # set to 0 to disable the limiter entirely.
    WS_MAX_CONNECTIONS_PER_IP: int = 100
    # Per-connection cap on instrument-token subscriptions on the
    # `/ws/marketdata` socket. Each subscribed token costs one slot in
    # the in-process ``MarketTickHub`` fanout map and one entry in the
    # upstream Zerodha / Infoway ticker — a power-user holding 200+
    # symbols in one watchlist would otherwise multiply tick-publish
    # work across the whole worker pool. 70 fits a typical user's full
    # watchlist + the option-chain expansion they have open at once,
    # with headroom; bigger requests get rejected with an explicit
    # `subscription_limit` error frame so the frontend can prompt the
    # user to unsubscribe something first.
    WS_MAX_SUBSCRIPTIONS_PER_CONN: int = 70

    # ── JWT ──────────────────────────────────────────────────────────
    # Refresh-token TTL widened from 7 → 30 days so the mobile app keeps
    # users logged in for a month (matches Zerodha / Groww / Upstox UX).
    # The token rotates on every refresh so a fresh login resets the
    # 30-day window — a daily-active user effectively never sees a login
    # screen unless they sign out explicitly or revoke from another device.
    JWT_SECRET: SecretStr = Field(default=SecretStr("change-me"))
    JWT_ALGORITHM: str = "HS256"
    # Access token bumped from 15 → 1440 min (24 h) so the silent-refresh
    # cycle fires at most once a day instead of every 15 min. User-flagged
    # symptom on the installed PWA: "30 din set hai fir bhi logout ho
    # raha hai". Cause was a transient refresh failure (PWA resume before
    # network reattaches, backend deploy mid-suspend, etc.) which the
    # frontend interceptor used to convert into a hard /login redirect.
    # Longer access lifetime + revised frontend retry semantics together
    # close that hole. Backend revocation is still instantaneous because
    # /auth/refresh + the JTI allow-list rotate on every refresh, so a
    # logout from another device kills the next refresh attempt — the
    # access token only lives until its own TTL after that, which 24 h
    # is still well within the security budget for a personal trading
    # app.
    JWT_ACCESS_TTL_MIN: int = 1440
    JWT_REFRESH_TTL_DAYS: int = 30

    # ── Admin extra security ─────────────────────────────────────────
    ADMIN_API_KEY: SecretStr = Field(default=SecretStr("change-me-admin"))
    ADMIN_IP_WHITELIST: str = ""

    # ── CORS ─────────────────────────────────────────────────────────
    CORS_USER_ORIGIN: str = "http://localhost:3000"
    CORS_ADMIN_ORIGIN: str = "http://localhost:3001"

    # ── Public backend URL (used by OAuth callback URLs etc.) ────────
    # Override in production to your actual API hostname, e.g.
    # https://api.setupfx.com — Kite redirects the user's browser here.
    BACKEND_PUBLIC_URL: str = "http://localhost:8000"

    # ── Rate limit ───────────────────────────────────────────────────
    RATE_LIMIT_AUTH_PER_MIN: int = 5
    RATE_LIMIT_DEFAULT_PER_MIN: int = 100
    RATE_LIMIT_TRADING_PER_MIN: int = 300

    # ── External APIs ────────────────────────────────────────────────
    ANGEL_ONE_API_KEY: str = ""
    ANGEL_ONE_CLIENT_CODE: str = ""
    ANGEL_ONE_CLIENT_PIN: str = ""
    ANGEL_ONE_TOTP_SECRET: str = ""
    ZERODHA_API_KEY: str = ""
    ZERODHA_API_SECRET: str = ""
    # AES-256-GCM key for encrypting the Zerodha auto-login credentials at rest.
    # 32 raw bytes, base64-encoded. Generate with:
    #   python -c "import os, base64; print(base64.b64encode(os.urandom(32)).decode())"
    # If unset, the auto-login service refuses to save credentials so a
    # misconfigured deploy can't accidentally store plaintext.
    ZERODHA_CREDS_KEY: SecretStr = Field(default=SecretStr(""))
    PRICE_FEED_PROVIDER: Literal["mock", "angel_one", "zerodha"] = "mock"

    # Infoway — global forex / crypto / metals / energy / stocks / indices feed.
    INFOWAY_API_KEY: SecretStr = Field(default=SecretStr(""))
    INFOWAY_AUTO_CONNECT: bool = True
    INFOWAY_DEFAULT_CRYPTO: str = "BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,BNBUSDT"
    # NOTE: keep this list pure forex pairs (6-char major/minor crosses). Don't
    # add USDINR here — Indian-rupee derivatives belong on the NSE/BSE CDS
    # segment, not the international Infoway forex bucket the user-side
    # "Forex" chip surfaces.
    INFOWAY_DEFAULT_FOREX: str = "EURUSD,GBPUSD,USDJPY,AUDUSD,USDCAD,USDCHF,NZDUSD"
    # Spot precious metals + common energy contracts (Infoway uses the same
    # ticker style — XAUUSD = gold/USD, XAGUSD = silver/USD, USOIL = WTI).
    INFOWAY_DEFAULT_METALS: str = "XAUUSD,XAGUSD,XPTUSD,XPDUSD"
    INFOWAY_DEFAULT_ENERGY: str = "USOIL,UKOIL,NATGAS"
    # International equities subscribe through Infoway's dedicated `stock`
    # WebSocket business channel (US / HK / A-share coverage). Indices
    # share the `common` channel with forex/metals/energy. Both are
    # treated as explicit allowlists by `_classify_infoway_code` so an
    # AAPL-shaped string can't be mis-routed as a forex pair.
    # Defaults cover the most-traded US tickers + global indices; admin
    # can override via env without code changes.
    INFOWAY_DEFAULT_STOCKS: str = "AAPL,MSFT,GOOGL,AMZN,TSLA,NVDA,META,NFLX"
    INFOWAY_DEFAULT_INDICES: str = "SPX500,NAS100,US30,UK100,DE40,JPN225,HK50"

    # ── Email / SMS ──────────────────────────────────────────────────
    SMTP_HOST: str = ""
    SMTP_PORT: int = 587
    SMTP_USER: str = ""
    SMTP_PASSWORD: SecretStr = Field(default=SecretStr(""))
    SMTP_FROM: str = "no-reply@setupfx.com"
    SMTP_TLS: bool = True
    SMS_PROVIDER: Literal["mock", "twilio", "msg91"] = "mock"
    SMS_API_KEY: SecretStr = Field(default=SecretStr(""))
    SMS_SENDER_ID: str = "STPFX"

    # ── S3 ───────────────────────────────────────────────────────────
    S3_BUCKET: str = ""
    S3_REGION: str = "ap-south-1"
    S3_ACCESS_KEY: str = ""
    S3_SECRET_KEY: SecretStr = Field(default=SecretStr(""))
    S3_ENDPOINT_URL: str = ""

    # ── Celery ───────────────────────────────────────────────────────
    CELERY_BROKER_URL: str = "redis://localhost:6379/1"
    CELERY_RESULT_BACKEND: str = "redis://localhost:6379/2"

    # ── Observability ────────────────────────────────────────────────
    SENTRY_DSN: str = ""
    LOG_LEVEL: str = "INFO"
    LOG_JSON: bool = True

    # ── Seed ─────────────────────────────────────────────────────────
    SEED_SUPER_ADMIN_EMAIL: str = "admin@setupfx.com"
    SEED_SUPER_ADMIN_PASSWORD: SecretStr = Field(default=SecretStr("Admin@123"))
    SEED_SUPER_ADMIN_MOBILE: str = "9999999999"
    RUN_SEED_ON_STARTUP: bool = True

    # ── Trading ──────────────────────────────────────────────────────
    DEFAULT_TIMEZONE: str = "Asia/Kolkata"
    MARKET_OPEN_TIME: str = "09:15"
    MARKET_CLOSE_TIME: str = "15:30"
    MUHURAT_OPEN_TIME: str = "18:15"
    MUHURAT_CLOSE_TIME: str = "19:15"

    # ── White-label branding ─────────────────────────────────────────
    # Master kill-switch for the white-label branding subsystem. When
    # False (default), the new schema fields on User exist but no code
    # path reads/writes them, the `/api/v1/branding/*` endpoints (added
    # in Phase 2) return 503, and the frontend BrandingProvider falls
    # back to default platform branding. Flip to True only after Phase
    # 1 is observed clean for ≥ 24h. Keeps prod 0-second reversible.
    BRANDING_ENABLED: bool = False
    # Public IPv4 the platform answers on — admins point their custom
    # domain's A records here for DNS verification (Phase 4). Empty
    # default keeps the verify endpoint a no-op when unset.
    PLATFORM_PUBLIC_IP: str = ""

    # ─────────────────────────────────────────────────────────────────
    @field_validator("MONGODB_URL")
    @classmethod
    def _validate_mongo_url(cls, v: str) -> str:
        if not v.startswith(("mongodb://", "mongodb+srv://")):
            raise ValueError("MONGODB_URL must start with mongodb:// or mongodb+srv://")
        return v

    @field_validator("REDIS_URL")
    @classmethod
    def _validate_redis_url(cls, v: str) -> str:
        if not v.startswith(("redis://", "rediss://", "unix://")):
            raise ValueError("REDIS_URL must start with redis://, rediss://, or unix://")
        return v

    @property
    def admin_ip_whitelist_set(self) -> set[str]:
        return {ip.strip() for ip in self.ADMIN_IP_WHITELIST.split(",") if ip.strip()}

    @property
    def cors_allowed_origins(self) -> list[str]:
        """Flatten both CORS_USER_ORIGIN and CORS_ADMIN_ORIGIN, splitting
        comma-separated values so each origin lands as its own list entry
        (Starlette's CORSMiddleware compares origins as exact strings — a
        single list entry like `"https://a,https://b"` matches nothing)."""
        raw = f"{self.CORS_USER_ORIGIN},{self.CORS_ADMIN_ORIGIN}"
        return [o.strip() for o in raw.split(",") if o.strip()]

    @property
    def zerodha_redirect_url(self) -> str:
        """Canonical Kite-Connect callback URL. Always lives on the backend
        because the request_token exchange happens server-side."""
        base = (self.BACKEND_PUBLIC_URL or "http://localhost:8000").rstrip("/")
        return f"{base}/api/v1/admin/zerodha/callback"

    @property
    def is_production(self) -> bool:
        return self.APP_ENV == "production"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


settings: Settings = get_settings()
