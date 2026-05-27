"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpToLine,
  Banknote,
  CircleDollarSign,
  ListOrdered,
  ShieldAlert,
  TrendingUp,
  Users,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DashboardAPI } from "@/lib/api";
import { formatINR, formatINRCompact, formatNumber, pnlColor } from "@/lib/utils";
import { PageHeader } from "@/components/common/PageHeader";
import { readDashboardSnapshot, writeDashboardSnapshot } from "@/lib/dashboardSnapshot";

/**
 * Tile palette. Each tone maps to:
 *   - card: soft gradient bg + tinted ring (replaces the default flat
 *     border so each tile has its own personality but the wall of
 *     tiles still reads as one harmonious set)
 *   - badge: filled icon chip in the top-right
 *   - icon: stroke color inside the badge
 *   - value: number color so the headline matches its tile family
 *
 * Tones use Tailwind palette suffixes that work in both light + dark
 * mode (the project ships both themes).
 */
type ToneKey = "emerald" | "sky" | "violet" | "amber" | "rose" | "indigo";
const TONES: Record<ToneKey, { card: string; badge: string; icon: string; value: string }> = {
  emerald: {
    card: "bg-gradient-to-br from-emerald-50 via-card to-card ring-1 ring-emerald-500/20 hover:ring-emerald-500/40 dark:from-emerald-500/10",
    badge: "bg-emerald-500/15",
    icon: "text-emerald-600 dark:text-emerald-400",
    value: "text-emerald-700 dark:text-emerald-300",
  },
  sky: {
    card: "bg-gradient-to-br from-sky-50 via-card to-card ring-1 ring-sky-500/20 hover:ring-sky-500/40 dark:from-sky-500/10",
    badge: "bg-sky-500/15",
    icon: "text-sky-600 dark:text-sky-400",
    value: "text-sky-700 dark:text-sky-300",
  },
  violet: {
    card: "bg-gradient-to-br from-violet-50 via-card to-card ring-1 ring-violet-500/20 hover:ring-violet-500/40 dark:from-violet-500/10",
    badge: "bg-violet-500/15",
    icon: "text-violet-600 dark:text-violet-400",
    value: "text-violet-700 dark:text-violet-300",
  },
  amber: {
    card: "bg-gradient-to-br from-amber-50 via-card to-card ring-1 ring-amber-500/20 hover:ring-amber-500/40 dark:from-amber-500/10",
    badge: "bg-amber-500/15",
    icon: "text-amber-600 dark:text-amber-400",
    value: "text-amber-700 dark:text-amber-300",
  },
  rose: {
    card: "bg-gradient-to-br from-rose-50 via-card to-card ring-1 ring-rose-500/20 hover:ring-rose-500/40 dark:from-rose-500/10",
    badge: "bg-rose-500/15",
    icon: "text-rose-600 dark:text-rose-400",
    value: "text-rose-700 dark:text-rose-300",
  },
  indigo: {
    card: "bg-gradient-to-br from-indigo-50 via-card to-card ring-1 ring-indigo-500/20 hover:ring-indigo-500/40 dark:from-indigo-500/10",
    badge: "bg-indigo-500/15",
    icon: "text-indigo-600 dark:text-indigo-400",
    value: "text-indigo-700 dark:text-indigo-300",
  },
};

export default function AdminDashboardPage() {
  // Initial render uses the last-known dashboard snapshot from localStorage
  // so the 10 stat cards never flash "0" between login and the first
  // /admin/dashboard/stats response. We persist on every successful fetch.
  const { data: stats } = useQuery({
    queryKey: ["admin", "dashboard", "stats"],
    queryFn: async () => {
      const s = await DashboardAPI.stats();
      writeDashboardSnapshot(s);
      return s;
    },
    refetchInterval: 10_000,
    placeholderData: () => readDashboardSnapshot(),
  });
  const { data: alerts } = useQuery({
    queryKey: ["admin", "dashboard", "alerts"],
    queryFn: () => DashboardAPI.riskAlerts(),
    refetchInterval: 15_000,
  });

  // When stats is undefined (no snapshot, no fetch yet) render an em-dash
  // instead of "0" so the admin doesn't briefly think every metric is zero.
  const ready = !!stats;
  const num = (v: number | null | undefined): string => (ready ? formatNumber(v ?? 0) : "—");
  // Compact Indian-style K/L/Cr formatting on the tiles — a 200 px card
  // couldn't fit ₹7,42,50,67,910.40, which was wrapping onto a second line
  // and overlapping the icon. Risk-monitor table further down still uses
  // the full `formatINR` because it has its own column width budget.
  const inr = (v: number | null | undefined): string => (ready ? formatINRCompact(v) : "₹ —");

  // Each tile gets a `tone` to drive a soft gradient + coloured icon
  // badge. We keep the palette deliberately tasteful: an emerald house
  // accent on people / money inflow cards, blue on activity, amber on
  // money outflow / pending work, rose for withdrawals. Pure UI flair,
  // no business logic changes.
  const cards: Array<{
    label: string;
    value: string;
    hint?: string;
    icon: any;
    title?: string;
    tone: ToneKey;
  }> = [
    { label: "Total users", value: num(stats?.users?.total), hint: "All roles", icon: Users, tone: "indigo" },
    { label: "Active today", value: num(stats?.users?.active_today), hint: "Last 24h", icon: Activity, tone: "sky" },
    { label: "Wallet balance", value: inr(stats?.money?.wallet_balance_total), title: formatINR(stats?.money?.wallet_balance_total), hint: "All users", icon: CircleDollarSign, tone: "emerald" },
    { label: "Margin used", value: inr(stats?.money?.margin_used_total), title: formatINR(stats?.money?.margin_used_total), hint: "Locked in trades", icon: Banknote, tone: "amber" },
    { label: "Today's volume", value: inr(stats?.trading?.today_volume), title: formatINR(stats?.trading?.today_volume), hint: "Turnover", icon: TrendingUp, tone: "violet" },
    { label: "Today's revenue", value: inr(stats?.trading?.today_revenue), title: formatINR(stats?.trading?.today_revenue), hint: "Brokerage", icon: Banknote, tone: "emerald" },
    { label: "Open positions", value: num(stats?.trading?.open_positions), hint: "Across users", icon: ListOrdered, tone: "sky" },
    { label: "Pending orders", value: num(stats?.trading?.pending_orders), hint: "Awaiting fill", icon: ListOrdered, tone: "amber" },
    { label: "Pending deposits", value: num(stats?.approvals?.pending_deposits), hint: "Approve in Money → Deposits", icon: ArrowDownToLine, tone: "emerald" },
    { label: "Pending withdrawals", value: num(stats?.approvals?.pending_withdrawals), hint: "Approve in Money → Withdrawals", icon: ArrowUpToLine, tone: "rose" },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="Operations dashboard" description="Live metrics, refreshing every 10 seconds." />

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {cards.map((c) => {
          const Icon = c.icon;
          const t = TONES[c.tone];
          return (
            <Card
              key={c.label}
              className={`group relative overflow-hidden border-0 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg ${t.card}`}
            >
              {/* Decorative blurred halo behind the icon — gives the
                  tile depth without resorting to heavy 3-D shadows. */}
              <span
                className={`pointer-events-none absolute -right-6 -top-6 h-20 w-20 rounded-full opacity-50 blur-2xl ${t.badge}`}
                aria-hidden
              />
              <CardHeader className="relative z-[1] flex flex-row items-start justify-between gap-2 pb-2">
                <CardDescription className="font-medium text-foreground/70">
                  {c.label}
                </CardDescription>
                <span
                  className={`inline-flex size-8 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ring-border/40 ${t.badge}`}
                  aria-hidden
                >
                  <Icon className={`size-4 ${t.icon}`} />
                </span>
              </CardHeader>
              <CardContent className="relative z-[1] space-y-1">
                <div
                  className={`font-tabular text-xl font-bold tracking-tight sm:text-2xl ${t.value}`}
                  title={(c as { title?: string }).title}
                >
                  {c.value}
                </div>
                {c.hint && (
                  <div className="text-[11px] text-muted-foreground">
                    {c.hint}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Risk monitor</CardTitle>
            <CardDescription>Users with high MTM-to-margin ratio. Refreshing every 15 s.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            {!alerts || alerts.length === 0 ? (
              <div className="flex items-center gap-2 rounded-md border border-dashed border-border p-6 text-muted-foreground">
                <ShieldAlert className="size-4" /> No risk alerts at the moment.
              </div>
            ) : (
              <div className="-mx-2 overflow-x-auto scrollbar-thin">
              <table className="w-full min-w-[560px] text-xs">
                <thead className="border-b border-border text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 text-left">User</th>
                    <th className="px-2 py-1.5 text-right">Open positions</th>
                    <th className="px-2 py-1.5 text-right">Margin used</th>
                    <th className="px-2 py-1.5 text-right">Unrealized</th>
                    <th className="px-2 py-1.5 text-right">MTM ratio</th>
                    <th className="px-2 py-1.5 text-right">Level</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {alerts.map((a: any) => (
                    <tr key={a.user_id}>
                      <td className="px-2 py-1.5 font-mono text-[10px]">{a.user_id.slice(-10)}</td>
                      <td className="px-2 py-1.5 text-right">{a.open_positions}</td>
                      <td className="px-2 py-1.5 text-right">{formatINR(a.margin_used)}</td>
                      <td className={`px-2 py-1.5 text-right ${pnlColor(a.unrealized_pnl)}`}>
                        {formatINR(a.unrealized_pnl)}
                      </td>
                      <td className="px-2 py-1.5 text-right">{a.mtm_ratio_pct}%</td>
                      <td className="px-2 py-1.5 text-right">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] ${
                            a.level === "DANGER" ? "bg-destructive/15 text-destructive" : "bg-amber-500/15 text-amber-400"
                          }`}
                        >
                          {a.level}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>System health</CardTitle>
            <CardDescription>Live checks</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="API" value="OK" ok />
            <Row label="Database" value={stats?.system?.db ? "OK" : "DOWN"} ok={!!stats?.system?.db} />
            <Row label="Redis" value={stats?.system?.redis ? "OK" : "DOWN"} ok={!!stats?.system?.redis} />
            <Row label="Market data feed" value="MOCK" ok />
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function Row({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-md border border-border bg-muted/20 px-3 py-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono text-xs ${ok ? "text-primary" : "text-destructive"}`}>{value}</span>
    </div>
  );
}
