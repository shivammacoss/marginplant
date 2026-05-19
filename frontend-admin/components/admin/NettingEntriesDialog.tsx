"use client";

import { useQuery } from "@tanstack/react-query";
import { TradingAPI } from "@/lib/api";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn, formatINR } from "@/lib/utils";

interface Props {
  /** Position id to drill into. Setting to null closes the dialog. */
  positionId: string | null;
  onClose: () => void;
}

interface NettingEntry {
  row: number;
  type: "Entry" | "Exit";
  side: "BUY" | "SELL";
  executed_at: string | null;
  volume: number;
  price: number;
  pnl_inr: number | null;
}

interface NettingPayload {
  position_id: string;
  symbol: string;
  exchange: string;
  token: string;
  status: string;
  side: "BUY" | "SELL";
  volume: number;
  avg_entry: number;
  current_price: number;
  total_pnl: number;
  avg_calc_formula: string;
  entries: NettingEntry[];
}

function pnlClass(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  if (v > 0) return "text-emerald-500";
  if (v < 0) return "text-red-500";
  return "text-foreground";
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  // "15 May, 09:59 am" — matches the mockup the user shared.
  const date = d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  const time = d
    .toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true })
    .toLowerCase();
  return `${date}, ${time}`;
}

export function NettingEntriesDialog({ positionId, onClose }: Props) {
  const { data, isLoading, error } = useQuery<NettingPayload>({
    queryKey: ["admin", "position-netting", positionId],
    queryFn: () => TradingAPI.positionNetting(positionId!),
    enabled: !!positionId,
    // Re-poll while OPEN positions are visible so the Current price + Total
    // P/L tile stay live with the WS feed. CLOSED positions don't change.
    refetchInterval: (q) =>
      q.state.data?.status === "OPEN" ? 3000 : false,
    staleTime: 1500,
    refetchOnWindowFocus: false,
  });

  return (
    <Dialog open={!!positionId} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl p-0">
        <DialogHeader className="px-5 pb-3 pt-5">
          <DialogTitle className="text-base font-semibold">
            Netting Entries — {data?.exchange || "—"}{" "}
            <span className="text-muted-foreground font-normal">
              ({data?.token || ""})
            </span>
          </DialogTitle>
        </DialogHeader>

        {isLoading && !data && (
          <div className="grid h-32 place-items-center text-sm text-muted-foreground">
            Loading…
          </div>
        )}
        {error && (
          <div className="mx-5 mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {(error as any)?.message || "Failed to load netting entries"}
          </div>
        )}

        {data && (
          <div className="px-5 pb-5">
            {/* Header summary tile — mirrors the user's mockup exactly. */}
            <div className="mb-3 rounded-md border border-border bg-muted/10 px-4 py-3">
              <div className="grid grid-cols-2 gap-y-2 sm:grid-cols-5">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Side
                  </div>
                  <div
                    className={cn(
                      "mt-0.5 text-sm font-semibold",
                      data.side === "BUY" ? "text-emerald-500" : "text-red-500"
                    )}
                  >
                    {data.side}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Volume
                  </div>
                  <div className="mt-0.5 text-sm font-semibold tabular-nums">
                    {data.volume}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Avg Entry
                  </div>
                  <div className="mt-0.5 text-sm font-semibold tabular-nums">
                    ₹{data.avg_entry.toFixed(2)}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Current
                  </div>
                  <div className="mt-0.5 text-sm font-semibold tabular-nums">
                    ₹{data.current_price.toFixed(2)}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Total P/L
                  </div>
                  <div
                    className={cn(
                      "mt-0.5 text-sm font-semibold tabular-nums",
                      pnlClass(data.total_pnl)
                    )}
                  >
                    {formatINR(data.total_pnl)}
                  </div>
                </div>
              </div>
            </div>

            {/* Per-fill table */}
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="min-w-full text-xs">
                <thead className="bg-muted/30 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">#</th>
                    <th className="px-3 py-2 text-left">Type</th>
                    <th className="px-3 py-2 text-left">Side</th>
                    <th className="px-3 py-2 text-left">Time</th>
                    <th className="px-3 py-2 text-right">Volume</th>
                    <th className="px-3 py-2 text-right">Price</th>
                    <th className="px-3 py-2 text-right">P/L</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.entries.length === 0 ? (
                    <tr>
                      <td
                        colSpan={7}
                        className="px-3 py-6 text-center text-muted-foreground"
                      >
                        No fills recorded for this position.
                      </td>
                    </tr>
                  ) : (
                    data.entries.map((e) => (
                      <tr key={e.row}>
                        <td className="px-3 py-2 tabular-nums">{e.row}</td>
                        <td
                          className={cn(
                            "px-3 py-2 font-medium",
                            e.type === "Entry"
                              ? "text-emerald-500"
                              : "text-red-500"
                          )}
                        >
                          {e.type}
                        </td>
                        <td
                          className={cn(
                            "px-3 py-2 font-semibold",
                            e.side === "BUY"
                              ? "text-emerald-500"
                              : "text-red-500"
                          )}
                        >
                          {e.side}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {fmtTime(e.executed_at)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {e.volume}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          ₹{e.price.toFixed(2)}
                        </td>
                        <td
                          className={cn(
                            "px-3 py-2 text-right tabular-nums",
                            pnlClass(e.pnl_inr)
                          )}
                        >
                          {e.pnl_inr == null ? "—" : formatINR(e.pnl_inr)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Avg Price Calculation formula — only shown when we have Entry
                fills to compose it from. Wrapped + horizontally scrollable
                so a 30-leg position doesn't overflow the dialog. */}
            {data.entries.some((e) => e.type === "Entry") && (
              <div className="mt-3 rounded-md border border-border bg-muted/10 px-3 py-2 text-[11px] leading-relaxed">
                <span className="font-medium text-amber-500">
                  Avg Price Calculation:
                </span>{" "}
                <span className="break-words text-foreground/90">
                  {data.avg_calc_formula}
                </span>
              </div>
            )}

            <div className="mt-4 flex justify-end">
              <Button variant="outline" size="sm" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
