"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Minus, Plus } from "lucide-react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { OrderAPI, SegmentSettingsAPI, WalletAPI } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn, formatINR } from "@/lib/utils";
import { playBuyTone, playSellTone } from "@/lib/trade-audio";
import { isInstrumentMarketOpen, marketLabel } from "@/lib/marketHours";

interface Props {
  instrument: any;
  ltp: number;
  bid?: number | null;
  ask?: number | null;
  /** Live USD/INR rate from the quote feed. Used to convert USD-quoted
   *  margin into INR for display — without this the panel shows the USD
   *  number with a ₹ symbol, which makes a $4737 gold lot look like it
   *  needs ₹4,737 when it actually needs ~₹3,93,000. Defaults to 1 so
   *  INR-quoted instruments work as-is. */
  fxRate?: number;
}

const ORDER_TABS = [
  { key: "MARKET", label: "Market" },
  { key: "LIMIT", label: "Limit" },
  { key: "SL-M", label: "SL-M" },
] as const;

type OrderTab = (typeof ORDER_TABS)[number]["key"];

const _OP_EXPIRY_MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] as const;

/** Friendly `DD-MMM-YYYY` rendering of the instrument's expiry, shown
 *  next to the order title for F&O contracts so the trader sees
 *  exactly which expiry their order will hit. */
function formatOrderPanelExpiry(raw: string | null | undefined): string {
  if (!raw) return "";
  const s = String(raw).slice(0, 10);
  const [y, m, d] = s.split("-");
  if (!y || !m || !d) return s;
  const mi = Number(m) - 1;
  if (mi < 0 || mi > 11) return s;
  return `${d}-${_OP_EXPIRY_MONTHS[mi]}-${y}`;
}

export function OrderPanel({ instrument, ltp, bid, ask, fxRate }: Props) {
  const qc = useQueryClient();

  // ── Segment-aware defaults ───────────────────────────────────────
  const seg = (instrument?.segment ?? "").toUpperCase();
  const exch = (instrument?.exchange ?? "").toUpperCase();
  const isCrypto = seg.includes("CRYPTO") || exch === "CRYPTO";
  // AllTick-mirrored forex / metals / energy all sit on virtual exchange CDS.
  // Treat them all as USD-quoted regardless of segment label.
  const isForex = seg.includes("FOREX") || seg.includes("FX") || exch === "CDS";
  const isFno = seg.includes("FUTURE") || seg.includes("OPTION");
  const isEquity = seg.includes("EQUITY") || seg === "" /* treat unknown as equity */;

  // Default product type: NRML for crypto/forex (no MIS auto-squareoff),
  // MIS for Indian intraday. (Lot defaults now come from the server's
  // resolved settings further below — admin is the source of truth.)
  const defaultProduct: "MIS" | "NRML" | "CNC" = isCrypto || isForex ? "NRML" : "MIS";

  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [orderType, setOrderType] = useState<OrderTab>("MARKET");
  const [productType, setProductType] = useState<"MIS" | "NRML" | "CNC">(defaultProduct);
  const [lots, setLots] = useState<number>(1);
  const [price, setPrice] = useState<string>("");
  const [trigger, setTrigger] = useState<string>("");
  const [stopLoss, setStopLoss] = useState<string>("");
  const [target, setTarget] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);

  // One-Click trading flag (managed by PositionsTabs toolbar). When ON we
  // skip the order-confirm prompt; the user wants immediate execution. Sync
  // from localStorage on mount, then live-update via the broadcast event.
  const [oneClick, setOneClick] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    setOneClick(window.localStorage.getItem("setupfx.terminal.oneClick") === "1");
    const onChange = (e: Event) => setOneClick(!!(e as CustomEvent).detail);
    window.addEventListener("oneclick:change", onChange);
    return () => window.removeEventListener("oneclick:change", onChange);
  }, []);

  // Subscribe to the SAME wallet-summary query the terminal layout polls
  // (4 s interval). Sharing the key means we read the freshest balance from
  // the React Query cache instead of issuing our own fetch — and the pre-
  // submit margin check below has live numbers without an extra round-trip.
  const { data: walletSummary } = useQuery<any>({
    queryKey: ["wallet", "summary"],
    queryFn: () => WalletAPI.summary(),
    staleTime: 2_000,
  });

  // Price field stays empty on LIMIT / SL-M switch — the placeholder shows
  // the limit-away boundary (see entryPlaceholder below) so the trader sees
  // the cap they need to stay within, and types the actual price they want
  // to fill at. Pre-filling with LTP / a small offset was confusing because
  // it looked like a committed value, not a suggestion — and it covered up
  // the limit-away placeholder the user explicitly asked for. If the trader
  // wants an instant-park price they can still type one; the matching
  // engine will park it in Pending whenever it sits outside the spread.

  // Pull effective segment-settings for this exact instrument + side + product
  // so margin, lot limits and brokerage shown here match what the server will
  // actually enforce. Refetch when any of those change.
  // Refetched every 8 s so admin's segment-settings save (margin %, leverage,
  // commission, lot caps) propagates to the live order panel within at most
  // ~8 s — the previous 30 s staleTime meant traders saw stale margin
  // numbers for half a minute after every admin tweak. Window-focus refetch
  // is on by default, so alt-tabbing back also picks up the new values.
  const { data: effSettings } = useQuery<any>({
    queryKey: ["segment-settings", instrument?.token, side, productType],
    queryFn: () => SegmentSettingsAPI.effective(instrument.token, side, productType),
    enabled: !!instrument?.token,
    staleTime: 5_000,
    refetchInterval: 8_000,
  });

  // Server-resolved lot defaults — drive the stepper min, max and default.
  // `minLots` = min lots per order, `orderLots` = max lots per order.
  const minLot = Number(effSettings?.min_lot ?? 1) || 1;
  const maxLotPerOrder = Number(effSettings?.order_lot ?? 0) || 0; // 0 = no cap
  // Stepper increment: when the segment's minimum is fractional (MCX 0.1,
  // crypto 0.001, forex 0.01) the +/− buttons should walk in the same units.
  // A hard-coded step of 1 made it impossible to go 0.1 → 0.2 → 0.3 from the
  // buttons, and turned an intended 0.1 entry into 0.01 if the user typed
  // through an off-by-one decimal place. Round-up to the next 0.001 to
  // avoid float-precision noise in the input.
  const lotStep = minLot < 1 ? +minLot.toFixed(3) : 1;
  const defaultLot = minLot;

  // Reset lot + product when instrument changes OR when we get a fresh
  // server-resolved minimum (so a crypto market correctly starts at 0.001
  // when admin set it that way).
  useEffect(() => {
    setLots(defaultLot);
    setProductType(defaultProduct);
    setStopLoss("");
    setTarget("");
  }, [instrument?.token, defaultLot, defaultProduct]);

  // Lot size — trust the backend across ALL segments.
  //   • Indian F&O (NSE / BSE / NFO / BFO): Zerodha CSV (NIFTY=75, …).
  //   • MCX: canonical commodity table (GOLD=100, …).
  //   • Forex: standard CFD lot — 100,000 base units / lot
  //     (1 EURUSD lot at 1.08 = $108,000 notional).
  //   • Spot metals: XAUUSD=100 troy oz / lot, XAGUSD=5,000, etc.
  //   • Energy: USOIL=1,000 barrels / lot, NATGAS=10,000 mmBtu.
  //   • Indices / Crypto / international stocks: 1 / lot.
  // All these come baked into `instrument.lot_size` from the backend
  // (Infoway mirror + per-order self-heal). effSettings.lot_size is the
  // admin override slot when set.
  const lotSize = effSettings?.lot_size ?? instrument?.lot_size ?? 1;
  const qty = lots * lotSize;
  // For MARKET orders the user will fill at the close-side price they see
  // on the BUY/SELL strip (BUY → ask, SELL → bid). Using that price (rather
  // than the LTP midpoint) for both notional and margin keeps the order
  // panel's Total value / Margin numbers aligned with what's actually
  // booked at execution — otherwise the user sees a number that's off by
  // half-spread × quantity. LIMIT orders use the user-entered price as
  // they always did.
  const sideQuote = side === "BUY" ? (ask ?? ltp ?? 0) : (bid ?? ltp ?? 0);
  const refPrice = orderType === "MARKET" ? (sideQuote || ltp) : Number(price || ltp);
  const notional = qty * refPrice;

  // Server-resolved margin %  (admin's segment-settings → script-override →
  // user-override). Fall back to coarse client constants only while the
  // settings query is still loading, never for the actual order submission.
  const serverMarginPct =
    effSettings?.margin_percentage != null
      ? Number(effSettings.margin_percentage) / 100
      : isFno
        ? 0.13
        : isCrypto
          ? 0.2
          : isForex
            ? 0.05
            : 1.0;
  const serverLeverage = Number(effSettings?.leverage ?? 1) || 1;
  // FX conversion has been disabled platform-wide — Infoway-fed prices
  // (crypto / forex / metals / energy / international equities) are now
  // treated as INR directly, so margin math runs against the raw feed
  // number without a USD→INR multiplier. Keeping the names so downstream
  // formulas don't need to change; both are hard-coded to the no-op
  // values that the previous "native-INR segment" branch produced.
  void fxRate;
  const isUsdSeg = false;
  const fxMultiplier = 1;
  // Admin's margin-mode dropdown — "fixed" means the configured value is
  // a flat ₹/lot, the rest of the price × lot_size math is bypassed.
  const marginCalcMode = String(effSettings?.margin_calc_mode || "").toLowerCase();
  const fixedMarginPerLot = Number(effSettings?.fixed_margin_per_lot ?? 0);
  const marginPerLot = useMemo(() => {
    if (marginCalcMode === "fixed" && fixedMarginPerLot > 0) {
      // Flat ₹/lot — admin's configured number, charged once per lot
      // regardless of price/lot_size. Matches the backend validator's
      // fixed-mode short-circuit in order_validator.py.
      return +fixedMarginPerLot.toFixed(2);
    }
    // Times / legacy percent: notional × marginPct ÷ leverage × fx.
    // `refPrice` is the BUY/SELL close-side price (ask for BUY, bid for
    // SELL) so the displayed margin tracks the price the order fills at.
    return +(((lotSize * (refPrice || ltp || 0) * serverMarginPct) / serverLeverage) * fxMultiplier).toFixed(2);
  }, [marginCalcMode, fixedMarginPerLot, lotSize, refPrice, ltp, serverMarginPct, serverLeverage, fxMultiplier]);
  const intradayMargin = +(marginPerLot * lots).toFixed(2);
  const carryforwardMargin = +(intradayMargin * 1.4).toFixed(2);
  // `notional` is in the instrument's quote currency. For USD-quoted segments
  // (crypto / forex / spot metals / energy) that's dollars; for Indian segments
  // it's already rupees. The breakdown tile renders everything with ₹, so we
  // convert USD → INR before display. Without this the Total value just shows
  // the USD number with a ₹ symbol — making an $80k BTC notional look like
  // ₹80k when it's actually ~₹66.8 lakh.
  const notionalInr = isUsdSeg ? notional * fxMultiplier : notional;
  const totalValue = notionalInr;

  // Brokerage preview using the same commission_type / commission_value the
  // server will charge. Statutory components (STT, exchange, SEBI, stamp, DP) come from the
  // BrokeragePlan and aren't included here — admin's segment-settings only
  // drives the brokerage portion.
  // PERCENTAGE / PER_CRORE rates are quoted against INR turnover — so we
  // must use the INR-converted notional, not the raw USD one.
  const brokeragePreview = useMemo(() => {
    if (!effSettings) return null;
    const ctype = (effSettings.commission_type || "PER_LOT").toUpperCase();
    const cval = Number(effSettings.commission_value ?? 0);
    if (!cval) return 0;
    let b = 0;
    if (ctype === "FLAT") b = cval;
    else if (ctype === "PERCENTAGE") b = (notionalInr * cval) / 100;
    else if (ctype === "PER_CRORE") b = (notionalInr * cval) / 1e7;
    else b = cval * Math.max(0.01, lots); // PER_LOT
    const minB = Number(effSettings.min_brokerage ?? 0);
    return Math.max(b, minB);
  }, [effSettings, notionalInr, lots]);

  const orderTypeApi: "MARKET" | "LIMIT" | "SL_M" =
    orderType === "SL-M" ? "SL_M" : (orderType as "MARKET" | "LIMIT");

  const sellPrice = bid ?? ltp ?? 0;
  const buyPrice = ask ?? ltp ?? 0;

  // No currency prefix anywhere price is shown — display the bare
  // grouped number. Decimal count still varies by instrument so crypto
  // stays at 2 places and forex keeps 4 places.
  const isUsdQuoted = false;
  const priceCcy = "";
  const priceDecimals = isCrypto ? 2 : isForex ? 4 : 2;
  function fmtPrice(n: number) {
    return `${priceCcy}${Number(n || 0).toFixed(priceDecimals)}`;
  }

  // ── Limit-away hints ────────────────────────────────────────────
  // `limitAwayPercent` is the MINIMUM distance the limit price / SL-M
  // trigger must sit from the live market reference. Anything inside
  // the ±pct band is rejected (`order_validator.py:_check`). The
  // placeholder shown to the trader is the NEAREST allowed boundary —
  // entering exactly that value, or anything further from market in
  // the same direction, passes; values between market and the
  // boundary are rejected as "too close".
  //
  //   LIMIT semantics (better-price intent):
  //     • BUY LIMIT  → placed AT or BELOW market × (1 − pct/100)
  //     • SELL LIMIT → placed AT or ABOVE market × (1 + pct/100)
  //   SL-M semantics (stop / breakout intent):
  //     • BUY SL-M  → trigger AT or ABOVE market × (1 + pct/100)
  //     • SELL SL-M → trigger AT or BELOW market × (1 − pct/100)
  //
  // `wantUpperEntry` XORs side with order kind so each combination
  // points at the correct boundary the trader must reach.
  //
  // Bracket SL / TP placeholders below are unchanged — they describe
  // the close-leg minimum-distance cap, which is always opposite the
  // entry direction regardless of LIMIT vs SL-M.
  const limitAwayPct = Number(effSettings?.limit_percentage ?? 0) || 0;
  const limitEntryRef = side === "BUY" ? buyPrice : sellPrice;
  const limitBracketRef =
    orderType !== "MARKET" && Number(price) > 0
      ? Number(price)
      : side === "BUY"
        ? sellPrice
        : buyPrice;
  const _roundPx = (n: number) => +n.toFixed(priceDecimals);
  // For BUY-side: LIMIT wants the LOWER cap, SL-M wants the UPPER cap.
  // For SELL-side: LIMIT wants the UPPER cap, SL-M wants the LOWER cap.
  // `wantUpper = (side === "BUY") XOR (orderType === "LIMIT")` collapses
  // the 4-case truth table into a single boolean.
  const wantUpperEntry = (side === "BUY") !== (orderType === "LIMIT");
  const entryPlaceholder =
    limitAwayPct > 0 && limitEntryRef > 0
      ? String(
          _roundPx(
            wantUpperEntry
              ? limitEntryRef * (1 + limitAwayPct / 100)
              : limitEntryRef * (1 - limitAwayPct / 100),
          ),
        )
      : "";
  // SL boundary (closes the position).
  //   Long  → SL is below entry → lower bound = ref × (1 − pct/100)
  //   Short → SL is above entry → upper bound = ref × (1 + pct/100)
  const slPlaceholder =
    limitAwayPct > 0 && limitBracketRef > 0
      ? String(
          _roundPx(
            side === "BUY"
              ? limitBracketRef * (1 - limitAwayPct / 100)
              : limitBracketRef * (1 + limitAwayPct / 100),
          ),
        )
      : "";
  // TP boundary — mirror of SL on the opposite direction.
  const tpPlaceholder =
    limitAwayPct > 0 && limitBracketRef > 0
      ? String(
          _roundPx(
            side === "BUY"
              ? limitBracketRef * (1 + limitAwayPct / 100)
              : limitBracketRef * (1 - limitAwayPct / 100),
          ),
        )
      : "";

  function fmtLots(n: number) {
    return isCrypto || isForex ? n.toFixed(2) : String(n);
  }

  function submit() {
    if (!instrument) {
      toast.error("Instrument not loaded — try selecting it again");
      return;
    }
    if (!lots || lots < minLot) {
      toast.error(`Lots must be at least ${minLot}`);
      return;
    }
    if (maxLotPerOrder > 0 && lots > maxLotPerOrder) {
      toast.error(`Maximum ${maxLotPerOrder} lot(s) per order`);
      return;
    }
    if (orderType === "LIMIT" && !Number(price)) {
      toast.error("Enter a limit price");
      return;
    }
    if (orderType === "SL-M" && !Number(trigger)) {
      toast.error("Enter a trigger price");
      return;
    }

    // ── Marketable-LIMIT guard ────────────────────────────────────────
    // A BUY LIMIT at a price ≥ the current ask (or a SELL LIMIT ≤ bid)
    // mirrors the matching engine's `_should_fill` condition — the order
    // would fire on the very next 1.5 s poller tick. Standard exchange
    // semantics, but traders kept setting a "wait until price reaches 250"
    // BUY LIMIT below market and got confused when it filled in 3 s. That
    // intent is a stop-buy, not a limit. We block here with a clear toast
    // pointing at SL-M so the user picks the right tool — and the order
    // never leaves the panel, no optimistic flicker, no surprise position.
    //
    // Compare against the close-side price the panel is showing live:
    //   BUY  → ask (the price you'd pay if you took the offer right now)
    //   SELL → bid (the price you'd get if you hit the bid right now)
    // Falls through silently when bid/ask haven't loaded (e.g. fresh
    // mount, feed lag) — server-side `_should_fill` still catches it.
    if (orderType === "LIMIT") {
      const limit = Number(price);
      const marketRef = side === "BUY" ? buyPrice : sellPrice;
      if (marketRef > 0 && limit > 0) {
        const marketable =
          side === "BUY" ? limit >= marketRef : limit <= marketRef;
        if (marketable) {
          const dir = side === "BUY" ? "above" : "below";
          // Toast is English-only — the previous wording mixed Hinglish
          // ("yeh order turant fill ho jaayega...") which slipped into
                // shipped UI per the broker spec.
          toast.error(
            `${side} LIMIT ${fmtPrice(limit)} is ${dir} the current price ${fmtPrice(marketRef)} — this order will fill immediately at market. To wait for price to reach ${fmtPrice(limit)} before ${side === "BUY" ? "buying" : "selling"}, use an SL-M order with trigger ${fmtPrice(limit)}.`,
            { duration: 6000 },
          );
          return;
        }
      }
    }

    // ── Limit-away directional pre-check ─────────────────────────────
    // `limitAwayPercent` is the MINIMUM distance the limit price /
    // SL-M trigger must sit away from the live market reference — the
    // band (lower, upper) immediately around market is rejected, the
    // region BEYOND each boundary is allowed. Direction-aware: for a
    // BUY LIMIT the trader is pushing the price below market, so the
    // candidate must be ≤ lower bound; for a SELL LIMIT ≥ upper bound;
    // BUY SL-M ≥ upper bound; SELL SL-M ≤ lower bound. The XOR rule
    // below collapses the 4-case table. Backend re-runs the same check
    // (symmetric, exclusive band) against its own bid/ask snapshot;
    // this just prevents the optimistic insert + rollback flicker when
    // the user types a value too close to market.
    if (limitAwayPct > 0 && limitEntryRef > 0 && (orderType === "LIMIT" || orderType === "SL-M")) {
      const candidate = orderType === "LIMIT" ? Number(price) : Number(trigger);
      if (candidate > 0) {
        const upperCap = _roundPx(limitEntryRef * (1 + limitAwayPct / 100));
        const lowerCap = _roundPx(limitEntryRef * (1 - limitAwayPct / 100));
        const wantUpper = (side === "BUY") !== (orderType === "LIMIT");
        const label = orderType === "LIMIT" ? "Limit price" : "Trigger price";
        // BUY SL-M / SELL LIMIT — must be AT LEAST upperCap (above
        // market by ≥ pct). Anything below the bound is "too close".
        if (wantUpper && candidate < upperCap) {
          toast.error(
            `${label} ${fmtPrice(candidate)} is too close to market ${fmtPrice(limitEntryRef)}. Must be at least ${limitAwayPct}% away — minimum ${fmtPrice(upperCap)}.`,
            { duration: 6000 },
          );
          return;
        }
        // BUY LIMIT / SELL SL-M — must be AT MOST lowerCap (below
        // market by ≥ pct). Anything above the bound is "too close".
        if (!wantUpper && candidate > lowerCap) {
          toast.error(
            `${label} ${fmtPrice(candidate)} is too close to market ${fmtPrice(limitEntryRef)}. Must be at least ${limitAwayPct}% away — maximum ${fmtPrice(lowerCap)}.`,
            { duration: 6000 },
          );
          return;
        }
      }
    }

    // ── SL / TP directional sanity ───────────────────────────────────
    // The backend rejects wrong-side SL/TP with SL_WRONG_SIDE / TP_WRONG_SIDE,
    // but doing the same check client-side avoids the optimistic insert
    // and rollback flicker. Reference price uses the entry the order will
    // actually land at: LIMIT/SL-M → user-typed price/trigger; MARKET →
    // the BUY ask / SELL bid the panel is showing right now.
    //   • BUY  (long) :  SL  <  entry  AND  TP  >  entry
    //   • SELL (short):  SL  >  entry  AND  TP  <  entry
    const slNum = stopLoss ? Number(stopLoss) : 0;
    const tpNum = target ? Number(target) : 0;
    if (slNum > 0 || tpNum > 0) {
      const entryRef =
        orderType === "LIMIT"
          ? Number(price)
          : orderType === "SL-M"
            ? Number(trigger)
            : side === "BUY"
              ? buyPrice
              : sellPrice;
      if (entryRef > 0) {
        if (slNum > 0) {
          if (side === "BUY" && slNum >= entryRef) {
            toast.error(`Stop loss must be BELOW entry ${fmtPrice(entryRef)} for a BUY`);
            return;
          }
          if (side === "SELL" && slNum <= entryRef) {
            toast.error(`Stop loss must be ABOVE entry ${fmtPrice(entryRef)} for a SELL`);
            return;
          }
        }
        if (tpNum > 0) {
          if (side === "BUY" && tpNum <= entryRef) {
            toast.error(`Target must be ABOVE entry ${fmtPrice(entryRef)} for a BUY`);
            return;
          }
          if (side === "SELL" && tpNum >= entryRef) {
            toast.error(`Target must be BELOW entry ${fmtPrice(entryRef)} for a SELL`);
            return;
          }
        }
      }
    }

    // ── Market-closed pre-check ───────────────────────────────────────
    // The backend's order_validator raises MarketClosedError when the
    // instrument's segment is outside its trading window (NSE/BSE 9:15-
    // 15:30 IST, MCX 9:00-23:30 IST, Forex 24/5, Crypto 24/7, etc.). The
    // backend toast says "Market is closed. Place AMO instead." but it
    // only fires AFTER the round-trip — by then the optimistic insert
    // below has already shown the position row in the Positions tab. The
    // user sees the trade appear, then disappear with an error toast.
    // Pre-check here against the same hours the backend uses so the
    // order never leaves the panel and the positions table stays clean.
    if (
      !isInstrumentMarketOpen(
        instrument.segment as string | undefined,
        instrument.exchange as string | undefined,
      )
    ) {
      const label = marketLabel(
        instrument.segment as string | undefined,
        instrument.exchange as string | undefined,
      );
      toast.error(`${label} market is closed. Try placing an AMO instead.`, {
        duration: 5000,
      });
      return;
    }

    // ── Insufficient-balance pre-check ────────────────────────────────
    // The backend's `wallet_service.lock_margin` rejects the order with
    // INSUFFICIENT_FUNDS when (available_balance + credit_limit) < margin.
    // Without this guard, the optimistic insert below fires anyway — the
    // user sees a phantom position for ~1 s, then the server rejection
    // rolls it back and an error toast appears. Doing the math here mirrors
    // the same check, so the order never leaves the panel and the
    // positions table stays clean. We only block when we *know* the user
    // is short — if the wallet hasn't loaded yet, fall through and let the
    // server decide (safer than blocking a valid trade behind a stale
    // cache).
    if (walletSummary) {
      const avail = Number(walletSummary.available_balance ?? 0);
      const credit = Number(walletSummary.credit_limit ?? 0);
      const total = avail + credit;
      if (intradayMargin > 0 && total < intradayMargin) {
        toast.error(
          `Insufficient balance — need ${formatINR(intradayMargin)}, have ${formatINR(total)}`,
        );
        return;
      }
    }

    // No confirm dialog — every BUY/SELL fires straight through to the
    // API. Pro-terminal behaviour: you're already looking at the panel,
    // an extra "are you sure?" just adds latency.

    // ── Audio cue: fires the instant the user commits, BEFORE the network
    // round-trip — that's what makes it feel pro-platform tight. The click
    // itself is the user-gesture that unlocks AudioContext on first use.
    if (side === "BUY") playBuyTone();
    else playSellTone();

    // ── Optimistic updates: shape depends on order_type ─────────────
    // MARKET orders execute server-side immediately, so we insert a
    // placeholder Position. LIMIT / SL-M orders sit in OPEN status until
    // the matching engine's 1.5 s poller sees LTP cross the limit — they
    // must NEVER touch the positions cache, otherwise the user sees a
    // "filled" trade and a P&L that doesn't reflect the actual server
    // state. For those, we drop an optimistic row into the orders cache
    // so the pending-orders panel reacts instantly instead.
    const optimisticId = `optimistic_${Date.now()}`;
    const signedQty = (side === "BUY" ? 1 : -1) * lots * lotSize;
    const fillPrice = refPrice || ltp || 0;
    const isImmediate = orderTypeApi === "MARKET";

    if (isImmediate) {
      // Cancel any in-flight positions refetch FIRST — otherwise the poll
      // that's already on the wire returns server data (without our trade
      // yet) and overwrites the optimistic row before the user sees it.
      qc.cancelQueries({ queryKey: ["positions", "open"] });

      // ── Merge with existing position (same instrument + product) ──────
      // The backend's position_service.apply_fill folds same-side fills
      // into ONE position row with a weighted-avg price. The optimistic
      // update must mirror that — otherwise each click of "BUY" briefly
      // shows a SEPARATE optimistic row in the Positions tab until the
      // server response lands and collapses them back into one. From the
      // user's perspective the table flickers between 4 rows and 1 row.
      qc.setQueryData<any[]>(["positions", "open"], (old) => {
        const prev = Array.isArray(old) ? old : [];
        const matchIdx = prev.findIndex(
          (p) =>
            p &&
            p.instrument_token === instrument.token &&
            p.product_type === productType
        );

        if (matchIdx < 0) {
          return [
            {
              id: optimisticId,
              _optimistic: true,
              symbol: instrument.symbol,
              exchange: instrument.exchange,
              segment_type: instrument.segment,
              product_type: productType,
              quantity: signedQty,
              // Include lots + lot_size so the positions panel's resolveQty
              // doesn't fall back to dividing by 1 (which would mis-display
              // a fractional-lot MCX order as e.g. "3 lots" until the next
              // server poll catches up).
              lots: (side === "BUY" ? 1 : -1) * lots,
              lot_size: lotSize,
              avg_price: fillPrice,
              ltp: ltp || fillPrice,
              stop_loss: stopLoss ? Number(stopLoss) : null,
              target: target ? Number(target) : null,
              charges: 0,
              unrealized_pnl: 0,
              realized_pnl: 0,
              margin_used: marginPerLot * lots,
              status: "OPEN",
              opened_at: new Date().toISOString(),
              instrument_token: instrument.token,
            },
            ...prev,
          ];
        }

        const existing = prev[matchIdx];
        const curQty = Number(existing.quantity) || 0;
        const curAvg = Number(existing.avg_price) || 0;
        const newQty = curQty + signedQty;

        let nextAvg = curAvg;
        if (newQty !== 0 && Math.sign(newQty) === Math.sign(curQty || signedQty)) {
          const totalAbs = Math.abs(curQty) + Math.abs(signedQty);
          nextAvg =
            totalAbs > 0
              ? (curAvg * Math.abs(curQty) + fillPrice * Math.abs(signedQty)) / totalAbs
              : fillPrice;
        }

        const merged = {
          ...existing,
          quantity: newQty,
          avg_price: nextAvg,
          ltp: ltp || existing.ltp,
          margin_used: (Number(existing.margin_used) || 0) + marginPerLot * lots,
        };

        const next = prev.slice();
        if (newQty === 0) {
          next.splice(matchIdx, 1);
        } else {
          next[matchIdx] = merged;
        }
        return next;
      });
    } else {
      // LIMIT / SL-M: park an optimistic order row so the pending-orders
      // panel reacts immediately. Shape mirrors backend orders.py
      // `_serialize` so the panel can render it the same as real rows.
      const limitPrice = Number(price || 0);
      const triggerPrice = orderType === "SL-M" ? Number(trigger || 0) : 0;
      const totalQty = lots * lotSize;
      qc.setQueryData<any[]>(["orders", "recent"], (old) => {
        const prev = Array.isArray(old) ? old : [];
        return [
          {
            id: optimisticId,
            _optimistic: true,
            order_number: "—",
            symbol: instrument.symbol,
            exchange: instrument.exchange,
            segment: instrument.segment,
            token: instrument.token,
            instrument_token: instrument.token,
            action: side,
            order_type: orderTypeApi,
            product_type: productType,
            validity: "DAY",
            lots,
            quantity: totalQty,
            filled_quantity: 0,
            pending_quantity: totalQty,
            price: String(limitPrice),
            trigger_price: String(triggerPrice),
            average_price: "0",
            status: "OPEN",
            rejection_reason: null,
            is_amo: false,
            margin_blocked: String(marginPerLot * lots),
            brokerage: "0",
            other_charges: "0",
            bracket_stop_loss: stopLoss ? String(Number(stopLoss)) : null,
            bracket_target: target ? String(Number(target)) : null,
            created_at: new Date().toISOString(),
            executed_at: null,
          },
          ...prev,
        ];
      });
    }

    // Brief 250 ms lockout JUST to prevent accidental double-clicks. The
    // button does NOT wait for the API response — we already inserted the
    // optimistic position row above, so the user sees their trade
    // immediately. The request itself runs fire-and-forget; success/error
    // are handled via toast + cache invalidation when it settles.
    setSubmitting(true);
    setTimeout(() => setSubmitting(false), 250);

    // Fire the success toast NOW, before the network round-trip. The user
    // already committed by clicking; pairing the toast with the click —
    // alongside the optimistic position row + the audio cue above — makes
    // the action feel instant rather than "click → wait → toast pops 1-2s
    // later" (which is what the user reported as "pop bahut slow aa raha").
    // On rejection we dismiss this and show an error toast instead.
    const pendingToastId = toast.success(
      `${side} ${fmtLots(lots)} ${instrument.symbol} placed`,
      { duration: 1500 },
    );

    OrderAPI.place({
      token: instrument.token,
      action: side,
      order_type: orderTypeApi,
      product_type: productType,
      lots,
      price: orderType === "MARKET" ? 0 : Number(price || 0),
      trigger_price: orderType === "SL-M" ? Number(trigger || 0) : 0,
      validity: "DAY",
      is_amo: false,
      stop_loss: stopLoss ? Number(stopLoss) : null,
      target: target ? Number(target) : null,
      // For MARKET orders, pin the fill at exactly what the user just saw
      // on the BUY/SELL strip (ask for BUY, bid for SELL). The backend
      // caps this at ±1% from the current live bid/ask so a tampered
      // client can't book off-market, but inside that band the displayed
      // price wins — ENTRY then matches the panel down to the rupee.
      expected_price:
        orderType === "MARKET" ? (side === "BUY" ? buyPrice : sellPrice) || null : null,
    })
      .then(() => {
        // Success toast already fired synchronously above — no need to
        // double-pop here. Just refresh dependent caches.
        // DO NOT invalidate "positions" here for MARKET — that triggers an
        // immediate refetch which can return server data that doesn't yet
        // include the new trade (Atlas can be ~100 ms behind the write
        // that just succeeded), and the resulting "flicker" wipes the
        // optimistic row for one tick before the next regular poll
        // restores it. The 2 s polling interval handles reconciliation.
        // For LIMIT/SL-M we DO want an orders refetch so the optimistic
        // placeholder is replaced with the real persisted row (carries
        // the proper id, order_number, server-side margin).
        qc.invalidateQueries({ queryKey: ["orders"] });
        qc.invalidateQueries({ queryKey: ["wallet"] });
      })
      .catch((e: any) => {
        // Rollback whichever optimistic row we inserted — server rejected
        // the order so the user shouldn't see a phantom position/order.
        if (isImmediate) {
          qc.setQueryData<any[]>(["positions", "open"], (old) =>
            Array.isArray(old) ? old.filter((p) => p.id !== optimisticId) : []
          );
        } else {
          qc.setQueryData<any[]>(["orders", "recent"], (old) =>
            Array.isArray(old) ? old.filter((o) => o.id !== optimisticId) : []
          );
        }
        // Dismiss the early success toast — the order didn't actually
        // go through. Then show the real rejection.
        toast.dismiss(pendingToastId);
        toast.error(e.message || "Order rejected");
      });
  }

  return (
    <aside className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
      <div className="border-b border-border px-3 py-2">
        <div className="flex items-baseline gap-2">
          <div className="text-sm font-semibold">{instrument?.symbol ?? "—"} order</div>
          {instrument?.expiry && (
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Expiry {formatOrderPanelExpiry(instrument.expiry)}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 scrollbar-thin">
        {/* Order type tabs (the decorative "Trade" button that sat above was
            a no-op heading and just stole vertical space — removed.) */}
        <div className="grid grid-cols-3 border-b border-border text-xs">
          {ORDER_TABS.map((o) => (
            <button
              key={o.key}
              type="button"
              onClick={() => setOrderType(o.key)}
              className={cn(
                "relative py-2 transition-colors",
                orderType === o.key ? "text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {o.label}
              {orderType === o.key && <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-t bg-primary" />}
            </button>
          ))}
        </div>

        {/* SELL / BUY price cards — compact: label + price on one row so
            the whole panel fits in the viewport without scrolling. */}
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setSide("SELL")}
            className={cn(
              "flex items-center justify-between rounded-md border px-2.5 py-1.5 text-left transition-colors",
              side === "SELL"
                ? "border-sell bg-sell/15"
                : "border-sell/30 bg-sell/5 hover:bg-sell/10"
            )}
          >
            <span className="text-[10px] font-semibold uppercase tracking-wider text-sell">SELL</span>
            <span className="font-tabular text-sm font-semibold">{fmtPrice(sellPrice)}</span>
          </button>
          <button
            type="button"
            onClick={() => setSide("BUY")}
            className={cn(
              "flex items-center justify-between rounded-md border px-2.5 py-1.5 text-left transition-colors",
              side === "BUY"
                ? "border-buy bg-buy/15"
                : "border-buy/30 bg-buy/5 hover:bg-buy/10"
            )}
          >
            <span className="text-[10px] font-semibold uppercase tracking-wider text-buy">BUY</span>
            <span className="font-tabular text-sm font-semibold">{fmtPrice(buyPrice)}</span>
          </button>
        </div>

        {/* Notional pill removed — the same number is shown inside the
            Margin breakdown as "Total value". */}

        {/* Limit / SL price input */}
        {orderType !== "MARKET" && (
          <div className="mt-2">
            <Label>{orderType === "SL-M" ? "Trigger price" : "Price"}</Label>
            <input
              type="number"
              step="0.05"
              value={orderType === "SL-M" ? trigger : price}
              onChange={(e) =>
                orderType === "SL-M" ? setTrigger(e.target.value) : setPrice(e.target.value)
              }
              placeholder={entryPlaceholder || undefined}
              className="h-9 w-full rounded-md border border-border bg-muted/20 px-2 text-sm font-tabular outline-none placeholder:text-muted-foreground focus:border-primary"
            />
          </div>
        )}

        {/* Product type UI removed by request — `productType` still tracked
            internally and submitted with every order. The default is segment-
            derived (NRML for crypto/forex, MIS for Indian intraday). */}

        {/* Lot Size — compact: stepper + meta on one row */}
        <div className="mt-2">
          <Label>{isCrypto || isForex ? "Volume (lots)" : "Lot Size"}</Label>
          <div className="flex h-9 overflow-hidden rounded-md border border-border bg-muted/20">
            <button
              type="button"
              onClick={() => setLots((x) => +Math.max(minLot, x - lotStep).toFixed(3))}
              className="grid w-9 place-items-center text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              aria-label="Decrease lots"
            >
              <Minus className="size-4" />
            </button>
            <input
              type="number"
              step={lotStep}
              min={minLot}
              max={maxLotPerOrder || undefined}
              value={lots}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v >= 0) setLots(v);
              }}
              // DO NOT silently clamp the typed value on blur — neither
              // up to `minLot` nor down to `maxLotPerOrder`. Both clamps
              // bypassed the submit-time validators and let trades fire
              // at a quantity the user didn't actually type:
              //   • lower clamp masked "Lots must be at least N"
              //   • upper clamp silently truncated 10 lots → 5 lots
              //     when the admin's per-order cap was 5 (the user
              //     thought their full size order had filled)
              // The submit() handler enforces both bounds explicitly
              // with clear toast errors and aborts the order — that's
              // the single source of truth for lot-range rejection.
              className="flex-1 bg-transparent text-center font-tabular text-sm outline-none"
            />
            <button
              type="button"
              onClick={() => setLots((x) => { const v = +(x + lotStep).toFixed(3); return maxLotPerOrder > 0 ? Math.min(maxLotPerOrder, v) : v; })}
              className="grid w-9 place-items-center text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              aria-label="Increase lots"
            >
              <Plus className="size-4" />
            </button>
          </div>
          {/* Lot-info badge — mirrors the reference broker UI: for F&O the
              user wants to see "1 lot = 75 units (index points / Qty per
              exchange)" + "Total contracts: 75" right under the stepper, so
              there's no confusion about how many real contracts a lot maps
              to. For equity / crypto / forex (lot_size == 1 or fractional)
              we fall back to the compact "Total: N" pill. */}
          {lotSize > 1 && !isCrypto && !isForex ? (
            <div className="mt-1.5 space-y-0.5 rounded-md border border-primary/20 bg-primary/5 px-2 py-1.5 text-[10px]">
              <div className="text-primary">
                1 lot = <span className="font-tabular font-semibold">{lotSize}</span> units
                <span className="text-muted-foreground"> (index points / Qty per exchange)</span>
              </div>
              <div className="text-muted-foreground">
                Total contracts:{" "}
                <span className="font-tabular font-semibold text-foreground">{fmtLots(qty)}</span>
              </div>
            </div>
          ) : (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground">
              <span>1 lot = <span className="font-tabular text-foreground">{lotSize}</span> units</span>
              <span>·</span>
              <span>Total: <span className="font-tabular text-foreground">{fmtLots(qty)}</span></span>
              {(isCrypto || isForex) && <><span>·</span><span>min {minLot}</span></>}
            </div>
          )}
        </div>

        {/* Take Profit + Stop Loss — always visible with +/- steppers.
            Empty value = no bracket leg (the order is still placed without it). */}
        <PriceStepper
          label="Take Profit"
          value={target}
          onChange={setTarget}
          step={isUsdQuoted ? 0.5 : 0.05}
          placeholder={tpPlaceholder || "Not set"}
        />
        <PriceStepper
          label="Stop Loss"
          value={stopLoss}
          onChange={setStopLoss}
          step={isUsdQuoted ? 0.5 : 0.05}
          placeholder={slPlaceholder || "Not set"}
        />

        {/* Margin breakdown — tighter spacing */}
        <div className="mt-2 space-y-1 rounded-md border border-border bg-muted/10 px-2.5 py-2 text-[11px]">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Margin</span>
            <span className="font-tabular">
              {!effSettings
                ? "Fixed"
                : marginCalcMode === "fixed"
                  ? "Fixed"
                  : marginCalcMode === "times"
                    ? `${Math.round(serverLeverage)}×`
                    : `${(serverMarginPct * 100).toFixed(2)}%`}
              {" · "}
              {formatINR(marginPerLot)}/lot
            </span>
          </div>
          <Row label="Intraday" value={formatINR(intradayMargin)} />
          {/* Carryforward is meaningful only for segments that have a
              daily settlement (NSE / BSE cash + F&O, MCX). Infoway-fed
              segments (Forex, Stocks, Indices, Commodities, Crypto) don't
              settle daily — admin's segment matrix even hides their
              overnight column — so showing a Carryforward number here is
              misleading. Mirror the same INTRADAY_ONLY_ADMIN_ROWS set the
              backend resolver uses. */}
          {!["FOREX", "STOCKS", "INDICES", "COMMODITIES", "CRYPTO"].some(
            (s) => seg.includes(s),
          ) && (
            <Row label="Carryforward" value={formatINR(carryforwardMargin)} />
          )}
          <Row label="Total value" value={formatINR(totalValue)} />
          {brokeragePreview != null && (
            <Row label="Brokerage" value={formatINR(brokeragePreview)} />
          )}
        </div>

        {/* Show ONLY the blocking warnings; the informational chips
            (Min lot, Per order, Max/script, MIS cap, CNC cap, Limit ±%)
            were removed by request — they're enforced server-side anyway. */}
        {effSettings && (!effSettings.allow || effSettings.stop_loss_mandatory) && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {!effSettings.allow && (
              <Chip className="bg-destructive/15 text-destructive">
                Trading blocked for this segment
              </Chip>
            )}
            {effSettings.stop_loss_mandatory && (
              <Chip className="bg-atm/15 text-atm">SL mandatory</Chip>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-border p-3">
        <Button
          type="button"
          variant={side === "BUY" ? "buy" : "sell"}
          className="h-11 w-full text-sm font-semibold"
          loading={submitting}
          onClick={submit}
        >
          {side} {fmtLots(lots)} {isCrypto || isForex ? "lots" : `lot${lots === 1 ? "" : "s"}`}
        </Button>
      </div>
    </aside>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-1 text-xs text-muted-foreground">{children}</div>;
}

function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "rounded border border-border bg-muted/30 px-1.5 py-0.5 text-[10px] text-muted-foreground",
        className
      )}
    >
      {children}
    </span>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-tabular">{value}</span>
    </div>
  );
}

function PriceStepper({
  label,
  value,
  onChange,
  step,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  step: number;
  placeholder?: string;
}) {
  function bump(delta: number) {
    const cur = Number(value || 0);
    const next = +(cur + delta).toFixed(4);
    onChange(next > 0 ? String(next) : "");
  }
  return (
    <div className="mt-3 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        {!value && <span className="text-[10px] text-muted-foreground">Not set</span>}
      </div>
      <div className="flex h-9 items-stretch overflow-hidden rounded-md border border-border bg-muted/20">
        <input
          type="number"
          step={step}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? "Price"}
          className="flex-1 bg-transparent px-2 text-sm font-tabular outline-none placeholder:text-muted-foreground"
        />
        <button
          type="button"
          aria-label={`Decrease ${label}`}
          onClick={() => bump(-step)}
          className="grid w-9 place-items-center border-l border-border text-muted-foreground hover:bg-muted/40 hover:text-foreground"
        >
          −
        </button>
        <button
          type="button"
          aria-label={`Increase ${label}`}
          onClick={() => bump(step)}
          className="grid w-9 place-items-center border-l border-border text-muted-foreground hover:bg-muted/40 hover:text-foreground"
        >
          +
        </button>
      </div>
    </div>
  );
}

function Collapsible({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-3 overflow-hidden rounded-md border border-border bg-muted/10">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-3 py-2 text-xs hover:bg-muted/20"
      >
        <span>{label}</span>
        <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
      </button>
      {open && <div className="border-t border-border px-3 py-2">{children}</div>}
    </div>
  );
}
