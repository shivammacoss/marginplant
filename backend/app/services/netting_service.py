"""Netting Segment + Risk Management service.

Three resolvers:
    NettingSegment   → NettingScriptOverride → UserSegmentOverride
    RiskSettings     → UserRiskSettings
"""

from __future__ import annotations

import logging
from typing import Any

from beanie import PydanticObjectId

from app.core.exceptions import NotFoundError, ValidationFailedError
from app.core.redis_client import cache_delete_pattern, cache_get, cache_set
from app.models.netting import (
    BrokerRiskSettings,
    BrokerSegmentOverride,
    NettingFieldsBase,
    NettingFieldsRequired,
    NettingScriptOverride,
    NettingSegment,
    RiskSettings,
    RiskSettingsBase,
    RiskSettingsRequired,
    SEGMENT_CODES,
    SubAdminRiskSettings,
    SubAdminSegmentOverride,
    SuperAdminRiskSettings,
    SuperAdminSegmentOverride,
    UserRiskSettings,
    UserSegmentOverride,
)
from app.models.user import User

logger = logging.getLogger(__name__)

CACHE_TTL = 300

NETTING_FIELDS = list(NettingFieldsRequired.model_fields.keys())
RISK_FIELDS = list(RiskSettingsRequired.model_fields.keys())


# Cached super-admin id — looked up once per process. The resolver hits
# this for every "user in super-admin's pool" lookup, so a Mongo round-
# trip per call would be expensive. The id never changes for a given
# super-admin user, and the SUPER_ADMIN role is platform-singleton in
# practice, so caching is safe. Reset on process restart.
_SUPER_ADMIN_ID_CACHE: PydanticObjectId | None = None


async def _resolve_super_admin_id() -> PydanticObjectId | None:
    """Returns the super-admin's user id. Cached after first hit."""
    global _SUPER_ADMIN_ID_CACHE
    if _SUPER_ADMIN_ID_CACHE is not None:
        return _SUPER_ADMIN_ID_CACHE
    from app.models.user import UserRole

    coll = User.get_motor_collection()
    doc = await coll.find_one(
        {"role": UserRole.SUPER_ADMIN.value}, {"_id": 1}
    )
    if doc is None:
        return None
    _SUPER_ADMIN_ID_CACHE = doc["_id"]
    return _SUPER_ADMIN_ID_CACHE

# Admin matrix rows whose instruments don't settle daily — no separate
# overnight margin exists. The resolver always reads the *Intraday* column
# for these rows and the admin UI greys out the overnight cells.
INTRADAY_ONLY_ADMIN_ROWS = frozenset({"FOREX", "STOCKS", "INDICES", "COMMODITIES", "CRYPTO"})

# Module-local debounce for "netting_eff:*" wipes. The admin Segment Matrix
# fires N parallel PUTs (one per dirty segment); without this each call
# would do its own SCAN-based Redis pattern delete, paying O(N×keys) when
# one wipe is enough. We dedupe by remembering the last wipe timestamp and
# skipping subsequent wipes within `_WIPE_DEDUP_SEC`.
_WIPE_DEDUP_SEC = 1.5
_last_eff_wipe: float = 0.0


async def _wipe_eff_cache_debounced() -> None:
    """Cheap O(1) check before the O(N) SCAN — drops redundant wipes that
    arrive within ~1.5 s of each other (typical for a multi-segment save).

    Also wipes the spread cache (`spread:*`) — admin spread changes need
    to surface on the live quote pump within one tick, and a single SCAN
    pass against two prefixes is cheap. Keeping the wipes co-located here
    means every admin save flow (segment update, script upsert, user
    override) takes care of both caches automatically.
    """
    global _last_eff_wipe
    import time

    now = time.time()
    if now - _last_eff_wipe < _WIPE_DEDUP_SEC:
        return
    _last_eff_wipe = now
    try:
        await cache_delete_pattern("netting_eff:*")
        await cache_delete_pattern(f"{_SPREAD_KEY_PREFIX}*")
        # Strike-far cache (option chain filter) lives under its own key
        # prefix; same wipe semantics so an admin edit shows up on the
        # next chain poll instead of waiting 30 s for the cache to expire.
        await cache_delete_pattern("strike_far:*")
        # Drop the inactive-rows cache too — admin toggling `isActive` on
        # a row must hide/unhide that segment on the user side immediately
        # (this is one key, not a pattern, but `cache_delete_pattern`
        # handles single-key wipes fine).
        await cache_delete_pattern("inactive_admin_rows")
    except Exception:
        logger.warning("netting_cache_invalidation_failed_redis_down")


# ── Default segment seed metadata (matches bharat reference) ─────────
SEGMENT_DEFAULTS: list[dict[str, Any]] = [
    {"name": "NSE_EQ", "displayName": "NSE EQ", "lotApplies": False, "qtyApplies": True, "optionApplies": False, "expiryHoldApplies": False, "futureApplies": False},
    {"name": "NSE_FUT", "displayName": "NSE FUT", "lotApplies": True, "qtyApplies": False, "optionApplies": False, "expiryHoldApplies": True, "futureApplies": True},
    {"name": "NSE_OPT", "displayName": "NSE OPT", "lotApplies": True, "qtyApplies": False, "optionApplies": True, "expiryHoldApplies": True, "futureApplies": False},
    {"name": "BSE_EQ", "displayName": "BSE EQ", "lotApplies": False, "qtyApplies": True, "optionApplies": False, "expiryHoldApplies": False, "futureApplies": False},
    {"name": "BSE_FUT", "displayName": "BSE FUT", "lotApplies": True, "qtyApplies": False, "optionApplies": False, "expiryHoldApplies": True, "futureApplies": True},
    {"name": "BSE_OPT", "displayName": "BSE OPT", "lotApplies": True, "qtyApplies": False, "optionApplies": True, "expiryHoldApplies": True, "futureApplies": False},
    {"name": "MCX_FUT", "displayName": "MCX FUT", "lotApplies": True, "qtyApplies": False, "optionApplies": False, "expiryHoldApplies": True, "futureApplies": True},
    {"name": "MCX_OPT", "displayName": "MCX OPT", "lotApplies": True, "qtyApplies": False, "optionApplies": True, "expiryHoldApplies": True, "futureApplies": False},
    {"name": "FOREX", "displayName": "Forex", "lotApplies": True, "qtyApplies": False, "optionApplies": False, "expiryHoldApplies": False, "futureApplies": False},
    {"name": "STOCKS", "displayName": "Stocks", "lotApplies": True, "qtyApplies": False, "optionApplies": False, "expiryHoldApplies": False, "futureApplies": False},
    {"name": "INDICES", "displayName": "Indices", "lotApplies": True, "qtyApplies": False, "optionApplies": False, "expiryHoldApplies": False, "futureApplies": False},
    {"name": "COMMODITIES", "displayName": "Commodities", "lotApplies": True, "qtyApplies": False, "optionApplies": False, "expiryHoldApplies": False, "futureApplies": False},
    # Single crypto row — covers spot, perpetual, dated futures and options.
    # The user side only shows one "Crypto" asset-class chip, so the admin
    # matrix mirrors that with one row rather than four sub-segments.
    {"name": "CRYPTO", "displayName": "Crypto", "lotApplies": True, "qtyApplies": False, "optionApplies": False, "expiryHoldApplies": False, "futureApplies": False},
]

# Segment names that were ever retired and need an idempotent cleanup on
# startup. The two-row split (CRYPTO_PERPETUAL + CRYPTO_OPTIONS) was
# collapsed into a single CRYPTO row, so the old names are retired here
# to drop them along with any dangling script / per-user overrides on
# the next boot.
RETIRED_SEGMENT_NAMES: tuple[str, ...] = ("CRYPTO_PERPETUAL", "CRYPTO_OPTIONS")


# ── Seeding ─────────────────────────────────────────────────────────
async def seed_default_segments() -> int:
    inserted = 0
    for spec in SEGMENT_DEFAULTS:
        existing = await NettingSegment.find_one(NettingSegment.name == spec["name"])
        if existing is not None:
            continue
        defaults = NettingFieldsRequired().model_dump()
        # Equity segments: percent margin and per-crore brokerage; tweak a couple
        if spec["name"].endswith("_EQ"):
            defaults["commissionType"] = "per_crore"
            defaults["commission"] = 300.0
        if spec["name"] == "FOREX":
            defaults["spreadType"] = "floating"
            defaults["minLots"] = 0.01
            defaults["orderLots"] = 0.01
        if spec["name"].startswith("CRYPTO"):
            defaults["minLots"] = 0.001
            defaults["orderLots"] = 0.001
        await NettingSegment(**spec, **defaults).insert()
        inserted += 1
    return inserted


async def heal_legacy_percent_seeds() -> int:
    """Idempotent boot heal — resets legacy seed values to NULL so the
    resolver's inheritance / inference paths take over.

    Two things get reset:

    1. ``marginCalcMode == "percent"`` (the old seed default which is no
       longer a valid admin dropdown option). Setting to NULL lets the
       resolver's defensive inference pick Times (if intradayMargin > 100)
       or Fixed (≤ 100) automatically.

    2. ``optionBuyIntraday == 100.0`` / ``optionSellIntraday == 15.0``
       (the old per-side seed defaults). Setting to NULL signals "inherit
       from segment-wide intradayMargin / overnightMargin", which is what
       admins almost always want — typing ``intradayMargin = 300`` on
       NSE_OPT expecting all options to use 300, only to discover the
       option columns silently overrode it.

    Safe to run on every boot — no-op once rows are cleaned. Returns the
    count of healed rows.
    """
    rows = await NettingSegment.find_all().to_list()
    SEED_INTRA = 100.0
    SEED_OPT_BUY = 100.0
    SEED_OPT_SELL = 15.0
    healed = 0
    for seg in rows:
        changed = False
        # Reset legacy "percent" mode when row is still at seed defaults.
        if (
            getattr(seg, "marginCalcMode", None) == "percent"
            and float(getattr(seg, "intradayMargin", 0) or 0) == SEED_INTRA
            and float(getattr(seg, "overnightMargin", 0) or 0) == SEED_INTRA
        ):
            seg.marginCalcMode = None
            changed = True
        # Reset per-side option columns when they're at seed defaults —
        # these almost always represent "inherit from segment", not an
        # explicit override.
        if float(getattr(seg, "optionBuyIntraday", 0) or 0) == SEED_OPT_BUY:
            seg.optionBuyIntraday = None
            changed = True
        if float(getattr(seg, "optionBuyOvernight", 0) or 0) == SEED_OPT_BUY:
            seg.optionBuyOvernight = None
            changed = True
        if float(getattr(seg, "optionSellIntraday", 0) or 0) == SEED_OPT_SELL:
            seg.optionSellIntraday = None
            changed = True
        if float(getattr(seg, "optionSellOvernight", 0) or 0) == SEED_OPT_SELL:
            seg.optionSellOvernight = None
            changed = True
        if changed:
            try:
                await seg.save()
                healed += 1
            except Exception:
                logger.exception("heal_seed_save_failed", extra={"name": seg.name})
    if healed:
        logger.info("healed_legacy_seed_rows", extra={"count": healed})
        try:
            await _wipe_eff_cache_debounced()
        except Exception:
            pass
    return healed


async def cleanup_retired_segments() -> int:
    """Idempotent — drop NettingSegment rows whose names are in
    RETIRED_SEGMENT_NAMES, along with any script overrides and per-user
    overrides that still reference them. Safe to run on every startup;
    no-op once the rows are gone."""
    removed = 0
    for name in RETIRED_SEGMENT_NAMES:
        # Drop the segment row itself.
        seg = await NettingSegment.find_one(NettingSegment.name == name)
        if seg is not None:
            await seg.delete()
            removed += 1
        # Drop dangling script overrides for this segment.
        scripts = await NettingScriptOverride.find(
            NettingScriptOverride.segment_name == name
        ).to_list()
        for s in scripts:
            await s.delete()
            removed += 1
        # Drop dangling per-user overrides for this segment.
        user_ovs = await UserSegmentOverride.find(
            UserSegmentOverride.segment_name == name
        ).to_list()
        for u in user_ovs:
            await u.delete()
            removed += 1
    if removed:
        logger.info("netting_retired_segments_cleaned", extra={"count": removed})
    return removed


async def seed_default_risk() -> bool:
    existing = await RiskSettings.find_one(RiskSettings.type == "global")
    if existing is not None:
        return False
    await RiskSettings(**RiskSettingsRequired().model_dump()).insert()
    return True


# ── Risk Management ────────────────────────────────────────────────
async def get_global_risk() -> RiskSettings:
    doc = await RiskSettings.find_one(RiskSettings.type == "global")
    if doc is None:
        await seed_default_risk()
        doc = await RiskSettings.find_one(RiskSettings.type == "global")
    return doc  # type: ignore[return-value]


def _coerce_risk_value(field: str, v: Any) -> Any:
    """Coerce frontend payloads to the model's declared type. Number inputs
    on the form arrive as floats (because of step=0.01); the int-typed hold
    timers must be rounded to int or Pydantic 2.13 strict-mode will reject
    them on the next read and crash the GET endpoint."""
    if v is None:
        return None
    if field in ("profitTradeHoldMinSeconds", "lossTradeHoldMinSeconds"):
        try:
            return int(round(float(v)))
        except (TypeError, ValueError):
            return v
    if field in ("ledgerBalanceClose", "marginCallLevel", "stopOutLevel"):
        try:
            return float(v)
        except (TypeError, ValueError):
            return v
    if field in ("blockLimitAboveBelowHighLow", "blockLimitBetweenHighLow", "exitOnlyMode"):
        if isinstance(v, str):
            return v.lower() in ("true", "1", "yes", "on")
        return bool(v)
    return v


async def update_global_risk(patch: dict[str, Any]) -> RiskSettings:
    doc = await get_global_risk()
    for k, v in patch.items():
        if k in RISK_FIELDS and v is not None:
            setattr(doc, k, _coerce_risk_value(k, v))
    await doc.save()
    await cache_delete_pattern("risk:*")
    return doc


async def get_user_risk(user_id: str | PydanticObjectId) -> UserRiskSettings | None:
    return await UserRiskSettings.find_one(
        UserRiskSettings.user_id == PydanticObjectId(user_id)
    )


async def upsert_user_risk(user_id: str | PydanticObjectId, patch: dict[str, Any]) -> UserRiskSettings:
    uid = PydanticObjectId(user_id)
    existing = await UserRiskSettings.find_one(UserRiskSettings.user_id == uid)
    if existing is None:
        existing = UserRiskSettings(user_id=uid)
    for k, v in patch.items():
        if k in RISK_FIELDS:
            setattr(existing, k, _coerce_risk_value(k, v) if v is not None else None)
    await existing.save()
    await cache_delete_pattern(f"risk:{uid}")
    return existing


async def copy_user_risk(source_user_id: str | PydanticObjectId, dest_user_id: str | PydanticObjectId) -> UserRiskSettings:
    """Clone one user's override doc onto another. If the source has no
    override, the destination ends up inheriting global (override deleted)."""
    src_uid = PydanticObjectId(source_user_id)
    dst_uid = PydanticObjectId(dest_user_id)
    if src_uid == dst_uid:
        raise ValueError("Source and destination users are the same")
    src = await UserRiskSettings.find_one(UserRiskSettings.user_id == src_uid)
    if src is None:
        # Nothing to copy → drop any existing override on dest so it inherits.
        await delete_user_risk(dst_uid)
        return UserRiskSettings(user_id=dst_uid)
    patch = {f: getattr(src, f, None) for f in RISK_FIELDS}
    return await upsert_user_risk(dst_uid, patch)


async def delete_user_risk(user_id: str | PydanticObjectId) -> None:
    uid = PydanticObjectId(user_id)
    await UserRiskSettings.find(UserRiskSettings.user_id == uid).delete()
    await cache_delete_pattern(f"risk:{uid}")


# ── Sub-admin risk default ────────────────────────────────────────────
async def get_sub_admin_risk(
    sub_admin_id: str | PydanticObjectId,
) -> SubAdminRiskSettings | None:
    return await SubAdminRiskSettings.find_one(
        SubAdminRiskSettings.sub_admin_id == PydanticObjectId(sub_admin_id)
    )


async def upsert_sub_admin_risk(
    sub_admin_id: str | PydanticObjectId, patch: dict[str, Any]
) -> SubAdminRiskSettings:
    sid = PydanticObjectId(sub_admin_id)
    existing = await SubAdminRiskSettings.find_one(
        SubAdminRiskSettings.sub_admin_id == sid
    )
    if existing is None:
        existing = SubAdminRiskSettings(sub_admin_id=sid)
    for k, v in patch.items():
        if k in RISK_FIELDS:
            setattr(
                existing, k, _coerce_risk_value(k, v) if v is not None else None
            )
    await existing.save()
    # Invalidate effective-risk cache for every user assigned to this sub-admin.
    await _invalidate_pool_risk_cache(sid)
    return existing


async def delete_sub_admin_risk(sub_admin_id: str | PydanticObjectId) -> None:
    sid = PydanticObjectId(sub_admin_id)
    await SubAdminRiskSettings.find(
        SubAdminRiskSettings.sub_admin_id == sid
    ).delete()
    await _invalidate_pool_risk_cache(sid)


async def _invalidate_pool_risk_cache(sub_admin_id: PydanticObjectId) -> None:
    """Wipes the per-user `risk:<uid>` cache for every user assigned to
    this sub-admin. Cheaper than wiping the whole `risk:*` pattern when
    only one pool changed."""
    coll = User.get_motor_collection()
    cursor = coll.find({"assigned_admin_id": sub_admin_id}, {"_id": 1})
    async for doc in cursor:
        await cache_delete_pattern(f"risk:{doc['_id']}")


# ── Super-admin risk default (super-admin's own pool) ────────────────
async def get_super_admin_risk(
    super_admin_id: str | PydanticObjectId,
) -> SuperAdminRiskSettings | None:
    return await SuperAdminRiskSettings.find_one(
        SuperAdminRiskSettings.super_admin_id == PydanticObjectId(super_admin_id)
    )


async def upsert_super_admin_risk(
    super_admin_id: str | PydanticObjectId, patch: dict[str, Any]
) -> SuperAdminRiskSettings:
    sid = PydanticObjectId(super_admin_id)
    existing = await SuperAdminRiskSettings.find_one(
        SuperAdminRiskSettings.super_admin_id == sid
    )
    if existing is None:
        existing = SuperAdminRiskSettings(super_admin_id=sid)
    for k, v in patch.items():
        if k in RISK_FIELDS:
            setattr(
                existing, k, _coerce_risk_value(k, v) if v is not None else None
            )
    await existing.save()
    await _invalidate_super_admin_pool_risk_cache()
    return existing


async def delete_super_admin_risk(super_admin_id: str | PydanticObjectId) -> None:
    sid = PydanticObjectId(super_admin_id)
    await SuperAdminRiskSettings.find(
        SuperAdminRiskSettings.super_admin_id == sid
    ).delete()
    await _invalidate_super_admin_pool_risk_cache()


async def _invalidate_super_admin_pool_risk_cache() -> None:
    coll = User.get_motor_collection()
    cursor = coll.find(
        {"assigned_admin_id": None, "assigned_broker_id": None},
        {"_id": 1},
    )
    async for doc in cursor:
        await cache_delete_pattern(f"risk:{doc['_id']}")


# ── Broker risk default (broker's own pool) ──────────────────────────
async def get_broker_risk(
    broker_id: str | PydanticObjectId,
) -> BrokerRiskSettings | None:
    return await BrokerRiskSettings.find_one(
        BrokerRiskSettings.broker_id == PydanticObjectId(broker_id)
    )


async def upsert_broker_risk(
    broker_id: str | PydanticObjectId, patch: dict[str, Any]
) -> BrokerRiskSettings:
    bid = PydanticObjectId(broker_id)
    existing = await BrokerRiskSettings.find_one(
        BrokerRiskSettings.broker_id == bid
    )
    if existing is None:
        existing = BrokerRiskSettings(broker_id=bid)
    for k, v in patch.items():
        if k in RISK_FIELDS:
            setattr(
                existing, k, _coerce_risk_value(k, v) if v is not None else None
            )
    await existing.save()
    await _invalidate_broker_pool_risk_cache(bid)
    return existing


async def delete_broker_risk(broker_id: str | PydanticObjectId) -> None:
    bid = PydanticObjectId(broker_id)
    await BrokerRiskSettings.find(BrokerRiskSettings.broker_id == bid).delete()
    await _invalidate_broker_pool_risk_cache(bid)


async def _invalidate_broker_pool_risk_cache(broker_id: PydanticObjectId) -> None:
    coll = User.get_motor_collection()
    cursor = coll.find({"assigned_broker_id": broker_id}, {"_id": 1})
    async for doc in cursor:
        await cache_delete_pattern(f"risk:{doc['_id']}")


async def get_effective_risk(user_id: str | PydanticObjectId) -> dict[str, Any]:
    uid = str(user_id)
    cache_key = f"risk:{uid}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

    # Layer 1: platform global (super-admin)
    g = await get_global_risk()
    merged: dict[str, Any] = {f: getattr(g, f) for f in RISK_FIELDS}
    sources = {f: "GLOBAL" for f in RISK_FIELDS}

    # Layer 2: pool default — picks exactly ONE tier override based on
    # the user's pool membership (broker > sub-admin > super-admin).
    # Each tier is independent — super-admin's risk edits no longer leak
    # into admin / broker pools as a shared fallback.
    user_doc = await User.get(PydanticObjectId(uid))
    if user_doc is not None:
        pool_risk = None
        pool_source = None
        broker_anc = user_doc.broker_ancestry or []
        if broker_anc:
            broker_id = broker_anc[-1]
            pool_risk = await get_broker_risk(broker_id)
            pool_source = "BROKER"
        elif user_doc.assigned_admin_id is not None:
            pool_risk = await get_sub_admin_risk(user_doc.assigned_admin_id)
            pool_source = "SUB_ADMIN"
        else:
            sa_id = await _resolve_super_admin_id()
            if sa_id is not None:
                pool_risk = await get_super_admin_risk(sa_id)
                pool_source = "SUPER_ADMIN"
        if pool_risk is not None and pool_source is not None:
            for f in RISK_FIELDS:
                v = getattr(pool_risk, f, None)
                if v is not None:
                    merged[f] = v
                    sources[f] = pool_source

    # Layer 3: per-user override (highest priority)
    u = await get_user_risk(uid)
    if u is not None:
        for f in RISK_FIELDS:
            v = getattr(u, f, None)
            if v is not None:
                merged[f] = v
                sources[f] = "USER"

    payload = {"settings": merged, "sources": sources}
    await cache_set(cache_key, payload, ttl_sec=CACHE_TTL)
    return payload


# ── Netting Segments ───────────────────────────────────────────────
async def list_segments() -> list[NettingSegment]:
    rows = await NettingSegment.find_all().to_list()
    if not rows:
        await seed_default_segments()
        rows = await NettingSegment.find_all().to_list()
    # Stable order matching SEGMENT_CODES
    order = {n: i for i, n in enumerate(SEGMENT_CODES)}
    rows.sort(key=lambda r: order.get(r.name, 99))
    return rows


def _split_pattern(script_symbol: str) -> tuple[str, str] | None:
    """If `script_symbol` is a derivative shorthand (e.g. `NIFTYFUT`,
    `BANKNIFTYCE`, `SBINPE`), return `(base, suffix)` where suffix is one
    of `FUT` / `CE` / `PE` and base is everything before it. Otherwise
    return None — caller should treat the script as an exact-match row.

    A symbol counts as a pattern when it ends in one of the three
    derivative suffixes AND contains no digit characters. Real exchange
    symbols always carry an expiry / strike digit chunk (NIFTY26JANFUT,
    NIFTY26JAN22500CE), so the digit-free rule cleanly separates the two.
    """
    s = (script_symbol or "").upper()
    if not s or any(c.isdigit() for c in s):
        return None
    for suf in ("FUT", "CE", "PE"):
        if s.endswith(suf) and len(s) > len(suf):
            return s[: -len(suf)], suf
    return None


def _instrument_matches_pattern(instrument_sym: str, base: str, suffix: str) -> bool:
    """True when an instrument's symbol matches a `<base><suffix>` pattern.

    Match rule: starts with `base` AND ends with `suffix`. So `NIFTYFUT`
    matches `NIFTY26JANFUT`, `NIFTY26FEBFUT`, `NIFTYNXT50FUT` (anything that
    starts with `NIFTY` and ends with `FUT`). The user wanted the broadest
    possible cover across expiries, so deliberately no expiry-digit gate
    on the middle section.
    """
    s = (instrument_sym or "").upper()
    return s.startswith(base) and s.endswith(suffix)


async def _match_pattern_script(
    seg_name: str, instrument_sym: str
) -> "NettingScriptOverride | None":
    """Scan every script override in the segment for one whose symbol is
    a pattern that matches `instrument_sym`. Falls through to None when
    no pattern matches — caller keeps the segment defaults.

    O(N) over the segment's script count; in practice N is small (a few
    dozen) so this is fine even on the resolver hot path. The 5-min
    `netting_eff:*` cache absorbs the lookup cost for repeat orders on
    the same instrument.
    """
    rows = await NettingScriptOverride.find(
        NettingScriptOverride.segment_name == seg_name
    ).to_list()
    for row in rows:
        split = _split_pattern(row.symbol)
        if split is None:
            continue
        base, suffix = split
        if _instrument_matches_pattern(instrument_sym, base, suffix):
            return row
    return None


async def get_segment(segment_id: str | PydanticObjectId) -> NettingSegment:
    doc = await NettingSegment.get(PydanticObjectId(segment_id))
    if doc is None:
        raise NotFoundError("Segment not found")
    return doc


# ── Spread resolver (no user context) ────────────────────────────────
# Called from the quote pump on every tick — must be cheap. Walks just the
# segment-default + per-script-override layers (UserSegmentOverride is
# skipped: spreads are admin-set markups, not per-user adjustments, and
# routing every tick through a user lookup would torpedo latency).
#
# Cache: 30 s in Redis keyed on `spread:{seg_name}:{symbol|_}`. The admin
# save flow wipes this key set alongside `netting_eff:*` so an admin edit
# propagates to the live feed within one tick after save.
SPREAD_CACHE_TTL = 30
_SPREAD_KEY_PREFIX = "spread:"


async def _wipe_spread_cache_debounced() -> None:
    try:
        await cache_delete_pattern(f"{_SPREAD_KEY_PREFIX}*")
    except Exception:
        logger.warning("spread_cache_invalidation_failed_redis_down")


async def inactive_admin_rows() -> set[str]:
    """Names of admin matrix rows currently flagged `isActive = false`.

    Used by the user-side instrument search to *hide* every instrument that
    belongs to a disabled segment — the user shouldn't see prices or
    candidates for a segment they can't trade. Validator still has its own
    server-side gate as a belt-and-braces check.

    Cached in Redis for 30 s under a single key — admins toggling Block
    fields propagate to the next user search within one tick after Save
    (the existing eff-cache wipe drops this key too).
    """
    cache_key = "inactive_admin_rows"
    try:
        cached = await cache_get(cache_key)
        if cached is not None and isinstance(cached, list):
            return set(cached)
    except Exception:
        pass
    rows = await NettingSegment.find({"isActive": False}).to_list()
    names = {r.name for r in rows if r.name}
    try:
        await cache_set(cache_key, sorted(names), ttl_sec=30)
    except Exception:
        pass
    return names


async def inactive_instrument_segments() -> set[str]:
    """Translate inactive admin-row names back into the SegmentType values
    instruments are tagged with — so the user search can filter by
    `instrument.segment NOT IN this_set`."""
    admin_rows = await inactive_admin_rows()
    if not admin_rows:
        return set()
    out: set[str] = set()
    for seg_type, admin_row in _SEGMENT_NAME_MAP.items():
        if admin_row in admin_rows:
            out.add(seg_type)
    # Admin rows whose name matches the instrument segment 1:1 (FOREX,
    # STOCKS, INDICES, COMMODITIES, CRYPTO and similar) — `_SEGMENT_NAME_MAP`
    # also maps these to themselves, so they're already covered above.
    # Include the raw admin-row names too as a safety net.
    out |= admin_rows
    return out


async def resolve_strike_far(segment_name: str) -> float:
    """Return the `strikeFarPercent` for an OPT admin row (NSE_OPT /
    BSE_OPT / MCX_OPT). Cached in Redis for 30 s under
    `strike_far:{seg}`. Same wipe pattern as the spread cache — segment
    save flow drops both keys together.

    No per-symbol / per-user layer: the option chain dialog is shared,
    so the filter must be deterministic across viewers. If admin needs
    a different cap for a single index later, a per-script override
    layer can land alongside the spread one.
    """
    seg_name = (segment_name or "").strip()
    if not seg_name:
        return 0.0
    cache_key = f"strike_far:{seg_name}"
    try:
        cached = await cache_get(cache_key)
        if cached is not None:
            return float(cached)
    except Exception:
        pass
    seg = await NettingSegment.find_one(NettingSegment.name == seg_name)
    pct = 0.0
    if seg is not None:
        pct = float(getattr(seg, "strikeFarPercent", 0.0) or 0.0)
    try:
        await cache_set(cache_key, pct, ttl_sec=30)
    except Exception:
        pass
    return pct


async def resolve_spread(segment_name: str, symbol: str | None) -> dict[str, Any]:
    """Return the admin-resolved `{spread_type, spread_pips}` for the
    segment + symbol pair. Cached in Redis for ~30 s.

    `segment_name` must be the ADMIN-row name (NSE_EQ / FOREX / CRYPTO …),
    NOT the instrument SegmentType. Callers translate via _SEGMENT_NAME_MAP
    before reaching here.
    """
    seg_name = (segment_name or "").strip()
    sym_key = (symbol or "").strip().upper() or "_"
    cache_key = f"{_SPREAD_KEY_PREFIX}{seg_name}:{sym_key}"
    try:
        cached = await cache_get(cache_key)
        if cached is not None:
            return cached
    except Exception:
        pass

    seg = await NettingSegment.find_one(NettingSegment.name == seg_name)
    spread_type: str = "fixed"
    spread_pips: float = 0.0
    if seg is not None:
        spread_type = str(getattr(seg, "spreadType", "fixed") or "fixed")
        spread_pips = float(getattr(seg, "spreadPips", 0.0) or 0.0)

    if symbol:
        # Same exact → pattern fallback as `get_effective_settings` so a
        # NIFTYFUT spread override applies to every NIFTY future contract.
        script = await NettingScriptOverride.find_one(
            NettingScriptOverride.segment_name == seg_name,
            NettingScriptOverride.symbol == sym_key,
        )
        if script is None:
            script = await _match_pattern_script(seg_name, sym_key)
        if script is not None:
            override_type = getattr(script, "spreadType", None)
            override_pips = getattr(script, "spreadPips", None)
            if override_type is not None:
                spread_type = str(override_type)
            if override_pips is not None:
                spread_pips = float(override_pips)

    payload = {"spread_type": spread_type, "spread_pips": spread_pips}
    try:
        await cache_set(cache_key, payload, ttl_sec=SPREAD_CACHE_TTL)
    except Exception:
        pass
    return payload


async def update_segment(segment_id: str | PydanticObjectId, patch: dict[str, Any]) -> NettingSegment:
    doc = await get_segment(segment_id)
    for k, v in patch.items():
        if k in NETTING_FIELDS and v is not None:
            setattr(doc, k, v)
    await doc.save()
    # Clear per-user effective-settings caches so admin edits take effect
    # immediately on the user terminal. The resolver's cache key has the
    # form `netting_eff:{user_id}:{seg_name}:...` — the old
    # `netting:NAME:*` pattern never matched and made admin edits invisible.
    # `_wipe_eff_cache_debounced` collapses bursts so a 14-segment Save All
    # pays one O(N) SCAN, not fourteen.
    await _wipe_eff_cache_debounced()
    try:
        await cache_delete_pattern(f"netting:{doc.name}:*")
    except Exception:
        logger.warning("netting_cache_invalidation_failed_redis_down")
    return doc


# ── Script overrides ──────────────────────────────────────────────
async def list_scripts(segment: str | None = None) -> list[NettingScriptOverride]:
    if segment:
        return await NettingScriptOverride.find(
            NettingScriptOverride.segment_name == segment
        ).to_list()
    return await NettingScriptOverride.find_all().to_list()


async def create_script(payload: dict[str, Any]) -> NettingScriptOverride:
    seg_name = payload.get("segment_name")
    seg_id = payload.get("segment_id")
    if not seg_name or not seg_id:
        raise ValidationFailedError("segment_name and segment_id required")
    symbol = (payload.get("symbol") or "").strip().upper()
    if not symbol:
        raise ValidationFailedError("symbol required")
    existing = await NettingScriptOverride.find_one(
        NettingScriptOverride.segment_name == seg_name,
        NettingScriptOverride.symbol == symbol,
    )
    if existing is not None:
        raise ValidationFailedError(f"Script {symbol} already exists in {seg_name}")
    clean: dict[str, Any] = {
        "segment_id": PydanticObjectId(seg_id),
        "segment_name": seg_name,
        "symbol": symbol,
        "tradingSymbol": payload.get("tradingSymbol") or symbol,
        "instrumentToken": payload.get("instrumentToken"),
        "lotSize": payload.get("lotSize") or 1.0,
    }
    for k in NETTING_FIELDS:
        if k in payload and payload[k] is not None:
            clean[k] = payload[k]
    doc = NettingScriptOverride(**clean)
    await doc.insert()
    return doc


async def update_script(script_id: str | PydanticObjectId, patch: dict[str, Any]) -> NettingScriptOverride:
    doc = await NettingScriptOverride.get(PydanticObjectId(script_id))
    if doc is None:
        raise NotFoundError("Script override not found")
    for k, v in patch.items():
        if k in NETTING_FIELDS:
            setattr(doc, k, v)
    if "lotSize" in patch and patch["lotSize"] is not None:
        doc.lotSize = float(patch["lotSize"])
    await doc.save()
    await _wipe_eff_cache_debounced()
    return doc


async def delete_script(script_id: str | PydanticObjectId) -> None:
    doc = await NettingScriptOverride.get(PydanticObjectId(script_id))
    if doc is not None:
        await doc.delete()
        await _wipe_eff_cache_debounced()


# ── Sub-admin segment defaults ────────────────────────────────────────
async def list_sub_admin_segment_overrides(
    sub_admin_id: str | PydanticObjectId,
) -> list[SubAdminSegmentOverride]:
    return await SubAdminSegmentOverride.find(
        SubAdminSegmentOverride.sub_admin_id == PydanticObjectId(sub_admin_id)
    ).to_list()


async def get_sub_admin_segment_override(
    sub_admin_id: str | PydanticObjectId, segment_name: str
) -> SubAdminSegmentOverride | None:
    return await SubAdminSegmentOverride.find_one(
        SubAdminSegmentOverride.sub_admin_id == PydanticObjectId(sub_admin_id),
        SubAdminSegmentOverride.segment_name == segment_name,
    )


async def upsert_sub_admin_segment_override(
    sub_admin_id: str | PydanticObjectId,
    segment_name: str,
    patch: dict[str, Any],
) -> SubAdminSegmentOverride:
    sid = PydanticObjectId(sub_admin_id)
    existing = await SubAdminSegmentOverride.find_one(
        SubAdminSegmentOverride.sub_admin_id == sid,
        SubAdminSegmentOverride.segment_name == segment_name,
    )
    if existing is None:
        existing = SubAdminSegmentOverride(
            sub_admin_id=sid, segment_name=segment_name
        )
    for k, v in patch.items():
        if k in NETTING_FIELDS:
            setattr(existing, k, v)
    await existing.save()
    await _invalidate_pool_netting_cache(sid)
    return existing


async def delete_sub_admin_segment_override(
    sub_admin_id: str | PydanticObjectId, segment_name: str
) -> None:
    sid = PydanticObjectId(sub_admin_id)
    await SubAdminSegmentOverride.find(
        SubAdminSegmentOverride.sub_admin_id == sid,
        SubAdminSegmentOverride.segment_name == segment_name,
    ).delete()
    await _invalidate_pool_netting_cache(sid)


async def _invalidate_pool_netting_cache(sub_admin_id: PydanticObjectId) -> None:
    """Wipes the per-user `netting_eff:<uid>:*` cache for every user
    assigned to this sub-admin."""
    coll = User.get_motor_collection()
    cursor = coll.find({"assigned_admin_id": sub_admin_id}, {"_id": 1})
    async for doc in cursor:
        await cache_delete_pattern(f"netting_eff:{doc['_id']}:*")


# ── Super-admin segment defaults (super-admin's own pool) ────────────
async def list_super_admin_segment_overrides(
    super_admin_id: str | PydanticObjectId,
) -> list[SuperAdminSegmentOverride]:
    return await SuperAdminSegmentOverride.find(
        SuperAdminSegmentOverride.super_admin_id == PydanticObjectId(super_admin_id)
    ).to_list()


async def get_super_admin_segment_override(
    super_admin_id: str | PydanticObjectId, segment_name: str
) -> SuperAdminSegmentOverride | None:
    return await SuperAdminSegmentOverride.find_one(
        SuperAdminSegmentOverride.super_admin_id == PydanticObjectId(super_admin_id),
        SuperAdminSegmentOverride.segment_name == segment_name,
    )


async def upsert_super_admin_segment_override(
    super_admin_id: str | PydanticObjectId,
    segment_name: str,
    patch: dict[str, Any],
) -> SuperAdminSegmentOverride:
    sid = PydanticObjectId(super_admin_id)
    existing = await SuperAdminSegmentOverride.find_one(
        SuperAdminSegmentOverride.super_admin_id == sid,
        SuperAdminSegmentOverride.segment_name == segment_name,
    )
    if existing is None:
        existing = SuperAdminSegmentOverride(
            super_admin_id=sid, segment_name=segment_name
        )
    for k, v in patch.items():
        if k in NETTING_FIELDS:
            setattr(existing, k, v)
    await existing.save()
    await _invalidate_super_admin_pool_netting_cache()
    return existing


async def delete_super_admin_segment_override(
    super_admin_id: str | PydanticObjectId, segment_name: str
) -> None:
    sid = PydanticObjectId(super_admin_id)
    await SuperAdminSegmentOverride.find(
        SuperAdminSegmentOverride.super_admin_id == sid,
        SuperAdminSegmentOverride.segment_name == segment_name,
    ).delete()
    await _invalidate_super_admin_pool_netting_cache()


async def _invalidate_super_admin_pool_netting_cache() -> None:
    """Wipes per-user netting cache for every user in the super-admin's
    pool (i.e. ``assigned_admin_id IS NULL`` AND no broker)."""
    coll = User.get_motor_collection()
    cursor = coll.find(
        {"assigned_admin_id": None, "assigned_broker_id": None},
        {"_id": 1},
    )
    async for doc in cursor:
        await cache_delete_pattern(f"netting_eff:{doc['_id']}:*")


# ── Broker segment defaults (broker's own pool) ──────────────────────
async def list_broker_segment_overrides(
    broker_id: str | PydanticObjectId,
) -> list[BrokerSegmentOverride]:
    return await BrokerSegmentOverride.find(
        BrokerSegmentOverride.broker_id == PydanticObjectId(broker_id)
    ).to_list()


async def get_broker_segment_override(
    broker_id: str | PydanticObjectId, segment_name: str
) -> BrokerSegmentOverride | None:
    return await BrokerSegmentOverride.find_one(
        BrokerSegmentOverride.broker_id == PydanticObjectId(broker_id),
        BrokerSegmentOverride.segment_name == segment_name,
    )


async def upsert_broker_segment_override(
    broker_id: str | PydanticObjectId,
    segment_name: str,
    patch: dict[str, Any],
) -> BrokerSegmentOverride:
    bid = PydanticObjectId(broker_id)
    existing = await BrokerSegmentOverride.find_one(
        BrokerSegmentOverride.broker_id == bid,
        BrokerSegmentOverride.segment_name == segment_name,
    )
    if existing is None:
        existing = BrokerSegmentOverride(broker_id=bid, segment_name=segment_name)
    for k, v in patch.items():
        if k in NETTING_FIELDS:
            setattr(existing, k, v)
    await existing.save()
    await _invalidate_broker_pool_netting_cache(bid)
    return existing


async def delete_broker_segment_override(
    broker_id: str | PydanticObjectId, segment_name: str
) -> None:
    bid = PydanticObjectId(broker_id)
    await BrokerSegmentOverride.find(
        BrokerSegmentOverride.broker_id == bid,
        BrokerSegmentOverride.segment_name == segment_name,
    ).delete()
    await _invalidate_broker_pool_netting_cache(bid)


async def _invalidate_broker_pool_netting_cache(broker_id: PydanticObjectId) -> None:
    """Wipes per-user netting cache for every user whose
    ``assigned_broker_id`` matches this broker (the broker's direct clients)."""
    coll = User.get_motor_collection()
    cursor = coll.find({"assigned_broker_id": broker_id}, {"_id": 1})
    async for doc in cursor:
        await cache_delete_pattern(f"netting_eff:{doc['_id']}:*")


# ── Per-user segment overrides ────────────────────────────────────
async def list_user_overrides(user_id: str | PydanticObjectId) -> list[UserSegmentOverride]:
    return await UserSegmentOverride.find(
        UserSegmentOverride.user_id == PydanticObjectId(user_id)
    ).to_list()


async def upsert_user_override(
    user_id: str | PydanticObjectId,
    segment_name: str,
    patch: dict[str, Any],
    symbol: str | None = None,
) -> UserSegmentOverride:
    uid = PydanticObjectId(user_id)
    sym = (symbol or "").strip().upper() or None
    existing = await UserSegmentOverride.find_one(
        UserSegmentOverride.user_id == uid,
        UserSegmentOverride.segment_name == segment_name,
        UserSegmentOverride.symbol == sym,
    )
    if existing is None:
        existing = UserSegmentOverride(user_id=uid, segment_name=segment_name, symbol=sym)
    for k, v in patch.items():
        if k in NETTING_FIELDS:
            setattr(existing, k, v)
    await existing.save()
    # Wipe per-user effective-settings cache so next read reflects this override.
    await cache_delete_pattern(f"netting_eff:{uid}:*")
    return existing


async def delete_user_override(
    user_id: str | PydanticObjectId,
    segment_name: str,
    symbol: str | None = None,
) -> None:
    uid = PydanticObjectId(user_id)
    sym = (symbol or "").strip().upper() or None
    await UserSegmentOverride.find(
        UserSegmentOverride.user_id == uid,
        UserSegmentOverride.segment_name == segment_name,
        UserSegmentOverride.symbol == sym,
    ).delete()
    await cache_delete_pattern(f"netting_eff:{uid}:*")


# ── Effective resolver (legacy field-name shim for order_validator) ─
# Map legacy SegmentType strings (NSE_EQUITY, NSE_FUTURE, …) to NettingSegment
# names (NSE_EQ, NSE_FUT, …). Multiple legacy types fold into one netting row.
_SEGMENT_NAME_MAP: dict[str, str] = {
    "NSE_EQUITY": "NSE_EQ",
    "NSE_FUTURE": "NSE_FUT",
    "NSE_INDEX_FUTURE": "NSE_FUT",
    "NSE_STOCK_OPTION_BUY": "NSE_OPT",
    "NSE_STOCK_OPTION_SELL": "NSE_OPT",
    "NSE_INDEX_OPTION_BUY": "NSE_OPT",
    "NSE_INDEX_OPTION_SELL": "NSE_OPT",
    "BSE_EQUITY": "BSE_EQ",
    "BSE_FUTURE": "BSE_FUT",
    "BSE_INDEX_FUTURE": "BSE_FUT",
    "BSE_OPTION_BUY": "BSE_OPT",
    "BSE_OPTION_SELL": "BSE_OPT",
    "MCX_FUTURE": "MCX_FUT",
    "MCX_OPTION_BUY": "MCX_OPT",
    "MCX_OPTION_SELL": "MCX_OPT",
    "CDS_FUTURE": "FOREX",
    "CDS_OPTION_BUY": "FOREX",
    "CDS_OPTION_SELL": "FOREX",
    # Every crypto instrument resolves to the single CRYPTO admin row.
    "CRYPTO_SPOT": "CRYPTO",
    "CRYPTO_FUTURE": "CRYPTO",
    "CRYPTO_PERPETUAL": "CRYPTO",
    # Infoway-fed international markets resolve to their own admin rows.
    # The instrument segment value already matches the admin row name —
    # we map them through explicitly so the resolver doesn't fall back
    # to the synthetic permissive defaults.
    "FOREX": "FOREX",
    "STOCKS": "STOCKS",
    "INDICES": "INDICES",
    "COMMODITIES": "COMMODITIES",
    # Legacy compatibility: instrument rows created before the
    # _auto_create_instrument / _mirror_from_zerodha segment-naming fix
    # (commit landed 2026-05) stored segment as the Kite exchange code
    # + suffix (e.g. "BFO_FUT") instead of the canonical SegmentType.
    # Map them through so admin's per-segment settings still apply on
    # those legacy positions/orders without forcing a data migration.
    "BFO_FUT": "BSE_FUT",
    "BFO_OPT": "BSE_OPT",
    "NFO_FUT": "NSE_FUT",
    "NFO_OPT": "NSE_OPT",
    "MCX_FUT": "MCX_FUT",
    "MCX_OPT": "MCX_OPT",
    "BSE_FUT": "BSE_FUT",
    "BSE_OPT": "BSE_OPT",
    "NSE_FUT": "NSE_FUT",
    "NSE_OPT": "NSE_OPT",
    "NSE_EQ": "NSE_EQ",
    "BSE_EQ": "BSE_EQ",
    # Even-older mirror format (pre-2025) — used singular "OPTION" /
    # "FUTURE" suffix without exchange-side disambiguation. Found in
    # the wild on COPPER26MAY*CE (MCX_OPTION) and BANKNIFTY26MAY*CE
    # (NFO_OPTION). These collisions cause the resolver to fall
    # through to synthetic permissive defaults (marginCalcMode=None,
    # intradayMargin=100) which renders as "Fixed · ₹100/lot" on the
    # user-side panel regardless of what admin sets for the row.
    "MCX_OPTION": "MCX_OPT",
    "MCX_FUTURE": "MCX_FUT",
    "NFO_OPTION": "NSE_OPT",
    "NFO_FUTURE": "NSE_FUT",
    "BFO_OPTION": "BSE_OPT",
    "BFO_FUTURE": "BSE_FUT",
}


def _to_legacy_dict(
    seg,
    override,
    *,
    action: str | None = None,
    option_type: str | None = None,
    product_type: str | None = None,
    is_expiry_day: bool = False,
) -> dict[str, Any]:
    """Map NettingSegment + optional UserSegmentOverride → legacy field names
    that order_validator + brokerage_calculator consume.

    When `option_type` ∈ {"CE", "PE"} and `action` ∈ {"BUY","SELL"}, the
    resolver picks `optionBuyIntraday` / `optionSellIntraday` (and equivalent
    overnight + commission fields) instead of the segment-wide values. This
    lets admins tune option-buy and option-sell margins separately, the way
    the netting UI advertises.
    """

    def pick(field: str, default=None):
        if override is not None:
            v = getattr(override, field, None)
            if v is not None:
                return v
        return getattr(seg, field, default)

    margin_mode = pick("marginCalcMode", None)
    # Defensive default when the admin row has never been saved with an
    # explicit mode. The legacy fallback was `"percent"`, which silently
    # interpreted Intraday=700 as "700% margin" and capped the display at
    # 100% via the OrderPanel's default. After dropping the percent mode
    # from the admin dropdown, any unset value should infer mode from the
    # configured number:
    #   • intradayMargin > 100 → almost certainly a leverage multiplier
    #     (a percentage above 100 doesn't make sense); treat as Times.
    #   • otherwise → flat ₹/lot (Fixed).
    # Admins who explicitly chose Times / Fixed get whatever they picked.
    if margin_mode not in ("fixed", "times", "percent"):
        sniff_value = float(pick("intradayMargin", 0.0) or 0.0)
        margin_mode = "times" if sniff_value > 100.0 else "fixed"
    is_option = (option_type or "").upper() in ("CE", "PE")
    is_option_buy = is_option and (action or "").upper() == "BUY"
    is_option_sell = is_option and (action or "").upper() == "SELL"

    # `Times` mode quotes a leverage multiplier (e.g. 700×), which is symmetric
    # across intraday and overnight — telling a user "you have 700× intraday
    # leverage but only 100× overnight" doesn't match how brokers price
    # leverage. So in Times mode we always read the `*Intraday*` field and
    # use it for any product type. The intraday/overnight split only matters
    # for `Percent` / `Fixed` mode, where margin actually carries more cost
    # to hold overnight.
    #
    # Infoway-fed segments (FOREX / STOCKS / INDICES / COMMODITIES / CRYPTO)
    # have no daily settlement — there's no separate "overnight" cost. We
    # always read the *Intraday* margin for those rows regardless of the
    # product_type sent by the order. Pairs with the admin matrix UI
    # gating in nettingMatrixConfig.ts so the overnight columns render as
    # N/A (—) and aren't editable.
    seg_name_for_check = getattr(seg, "name", "")
    if seg_name_for_check in INTRADAY_ONLY_ADMIN_ROWS:
        is_overnight = False
    else:
        is_overnight = (
            False if margin_mode == "times" else (product_type or "").upper() in ("CNC", "NRML")
        )

    # Resolve effective margin %. Order matters: expiry-day → option BUY/SELL
    # specifics → segment-wide intraday/overnight.
    #
    # Segment-wide fallback for OPT rows: the admin matrix exposes
    # `intradayMargin` on every row including options. If the admin sets
    # it to a non-default value (e.g. Times=700 for MCX OPT) but never
    # touches `optionBuyIntraday` / `optionSellIntraday` (still at the
    # seed default of 100/15), the resolver previously ignored their
    # intent and returned the option-specific default. Treat the
    # option-specific columns as overrides ONLY when admin has set them
    # to a value different from the seed default; otherwise inherit the
    # row's segment-wide intraday/overnight value.
    seg_intraday = float(pick("intradayMargin", 100.0) or 100.0)
    seg_overnight = float(pick("overnightMargin", 100.0) or 100.0)
    seg_value_for_now = seg_overnight if is_overnight else seg_intraday

    def _opt_pick(field: str, ovn_field: str) -> float:
        """Option-specific margin override. NULL or 0 = inherit from
        segment-wide intraday/overnight; any other number is an explicit
        per-side override. Treat 0 as inherit since the matrix UI uses
        plain number inputs with no "blank/inherit" affordance — typing
        0 is the only way for admin to signal "don't override".
        """
        opt_ovn = pick(ovn_field, None) if is_overnight else None
        opt_intra = pick(field, None)
        chosen = opt_ovn if opt_ovn is not None else opt_intra
        if chosen is None or float(chosen) == 0.0:
            return seg_value_for_now
        return float(chosen)

    if is_expiry_day:
        if is_option_buy:
            effective_margin_pct = float(pick("expiryDayOptionBuyMargin", 100.0) or 100.0)
        elif is_option_sell:
            effective_margin_pct = float(pick("expiryDayOptionSellMargin", 50.0) or 50.0)
        else:
            effective_margin_pct = float(pick("expiryDayIntradayMargin", 100.0) or 100.0)
    elif is_option_buy:
        effective_margin_pct = _opt_pick("optionBuyIntraday", "optionBuyOvernight")
    elif is_option_sell:
        effective_margin_pct = _opt_pick("optionSellIntraday", "optionSellOvernight")
    else:
        effective_margin_pct = seg_value_for_now

    # Always resolve the OVERNIGHT (carry-forward) variant too — even when
    # the current order's product_type is intraday. The frontend trade
    # panel displays both Intraday + Carry-forward tiles side-by-side so
    # the user can see what the position would cost if they held it
    # overnight before they place the trade.
    if is_expiry_day:
        # Expiry-day rates apply to BOTH legs of the day; no separate
        # "overnight" exists because positions don't survive expiry.
        effective_overnight_pct = effective_margin_pct
    elif is_option_buy:
        opt_ovn = pick("optionBuyOvernight", None)
        opt_intra = pick("optionBuyIntraday", None)
        chosen = opt_ovn if opt_ovn is not None else opt_intra
        effective_overnight_pct = (
            seg_overnight
            if chosen is None or float(chosen) == 0.0
            else float(chosen)
        )
    elif is_option_sell:
        opt_ovn = pick("optionSellOvernight", None)
        opt_intra = pick("optionSellIntraday", None)
        chosen = opt_ovn if opt_ovn is not None else opt_intra
        effective_overnight_pct = (
            seg_overnight
            if chosen is None or float(chosen) == 0.0
            else float(chosen)
        )
    else:
        # INTRADAY_ONLY admin rows (Forex / Crypto / spot Commodity / etc.)
        # have no separate carry-forward concept; the overnight column is
        # explicitly N/A in the admin matrix. Mirror that here by reusing
        # the intraday pct rather than a stale `seg_overnight` default.
        effective_overnight_pct = (
            effective_margin_pct
            if seg_name_for_check in INTRADAY_ONLY_ADMIN_ROWS
            else seg_overnight
        )

    # Translate the admin's chosen mode into the legacy
    # {leverage, margin_percentage, fixed_margin_per_lot} triple consumed
    # by order_validator + OrderPanel.
    #
    #   times → effective value is the leverage multiplier (100 → 100×).
    #           margin_required = notional × 100% ÷ leverage
    #
    #   fixed → effective value is a flat rupee amount per lot. Price and
    #           lot_size don't enter the formula. margin_required = lots ×
    #           fixed_margin_per_lot. The legacy `margin_percentage` /
    #           `leverage` pair is zeroed out so any older consumer that
    #           still uses them produces 0 (and falls through to the new
    #           fixed-per-lot path).
    #
    #   percent (legacy) → kept working for migration. effective value is
    #           a percent of notional. New rows can't be created in this
    #           mode (admin dropdown no longer offers it) but existing
    #           docs continue to resolve.
    fixed_margin_per_lot = 0.0
    overnight_fixed_margin_per_lot = 0.0
    if margin_mode == "times":
        leverage = max(1.0, effective_margin_pct)
        margin_pct = 100.0
        overnight_leverage = max(1.0, effective_overnight_pct)
        overnight_margin_pct = 100.0
    elif margin_mode == "fixed":
        fixed_margin_per_lot = float(effective_margin_pct or 0.0)
        leverage = 1.0
        margin_pct = 0.0
        overnight_fixed_margin_per_lot = float(effective_overnight_pct or 0.0)
        overnight_leverage = 1.0
        overnight_margin_pct = 0.0
    else:  # legacy "percent"
        leverage = 1.0
        margin_pct = effective_margin_pct
        overnight_leverage = 1.0
        overnight_margin_pct = effective_overnight_pct

    # Diagnostic log — one line per resolution. Lets us answer "is the
    # running process on the symmetric-Times patch?" by tailing the backend
    # console: a `is_ovn=False mode=times` line for an NRML order proves
    # the patch is live; `is_ovn=True mode=times` means it's not.
    logger.info(
        "netting_resolve seg=%s mode=%s product=%s is_ovn=%s eff_pct=%s leverage=%s margin_pct=%s",
        getattr(seg, "name", "?"),
        margin_mode,
        (product_type or "?"),
        is_overnight,
        effective_margin_pct,
        leverage,
        margin_pct,
    )

    # Action-aware commission (option leg vs everything else)
    commission_type_raw = pick("commissionType", "per_lot")
    if is_option_buy:
        commission_value = float(
            (pick("optionBuyCommission", None) or pick("commission", 0.0)) or 0.0
        )
    elif is_option_sell:
        commission_value = float(
            (pick("optionSellCommission", None) or pick("commission", 0.0)) or 0.0
        )
    else:
        commission_value = float(pick("commission", 0.0) or 0.0)
    if commission_type_raw == "per_crore":
        legacy_commission_type = "PER_CRORE"
    elif commission_type_raw == "per_lot":
        legacy_commission_type = "PER_LOT"
    else:
        legacy_commission_type = "PERCENTAGE"

    # Segment metadata — these flags decide whether lot-based or qty-based
    # caps apply. NSE_OPT, NSE_FUT etc. are LOT-based: 1 lot = N units, the
    # qty caps are meaningless and just block legitimate orders. NSE_EQ is
    # QTY-based: every share is one unit, the lot caps don't apply.
    lot_applies = getattr(seg, "lotApplies", True)
    qty_applies = getattr(seg, "qtyApplies", False)

    return {
        # legacy 22-field shape (and a few netting-only extras)
        # `allow` is the combined gate for backwards-compat (OrderPanel reads
        # it for the "no trading" warning). Two flags are also exposed
        # separately so the validator can permit closing trades even when
        # `tradingEnabled = false` — see admin Block settings spec.
        "allow": bool(pick("tradingEnabled", True)) and bool(pick("isActive", True)),
        "is_active": bool(pick("isActive", True)),
        "trading_enabled": bool(pick("tradingEnabled", True)),
        "commission_type": legacy_commission_type,
        "commission_value": commission_value,
        "min_brokerage": 0.0,
        "min_lot": float(pick("minLots", 1.0) if pick("minLots", 1.0) else 1.0) if lot_applies else 0.0,
        "max_lot": float(pick("maxLots", 0.0) or 0.0) if lot_applies else 0.0,
        "order_lot": float(pick("orderLots", 0.0) or 0.0) if lot_applies else 0.0,
        "intraday_lot_limit": float(pick("maxExchangeLots", 0.0) or 0.0) if lot_applies else 0.0,
        "holding_lot_limit": float(pick("maxExchangeLots", 0.0) or 0.0) if lot_applies else 0.0,
        "selling_overnight": bool(pick("allowOvernight", True)),
        "limit_percentage": float(pick("limitAwayPercent", 0.0) or 0.0),
        "strike_difference": 5,
        "max_each_lot": float(pick("maxLots", 0.0) or 0.0) if lot_applies else 0.0,
        "otm_max_each_lot": float(pick("maxLots", 0.0) or 0.0) if lot_applies else 0.0,
        "expiry_loss_holding": float(pick("expiryLossHoldMinSeconds", 0) or 0),
        "expiry_profit_hold": float(pick("expiryProfitHoldMinSeconds", 0) or 0),
        "expiry_intraday_margin": float(pick("expiryDayIntradayMargin", effective_margin_pct) or effective_margin_pct),
        # When True the three `expiry_*_margin` numbers in this dict are
        # % of notional; when False they're flat ₹ per lot (same shape as
        # `fixed_margin_per_lot`). The validator short-circuits on this
        # flag the same way it does for the segment-level `marginCalcMode`.
        "expiry_margin_as_percent": bool(
            pick("expiryDayMarginAsPercent", True) if pick("expiryDayMarginAsPercent", True) is not None else True
        ),
        "margin_percentage": margin_pct,
        "leverage": leverage,
        "margin_calc_mode": margin_mode,
        # Flat ₹/lot — only non-zero when mode == "fixed". Validator + UI
        # short-circuit on this and skip the notional × pct ÷ leverage
        # path entirely, so the configured value is the literal margin
        # locked per lot.
        "fixed_margin_per_lot": float(fixed_margin_per_lot),
        # ── Carry-forward (overnight) equivalents ─────────────────────
        # Computed in parallel with the intraday set above so the trade
        # panel can render both tiles ("Intraday ₹X" / "Carry-forward ₹Y")
        # without any frontend-side multiplier guesses. For intraday-only
        # segments (Forex / Crypto / spot Commodity) overnight equals
        # intraday — there's no separate carry tier on those instruments.
        "overnight_margin_percentage": overnight_margin_pct,
        "overnight_leverage": overnight_leverage,
        "overnight_fixed_margin_per_lot": float(overnight_fixed_margin_per_lot),
        "auto_squareoff_time": "15:15",
        "m2m_squareoff_percent": 80.0,
        "stop_loss_mandatory": False,
        # ── Netting-only fields exposed for validator ──────────────
        # `lot_applies` / `qty_applies` let the validator skip the caps that
        # don't make sense for this segment kind. Without this gating the
        # default `perOrderQty=1` on a lot-based segment (NFO_OPT) blocks
        # every legitimate option order because lot_size×lots > 1.
        "lot_applies": bool(lot_applies),
        "qty_applies": bool(qty_applies),
        "max_value": float(pick("maxValue", 0.0) or 0.0),
        "min_qty": float(pick("minQty", 0.0) or 0.0) if qty_applies else 0.0,
        "per_order_qty": float(pick("perOrderQty", 0.0) or 0.0) if qty_applies else 0.0,
        "max_qty_per_script": float(pick("maxQtyPerScript", 0.0) or 0.0) if qty_applies else 0.0,
        # Single percent that gates option-leg orders on BOTH sides and
        # filters the option chain dialog. 0 = no cap.
        "strike_far_percent": float(pick("strikeFarPercent", 0.0) or 0.0),
        "spread_type": str(pick("spreadType", "fixed")),
        "spread_pips": float(pick("spreadPips", 0.0) or 0.0),
        "swap_type": str(pick("swapType", "points")),
        "swap_long": float(pick("swapLong", 0.0) or 0.0),
        "swap_short": float(pick("swapShort", 0.0) or 0.0),
        "swap_time": str(pick("swapTime", "22:30")),
        "charge_on": str(pick("chargeOn", "both")),
    }


async def get_effective_settings(
    user_id: str | PydanticObjectId,
    segment_type: str,
    *,
    action: str | None = None,
    option_type: str | None = None,
    product_type: str | None = None,
    is_expiry_day: bool = False,
    symbol: str | None = None,
) -> dict[str, Any]:
    """Legacy-compat resolver. Returns the merged `NettingSegment +
    NettingScriptOverride (per-symbol) + UserSegmentOverride (per-user)` view
    in the field shape ``order_validator`` + ``brokerage_calculator`` consume.

    When ``action`` / ``option_type`` / ``product_type`` are passed we pick
    option-buy vs option-sell margin and commission, intraday vs overnight,
    expiry-day vs normal — so the order validator gets the exact margin %
    and commission that should be applied to **this** specific order.
    """
    seg_name = _SEGMENT_NAME_MAP.get(segment_type, segment_type)
    sym_key = (symbol or "").strip().upper() or "_"
    cache_key = (
        f"netting_eff:{user_id}:{seg_name}:{sym_key}:"
        f"{(action or '_').upper()}:{(option_type or '_').upper()}:"
        f"{(product_type or '_').upper()}:{int(is_expiry_day)}"
    )
    try:
        cached = await cache_get(cache_key)
        if cached is not None:
            return cached
    except Exception:
        logger.warning("netting_cache_get_failed", extra={"key": cache_key})

    seg = await NettingSegment.find_one(NettingSegment.name == seg_name)
    if seg is None:
        # No row yet (un-seeded segment) — return all-permissive defaults
        seg = NettingSegment(
            name=seg_name, displayName=seg_name, **NettingFieldsRequired().model_dump()
        )

    # Resolve per-symbol script override.
    #
    # Two match modes — both supported, exact wins:
    #   1. Exact: script.symbol equals the instrument's symbol verbatim
    #      (e.g. `SBIN` overrides the SBIN equity row).
    #   2. Pattern: script.symbol is a derivative shorthand like `NIFTYFUT`,
    #      `BANKNIFTYCE`, `SBINPE` — i.e. ends in FUT/CE/PE and has no digit
    #      character. Matches every instrument whose symbol starts with the
    #      pattern's base (the bit before FUT/CE/PE) AND ends with the same
    #      contract type. Lets admin write ONE override that covers every
    #      expiry of an underlying's futures or options.
    script_override = None
    if symbol:
        sym_normalised = symbol.strip().upper()
        # Exact match first — cheapest path, satisfies the SBIN-style stock
        # override case.
        script_override = await NettingScriptOverride.find_one(
            NettingScriptOverride.segment_name == seg_name,
            NettingScriptOverride.symbol == sym_normalised,
        )
        if script_override is None:
            script_override = await _match_pattern_script(seg_name, sym_normalised)

    user_override_symbol = await UserSegmentOverride.find_one(
        UserSegmentOverride.user_id == PydanticObjectId(user_id),
        UserSegmentOverride.segment_name == seg_name,
        UserSegmentOverride.symbol == (symbol.strip().upper() if symbol else None),
    )
    user_override_segment = await UserSegmentOverride.find_one(
        UserSegmentOverride.user_id == PydanticObjectId(user_id),
        UserSegmentOverride.segment_name == seg_name,
        UserSegmentOverride.symbol == None,  # noqa: E711
    )

    # Pool-default cascade — picks exactly ONE pool override based on the
    # user's tier ownership (broker > sub-admin > super-admin). Each tier
    # is independent: super-admin's edits only affect their own pool, and
    # don't leak into admin / broker pools as a shared fallback. The
    # caller's `assigned_admin_id` + `broker_ancestry` decide which pool
    # row applies.
    pool_override = None
    user_doc = await User.get(PydanticObjectId(user_id))
    if user_doc is not None:
        # Broker pool (most specific) — immediate broker from ancestry.
        broker_anc = user_doc.broker_ancestry or []
        if broker_anc:
            broker_id = broker_anc[-1]
            pool_override = await BrokerSegmentOverride.find_one(
                BrokerSegmentOverride.broker_id == broker_id,
                BrokerSegmentOverride.segment_name == seg_name,
            )
        elif user_doc.assigned_admin_id is not None:
            # Sub-admin pool
            pool_override = await SubAdminSegmentOverride.find_one(
                SubAdminSegmentOverride.sub_admin_id == user_doc.assigned_admin_id,
                SubAdminSegmentOverride.segment_name == seg_name,
            )
        else:
            # Super-admin pool — find_one against the single super-admin's
            # id. If there are multiple super-admins, each gets their own
            # override row (single super-admin pool here uses the first).
            sa_id = await _resolve_super_admin_id()
            if sa_id is not None:
                pool_override = await SuperAdminSegmentOverride.find_one(
                    SuperAdminSegmentOverride.super_admin_id == sa_id,
                    SuperAdminSegmentOverride.segment_name == seg_name,
                )

    # Walk in priority order (first-wins):
    #   user-symbol > user-segment > script-override > <pool-override> > segment
    # `_to_legacy_dict.pick` only reads from one override layer, so flatten
    # by creating a synthetic override doc whose fields mask the segment defaults.
    composite_override = None
    layers = [
        user_override_symbol,
        user_override_segment,
        script_override,
        pool_override,
    ]
    if any(layers):
        composite_override = NettingFieldsBase()
        for layer in layers:
            if layer is None:
                continue
            for f in NETTING_FIELDS:
                v = getattr(layer, f, None)
                if v is not None and getattr(composite_override, f, None) is None:
                    setattr(composite_override, f, v)

    settings_dict = _to_legacy_dict(
        seg,
        composite_override,
        action=action,
        option_type=option_type,
        product_type=product_type,
        is_expiry_day=is_expiry_day,
    )
    sources = {
        "segment": seg_name,
        "script_override": bool(script_override),
        "pool_override": bool(pool_override),
        "user_override": bool(user_override_symbol or user_override_segment),
    }
    payload = {"segment_type": segment_type, "settings": settings_dict, "sources": sources}
    try:
        await cache_set(cache_key, payload, ttl_sec=CACHE_TTL)
    except Exception:
        logger.warning("netting_cache_set_failed", extra={"key": cache_key})
    return payload


# ── Bulk copy ──────────────────────────────────────────────────────
async def copy_user_overrides(
    *,
    source_user_id: str | PydanticObjectId,
    target_user_ids: list[str],
    overwrite: bool = True,
) -> dict[str, Any]:
    src_rows = await list_user_overrides(source_user_id)
    if not src_rows:
        return {"applied_users": 0, "applied_rows": 0, "skipped": len(target_user_ids), "reason": "Source has no overrides"}

    applied_users = 0
    applied_rows = 0
    skipped = 0
    for uid_raw in target_user_ids:
        try:
            uid = PydanticObjectId(uid_raw)
        except Exception:
            skipped += 1
            continue
        if str(uid) == str(source_user_id):
            skipped += 1
            continue
        if await User.get(uid) is None:
            skipped += 1
            continue
        touched = 0
        for src in src_rows:
            existing = await UserSegmentOverride.find_one(
                UserSegmentOverride.user_id == uid,
                UserSegmentOverride.segment_name == src.segment_name,
                UserSegmentOverride.symbol == src.symbol,
            )
            if existing is None:
                existing = UserSegmentOverride(
                    user_id=uid, segment_name=src.segment_name, symbol=src.symbol
                )
            elif not overwrite:
                if any(getattr(existing, f, None) is not None for f in NETTING_FIELDS):
                    continue
            for f in NETTING_FIELDS:
                v = getattr(src, f, None)
                if v is not None:
                    setattr(existing, f, v)
            await existing.save()
            touched += 1
        if touched > 0:
            applied_users += 1
            applied_rows += touched
    return {"applied_users": applied_users, "applied_rows": applied_rows, "skipped": skipped, "source_rows": len(src_rows)}
