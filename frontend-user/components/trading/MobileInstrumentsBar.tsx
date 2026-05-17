"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, ChevronUp, Plus, Search, Star, X } from "lucide-react";
import { InstrumentAPI, MarketwatchAPI, SegmentSettingsAPI } from "@/lib/api";
import { useMarketStream } from "@/lib/useMarketStream";
import { usePriceFlash } from "@/lib/usePriceFlash";
import { cn, formatPrice, pnlColor } from "@/lib/utils";

interface Props {
  activeToken: string | null;
  onSelect: (token: string) => void;
}

type Bucket = {
  key: string;
  label: string;
  mode: "watchlist" | "filter";
  segments?: string[];
  adminRows?: string[];
  // Indian-segment chips are user-managed: list shows only what the
  // user has explicitly added (via search + "+"). Mirrors the desktop
  // InstrumentsPanel behaviour. Infoway-fed chips (Forex/Crypto/etc.)
  // stay non-managed — the entire small feed is shown.
  managed?: boolean;
};

// Bucket order: Favorites first, then every Indian-exchange-backed
// segment (NSE EQ / FUT / OPT, MCX FUT), then the international /
// Infoway-backed ones (Indices, Stocks, Commodities, Forex, Crypto) so
// a user reaching for "NIFTY FUT" doesn't have to scroll past five
// foreign-market chips first. Matches the user's request: Indian
// markets pehle, crypto/forex last.
const BUCKETS: Bucket[] = [
  { key: "favorites", label: "Favorites", mode: "watchlist" },
  // Indian segments — managed (user explicitly adds instruments)
  { key: "nse_eq", label: "NSE EQ", mode: "filter", segments: ["NSE_EQUITY"], adminRows: ["NSE_EQ"], managed: true },
  { key: "nse_fut", label: "NSE FUT", mode: "filter", segments: ["NSE_FUTURE", "NSE_INDEX_FUTURE"], adminRows: ["NSE_FUT"], managed: true },
  { key: "nse_opt", label: "NSE OPT", mode: "filter", segments: ["NSE_INDEX_OPTION_BUY", "NSE_INDEX_OPTION_SELL", "NSE_STOCK_OPTION_BUY", "NSE_STOCK_OPTION_SELL"], adminRows: ["NSE_OPT"], managed: true },
  { key: "bse_eq", label: "BSE EQ", mode: "filter", segments: ["BSE_EQUITY"], adminRows: ["BSE_EQ"], managed: true },
  { key: "bse_fut", label: "BSE FUT", mode: "filter", segments: ["BSE_FUTURE", "BSE_INDEX_FUTURE"], adminRows: ["BSE_FUT"], managed: true },
  { key: "bse_opt", label: "BSE OPT", mode: "filter", segments: ["BSE_OPTION_BUY", "BSE_OPTION_SELL"], adminRows: ["BSE_OPT"], managed: true },
  { key: "mcx_fut", label: "MCX FUT", mode: "filter", segments: ["MCX_FUTURE"], adminRows: ["MCX_FUT"], managed: true },
  // MCX OPT — was missing from this list (admin enables MCX_OPT but the
  // mobile chip strip never surfaced it, so users on phones couldn't
  // see commodity options at all). Same admin row + segment-set as the
  // desktop InstrumentsPanel.
  { key: "mcx_opt", label: "MCX OPT", mode: "filter", segments: ["MCX_OPTION_BUY", "MCX_OPTION_SELL"], adminRows: ["MCX_OPT"], managed: true },
  // Infoway-fed chips — non-managed (entire small feed visible)
  { key: "indices", label: "Indices", mode: "filter", segments: ["INDICES"], adminRows: ["INDICES"] },
  { key: "stocks", label: "Stocks", mode: "filter", segments: ["STOCKS"], adminRows: ["STOCKS"] },
  { key: "commodities", label: "Commodities", mode: "filter", segments: ["COMMODITIES"], adminRows: ["COMMODITIES"] },
  { key: "forex", label: "Forex", mode: "filter", segments: ["FOREX"], adminRows: ["FOREX"] },
  { key: "crypto", label: "Crypto", mode: "filter", segments: ["CRYPTO_PERPETUAL", "CRYPTO_SPOT", "CRYPTO_FUTURE"], adminRows: ["CRYPTO"] },
];

/**
 * Mobile-only instruments bar that sits at the top of the terminal page.
 * Mirrors the InstrumentsPanel's search + bucket model but in a flatter
 * horizontal layout — chips strip + search row + scrollable picks. Tapping
 * a row fires `onSelect(token)` which the terminal page maps onto the
 * existing `selectedToken` state — no navigation, the chart and order panel
 * below just swap.
 */
export function MobileInstrumentsBar({ activeToken, onSelect }: Props) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(true);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [bucketKey, setBucketKey] = useState<string>("favorites");
  // Optimistic favorite toggle — tracks tokens the user just starred /
  // unstarred so the star icon flips before the network round-trip lands.
  // Reset whenever the source watchlist refetches.
  const [pendingFav, setPendingFav] = useState<Map<string, boolean>>(new Map());

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 180);
    return () => clearTimeout(t);
  }, [search]);

  const { data: inactiveRows } = useQuery({
    queryKey: ["segment-settings", "inactive"],
    queryFn: () => SegmentSettingsAPI.inactive(),
    staleTime: 30_000,
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });
  const inactiveSet = useMemo(() => new Set(inactiveRows ?? []), [inactiveRows]);
  const visibleBuckets = useMemo(
    () =>
      BUCKETS.filter((b) => {
        const rows = b.adminRows ?? [];
        if (rows.length === 0) return true;
        return rows.some((r) => !inactiveSet.has(r));
      }),
    [inactiveSet],
  );
  useEffect(() => {
    if (!visibleBuckets.find((b) => b.key === bucketKey)) setBucketKey("favorites");
  }, [visibleBuckets, bucketKey]);

  // Smooth-scroll the active chip into view when the bucket changes.
  // `block: nearest` keeps vertical position; `inline: center` slides the
  // chip into the middle of the strip so the user always sees adjacent
  // buckets on both sides — far better than the previous `snap-start`
  // jump that left the active chip pinned to the left edge.
  const chipsScrollerRef = useRef<HTMLDivElement | null>(null);
  const chipRefs = useRef<Record<string, HTMLButtonElement>>({});
  useEffect(() => {
    const el = chipRefs.current[bucketKey];
    if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [bucketKey]);

  const bucket = visibleBuckets.find((b) => b.key === bucketKey) ?? visibleBuckets[0];

  const { data: watchlists } = useQuery({
    queryKey: ["watchlists"],
    queryFn: () => MarketwatchAPI.list(),
    staleTime: 30_000,
  });
  const activeWl = watchlists?.[0];

  // Token → item-id map for the active watchlist so a tap on the star can
  // resolve the item id needed for `removeItem` without a second round-trip.
  const favItemByToken = useMemo(() => {
    const map = new Map<string, string>();
    for (const it of activeWl?.items ?? []) {
      if (it?.instrument_token && it?.id) map.set(String(it.instrument_token), String(it.id));
    }
    return map;
  }, [activeWl]);

  // Clear the optimistic-flip overlay once the server-side list catches up
  // — otherwise repeated stars on the same token would stay "pending" forever.
  useEffect(() => {
    if (pendingFav.size === 0) return;
    setPendingFav((prev) => {
      const next = new Map(prev);
      for (const [tok, wantStarred] of prev) {
        const isStarred = favItemByToken.has(tok);
        if (isStarred === wantStarred) next.delete(tok);
      }
      return next;
    });
  }, [favItemByToken, pendingFav]);

  function isFav(token: string): boolean {
    const tok = String(token);
    if (pendingFav.has(tok)) return pendingFav.get(tok)!;
    return favItemByToken.has(tok);
  }

  async function toggleFavorite(token: string) {
    const tok = String(token);
    if (!activeWl?.id) {
      toast.error("No watchlist available");
      return;
    }
    const currentlyFav = isFav(tok);
    // Flip the star instantly — server reconciliation happens in the
    // invalidate below.
    setPendingFav((prev) => new Map(prev).set(tok, !currentlyFav));
    try {
      if (currentlyFav) {
        const itemId = favItemByToken.get(tok);
        if (!itemId) throw new Error("Item not found in watchlist");
        await MarketwatchAPI.removeItem(activeWl.id, itemId);
      } else {
        await MarketwatchAPI.addItem(activeWl.id, tok);
      }
      qc.invalidateQueries({ queryKey: ["watchlists"] });
      qc.invalidateQueries({ queryKey: ["watchlist-quotes"] });
    } catch (e: any) {
      // Roll back the optimistic flip on failure.
      setPendingFav((prev) => {
        const next = new Map(prev);
        next.delete(tok);
        return next;
      });
      toast.error(e?.message || (currentlyFav ? "Failed to remove" : "Failed to add"));
    }
  }
  const { data: wlQuotes } = useQuery({
    queryKey: ["watchlist-quotes", activeWl?.id],
    queryFn: () => MarketwatchAPI.quotes(activeWl!.id),
    enabled: !!activeWl?.id && bucketKey === "favorites" && search.trim().length === 0 && expanded,
    refetchInterval: 3000,
    staleTime: 2000,
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });

  const browseSegments = bucket?.mode === "filter" ? bucket.segments?.join(",") : undefined;
  const searchScopeSegments = bucket?.mode === "filter" ? browseSegments : undefined;

  // Managed-segment marker — Indian chips show only what the user
  // explicitly added. The admin row name (e.g. "NSE_EQ") is the
  // backend's segment key. Same flow as the desktop InstrumentsPanel.
  const managedSegmentName =
    bucket?.managed && bucket?.adminRows?.[0] ? bucket.adminRows[0] : null;

  const { data: segmentItems } = useQuery<any[]>({
    queryKey: ["segment-items", managedSegmentName],
    queryFn: () => MarketwatchAPI.segmentItems(managedSegmentName!),
    enabled: !!managedSegmentName && expanded,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
  const addedTokenSet = useMemo(() => {
    const s = new Set<string>();
    for (const it of segmentItems ?? []) {
      if (it?.instrument_token) s.add(String(it.instrument_token));
    }
    return s;
  }, [segmentItems]);

  async function addToSegment(token: string, symbol: string) {
    if (!managedSegmentName) return;
    try {
      await MarketwatchAPI.addSegmentItem(managedSegmentName, token);
      qc.invalidateQueries({ queryKey: ["segment-items", managedSegmentName] });
      toast.success(`Added ${symbol} to ${bucket?.label}`, { duration: 1500 });
    } catch (e: any) {
      toast.error(e?.message || `Failed to add ${symbol}`);
    }
  }

  async function removeFromSegment(token: string, symbol: string) {
    if (!managedSegmentName) return;
    try {
      await MarketwatchAPI.removeSegmentItem(managedSegmentName, token);
      qc.invalidateQueries({ queryKey: ["segment-items", managedSegmentName] });
      toast.success(`Removed ${symbol}`, { duration: 1500 });
    } catch (e: any) {
      toast.error(e?.message || `Failed to remove ${symbol}`);
    }
  }

  const { data: searchHits } = useQuery({
    queryKey: ["mobile-instruments-search", debouncedSearch, searchScopeSegments],
    queryFn: () =>
      InstrumentAPI.search(debouncedSearch, undefined, searchScopeSegments, 30),
    enabled: debouncedSearch.trim().length > 0 && expanded,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });
  // Browse the bucket — cap at 40 (was 60). A bigger result set bloats the
  // WS subscribe list and the per-row quote map without the user actually
  // seeing past the first ~10 rows on screen.
  // Skipped for managed segments — those render `segmentItems` (user's
  // explicit additions) instead of the full Kite cache.
  const { data: bucketHits } = useQuery({
    queryKey: ["mobile-instruments-bucket", bucketKey, browseSegments],
    queryFn: () => InstrumentAPI.search(undefined, undefined, browseSegments, 40),
    enabled:
      search.trim().length === 0 &&
      bucket?.mode !== "watchlist" &&
      !!browseSegments &&
      expanded &&
      !managedSegmentName,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });

  // `tokensKey` (a stable string) is the dep — using the array itself
  // would invalidate the memo on every render even when the contents
  // matched, which in turn churned the WS subscribe / unsubscribe in
  // useMarketStream below.
  // Cap subscribed tokens to LIVE_TOKEN_CAP (top N of the filtered
  // list). Mirrors the same cap on the desktop InstrumentsPanel —
  // prevents the backend pump from refreshing 100+ overlays per cycle
  // when the user only sees 8-10 rows on a phone viewport. The
  // remaining rows render with the initial REST snapshot bid/ask which
  // is good enough until the user scrolls.
  const LIVE_TOKEN_CAP = 30;
  const tokensKey = useMemo<string>(() => {
    const all = (() => {
      if (debouncedSearch.trim().length > 0) {
        return (searchHits ?? []).map((s: any) => s.token);
      }
      if (bucket?.mode === "watchlist") return [];
      if (managedSegmentName) {
        return (segmentItems ?? []).map((it: any) => String(it.instrument_token));
      }
      return (bucketHits ?? []).map((s: any) => s.token);
    })();
    return all.slice(0, LIVE_TOKEN_CAP).join(",");
  }, [debouncedSearch, searchHits, bucketHits, bucket?.mode, managedSegmentName, segmentItems]);
  const visibleTokens = useMemo<string[]>(
    () => (tokensKey ? tokensKey.split(",") : []),
    [tokensKey],
  );

  const { data: liveQuotes } = useQuery<any[]>({
    queryKey: ["mobile-instruments-batch-seed", tokensKey],
    queryFn: () => InstrumentAPI.quotesBatch(visibleTokens),
    enabled: visibleTokens.length > 0 && expanded,
    staleTime: 60_000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });
  // Skip WS subscription entirely when the bar is collapsed — the user
  // can't see anything, no point burning sockets / handlers.
  const streamQuotes = useMarketStream(expanded ? visibleTokens : []);
  const quoteByToken = useMemo(() => {
    const map = new Map<string, any>();
    for (const q of liveQuotes ?? []) map.set(String(q.token), q);
    streamQuotes.forEach((q, tok) => map.set(tok, q));
    return map;
  }, [liveQuotes, streamQuotes]);

  const list = useMemo(() => {
    const enrich = (s: any) => {
      const live = quoteByToken.get(String(s.token));
      return {
        instrument_token: s.token,
        symbol: s.symbol,
        exchange: s.exchange,
        segment: s.segment ?? s.instrument_type,
        bid: live?.bid ?? null,
        ask: live?.ask ?? null,
        change_pct: live?.change_pct ?? null,
      };
    };
    if (debouncedSearch.trim().length > 0) return (searchHits ?? []).map(enrich);
    if (bucket?.mode === "watchlist") return wlQuotes ?? [];
    if (managedSegmentName) {
      return (segmentItems ?? []).map((it: any) =>
        enrich({
          token: it.instrument_token,
          symbol: it.symbol,
          exchange: it.exchange,
          segment: null,
          instrument_type: null,
        }),
      );
    }
    return (bucketHits ?? []).map(enrich);
  }, [debouncedSearch, searchHits, wlQuotes, bucketHits, bucket, quoteByToken, managedSegmentName, segmentItems]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
      {/* Header — mirrors the desktop InstrumentsPanel ("INSTRUMENTS"
          uppercase label + close on the right). The collapse chevron is
          kept so the user can shrink the strip on phones that have less
          vertical room. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Instruments
        </span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="ml-auto grid size-7 place-items-center rounded text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          aria-label={expanded ? "Collapse instruments" : "Expand instruments"}
        >
          {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </button>
      </div>

      {expanded && (
        <>
          <div className="shrink-0 space-y-2 border-b border-border px-3 py-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search symbols..."
                className="h-8 w-full rounded-md border border-border bg-background pl-7 pr-7 text-xs outline-none placeholder:text-muted-foreground focus:border-primary"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  aria-label="Clear search"
                  className="absolute right-1 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>

            {/* Segment chips — horizontally scrollable strip. Hides the
                scrollbar entirely (touch-friendly), uses snap-x so a swipe
                lands the next chip cleanly aligned at the leading edge,
                and a fade-mask on the right indicates more chips are
                available off-screen. Larger touch target (h-7, px-3)
                makes the chips comfortable to tap on phones. `scroll-smooth`
                + `scrollIntoView` on the active chip below means a tap on
                a partially-clipped chip smoothly centres it instead of
                jumping abruptly to the snap point. */}
            <div
              ref={chipsScrollerRef}
              className="scroll-smooth -mx-3 overflow-x-auto overscroll-x-contain px-3 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
              style={{
                maskImage:
                  "linear-gradient(to right, black 0%, black calc(100% - 24px), transparent 100%)",
                WebkitMaskImage:
                  "linear-gradient(to right, black 0%, black calc(100% - 24px), transparent 100%)",
                WebkitOverflowScrolling: "touch",
              }}
            >
              <div className="flex snap-x gap-1.5">
                {visibleBuckets.map((b) => (
                  <button
                    key={b.key}
                    type="button"
                    ref={(el) => {
                      if (el) chipRefs.current[b.key] = el;
                      else delete chipRefs.current[b.key];
                    }}
                    onClick={() => setBucketKey(b.key)}
                    className={cn(
                      // uppercase keeps Infoway chips ("Forex", "Stocks", …)
                      // visually consistent with Zerodha chips ("NSE EQ" etc).
                      "h-7 shrink-0 snap-center whitespace-nowrap rounded-full border px-3 text-[11px] font-medium uppercase tracking-wide transition-colors",
                      bucketKey === b.key
                        ? "border-primary bg-primary/15 text-primary"
                        : "border-border text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                    )}
                  >
                    {b.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
            {list.length === 0 && (
              <div className="grid h-24 place-items-center px-4 text-center text-xs text-muted-foreground">
                {search.trim()
                  ? "No instruments match"
                  : managedSegmentName
                    ? `No instruments yet. Search above to add to ${bucket?.label}.`
                    : "Add instruments to your watchlist to see them here."}
              </div>
            )}
            {list.map((q: any) => {
              const token = String(q.instrument_token);
              const isActive = token === String(activeToken);
              const starred = isFav(token);
              const liveOverlay = quoteByToken.get(token);
              const bid = q.bid ?? liveOverlay?.bid ?? null;
              const ask = q.ask ?? liveOverlay?.ask ?? null;
              const changePct = q.change_pct ?? liveOverlay?.change_pct ?? null;
              const inSearchMode = debouncedSearch.trim().length > 0;
              const alreadyAdded = managedSegmentName ? addedTokenSet.has(token) : false;
              // Right-edge action button — see desktop InstrumentsPanel
              // for the same context rules. Keeps the mobile row tight:
              // ONE action on the right edge, no star+plus side-by-side.
              let rightAction: React.ReactNode = null;
              if (managedSegmentName) {
                if (inSearchMode && !alreadyAdded) {
                  rightAction = (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        addToSegment(token, q.symbol);
                      }}
                      aria-label={`Add ${q.symbol}`}
                      title={`Add to ${bucket?.label}`}
                      className="grid size-7 shrink-0 place-items-center rounded text-primary hover:bg-primary/10"
                    >
                      <Plus className="size-4" />
                    </button>
                  );
                } else if (inSearchMode && alreadyAdded) {
                  rightAction = (
                    <span
                      title="Already added"
                      className="grid size-7 shrink-0 place-items-center text-[11px] font-bold text-emerald-500"
                    >
                      ✓
                    </span>
                  );
                } else {
                  // Browse mode on a managed Indian segment: pair the
                  // favorites star with the segment-remove X so the user
                  // can favorite a stock and/or remove it from this
                  // segment list, matching the desktop panel.
                  rightAction = (
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFavorite(token);
                        }}
                        aria-label={
                          starred
                            ? `Remove ${q.symbol} from favorites`
                            : `Add ${q.symbol} to favorites`
                        }
                        title={starred ? "Remove from favorites" : "Add to favorites"}
                        className="grid size-7 place-items-center rounded hover:bg-muted/40"
                      >
                        <Star
                          className={cn(
                            "size-4 transition-colors",
                            starred ? "fill-atm text-atm" : "text-muted-foreground",
                          )}
                        />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeFromSegment(token, q.symbol);
                        }}
                        aria-label={`Remove ${q.symbol}`}
                        title={`Remove from ${bucket?.label}`}
                        className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                      >
                        <X className="size-4" />
                      </button>
                    </div>
                  );
                }
              } else if (bucket?.mode === "watchlist" && starred) {
                rightAction = (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFavorite(token);
                    }}
                    aria-label={`Remove ${q.symbol} from favorites`}
                    title="Remove from favorites"
                    className="grid size-7 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                  >
                    <X className="size-4" />
                  </button>
                );
              } else {
                rightAction = (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFavorite(token);
                    }}
                    aria-label={starred ? `Remove ${q.symbol} from favorites` : `Add ${q.symbol} to favorites`}
                    title={starred ? "Remove from favorites" : "Add to favorites"}
                    className="grid size-7 shrink-0 place-items-center rounded hover:bg-muted/40"
                  >
                    <Star
                      className={cn(
                        "size-4 transition-colors",
                        starred ? "fill-atm text-atm" : "text-muted-foreground",
                      )}
                    />
                  </button>
                );
              }
              return (
                <div
                  key={token}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(token)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(token);
                    }
                  }}
                  className={cn(
                    // Right column `auto` so Indian-segment rows fit both
                    // star + X without clipping; single-button rows still
                    // sit flush on the right edge.
                    "grid w-full cursor-pointer grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-border/40 px-3 py-2.5 text-xs transition-colors",
                    isActive ? "bg-primary/10" : "hover:bg-muted/30",
                  )}
                >
                  {/* Symbol + change% + exchange (left, stacked) */}
                  <div className="flex min-w-0 flex-col items-start leading-tight">
                    <span
                      className={cn(
                        "truncate font-semibold text-sm",
                        isActive && "text-primary",
                      )}
                    >
                      {q.symbol}
                    </span>
                    <div className="mt-0.5 flex items-baseline gap-1.5 text-[10px]">
                      {changePct != null ? (
                        <span
                          className={cn(
                            "font-medium tabular-nums",
                            Number(changePct) > 0
                              ? "text-emerald-500"
                              : Number(changePct) < 0
                                ? "text-red-500"
                                : "text-muted-foreground",
                          )}
                        >
                          {Number(changePct) >= 0 ? "+" : ""}
                          {Number(changePct).toFixed(2)}%
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                      {q.exchange && (
                        <span className="truncate uppercase tracking-wider text-muted-foreground">
                          {q.exchange}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Bid (red) over Ask (green) — stacked vertically */}
                  <div className="flex flex-col items-end gap-0.5 leading-tight">
                    <FlashCell
                      value={bid}
                      segment={q.segment}
                      exchange={q.exchange}
                      side="bid"
                    />
                    <FlashCell
                      value={ask}
                      segment={q.segment}
                      exchange={q.exchange}
                      side="ask"
                    />
                  </div>

                  {rightAction}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}


/** Tick-flash cell — bid red / ask green by default, flashes green/red
 *  on tick direction. Rendered inside a clickable row so this is a
 *  `<span>`, not a button. */
function FlashCell({
  value,
  segment,
  exchange,
  side,
}: {
  value: number | null;
  segment?: string;
  exchange?: string;
  side: "bid" | "ask";
}) {
  const dir = usePriceFlash(value);
  const baseColor = side === "bid" ? "text-red-500" : "text-emerald-500";
  const flashColor =
    dir === "up"
      ? "text-emerald-500"
      : dir === "down"
        ? "text-red-500"
        : baseColor;
  return (
    <span
      className={cn(
        "whitespace-nowrap font-tabular tabular-nums text-[11px] font-medium transition-colors",
        flashColor,
      )}
    >
      {value != null ? formatPrice(value, segment, exchange) : "—"}
    </span>
  );
}
