"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowDownRight,
  ArrowUpRight,
  ArrowLeftRight,
  LineChart,
  Layers,
  Minus,
  Plus,
  ShoppingBag,
  Target,
  Timer,
  Zap,
} from "lucide-react";
import { OptionChainPicker } from "@/components/trading/OptionChainPicker";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  InstrumentAPI,
  OrderAPI,
  PositionAPI,
  SegmentSettingsAPI,
  WalletAPI,
} from "@/lib/api";
import { playBuyTone, playSellTone } from "@/lib/trade-audio";
import { getIndexLotSize } from "@/lib/indexLots";
import { isInstrumentMarketOpen, marketLabel } from "@/lib/marketHours";
import { cn, formatINR, formatIST, formatPercent, pnlColor } from "@/lib/utils";

interface Props {
  token: string | null;
  open: boolean;
  onClose: () => void;
}

/**
 * Slide-up trade card. Opens over the Markets page when a row is tapped.
 * Card-style modal (not a full route) so closing returns the trader to the
 * exact scroll position in the watchlist they left. All sections are wired
 * to live data: instrument detail, 1 s quote, segment-resolved margin %,
 * wallet summary for available balance, open-position count for the badge.
 *
 * Theme: uses the project's purple `primary` for accent CTAs (Market tab,
 * BUY-side preselect), `buy` (green) and `sell` (red) for direction, never
 * pulling in foreign colours from external mocks.
 */
export function TradeDetailSheet(props: Props) {
  // Lazy-mount: when the sheet is closed we render NOTHING. That tears down
  // every useQuery / useState / useMemo inside the inner component, which
  // matters because the marketwatch page mounts this sheet permanently —
  // without the early-return, the closed sheet still occupied React-tree
  // memory and ran a useMarketStream WS (via the React Query cache it
  // shares with the order panel), making the watchlist feel sluggish.
  if (!props.open || !props.token) return null;
  return <TradeDetailSheetInner {...props} />;
}

function TradeDetailSheetInner({ token, open, onClose }: Props) {
  const qc = useQueryClient();

  // ── Live data ─────────────────────────────────────────────────────
  // Instrument detail is essentially static — cache for 5 min, no refetch
  // on focus / mount (the Markets page already loaded most of these).
  const { data: instrument } = useQuery({
    queryKey: ["instrument", token],
    queryFn: () => InstrumentAPI.detail(token!),
    enabled: !!token,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  // 1.5 s quote — slightly slower than the OrderPanel's 1 s but a sheet that
  // ticks every second on a busy phone re-renders heavily and starves the
  // chart paint loop. 1.5 s still feels live, costs 33 % fewer requests.
  const { data: quote } = useQuery({
    queryKey: ["quote", token],
    queryFn: () => InstrumentAPI.quote(token!),
    enabled: !!token,
    refetchInterval: 1500,
    staleTime: 1000,
  });

  const { data: walletSummary } = useQuery({
    queryKey: ["wallet", "summary"],
    queryFn: () => WalletAPI.summary(),
    refetchInterval: 10_000,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
  });

  const { data: openPositions } = useQuery({
    queryKey: ["positions", "open"],
    queryFn: () => PositionAPI.open(),
    refetchInterval: 6_000,
    staleTime: 3_000,
    refetchOnWindowFocus: false,
  });

  // Live unrealised P&L across ALL open positions — used to compute Equity
  // (= total balance + open unrealised) for the wallet strip below.
  const { data: pnlSummary } = useQuery({
    queryKey: ["positions", "pnl-summary"],
    queryFn: () => PositionAPI.pnlSummary(),
    refetchInterval: 5_000,
    staleTime: 2_000,
    refetchOnWindowFocus: false,
  });

  // ── Local UI state — reset whenever the sheet opens a fresh token ─
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT">("MARKET");
  const [slTpEnabled, setSlTpEnabled] = useState(false);
  const [stopLoss, setStopLoss] = useState<string>("");
  const [target, setTarget] = useState<string>("");
  const [limitPrice, setLimitPrice] = useState<string>("");
  const [unit, setUnit] = useState<"LOTS" | "QTY">("LOTS");
  const [lots, setLots] = useState<number>(1);
  // Local string buffer for the stepper input. Lets the user clear the
  // field, type intermediate states ("0." while typing "0.5"), or wipe
  // and retype freely without the controlled-input bouncing back to the
  // committed `lots` value on every keystroke. Committed to `lots` on
  // blur / Enter, and mirrored back here whenever `lots` changes via
  // the +/− buttons or external resets.
  const [lotInput, setLotInput] = useState<string>("");
  const [submitting, setSubmitting] = useState<"BUY" | "SELL" | null>(null);
  // Option-chain picker open state. Only meaningful for Indian
  // equity/index/future rows (see `showOptionChain` below).
  const [optionChainOpen, setOptionChainOpen] = useState(false);
  const router = useRouter();

  // ── Segment + product ─────────────────────────────────────────────
  const seg = (instrument?.segment ?? "").toUpperCase();
  const exch = (instrument?.exchange ?? "").toUpperCase();
  const isCrypto = seg.includes("CRYPTO") || exch === "CRYPTO";
  const isForex = seg.includes("FOREX") || seg.includes("FX") || exch === "CDS";
  const isFno = seg.includes("FUTURE") || seg.includes("OPTION");
  // Indian equity / index / future rows expose an Option Chain shortcut
  // — tapping it opens the strike grid for THIS underlying (NIFTY,
  // RELIANCE, SENSEX…) like Zerodha Kite. Hidden on Infoway-fed rows
  // (forex / crypto / metals / energy / international equities, since
  // those don't trade options on this platform) and on option rows
  // themselves (the user is already inside an option contract).
  const isIndianExch = ["NSE", "BSE", "NFO", "BFO", "MCX"].includes(exch);
  const isOptionRow = seg.includes("OPTION");
  const showOptionChain = isIndianExch && !isOptionRow;
  // Infoway-fed instruments (forex / crypto / spot metals / energy /
  // international equities + indices) settle in 24×5 or 24×7 mode — they
  // don't have a separate carry-forward margin tier the way Indian F&O
  // does. The margin posted at fill IS the margin held overnight, so we
  // collapse the Intraday/Holding tile pair into a single "Margin" tile
  // for these rows. Indian segments still show both because admin can
  // configure different intraday-vs-overnight requirements there.
  const isInfowaySeg =
    /CRYPTO|FOREX|FX|CDS|STOCKS|INDICES|COMMODITIES/.test(seg) ||
    exch === "CDS" ||
    exch === "CRYPTO";
  // FX conversion is disabled platform-wide — Infoway feed numbers are
  // INR by convention now. Keeping the variable so the margin formula and
  // currency-prefix logic below don't fork; both naturally fall into the
  // "treat as INR" branch.
  const isUsdQuoted = false;
  const productType: "MIS" | "NRML" | "CNC" =
    isCrypto || isForex ? "NRML" : "MIS";

  // ── Segment settings ──────────────────────────────────────────────
  // Admin's margin %/lot caps change rarely — 30 s refetch is plenty, and
  // a generous staleTime keeps the BUY ↔ SELL flip instant (was hitting
  // network on every toggle because the queryKey embeds `side`).
  const { data: effSettings } = useQuery({
    queryKey: ["segment-settings", token, side, productType],
    queryFn: () => SegmentSettingsAPI.effective(token!, side, productType),
    enabled: !!token,
    refetchInterval: 30_000,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  // ── Lot resolution (matches OrderPanel) ───────────────────────────
  const minLot =
    Number(effSettings?.min_lot ?? (isCrypto ? 0.001 : isForex ? 0.01 : 1)) || 1;
  const maxLotPerOrder = Number(effSettings?.order_lot ?? 0) || 0;
  const maxLotTotal = Number(effSettings?.max_lot ?? 0) || 0;
  const lotStep = minLot < 1 ? +minLot.toFixed(3) : 1;
  const canonicalLot =
    isCrypto || isForex
      ? null
      : getIndexLotSize(instrument?.symbol, instrument?.name, instrument?.trading_symbol);
  const lotSize = canonicalLot ?? effSettings?.lot_size ?? instrument?.lot_size ?? 1;

  // `liveLots` mirrors the committed `lots` until the trader starts
  // editing the lot field, at which point it tracks the unsubmitted
  // string so margin / qty / total-value tiles update on every
  // keystroke (matches desktop OrderPanel's behaviour where the
  // stepper writes straight into `lots`). Falls back to `lots` when
  // the buffer is empty or a mid-edit intermediate like "0." parses
  // to NaN. The actual order body still goes through `lotsToUse` in
  // submit() — that path also reads `lotInput` so a tap-BUY-before-
  // blur fires with the visible value, not the stale state.
  const liveLots = (() => {
    const n = Number(lotInput);
    if (!Number.isFinite(n) || n <= 0) return lots;
    return unit === "LOTS" ? n : n / Math.max(1, lotSize);
  })();
  const liveQty = +(liveLots * Math.max(1, lotSize)).toFixed(3);

  // Reset form state whenever the sheet (re)opens for a different token.
  // Dep is intentionally just `[token, open]` — including `minLot` would
  // reset the user's mid-trade lot input whenever effSettings refetches
  // (every 30 s) and the resolver re-emitted the same min value with a
  // different Number reference, which manifested as "I can't change the
  // lots on mobile".
  useEffect(() => {
    if (!open) return;
    setLots(minLot);
    setStopLoss("");
    setTarget("");
    setLimitPrice("");
    setSide("BUY");
    setOrderType("MARKET");
    setSlTpEnabled(false);
    setUnit("LOTS");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, open]);

  // ── Pricing ───────────────────────────────────────────────────────
  const ltp = Number(quote?.ltp ?? 0);
  const bid = Number(quote?.bid ?? quote?.depth?.bids?.[0]?.price ?? ltp);
  const ask = Number(quote?.ask ?? quote?.depth?.asks?.[0]?.price ?? ltp);
  const sellPrice = bid || ltp;
  const buyPrice = ask || ltp;
  const sideQuote = side === "BUY" ? buyPrice : sellPrice;
  const refPrice = orderType === "MARKET" ? sideQuote : Number(limitPrice || ltp);
  // fx_rate is intentionally not consumed — margin/notional run on the
  // raw feed number which we now interpret as INR.
  void quote?.fx_rate;
  const fxMultiplier = 1;

  // ── Margin ────────────────────────────────────────────────────────
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
  const marginCalcMode = String(effSettings?.margin_calc_mode || "").toLowerCase();
  const fixedMarginPerLot = Number(effSettings?.fixed_margin_per_lot ?? 0);
  // Backend now returns dedicated carry-forward (overnight) margin params
  // so the frontend doesn't have to guess (the old `intraday × 1.4` was
  // wrong for every non-NSE-equity segment). For intraday-only segments
  // (Forex / Crypto / spot Commodity) the overnight numbers come back
  // equal to intraday, which folds into the same `marginPerLot` math.
  const serverOvernightMarginPct =
    effSettings?.overnight_margin_percentage != null
      ? Number(effSettings.overnight_margin_percentage) / 100
      : serverMarginPct;
  const serverOvernightLeverage =
    Number(effSettings?.overnight_leverage ?? serverLeverage) || serverLeverage;
  const overnightFixedMarginPerLot = Number(
    effSettings?.overnight_fixed_margin_per_lot ?? fixedMarginPerLot,
  );

  const marginPerLot = useMemo(() => {
    if (marginCalcMode === "fixed" && fixedMarginPerLot > 0) {
      return +fixedMarginPerLot.toFixed(2);
    }
    return +(
      ((lotSize * (refPrice || ltp || 0) * serverMarginPct) / serverLeverage) *
      fxMultiplier
    ).toFixed(2);
  }, [marginCalcMode, fixedMarginPerLot, lotSize, refPrice, ltp, serverMarginPct, serverLeverage, fxMultiplier]);

  // Carry-forward (overnight) per-lot margin — same formula as intraday
  // but with the overnight leverage / margin% the admin configured for
  // this segment. Falls back to intraday math when the backend hasn't
  // populated the overnight fields yet (older deploys).
  const overnightMarginPerLot = useMemo(() => {
    if (marginCalcMode === "fixed" && overnightFixedMarginPerLot > 0) {
      return +overnightFixedMarginPerLot.toFixed(2);
    }
    return +(
      ((lotSize * (refPrice || ltp || 0) * serverOvernightMarginPct) /
        serverOvernightLeverage) *
      fxMultiplier
    ).toFixed(2);
  }, [
    marginCalcMode,
    overnightFixedMarginPerLot,
    lotSize,
    refPrice,
    ltp,
    serverOvernightMarginPct,
    serverOvernightLeverage,
    fxMultiplier,
  ]);

  // Margin tile updates LIVE off `liveLots` so the trader sees the
  // posted-margin number react on every keystroke, just like the
  // desktop OrderPanel where typing into the stepper writes straight
  // into `lots`. submit() still uses `lotsToUse` for the actual order.
  const intradayMargin = +(marginPerLot * liveLots).toFixed(2);
  const carryforwardMargin = +(overnightMarginPerLot * liveLots).toFixed(2);
  const availableMargin =
    Number(walletSummary?.available_balance ?? 0) +
    Number(walletSummary?.credit_limit ?? 0);

  // Open-position count on THIS instrument — small badge by the symbol.
  const openPosCount = useMemo(() => {
    const tok = String(token ?? "");
    if (!tok) return 0;
    return (openPositions ?? []).filter(
      (p: any) => String(p?.instrument_token ?? p?.token ?? "") === tok,
    ).length;
  }, [openPositions, token]);

  // ── Formatters ────────────────────────────────────────────────────
  const priceDecimals = isCrypto ? 2 : isForex ? 4 : 2;
  const priceCcy = "";
  function fmtPrice(n: number | null | undefined): string {
    const v = Number(n ?? 0);
    if (!Number.isFinite(v)) return "—";
    return `${priceCcy}${v.toFixed(priceDecimals)}`;
  }
  function fmtLots(n: number) {
    return isCrypto || isForex ? n.toFixed(isCrypto ? 3 : 2) : String(n);
  }

  // INR formatter for the wallet KPI grid — user feedback was that the
  // abbreviated "K / L / Cr" suffixes hid the exact figure ("4.47 L" is
  // less actionable than "₹4,47,000.00" when sizing a position). We now
  // render the full Indian-grouped number everywhere and let the card
  // width handle overflow (auto-shrink via `truncate`/CSS clamp).
  function formatINRCompact(value: number | null | undefined): string {
    return formatINR(Number(value ?? 0));
  }

  const expiryShort = useMemo(() => {
    const raw = instrument?.expiry;
    if (!raw) return "";
    const s = String(raw).slice(0, 10);
    const [y, m, d] = s.split("-");
    if (!y || !m || !d) return s;
    const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
    const mi = Number(m) - 1;
    if (mi < 0 || mi > 11) return s;
    return `${d} ${months[mi]}`;
  }, [instrument?.expiry]);

  // ── Submit ────────────────────────────────────────────────────────
  async function submit(action: "BUY" | "SELL") {
    if (!instrument || !token) {
      toast.error("Instrument not loaded");
      return;
    }
    // Force-commit any pending lot input — the user can tap BUY/SELL
    // without first blurring the lot field on mobile, in which case
    // `lots` state still holds the previous value while `lotInput`
    // carries the new typed string. We parse `lotInput` and use the
    // result locally; the order body below also uses this local so a
    // typed 0.1 lot can't be silently replaced by the stale 1.
    let lotsToUse = lots;
    {
      const pending = Number(lotInput);
      if (Number.isFinite(pending) && pending > 0) {
        const asLots = unit === "LOTS" ? pending : pending / lotSize;
        const rounded = +asLots.toFixed(3);
        // DO NOT silently clamp to maxLotPerOrder here — the admin's
        // per-order cap must be surfaced as a clear rejection toast
        // (next block below), not as a silent reduction of the user's
        // typed quantity. Without this fix, typing 10 lots when the
        // admin cap is 5 used to silently submit 5 — the user thought
        // their full 10-lot order had been split / executed, when
        // really the platform had quietly truncated the request.
        lotsToUse = rounded;
        if (rounded !== lots) setLots(rounded);
      }
    }
    if (!lotsToUse || lotsToUse < minLot) {
      toast.error(`Lots must be at least ${minLot}`);
      return;
    }
    if (maxLotPerOrder > 0 && lotsToUse > maxLotPerOrder) {
      toast.error(`Maximum ${maxLotPerOrder} lot(s) per order`);
      return;
    }
    if (orderType === "LIMIT" && !Number(limitPrice)) {
      toast.error("Enter a limit price");
      return;
    }
    // ── SL / TP directional sanity ───────────────────────────────────
    // Mirrors the backend validator (order_validator.py: SL_WRONG_SIDE /
    // TP_WRONG_SIDE). Validates SL and TP independently — the old check
    // only fired on SL, which let a wrong-side TP through. A long with
    // TP below entry would auto-trigger the moment the order filled.
    if (slTpEnabled) {
      const entry = orderType === "MARKET" ? refPrice : Number(limitPrice);
      const sl = Number(stopLoss);
      const tp = Number(target);
      if (entry > 0) {
        if (sl > 0) {
          if (action === "BUY" && sl >= entry) {
            toast.error(`Stop loss must be BELOW entry ${fmtPrice(entry)} for a BUY`);
            return;
          }
          if (action === "SELL" && sl <= entry) {
            toast.error(`Stop loss must be ABOVE entry ${fmtPrice(entry)} for a SELL`);
            return;
          }
        }
        if (tp > 0) {
          if (action === "BUY" && tp <= entry) {
            toast.error(`Target must be ABOVE entry ${fmtPrice(entry)} for a BUY`);
            return;
          }
          if (action === "SELL" && tp >= entry) {
            toast.error(`Target must be BELOW entry ${fmtPrice(entry)} for a SELL`);
            return;
          }
        }
      }
    }
    if (intradayMargin > 0 && availableMargin < intradayMargin) {
      toast.error(
        `Insufficient margin — need ${formatINR(intradayMargin)}, have ${formatINR(availableMargin)}`,
      );
      return;
    }
    // Market-closed pre-check — mirror the OrderPanel guard so the
    // mobile bottom-sheet path also fails fast outside trading hours.
    // Without it, the audio cue + synchronous success toast +
    // optimistic position row all fired before the backend rejection
    // came back, producing the "trade ek baar ko lag jaa rahi h fir
    // waps aa rha h" flicker the user reported.
    if (
      !isInstrumentMarketOpen(
        (instrument as any).segment as string | undefined,
        (instrument as any).exchange as string | undefined,
      )
    ) {
      const label = marketLabel(
        (instrument as any).segment as string | undefined,
        (instrument as any).exchange as string | undefined,
      );
      toast.error(
        `${label} market is closed. Try placing an AMO instead.`,
        { duration: 5000 },
      );
      return;
    }

    // 250 ms double-tap lockout (NOT a network wait — the request fires
    // immediately below). Releases by the time the sheet's close
    // animation completes, so a second order on the same instrument
    // becomes possible the moment the user re-opens the sheet.
    setSubmitting(action);
    setTimeout(() => setSubmitting(null), 250);

    // ── Fire-and-forget submission ────────────────────────────────────
    // Earlier the BUY/SELL handler `await`ed OrderAPI.place inside the
    // sheet — that pinned the buttons in a loading spinner for the full
    // 500 ms – 2 s round-trip while the user just stared at the same
    // sheet. The OrderPanel on desktop already uses an
    // optimistic-insert + fire-and-forget pattern that feels instant;
    // this mirrors it for the mobile sheet:
    //   1. validate sync (above)
    //   2. play audio cue (so the click is "felt" before the network)
    //   3. drop an optimistic Position row into the React Query cache
    //   4. close the sheet immediately — user returns to the watchlist
    //      with their position already visible
    //   5. fire the API call in the background; on rejection toast +
    //      roll the optimistic row back so the watchlist stays honest
    if (action === "BUY") playBuyTone();
    else playSellTone();

    // Fire the success toast OPTIMISTICALLY — on the same tick as the
    // audio cue, before the network request leaves the device. Earlier
    // this lived inside `.then()` after `OrderAPI.place()` resolved, so
    // the toast was delayed by the full 500 ms – 2 s round-trip even
    // though the click "felt" instant via the audio + sheet close. If
    // the server rejects the order, the .catch() below downgrades this
    // with a toast.error so the user still sees the failure.
    toast.success(`${action} ${fmtLots(lotsToUse)} ${instrument.symbol} placed`, {
      duration: 1500,
    });

    const optimisticId = `optimistic_${Date.now()}`;
    const fillPrice = orderType === "MARKET" ? sideQuote : Number(limitPrice || ltp) || ltp;
    const signedQty = (action === "BUY" ? 1 : -1) * lotsToUse * lotSize;
    const isImmediate = orderType === "MARKET";

    if (isImmediate) {
      // Cancel any in-flight positions refetch FIRST so the network reply
      // (without our trade) can't overwrite the optimistic row before
      // the user sees it. Same anti-flicker pattern as OrderPanel.
      qc.cancelQueries({ queryKey: ["positions", "open"] });
      qc.setQueryData<any[]>(["positions", "open"], (old) => {
        const prev = Array.isArray(old) ? old : [];
        // Merge with existing position on same instrument + product so
        // pyramiding shows ONE merged row, not two stacked rows.
        const matchIdx = prev.findIndex(
          (p) => p && p.instrument_token === token && p.product_type === productType,
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
              lots: (action === "BUY" ? 1 : -1) * lotsToUse,
              lot_size: lotSize,
              avg_price: fillPrice,
              ltp: ltp || fillPrice,
              stop_loss: slTpEnabled && Number(stopLoss) > 0 ? Number(stopLoss) : null,
              target: slTpEnabled && Number(target) > 0 ? Number(target) : null,
              charges: 0,
              unrealized_pnl: 0,
              realized_pnl: 0,
              margin_used: intradayMargin,
              status: "OPEN",
              opened_at: new Date().toISOString(),
              instrument_token: token,
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
          margin_used: (Number(existing.margin_used) || 0) + intradayMargin,
        };
        const next = prev.slice();
        if (newQty === 0) next.splice(matchIdx, 1);
        else next[matchIdx] = merged;
        return next;
      });
    } else {
      // LIMIT order — park an optimistic row in the orders cache so the
      // pending-orders panel reacts instantly. Shape mirrors backend
      // `_serialize`.
      qc.setQueryData<any[]>(["orders", "recent"], (old) => {
        const prev = Array.isArray(old) ? old : [];
        const limitPriceNum = Number(limitPrice || 0);
        return [
          {
            id: optimisticId,
            _optimistic: true,
            order_number: "—",
            symbol: instrument.symbol,
            exchange: instrument.exchange,
            segment: instrument.segment,
            token,
            instrument_token: token,
            action,
            order_type: orderType,
            product_type: productType,
            validity: "DAY",
            lots: lotsToUse,
            quantity: lotsToUse * lotSize,
            filled_quantity: 0,
            pending_quantity: lotsToUse * lotSize,
            price: String(limitPriceNum),
            trigger_price: "0",
            average_price: "0",
            status: "OPEN",
            rejection_reason: null,
            is_amo: false,
            margin_blocked: String(intradayMargin),
            brokerage: "0",
            other_charges: "0",
            bracket_stop_loss:
              slTpEnabled && Number(stopLoss) > 0 ? String(Number(stopLoss)) : null,
            bracket_target:
              slTpEnabled && Number(target) > 0 ? String(Number(target)) : null,
            created_at: new Date().toISOString(),
            executed_at: null,
          },
          ...prev,
        ];
      });
    }

    // Close the sheet right away — the user returns to the market list
    // with the optimistic position already visible. Toast confirms
    // when the server acks the trade.
    onClose();

    OrderAPI.place({
      token,
      action,
      order_type: orderType,
      product_type: productType,
      lots: lotsToUse,
      price: orderType === "MARKET" ? 0 : Number(limitPrice || 0),
      trigger_price: 0,
      validity: "DAY",
      is_amo: false,
      stop_loss: slTpEnabled && Number(stopLoss) > 0 ? Number(stopLoss) : null,
      target: slTpEnabled && Number(target) > 0 ? Number(target) : null,
      expected_price: orderType === "MARKET" ? sideQuote : null,
    })
      .then(() => {
        // Success toast already fired optimistically above. Just reconcile
        // the caches so the orders panel / wallet number catch up.
        qc.invalidateQueries({ queryKey: ["orders"] });
        qc.invalidateQueries({ queryKey: ["wallet"] });
      })
      .catch((e: any) => {
        // Roll the optimistic row back so the watchlist stays honest.
        if (isImmediate) {
          qc.setQueryData<any[]>(["positions", "open"], (old) =>
            Array.isArray(old) ? old.filter((p) => p.id !== optimisticId) : [],
          );
        } else {
          qc.setQueryData<any[]>(["orders", "recent"], (old) =>
            Array.isArray(old) ? old.filter((o) => o.id !== optimisticId) : [],
          );
        }
        toast.error(e?.message || "Order rejected");
      });
  }

  // Qty ↔ Lots conversion. Stepper always stores `lots`.
  const qty = lots * lotSize;
  const displayValue = unit === "LOTS" ? fmtLots(lots) : String(qty);
  function bumpLots(delta: number) {
    const next = +(lots + delta).toFixed(3);
    const min = Math.max(minLot, next);
    const capped = maxLotPerOrder > 0 ? Math.min(maxLotPerOrder, min) : min;
    setLots(capped);
  }
  // Keep the stepper input in sync with the canonical `lots` whenever
  // it changes via +/− buttons, BUY/SELL flip, or sheet (re)open. Bail
  // when the user is mid-edit (their string parses to the same numeric
  // value) so a tap on the field doesn't get hijacked by this effect.
  useEffect(() => {
    const canonical = displayValue;
    if (Number(lotInput) !== Number(canonical)) setLotInput(canonical);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lots, unit, lotSize]);

  function commitLotInput() {
    // On blur / Enter: parse whatever's in the field, commit to `lots`.
    // Both lower (minLot) AND upper (maxLotPerOrder) bounds are
    // intentionally NOT clamped here. Two separate bugs we hit:
    //
    //   • Lower clamp used to bump "0.1 lot" entries back up to
    //     admin's min_lot (often 1), so the user saw their typed 0.1
    //     silently jump.
    //   • Upper clamp used to truncate "10 lots" down to admin's
    //     per-order cap (e.g. 5) without any indication — the user
    //     thought their 10-lot order had filled, but only 5 were
    //     actually sent. (The current bug fix.)
    //
    // The placement-time submit() check now rejects out-of-range
    // typed values with a clear toast, so the input can faithfully
    // reflect what the trader wrote and the conversion hint stays
    // accurate.
    const n = Number(lotInput);
    if (!Number.isFinite(n) || n <= 0) {
      setLots(minLot);
      setLotInput(fmtLots(minLot));
      return;
    }
    const asLots = unit === "LOTS" ? n : n / lotSize;
    const rounded = +asLots.toFixed(3);
    setLots(rounded);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="w-[calc(100%-1rem)] max-w-md gap-0 p-0">
        <DialogTitle className="sr-only">
          Trade {instrument?.symbol ?? ""}
        </DialogTitle>

        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-lg font-bold">
                  {instrument?.symbol ?? "—"}
                </span>
                {openPosCount > 0 && (
                  <Link
                    href="/positions"
                    aria-label={`${openPosCount} open position${openPosCount === 1 ? "" : "s"}`}
                    className="flex h-5 items-center gap-1 rounded-full bg-primary/15 px-1.5 text-[10px] font-bold text-primary"
                  >
                    <ShoppingBag className="size-3" />
                    {openPosCount}
                  </Link>
                )}
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                {expiryShort && <span className="mr-1.5">{expiryShort}</span>}
                LTP <span className="font-tabular tabular-nums">{fmtPrice(ltp)}</span>
              </div>
            </div>
            <div className="pr-7 text-right">
              <div className="flex items-baseline gap-2 font-tabular text-base font-bold tabular-nums">
                <span className="text-sell">{fmtPrice(sellPrice)}</span>
                <span className="text-buy">{fmtPrice(buyPrice)}</span>
              </div>
              <div
                className={cn(
                  "mt-0.5 text-[11px] font-tabular tabular-nums",
                  pnlColor(quote?.change_pct ?? 0),
                )}
              >
                {quote?.change != null ? quote.change.toFixed(2) : "—"} (
                {formatPercent(quote?.change_pct ?? 0)})
              </div>
            </div>
          </div>
        </div>

        {/* ── Action row ──────────────────────────────────────────── */}
        <div className="flex items-center gap-2 px-4 pt-3">
          <Link
            href={`/terminal?token=${encodeURIComponent(token ?? "")}`}
            className="flex h-9 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-xs font-medium hover:bg-muted/40"
          >
            <LineChart className="size-3.5" /> Charts
          </Link>
          {showOptionChain && (
            <button
              type="button"
              onClick={() => setOptionChainOpen(true)}
              className="flex h-9 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-xs font-medium hover:bg-muted/40"
            >
              <Layers className="size-3.5" /> Option Chain
            </button>
          )}
          {/* BUY / SELL toggle removed from this row — the big BUY/SELL
              CTAs at the bottom of the sheet already drive direction
              (each carries its own live price label), and the duplicate
              header toggle just confused users who tapped it expecting
              to place a trade. */}
          <button
            type="button"
            onClick={() => setSlTpEnabled((v) => !v)}
            className="ml-auto flex h-9 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs font-medium"
          >
            <Target className="size-3.5" /> SL · TP
            <span
              className={cn(
                "relative inline-block h-4 w-7 rounded-full transition-colors",
                slTpEnabled ? "bg-primary" : "bg-muted",
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 size-3 rounded-full bg-background transition-all",
                  slTpEnabled ? "left-3" : "left-0.5",
                )}
              />
            </span>
          </button>
        </div>

        {/* ── Stats grid ──────────────────────────────────────────── */}
        <div className="grid grid-cols-4 gap-2 px-4 pt-4 text-[11px]">
          {/* Render an em-dash when the feed hasn't delivered an OHLC
              field yet (typical for fresh subscribes / off-hours), so
              the user doesn't see a confusing "0.0000" placeholder. */}
          <Stat
            label="LTP High"
            value={Number(quote?.high ?? 0) > 0 ? fmtPrice(quote!.high) : "—"}
          />
          <Stat
            label="LTP Low"
            value={Number(quote?.low ?? 0) > 0 ? fmtPrice(quote!.low) : "—"}
          />
          <Stat
            label="Open"
            value={Number(quote?.open ?? 0) > 0 ? fmtPrice(quote!.open) : "—"}
          />
          <Stat
            label="Last Trade"
            value={quote?.timestamp ? formatIST(quote.timestamp, { withSeconds: false }) : "—"}
          />
        </div>

        <div className="my-3 h-px bg-border" />

        {/* ── Lot info row ────────────────────────────────────────── */}
        <div className="flex items-end gap-3 px-4">
          <div className="flex flex-1 gap-4 text-[11px]">
            <LotMeta label="Max Lots" value={maxLotTotal > 0 ? String(maxLotTotal) : "—"} />
            <LotMeta label="Order Lots" value={maxLotPerOrder > 0 ? String(maxLotPerOrder) : "—"} />
            <LotMeta label="Lot Size" value={String(lotSize)} />
          </div>
          <button
            type="button"
            onClick={() => setUnit((u) => (u === "LOTS" ? "QTY" : "LOTS"))}
            className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[11px] font-medium hover:bg-muted/40"
          >
            <ArrowLeftRight className="size-3" />
            {unit === "LOTS" ? "Qty" : "Lots"}
          </button>
        </div>

        {/* ── Price + Lot stepper ─────────────────────────────────── */}
        <div className="mt-3 grid grid-cols-2 gap-2 px-4">
          <div className="rounded-lg border border-border bg-card px-3 py-3 text-center">
            {orderType === "MARKET" ? (
              <>
                <div className="text-base font-semibold">Market</div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Price
                </div>
              </>
            ) : (
              <>
                <input
                  inputMode="decimal"
                  value={limitPrice}
                  onChange={(e) => setLimitPrice(e.target.value)}
                  placeholder={fmtPrice(refPrice).replace(priceCcy, "")}
                  className="w-full bg-transparent text-center text-base font-semibold outline-none"
                />
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Limit Price
                </div>
              </>
            )}
          </div>
          <div className="flex flex-col items-stretch gap-1 rounded-lg border border-border bg-card px-2 py-2">
            <div className="flex items-center justify-between gap-1">
              <button
                type="button"
                onClick={() => bumpLots(-lotStep)}
                aria-label={unit === "LOTS" ? "Decrease lots" : "Decrease quantity"}
                className="grid size-9 place-items-center rounded-md hover:bg-muted/40"
              >
                <Minus className="size-4" />
              </button>
              <div className="text-center">
                <input
                  inputMode="decimal"
                  pattern="[0-9]*\.?[0-9]*"
                  value={lotInput}
                  onChange={(e) => {
                    // Mobile keyboards (especially Android with predictive
                    // text on) will happily inject letters here even with
                    // `inputMode="decimal"`. Filter to digits + a single
                    // decimal point so the field never lands in a state
                    // like "asdads" → NaN on commit → snap-back to minLot.
                    const cleaned = e.target.value
                      .replace(/[^0-9.]/g, "")
                      .replace(/(\..*)\./g, "$1");
                    setLotInput(cleaned);
                  }}
                  onFocus={(e) => e.currentTarget.select()}
                  onBlur={commitLotInput}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitLotInput();
                      (e.currentTarget as HTMLInputElement).blur();
                    }
                  }}
                  className="w-16 bg-transparent text-center text-base font-bold outline-none"
                />
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {unit === "LOTS" ? "Lot" : "Qty"}
                </div>
              </div>
              <button
                type="button"
                onClick={() => bumpLots(lotStep)}
                aria-label={unit === "LOTS" ? "Increase lots" : "Increase quantity"}
                className="grid size-9 place-items-center rounded-md hover:bg-muted/40"
              >
                <Plus className="size-4" />
              </button>
            </div>
            {/* Live bidirectional conversion hint — always visible so the
                trader doesn't have to flip the unit toggle to see the
                other side. Mirrors the desktop OrderPanel's "1 lot = N
                units · Total: M" pill but tuned tighter for the sheet. */}
            <div className="text-center text-[10px] text-muted-foreground">
              {unit === "LOTS" ? (
                <>= <span className="font-tabular text-foreground">{fmtLots(liveQty)}</span> Qty</>
              ) : (
                <>= <span className="font-tabular text-foreground">{fmtLots(liveLots)}</span> Lot</>
              )}
            </div>
          </div>
        </div>

        {/* ── Order type tabs ─────────────────────────────────────── */}
        <div className="mt-3 grid grid-cols-2 gap-2 px-4">
          <button
            type="button"
            onClick={() => setOrderType("MARKET")}
            className={cn(
              "flex h-10 items-center justify-center gap-1.5 rounded-md text-sm font-semibold transition-colors",
              orderType === "MARKET"
                ? "bg-primary text-primary-foreground"
                : "border border-border bg-card text-muted-foreground",
            )}
          >
            <Zap className="size-4" /> Market
          </button>
          <button
            type="button"
            onClick={() => setOrderType("LIMIT")}
            className={cn(
              "flex h-10 items-center justify-center gap-1.5 rounded-md text-sm font-semibold transition-colors",
              orderType === "LIMIT"
                ? "bg-primary text-primary-foreground"
                : "border border-border bg-card text-muted-foreground",
            )}
          >
            <Timer className="size-4" /> Limit
          </button>
        </div>

        {/* ── SL / TP inputs ──────────────────────────────────────── */}
        {slTpEnabled && (
          <div className="mt-3 grid grid-cols-2 gap-2 px-4">
            <div className="rounded-lg border border-border bg-card px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Stop Loss
              </div>
              <input
                inputMode="decimal"
                value={stopLoss}
                onChange={(e) => setStopLoss(e.target.value)}
                placeholder="Optional"
                className="w-full bg-transparent text-base font-semibold outline-none"
              />
            </div>
            <div className="rounded-lg border border-border bg-card px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Take Profit
              </div>
              <input
                inputMode="decimal"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="Optional"
                className="w-full bg-transparent text-base font-semibold outline-none"
              />
            </div>
          </div>
        )}

        {/* ── Wallet snapshot ──────────────────────────────────────────
            Slim three-up of wallet-level numbers (Total Balance / Equity /
            Used Margin) so the trader sees their wallet health on the
            same screen as the order they're about to place. Equity =
            total + open unrealised P/L, so it ticks live as positions
            move. Mirrors the bottom-of-trade wallet footer on desktop. */}
        {(() => {
          const walletUsed = Number(walletSummary?.used_margin ?? 0);
          const walletAvail = Number(walletSummary?.available_balance ?? 0);
          const walletTotal = walletUsed + walletAvail;
          const openUnrl = Number(
            (pnlSummary as any)?.open_unrealised ?? (pnlSummary as any)?.unrealized_pnl ?? 0,
          );
          const equity = walletTotal + openUnrl;
          return (
            <div className="mt-4 grid grid-cols-3 gap-2 px-4 text-[11px]">
              <MarginCard
                label="Total Balance"
                value={formatINRCompact(walletTotal)}
                fullValue={formatINR(walletTotal)}
              />
              <MarginCard
                label="Equity"
                value={formatINRCompact(equity)}
                fullValue={`${formatINR(equity)} (incl. ${openUnrl >= 0 ? "+" : ""}${formatINR(openUnrl)} open P/L)`}
                accent={openUnrl >= 0 ? "ok" : "low"}
              />
              <MarginCard
                label="Used Margin"
                value={formatINRCompact(walletUsed)}
                fullValue={formatINR(walletUsed)}
              />
            </div>
          );
        })()}

        {/* ── Margin cards ────────────────────────────────────────────
            Order-level margin breakdown for the trade being composed.
            Indian segments show Intraday + Holding side by side (admin
            configures different overnight margin); Infoway segments
            collapse to a single Margin tile because there is no carry
            tier — the posted margin is held forever. */}
        <div
          className={cn(
            "mt-2 grid gap-2 px-4 text-[11px]",
            isInfowaySeg ? "grid-cols-2" : "grid-cols-3",
          )}
        >
          {isInfowaySeg ? (
            <MarginCard
              label="Margin"
              value={formatINRCompact(intradayMargin)}
              fullValue={formatINR(intradayMargin)}
            />
          ) : (
            <>
              <MarginCard
                label="Intraday"
                value={formatINRCompact(intradayMargin)}
                fullValue={formatINR(intradayMargin)}
              />
              <MarginCard
                label="Holding"
                value={formatINRCompact(carryforwardMargin)}
                fullValue={formatINR(carryforwardMargin)}
              />
            </>
          )}
          <MarginCard
            label="Available"
            value={formatINRCompact(availableMargin)}
            fullValue={formatINR(availableMargin)}
            accent={availableMargin >= intradayMargin ? "ok" : "low"}
          />
        </div>

        {/* ── Big BUY / SELL ──────────────────────────────────────── */}
        <div className="mt-4 grid grid-cols-2 gap-2 px-4 pb-4">
          {/* `loading` removed — submit is fire-and-forget now and the
              sheet closes immediately on tap, so no spinner state is
              ever visible. `disabled` keeps the 250 ms double-tap
              lockout in case the close animation is slow. */}
          <Button
            type="button"
            disabled={submitting !== null}
            onClick={() => submit("BUY")}
            className="flex h-14 flex-col items-center justify-center gap-0 rounded-lg bg-buy text-buy-foreground hover:bg-buy/90"
          >
            <span className="flex items-center gap-1 text-sm font-bold">
              <ArrowUpRight className="size-4" /> BUY
            </span>
            <span className="font-tabular text-xs tabular-nums opacity-90">
              {fmtPrice(buyPrice)}
            </span>
          </Button>
          <Button
            type="button"
            disabled={submitting !== null}
            onClick={() => submit("SELL")}
            className="flex h-14 flex-col items-center justify-center gap-0 rounded-lg bg-sell text-sell-foreground hover:bg-sell/90"
          >
            <span className="flex items-center gap-1 text-sm font-bold">
              <ArrowDownRight className="size-4" /> SELL
            </span>
            <span className="font-tabular text-xs tabular-nums opacity-90">
              {fmtPrice(sellPrice)}
            </span>
          </Button>
        </div>
      </DialogContent>
      {/* Option chain picker — only mounted for Indian rows. On pick we
          close the sheet AND navigate to terminal so the trader lands
          on the full chart + order panel for that strike, matching the
          Zerodha flow ("Tap a strike → terminal opens"). Keep this
          OUTSIDE DialogContent so the picker dialog can stack over it. */}
      {showOptionChain && (
        <OptionChainPicker
          open={optionChainOpen}
          onOpenChange={setOptionChainOpen}
          initialUnderlying={instrument?.symbol ?? null}
          onPick={(tok) => {
            setOptionChainOpen(false);
            onClose();
            router.push(`/terminal?token=${encodeURIComponent(tok)}`);
          }}
        />
      )}
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className="font-tabular text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function LotMeta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className="font-tabular text-base font-bold tabular-nums">{value}</div>
    </div>
  );
}

function MarginCard({
  label,
  value,
  fullValue,
  accent,
}: {
  label: string;
  value: string;
  fullValue?: string;
  accent?: "ok" | "low";
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card px-2.5 py-2">
      <div className="truncate text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        title={fullValue}
        className={cn(
          "truncate font-tabular text-[13px] font-bold tabular-nums",
          accent === "ok" && "text-buy",
          accent === "low" && "text-sell",
        )}
      >
        {value}
      </div>
    </div>
  );
}
