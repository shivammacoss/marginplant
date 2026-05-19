"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Minus, Plus } from "lucide-react";
import { OrderAPI } from "@/lib/api";
import { playBuyTone, playSellTone } from "@/lib/trade-audio";
import { isInstrumentMarketOpen, marketLabel } from "@/lib/marketHours";
import { cn } from "@/lib/utils";

interface Props {
  instrument: any;
  ltp: number;
  bid?: number | null;
  ask?: number | null;
}

/**
 * Mobile-only quick-trade strip that sits above the chart on the terminal
 * page. Mirrors the MT5 / cTrader top-of-chart pattern: a SELL price card
 * (bid), a centre lot-stepper, and a BUY price card (ask). Tapping a side
 * fires a MARKET order at the displayed price — no second screen, no
 * confirm dialog. For LIMIT / SL-M / SL-TP / product-type the trader uses
 * the desktop order panel; mobile keeps the surface minimal.
 */
export function MobileQuickTradeBar({ instrument, ltp, bid, ask }: Props) {
  const qc = useQueryClient();

  const seg = (instrument?.segment ?? "").toUpperCase();
  const exch = (instrument?.exchange ?? "").toUpperCase();
  const isCrypto = seg.includes("CRYPTO") || exch === "CRYPTO";
  const isForex = seg.includes("FOREX") || seg.includes("FX") || exch === "CDS";
  const defaultProduct: "MIS" | "NRML" | "CNC" = isCrypto || isForex ? "NRML" : "MIS";

  // Lot defaults — sub-1 minimum for crypto/forex so the stepper steps in
  // fractional units (0.01, 0.001) rather than whole lots.
  const minLot = isCrypto ? 0.001 : isForex ? 0.01 : 1;
  const lotStep = minLot;
  const [lots, setLots] = useState<number>(minLot);
  const [submitting, setSubmitting] = useState<"BUY" | "SELL" | null>(null);

  // Mirror of `lots` as a string so the user can type freely (including
  // intermediate states like "0." or "" while editing). The actual `lots`
  // number is committed on blur / Enter. Keeping a separate string state
  // means typing into the field doesn't get clobbered by `lots` re-renders.
  const [lotInput, setLotInput] = useState<string>(() =>
    (isCrypto || isForex ? minLot.toFixed(isCrypto ? 3 : 2) : String(minLot)),
  );

  // Reset lots when the instrument swaps so a crypto symbol doesn't get
  // stuck at the previous equity's "1" default.
  useEffect(() => {
    setLots(minLot);
  }, [instrument?.token, minLot]);

  // Keep the text-input mirror in sync whenever `lots` changes via +/−
  // buttons, instrument swap, or after onBlur clamping. Skips when the
  // user is mid-edit (input differs from the canonical value) so a tap
  // on the field doesn't get hijacked by this effect re-rendering.
  useEffect(() => {
    const canonical = isCrypto || isForex ? lots.toFixed(isCrypto ? 3 : 2) : String(lots);
    if (Number(lotInput) !== lots) setLotInput(canonical);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lots, isCrypto, isForex]);

  const priceDecimals = isCrypto ? 2 : isForex ? 4 : 2;
  // No currency prefix on price displays — bare grouped numbers everywhere.
  const priceCcy = "";
  const sellPrice = bid ?? ltp ?? 0;
  const buyPrice = ask ?? ltp ?? 0;
  function fmtPrice(n: number) {
    return `${priceCcy}${Number(n || 0).toFixed(priceDecimals)}`;
  }
  function fmtLots(n: number) {
    return isCrypto || isForex ? n.toFixed(isCrypto ? 3 : 2) : String(n);
  }

  async function place(side: "BUY" | "SELL") {
    if (!instrument?.token) {
      toast.error("Instrument not loaded");
      return;
    }
    if (!lots || lots < minLot) {
      toast.error(`Lots must be at least ${minLot}`);
      return;
    }
    // Market-closed pre-check — mirror the OrderPanel guard so a tap
    // outside trading hours fails immediately with a clear toast.
    // Without this, the optimistic flow (audio cue + green success toast
    // synchronously, then the backend rejects) flashes "BUY placed"
    // for ~500-1000 ms before the red error replaces it — the
    // "5 ms ke liye trade lagne ka pop aata hai phir waps aa rha hai"
    // symptom the user flagged. With this guard, market-closed
    // instruments never fire the optimistic path at all.
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
    setSubmitting(side);
    // Audio cue fires synchronously on the click — same as OrderPanel — so
    // the user gets confirmation before the network round-trip.
    if (side === "BUY") playBuyTone();
    else playSellTone();

    // Fire the success toast synchronously alongside the audio cue, so
    // the popup appears in the SAME frame as the click — matches the
    // OrderPanel + ClosePositionDialog timing. Dismissed on rejection.
    const pendingToastId = toast.success(
      `${side} ${fmtLots(lots)} ${instrument.symbol} placed`,
      { duration: 1500 },
    );

    try {
      await OrderAPI.place({
        token: instrument.token,
        action: side,
        order_type: "MARKET",
        product_type: defaultProduct,
        lots,
        price: 0,
        trigger_price: 0,
        validity: "DAY",
        is_amo: false,
        stop_loss: null,
        target: null,
        expected_price: side === "BUY" ? buyPrice : sellPrice,
      });
      qc.invalidateQueries({ queryKey: ["positions"] });
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["wallet"] });
    } catch (e: any) {
      toast.dismiss(pendingToastId);
      toast.error(e?.message || "Order rejected");
    } finally {
      setSubmitting(null);
    }
  }

  // APK-parity layout — each side button stacks a small "sell"/"buy"
  // label above its price number. Price uses `text-sm` + `tabular-nums`
  // + `truncate` so wide numbers (BTCUSD 80,000.00, crypto pairs with
  // 2 dp) fit inside the button instead of pushing the side label out
  // of bounds — user flagged this: "bay sell ke button me price over
  // lap karta hai bhaut jada bada ho jata hai". Vertical stack
  // (label-above-price) replaces the previous absolute-positioned
  // corner caption so the label never overlaps the number.
  function fmtAria(price: number) {
    return `${fmtPrice(price)}`;
  }
  return (
    <div className="shrink-0 bg-card lg:hidden">
      <div className="grid grid-cols-[1fr_auto_auto_auto_1fr] items-stretch gap-1.5 p-2">
        <button
          type="button"
          onClick={() => place("SELL")}
          disabled={submitting !== null || !instrument}
          aria-label={`Sell ${instrument?.symbol ?? ""} at market ${fmtAria(sellPrice)}`}
          className={cn(
            "flex min-w-0 flex-col items-center justify-center rounded-lg bg-sell px-2 py-1.5 text-white shadow-sm transition-opacity",
            (submitting !== null || !instrument) && "opacity-50",
            submitting === "SELL" && "animate-pulse",
          )}
        >
          <span className="text-[9px] font-medium uppercase tracking-[0.18em] opacity-90 leading-none">
            sell
          </span>
          <span className="mt-0.5 w-full truncate text-center font-tabular text-sm font-bold tabular-nums leading-tight">
            {fmtPrice(sellPrice)}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setLots((x) => +Math.max(minLot, x - lotStep).toFixed(3))}
          aria-label="Decrease lots"
          className="grid size-10 place-items-center self-center rounded-lg bg-info text-white shadow-sm transition-opacity active:opacity-80"
        >
          <Minus className="size-4" />
        </button>

        <div className="flex items-center justify-center">
          {/* Lot input grew from w-12 → w-16 + dropped from text-xl →
              text-base so fractional crypto sizes (0.001 BTC, 1.234)
              and 4-digit lot counts stay legible. tabular-nums keeps
              digits monospaced so the box width is stable. */}
          <input
            type="text"
            inputMode="decimal"
            value={lotInput}
            onChange={(e) => setLotInput(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => {
              const n = Number(lotInput);
              if (!Number.isFinite(n) || n < minLot) {
                setLots(minLot);
              } else {
                setLots(+n.toFixed(3));
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            aria-label="Lot size"
            className="w-16 bg-transparent text-center font-tabular text-base font-bold tabular-nums text-foreground outline-none"
          />
        </div>

        <button
          type="button"
          onClick={() => setLots((x) => +(x + lotStep).toFixed(3))}
          aria-label="Increase lots"
          className="grid size-10 place-items-center self-center rounded-lg bg-info text-white shadow-sm transition-opacity active:opacity-80"
        >
          <Plus className="size-4" />
        </button>

        <button
          type="button"
          onClick={() => place("BUY")}
          disabled={submitting !== null || !instrument}
          aria-label={`Buy ${instrument?.symbol ?? ""} at market ${fmtAria(buyPrice)}`}
          className={cn(
            "flex min-w-0 flex-col items-center justify-center rounded-lg bg-buy px-2 py-1.5 text-white shadow-sm transition-opacity",
            (submitting !== null || !instrument) && "opacity-50",
            submitting === "BUY" && "animate-pulse",
          )}
        >
          <span className="text-[9px] font-medium uppercase tracking-[0.18em] opacity-90 leading-none">
            buy
          </span>
          <span className="mt-0.5 w-full truncate text-center font-tabular text-sm font-bold tabular-nums leading-tight">
            {fmtPrice(buyPrice)}
          </span>
        </button>
      </div>
    </div>
  );
}
