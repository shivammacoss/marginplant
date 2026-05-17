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
    REDIS_MAX_CONNECTIONS: int = 50

    # ── JWT ──────────────────────────────────────────────────────────
    # Refresh-token TTL widened from 7 → 30 days so the mobile app keeps
    # users logged in for a month (matches Zerodha / Groww / Upstox UX).
    # The token rotates on every refresh so a fresh login resets the
    # 30-day window — a daily-active user effectively never sees a login
    # screen unless they sign out explicitly or revoke from another device.
    JWT_SECRET: SecretStr = Field(default=SecretStr("change-me"))
    JWT_ALGORITHM: str = "HS256"
    JWT_ACCESS_TTL_MIN: int = 15
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
