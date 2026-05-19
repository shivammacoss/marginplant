"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { UsersAPI } from "@/lib/api";

interface Props {
  open: boolean;
  onClose: () => void;
  user:
    | { id: string; user_code?: string; full_name?: string }
    | null;
}

function formatINR(v: unknown): string {
  const n = Number(v ?? 0);
  return `₹${n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function LiveStatsSheet({ open, onClose, user }: Props) {
  const { data: stats, isLoading } = useQuery<any>({
    queryKey: ["admin", "users", "live-stats", user?.id],
    queryFn: () => UsersAPI.liveTradeStats(user!.id),
    enabled: !!user && open,
    // Live refresh every 3s while sheet is open
    refetchInterval: 3000,
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Live stats — {user?.full_name || user?.user_code || ""}
          </DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading...</div>
        ) : !stats ? (
          <div className="text-sm text-muted-foreground">No data</div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat
                label="Open positions"
                value={String(stats.open_positions?.length ?? 0)}
              />
              <Stat
                label="Floating P&L"
                value={formatINR(stats.floating_pnl)}
                tone={
                  Number(stats.floating_pnl ?? 0) >= 0 ? "profit" : "loss"
                }
              />
              <Stat
                label="Equity"
                value={formatINR(stats.equity)}
              />
              <Stat
                label="Available balance"
                value={formatINR(stats.available_balance)}
              />
              <Stat
                label="Margin used"
                value={formatINR(stats.margin_used)}
              />
              <Stat
                label="Credit limit"
                value={formatINR(stats.credit_limit)}
              />
              <Stat
                label="CF total (EOD)"
                value={formatINR(stats.cf_total_eod)}
              />
              <Stat
                label="CF extra needed"
                value={formatINR(stats.cf_extra_needed)}
                tone={
                  Number(stats.cf_extra_needed ?? 0) > 0 ? "loss" : undefined
                }
              />
              <Stat
                label="USD/INR"
                value={
                  stats.usd_inr_rate != null
                    ? Number(stats.usd_inr_rate).toFixed(4)
                    : "—"
                }
              />
              <Stat
                label="Weekly net P&L"
                value={formatINR(stats.weekly_net_pnl)}
                tone={
                  Number(stats.weekly_net_pnl ?? 0) >= 0 ? "profit" : "loss"
                }
              />
              <Stat
                label="Weekly trades"
                value={`${stats.weekly_trades ?? 0} (W ${stats.weekly_wins ?? 0} / L ${stats.weekly_losses ?? 0})`}
              />
              <Stat
                label="All-time P&L"
                value={formatINR(stats.closed_pnl_all_time)}
                tone={
                  Number(stats.closed_pnl_all_time ?? 0) >= 0
                    ? "profit"
                    : "loss"
                }
              />
              <Stat
                label="All-time trades"
                value={`${stats.all_time_trades ?? 0} (W ${stats.all_time_wins ?? 0} / L ${stats.all_time_losses ?? 0})`}
              />
            </div>

            {Array.isArray(stats.open_positions) &&
              stats.open_positions.length > 0 && (
                <div className="mt-4">
                  <div className="text-xs text-muted-foreground uppercase tracking-wider mb-2">
                    Open positions
                  </div>
                  <div className="space-y-1 max-h-[35vh] overflow-y-auto pr-1">
                    {stats.open_positions.map((p: any, idx: number) => {
                      const pnl = Number(p.unrealized_pnl_inr ?? 0);
                      return (
                        <div
                          key={`${p.instrument_token}-${idx}`}
                          className="flex items-center justify-between rounded-md border border-border p-2 text-sm"
                        >
                          <div className="flex flex-col leading-tight min-w-0">
                            <span className="font-medium truncate">
                              {p.symbol}
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              {p.exchange} · {p.segment} · {p.product_type} ·{" "}
                              qty {p.quantity}
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              avg {Number(p.avg_price ?? 0).toFixed(2)} · ltp{" "}
                              {Number(p.ltp ?? 0).toFixed(2)}
                            </span>
                          </div>
                          <div
                            className={
                              pnl >= 0
                                ? "font-mono font-semibold text-[#10b981] shrink-0"
                                : "font-mono font-semibold text-[#ef4444] shrink-0"
                            }
                          >
                            {formatINR(pnl)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "profit" | "loss";
}) {
  const cls =
    tone === "profit"
      ? "text-[#10b981]"
      : tone === "loss"
        ? "text-[#ef4444]"
        : "";
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className={`font-mono text-base font-semibold mt-1 ${cls}`}>
        {value}
      </div>
    </div>
  );
}
