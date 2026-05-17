"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Search, TrendingDown, TrendingUp } from "lucide-react";
import { OptionChainAPI } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/common/PageHeader";
import { cn, formatNumber, pnlColor } from "@/lib/utils";

const UNDERLYINGS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX"] as const;

export default function OptionChainPage() {
  const [underlying, setUnderlying] = useState<string>("NIFTY");
  const [expiry, setExpiry] = useState<string | undefined>(undefined);
  const [strikeFilter, setStrikeFilter] = useState("");

  const { data, isFetching } = useQuery({
    queryKey: ["option-chain", underlying, expiry],
    queryFn: () => OptionChainAPI.fetch(underlying, expiry),
    refetchInterval: 2500,
  });

  const expiries: string[] = data?.expiries ?? [];
  const rows: any[] = data?.rows ?? [];
  const atmStrike: number | null = data?.atm_strike ?? null;
  const atmSpot: number | null = data?.atm_spot ?? null;

  const filteredRows = useMemo(() => {
    if (!strikeFilter.trim()) return rows;
    if (/^\d+$/.test(strikeFilter)) {
      return rows.filter((r) => String(r.strike).includes(strikeFilter));
    }
    return rows;
  }, [rows, strikeFilter]);

  // Auto-scroll to ATM row on load / underlying change
  const atmRowRef = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    if (!atmRowRef.current) return;
    atmRowRef.current.scrollIntoView({ block: "center", behavior: "auto" });
  }, [underlying, expiry, atmStrike]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Option chain"
        description="Live CE | STRIKE | PE grid. Click any leg to open the trading terminal."
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-md bg-muted/40 p-1">
          {UNDERLYINGS.map((u) => (
            <button
              key={u}
              onClick={() => {
                setUnderlying(u);
                setExpiry(undefined);
              }}
              className={cn(
                "rounded px-3 py-1.5 text-xs font-medium",
                underlying === u ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {u}
            </button>
          ))}
        </div>

        <div className="relative">
          <select
            value={expiry ?? ""}
            onChange={(e) => setExpiry(e.target.value || undefined)}
            className="h-9 appearance-none rounded-md border border-border bg-background pl-3 pr-8 text-sm"
          >
            <option value="">Nearest expiry</option>
            {expiries.map((e) => (
              <option key={e} value={e}>
                {new Date(e).toLocaleDateString("en-IN", {
                  day: "2-digit",
                  month: "short",
                  year: "numeric",
                })}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        </div>

        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={strikeFilter}
            onChange={(e) => setStrikeFilter(e.target.value)}
            placeholder="Filter by strike"
            className="h-9 pl-9 text-sm"
          />
        </div>

        <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          {atmSpot && (
            <span>
              Spot ≈ <span className="font-tabular text-foreground">{formatNumber(atmSpot)}</span>
            </span>
          )}
          {atmStrike != null && (
            <span>
              ATM <span className="font-tabular text-primary">{atmStrike.toLocaleString("en-IN")}</span>
            </span>
          )}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-card scrollbar-thin">
        <table className="min-w-full text-xs">
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b border-border text-muted-foreground">
              <th colSpan={5} className="px-3 py-2 text-center text-[11px] uppercase tracking-wider text-buy">
                Calls (CE)
              </th>
              <th className="px-3 py-2 text-center text-[11px] uppercase tracking-wider">Strike</th>
              <th colSpan={5} className="px-3 py-2 text-center text-[11px] uppercase tracking-wider text-sell">
                Puts (PE)
              </th>
            </tr>
            <tr className="border-b border-border text-[10px] uppercase text-muted-foreground">
              <th className="px-2 py-1 text-right">Volume</th>
              <th className="px-2 py-1 text-right">Bid</th>
              <th className="px-2 py-1 text-right">LTP</th>
              <th className="px-2 py-1 text-right">Ask</th>
              <th className="px-2 py-1 text-right">%Chg</th>
              <th className="px-2 py-1 text-center"></th>
              <th className="px-2 py-1 text-right">%Chg</th>
              <th className="px-2 py-1 text-right">Bid</th>
              <th className="px-2 py-1 text-right">LTP</th>
              <th className="px-2 py-1 text-right">Ask</th>
              <th className="px-2 py-1 text-right">Volume</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isFetching && filteredRows.length === 0 && (
              <tr>
                <td colSpan={11} className="px-3 py-12 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            )}
            {!isFetching && filteredRows.length === 0 && (
              <tr>
                <td colSpan={11} className="px-3 py-12 text-center text-muted-foreground">
                  No options found for this underlying. Subscribe instruments in admin → Zerodha Connect.
                </td>
              </tr>
            )}
            {filteredRows.map((r) => {
              const isATM = r.strike === atmStrike;
              const isITMCall = atmStrike != null && r.strike < atmStrike;
              const isITMPut = atmStrike != null && r.strike > atmStrike;
              return (
                <tr
                  key={r.strike}
                  ref={isATM ? atmRowRef : undefined}
                  className={cn(
                    "transition-colors hover:bg-muted/40",
                    isATM && "bg-primary/10",
                    !isATM && (isITMCall || isITMPut) && "bg-muted/10"
                  )}
                >
                  <ChainCell leg={r.ce} side="ce" align="right" />
                  <td className={cn("px-2 py-1 text-center font-tabular", isATM && "font-semibold text-primary")}>
                    {r.strike.toLocaleString("en-IN")}
                  </td>
                  <ChainCell leg={r.pe} side="pe" align="left" />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ChainCell({ leg, side, align }: { leg: any; side: "ce" | "pe"; align: "left" | "right" }) {
  if (!leg) {
    return (
      <>
        <td className="px-2 py-1 text-right text-muted-foreground">—</td>
        <td className="px-2 py-1 text-right text-muted-foreground">—</td>
        <td className="px-2 py-1 text-right text-muted-foreground">—</td>
        <td className="px-2 py-1 text-right text-muted-foreground">—</td>
        <td className="px-2 py-1 text-right text-muted-foreground">—</td>
      </>
    );
  }
  const Trend = (leg.change_pct ?? 0) >= 0 ? TrendingUp : TrendingDown;
  const link = `/terminal?token=${encodeURIComponent(leg.token)}`;
  const cells = [
    <td key="vol" className="px-2 py-1 text-right text-muted-foreground">
      {leg.volume?.toLocaleString("en-IN") || "—"}
    </td>,
    <td key="bid" className="px-2 py-1 text-right">
      <Link href={link} className={side === "ce" ? "text-buy hover:underline" : "text-sell hover:underline"}>
        {formatNumber(leg.bid)}
      </Link>
    </td>,
    <td key="ltp" className="px-2 py-1 text-right">
      <Link href={link} className="font-medium hover:underline">
        {formatNumber(leg.ltp)}
      </Link>
    </td>,
    <td key="ask" className="px-2 py-1 text-right">
      <Link href={link} className={side === "ce" ? "text-buy hover:underline" : "text-sell hover:underline"}>
        {formatNumber(leg.ask)}
      </Link>
    </td>,
    <td key="chg" className={cn("px-2 py-1 text-right", pnlColor(leg.change_pct))}>
      <span className="inline-flex items-center gap-1">
        <Trend className="size-3" />
        {(leg.change_pct ?? 0).toFixed(2)}%
      </span>
    </td>,
  ];
  return align === "right" ? <>{cells}</> : <>{cells.reverse()}</>;
}
