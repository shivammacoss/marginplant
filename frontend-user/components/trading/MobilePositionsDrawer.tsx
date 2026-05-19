"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp, Flag, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PositionAPI } from "@/lib/api";
import { isInstrumentMarketOpen, marketLabel } from "@/lib/marketHours";
import { cn, formatNumber, pnlColor } from "@/lib/utils";

interface Props {
  positions: any[];
  totalPnL: number;
  /** Tap a card to jump the chart to that instrument. Token comes from
   *  `instrument_token` (Zerodha) or `token` (Infoway) on the position. */
  onJumpToToken?: (token: string) => void;
}

/**
 * Mobile-only pull-up drawer that sits at the bottom of the chart card.
 * Tapping the pill toggles a half-sheet of OPEN POSITIONS (APK parity).
 * The chart above stays visible so the user can monitor the move while
 * deciding to close.
 *
 * Each card mirrors the APK layout: side pill · symbol · qty chip ·
 * unrealised P&L · entry → close-side price + %change · close button.
 * The CLOS button reuses `PositionAPI.squareoff` with the same
 * optimistic-update pattern as `PositionsTabs.squareoff` — instant row
 * removal, synchronous success toast, rollback on backend rejection.
 */
export function MobilePositionsDrawer({ positions, totalPnL, onJumpToToken }: Props) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [closingId, setClosingId] = useState<string | null>(null);
  const openCount = positions?.length ?? 0;

  function squareoff(p: any) {
    const id = String(p?.id ?? "");
    const symbol = String(p?.symbol ?? "—");
    if (!id) return;
    if (!isInstrumentMarketOpen(p?.segment_type, p?.exchange)) {
      toast.error(
        `${marketLabel(p?.segment_type, p?.exchange)} market is closed — close ${symbol} during trading hours`,
        { duration: 4000 },
      );
      return;
    }
    setClosingId(id);

    const posSnapshot = qc.getQueryData<any[]>(["positions", "open"]);
    qc.cancelQueries({ queryKey: ["positions", "open"] });
    qc.setQueryData<any[]>(["positions", "open"], (old) =>
      Array.isArray(old) ? old.filter((x) => x.id !== id) : [],
    );
    const pendingToastId = toast.success(`Closed ${symbol} at market`, { duration: 1500 });

    PositionAPI.squareoff(id)
      .then(() => {
        qc.invalidateQueries({ queryKey: ["orders"] });
        qc.invalidateQueries({ queryKey: ["wallet"] });
      })
      .catch((e: any) => {
        if (posSnapshot) qc.setQueryData(["positions", "open"], posSnapshot);
        toast.dismiss(pendingToastId);
        toast.error(e?.message || "Close failed");
      })
      .finally(() => setClosingId(null));
  }

  return (
    <div className="shrink-0 border-t border-border bg-card lg:hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-center gap-2 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
        <span>{open ? "Hide positions" : "Show positions"}</span>
        {openCount > 0 && (
          <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold tracking-wider text-primary">
            {openCount}
          </span>
        )}
      </button>

      {open && (
        <div className="max-h-[40vh] overflow-y-auto border-t border-border bg-background/40 px-3 py-2">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Open positions · {openCount}
            </span>
            <Link
              href="/positions"
              className="text-[11px] font-medium text-primary hover:underline"
            >
              View all →
            </Link>
          </div>

          {openCount === 0 ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              No open positions.
            </div>
          ) : (
            <ul className="space-y-2">
              {positions.map((p) => (
                <PositionCard
                  key={String(p.id)}
                  p={p}
                  isClosing={closingId === String(p.id)}
                  onClose={() => squareoff(p)}
                  onTapSymbol={() => {
                    const tok = String(p?.instrument_token ?? p?.token ?? "");
                    if (tok) onJumpToToken?.(tok);
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function PositionCard({
  p,
  isClosing,
  onClose,
  onTapSymbol,
}: {
  p: any;
  isClosing: boolean;
  onClose: () => void;
  onTapSymbol: () => void;
}) {
  const qty = Number(p?.quantity ?? 0);
  const isLong = qty >= 0;
  const side: "BUY" | "SELL" = isLong ? "BUY" : "SELL";
  const lotSize = Number(p?.lot_size ?? 1) || 1;
  const lots = lotSize > 0 ? Math.abs(qty) / lotSize : Math.abs(qty);
  const avg = Number(p?.avg_price ?? 0);
  const ltp = Number(p?.ltp ?? 0);
  const pnl = Number(p?.unrealized_pnl ?? 0);
  const pct = avg > 0 ? ((ltp - avg) / avg) * (isLong ? 1 : -1) * 100 : 0;
  const seg = String(p?.segment_type ?? p?.segment ?? "").toUpperCase();
  const exch = String(p?.exchange ?? "").toUpperCase();
  const segLabel = seg.includes("OPTION")
    ? "NFO"
    : seg.includes("FUT")
      ? "NFO"
      : exch || seg.slice(0, 3) || "—";

  // Pretty time — entry timestamp if available, else fallback to "—".
  const ts = p?.created_at ?? p?.entry_time ?? null;
  const timeLabel = ts
    ? new Date(ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
    : "—";

  return (
    <li
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-card",
        isLong ? "border-l-4 border-l-buy" : "border-l-4 border-l-sell",
        isClosing && "opacity-50",
      )}
    >
      <div className="flex items-center gap-2 px-3 pt-2">
        <span
          className={cn(
            "rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
            isLong ? "bg-buy/15 text-buy" : "bg-sell/15 text-sell",
          )}
        >
          {side}
        </span>
        <button
          type="button"
          onClick={onTapSymbol}
          className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-foreground"
        >
          {p?.symbol ?? "—"}
        </button>
        <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-foreground">
          ×{Math.abs(qty)}
        </span>
        <span
          className={cn(
            "font-tabular text-sm font-semibold tabular-nums",
            pnlColor(pnl),
          )}
        >
          {pnl >= 0 ? "+" : ""}
          ₹{formatNumber(pnl)}
        </span>
      </div>

      <div className="mx-3 mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-md bg-muted/40 px-3 py-1.5">
        <div className="flex flex-col">
          <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
            Entry
          </span>
          <span className="font-tabular text-sm font-semibold tabular-nums">
            {avg.toFixed(2)}
          </span>
        </div>
        <span className="text-muted-foreground">→</span>
        <div className="flex flex-col items-end">
          <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
            {isLong ? "Bid" : "Ask"}
          </span>
          <div className="flex items-baseline gap-1">
            <span className="font-tabular text-sm font-semibold tabular-nums">
              {ltp.toFixed(2)}
            </span>
            <span className={cn("text-[10px] font-semibold", pnlColor(pct))}>
              {pct >= 0 ? "+" : ""}
              {pct.toFixed(2)}%
            </span>
          </div>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 border-t border-border px-3 py-1.5">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {segLabel} · {timeLabel}
        </span>
        <div className="flex items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-md bg-info/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-info">
            <Flag className="size-3" />
            SL · TP
          </span>
          <button
            type="button"
            onClick={onClose}
            disabled={isClosing}
            className="inline-flex items-center gap-1 rounded-md bg-sell/15 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-sell hover:bg-sell/25 disabled:opacity-50"
          >
            <X className="size-3" />
            CLOS
          </button>
        </div>
      </div>
    </li>
  );
}
