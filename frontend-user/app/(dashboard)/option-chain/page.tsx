"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Search, TrendingDown, TrendingUp } from "lucide-react";
import { OptionChainAPI } from "@/lib/api";
import { useMarketStream } from "@/lib/useMarketStream";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/common/PageHeader";
import { TradeDetailSheet } from "@/components/trading/TradeDetailSheet";
import { cn, formatNumber, pnlColor } from "@/lib/utils";

const UNDERLYINGS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX"] as const;

export default function OptionChainPage() {
  const router = useRouter();
  const [underlying, setUnderlying] = useState<string>("NIFTY");
  const [expiry, setExpiry] = useState<string | undefined>(undefined);
  const [strikeFilter, setStrikeFilter] = useState("");
  // Mobile-only: tapped strike/leg opens the compact TradeDetailSheet
  // instead of full-route navigating to /terminal — user spec:
  // "stcick price click pe card open ho, bina chart me gaye buy/sell".
  // Desktop keeps the old behaviour (Link → terminal) because the wider
  // viewport actually benefits from the full chart + order panel.
  const [sheetToken, setSheetToken] = useState<string | null>(null);

  const openTrade = useCallback(
    (token: string) => {
      if (!token) return;
      // Mobile + tablet (< lg / 1024 px) open the slide-up trade sheet
      // so the user never loses the option-chain context. Earlier this
      // gated on (max-width: 767px) but several Android phones report a
      // CSS viewport ≥ 768 px in the optical-zoom default, which made
      // the gate fall to the desktop /terminal branch — symptom the
      // user flagged: "stick price click karne par card open nahi
      // hota". Widening to 1023 px catches every non-desktop form
      // factor; the desktop branch only fires on real desktops where
      // the full chart + order panel page actually fits.
      const isMobileUi =
        typeof window !== "undefined" &&
        window.matchMedia("(max-width: 1023px)").matches;
      if (isMobileUi) {
        setSheetToken(token);
      } else {
        router.push(`/terminal?token=${encodeURIComponent(token)}`);
      }
    },
    [router],
  );

  const { data, isFetching } = useQuery({
    queryKey: ["option-chain", underlying, expiry],
    queryFn: () => OptionChainAPI.fetch(underlying, expiry),
    refetchInterval: 2500,
  });

  const expiries: string[] = data?.expiries ?? [];
  const rows: any[] = data?.rows ?? [];
  const atmStrike: number | null = data?.atm_strike ?? null;
  const atmSpot: number | null = data?.atm_spot ?? null;

  // ── Live WS overlay ──────────────────────────────────────────
  // The REST query above refetches every 2.5 s — fine for the strike
  // grid layout but the numbers FEEL static between polls. Mirror the
  // marketwatch pattern: subscribe to every visible CE + PE token via
  // `useMarketStream` so bid / ask / ltp tick at the upstream rate
  // (throttled to ~500 ms display) and the grid feels live. User
  // complaint: "option chain page me tick tick wali movement nahi
  // ho rahi, esko start karo, user ko feel ho price move karte".
  // Cap to the 200 nearest-to-ATM tokens so a 1000-strike feed
  // (BANKNIFTY weeklies) doesn't open a huge subscription set.
  const visibleTokens = useMemo<string[]>(() => {
    if (!rows.length) return [];
    const tokens: string[] = [];
    for (const r of rows) {
      if (r.ce?.token) tokens.push(String(r.ce.token));
      if (r.pe?.token) tokens.push(String(r.pe.token));
    }
    return tokens.slice(0, 400);
  }, [rows]);
  const liveQuotes = useMarketStream(visibleTokens);

  // Overlay the live tick onto each row's CE / PE leg so the table
  // renders sub-second movement. The original `r.ce` / `r.pe` keep
  // every field (volume, oi, change_pct) and we just splice in the
  // most recent bid / ask / ltp from the WS feed.
  const liveRows = useMemo(() => {
    if (liveQuotes.size === 0) return rows;
    return rows.map((r) => {
      const ceLive = r.ce?.token ? liveQuotes.get(String(r.ce.token)) : undefined;
      const peLive = r.pe?.token ? liveQuotes.get(String(r.pe.token)) : undefined;
      if (!ceLive && !peLive) return r;
      return {
        ...r,
        ce: ceLive
          ? {
              ...r.ce,
              bid: Number(ceLive.bid ?? r.ce?.bid ?? 0),
              ask: Number(ceLive.ask ?? r.ce?.ask ?? 0),
              ltp: Number(ceLive.ltp ?? r.ce?.ltp ?? 0),
              change_pct: Number(ceLive.change_pct ?? r.ce?.change_pct ?? 0),
              volume: Number(ceLive.volume ?? r.ce?.volume ?? 0),
            }
          : r.ce,
        pe: peLive
          ? {
              ...r.pe,
              bid: Number(peLive.bid ?? r.pe?.bid ?? 0),
              ask: Number(peLive.ask ?? r.pe?.ask ?? 0),
              ltp: Number(peLive.ltp ?? r.pe?.ltp ?? 0),
              change_pct: Number(peLive.change_pct ?? r.pe?.change_pct ?? 0),
              volume: Number(peLive.volume ?? r.pe?.volume ?? 0),
            }
          : r.pe,
      };
    });
  }, [rows, liveQuotes]);

  const filteredRows = useMemo(() => {
    if (!strikeFilter.trim()) return liveRows;
    if (/^\d+$/.test(strikeFilter)) {
      return liveRows.filter((r) => String(r.strike).includes(strikeFilter));
    }
    return liveRows;
  }, [liveRows, strikeFilter]);

  // Auto-scroll to ATM row on load / underlying change
  const atmRowRef = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    if (!atmRowRef.current) return;
    atmRowRef.current.scrollIntoView({ block: "center", behavior: "auto" });
  }, [underlying, expiry, atmStrike]);

  return (
    <div className="space-y-4">
      {/* Title only on desktop — mobile screens are short, the page
          header was eating ~88 px of vertical room before the user
          could even see the chain. User asked to drop it from the
          mobile view ("option chain hata dena upar se"). */}
      <div className="hidden md:block">
        <PageHeader
          title="Option chain"
          description="Live CE | STRIKE | PE grid. Click any leg to open the trading terminal."
        />
      </div>

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
                  <ChainCell leg={r.ce} side="ce" align="right" onOpenTrade={openTrade} />
                  <td
                    className={cn(
                      "cursor-pointer px-2 py-1 text-center font-tabular hover:bg-primary/10",
                      isATM && "font-semibold text-primary",
                    )}
                    onClick={() => openTrade(r.ce?.token || r.pe?.token || "")}
                  >
                    {r.strike.toLocaleString("en-IN")}
                  </td>
                  <ChainCell leg={r.pe} side="pe" align="left" onOpenTrade={openTrade} />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile trade sheet — opens when a strike or leg is tapped on
          phones. Desktop still gets the /terminal navigation above.
          `onSwap` lets the in-sheet Option Chain picker swap strikes
          without bouncing the user through /terminal. */}
      <TradeDetailSheet
        token={sheetToken}
        open={!!sheetToken}
        onClose={() => setSheetToken(null)}
        onSwap={(tok) => setSheetToken(tok)}
      />
    </div>
  );
}

function ChainCell({
  leg,
  side,
  align,
  onOpenTrade,
}: {
  leg: any;
  side: "ce" | "pe";
  align: "left" | "right";
  onOpenTrade: (token: string) => void;
}) {
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
  // Replace the previous next/link Link with a plain <button> + onClick
  // so the OPENTRADE branch can dispatch differently per viewport
  // (mobile → bottom sheet, desktop → /terminal navigate). Keeping the
  // visual treatment identical to the old Link so the chain looks the
  // same in both modes.
  const onClick = () => onOpenTrade(leg.token);
  const cells = [
    <td key="vol" className="px-2 py-1 text-right text-muted-foreground">
      {leg.volume?.toLocaleString("en-IN") || "—"}
    </td>,
    <td key="bid" className="px-2 py-1 text-right">
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "rounded hover:underline",
          side === "ce" ? "text-buy" : "text-sell",
        )}
      >
        {formatNumber(leg.bid)}
      </button>
    </td>,
    <td key="ltp" className="px-2 py-1 text-right">
      <button
        type="button"
        onClick={onClick}
        className="rounded font-medium hover:underline"
      >
        {formatNumber(leg.ltp)}
      </button>
    </td>,
    <td key="ask" className="px-2 py-1 text-right">
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "rounded hover:underline",
          side === "ce" ? "text-buy" : "text-sell",
        )}
      >
        {formatNumber(leg.ask)}
      </button>
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
