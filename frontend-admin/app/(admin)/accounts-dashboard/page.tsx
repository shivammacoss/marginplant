"use client";

import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import {
  ArrowDownRight, ArrowUpRight, BarChart3, Briefcase, Calendar,
  ChevronRight, Crown, DollarSign, Filter, Loader2, PieChartIcon,
  RefreshCw, TrendingUp, Trophy, UserPlus, Users, X,
} from "lucide-react";
import { AccountsAPI, type AccountEntity, type AccountsSummary } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/common/PageHeader";
import { useAdminAuthStore } from "@/stores/authStore";

const PRESETS = [
  { value: "", label: "All time" },
  { value: "current_week", label: "Current week" },
  { value: "last_week", label: "Last week" },
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
];

const CHART_GREEN = "#10b981";
const CHART_RED = "#ef4444";
const CHART_BLUE = "#3b82f6";
const CHART_YELLOW = "#f59e0b";
const CHART_MUTED = "#6b7280";

// Role-based tab config. Each role sees different scope tabs.
type TabDef = { value: string; label: string; icon: React.ReactNode };

const SUPER_ADMIN_TABS: TabDef[] = [
  { value: "all_users", label: "All Users", icon: <Users className="size-3.5" /> },
  { value: "admins", label: "Admins", icon: <Crown className="size-3.5" /> },
  { value: "brokers", label: "Brokers", icon: <Briefcase className="size-3.5" /> },
  { value: "sub_brokers", label: "Sub-Brokers", icon: <UserPlus className="size-3.5" /> },
];
const ADMIN_TABS: TabDef[] = [
  { value: "all_users", label: "All Users", icon: <Users className="size-3.5" /> },
  { value: "brokers", label: "Brokers", icon: <Briefcase className="size-3.5" /> },
  { value: "sub_brokers", label: "Sub-Brokers", icon: <UserPlus className="size-3.5" /> },
];
const BROKER_TABS: TabDef[] = [
  { value: "all_users", label: "All Users", icon: <Users className="size-3.5" /> },
  { value: "sub_brokers", label: "Sub-Brokers", icon: <UserPlus className="size-3.5" /> },
];

export default function AccountsDashboardPage() {
  const admin = useAdminAuthStore((s) => s.admin);
  const role = admin?.role;
  const tabs = role === "SUPER_ADMIN" ? SUPER_ADMIN_TABS
    : role === "BROKER" ? BROKER_TABS
    : ADMIN_TABS;

  const [scope, setScope] = useState("all_users");
  const [preset, setPreset] = useState<string>("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [search, setSearch] = useState("");

  const { data, isFetching, refetch } = useQuery<AccountsSummary>({
    queryKey: ["admin", "accounts", "summary", scope, preset, fromDate, toDate],
    queryFn: () =>
      AccountsAPI.summary({
        scope,
        preset: preset || undefined,
        from_date: fromDate || undefined,
        to_date: toDate || undefined,
      }),
  });

  const gt = data?.grand_total;
  const entities = (data?.entities ?? []).filter((e) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      (e.name || "").toLowerCase().includes(q) ||
      (e.user_code || "").toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Accounts Dashboard"
        description="Financial overview across all pools"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw className={`size-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
        }
      />

      {/* ── Scope Tabs ──────────────────────────────────────── */}
      <div className="flex gap-1.5">
        {tabs.map((t) => (
          <button
            key={t.value}
            onClick={() => setScope(t.value)}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors ${
              scope === t.value
                ? "bg-primary text-primary-foreground shadow-sm"
                : "bg-card/60 text-muted-foreground hover:bg-card hover:text-foreground border border-border/60"
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Filters ──────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border/60 bg-card/40 p-4">
        <div className="min-w-[200px] flex-1">
          <label className="mb-1 block text-xs text-muted-foreground">Search</label>
          <Input
            placeholder="Search by name or code..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Period</label>
          <select
            value={preset}
            onChange={(e) => {
              setPreset(e.target.value);
              if (e.target.value) { setFromDate(""); setToDate(""); }
            }}
            className="h-10 rounded-md border border-border bg-background px-3 text-sm"
          >
            {PRESETS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">From</label>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => { setFromDate(e.target.value); setPreset(""); }}
            className="h-10 rounded-md border border-border bg-background px-3 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">To</label>
          <input
            type="date"
            value={toDate}
            onChange={(e) => { setToDate(e.target.value); setPreset(""); }}
            className="h-10 rounded-md border border-border bg-background px-3 text-sm"
          />
        </div>
        {(fromDate || toDate || preset) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setPreset(""); setFromDate(""); setToDate(""); }}
          >
            <X className="mr-1 size-3" /> Clear
          </Button>
        )}
      </div>

      {/* ── Animated Summary Tiles ───────────────────────────── */}
      {gt && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
          <SummaryTile
            icon={<ArrowDownRight className="size-4" />}
            label="Deposits"
            value={gt.deposits}
            color="text-emerald-400"
            prefix="₹"
          />
          <SummaryTile
            icon={<ArrowUpRight className="size-4" />}
            label="Withdrawals"
            value={gt.withdrawals}
            color="text-orange-400"
            prefix="₹"
          />
          <SummaryTile
            icon={<TrendingUp className="size-4" />}
            label="Net P&L"
            value={gt.net_pnl}
            color={gt.net_pnl >= 0 ? "text-emerald-400" : "text-destructive"}
            prefix="₹"
            showSign
          />
          <SummaryTile
            icon={<DollarSign className="size-4" />}
            label="Brokerage"
            value={gt.brokerage}
            color="text-blue-400"
            prefix="₹"
          />
          <SummaryTile
            icon={<Trophy className="size-4" />}
            label="Win Rate"
            value={gt.win_rate}
            color={gt.win_rate >= 50 ? "text-emerald-400" : "text-destructive"}
            suffix="%"
            decimals={1}
          />
        </div>
      )}

      {/* ── Charts Row ───────────────────────────────────────── */}
      {gt && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* Deposits vs Withdrawals Bar */}
          <ChartCard title="Deposits vs Withdrawals" icon={<BarChart3 className="size-4" />}>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={entities.map((e) => ({
                name: (e.name || "").slice(0, 12),
                Deposits: e.deposits,
                Withdrawals: e.withdrawals,
              }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                <XAxis dataKey="name" tick={{ fill: "#888", fontSize: 11 }} />
                <YAxis tick={{ fill: "#888", fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 8 }}
                  labelStyle={{ color: "#ccc" }}
                />
                <Bar dataKey="Deposits" fill={CHART_GREEN} radius={[4, 4, 0, 0]} animationDuration={1000} />
                <Bar dataKey="Withdrawals" fill={CHART_RED} radius={[4, 4, 0, 0]} animationDuration={1200} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Win/Loss Donut */}
          <ChartCard title="Win / Loss Ratio" icon={<PieChartIcon className="size-4" />}>
            <div className="flex items-center justify-center">
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={[
                      { name: "Wins", value: gt.profit_trades },
                      { name: "Losses", value: gt.loss_trades },
                    ]}
                    cx="50%"
                    cy="50%"
                    innerRadius={55}
                    outerRadius={85}
                    paddingAngle={3}
                    dataKey="value"
                    animationDuration={1200}
                    animationBegin={200}
                  >
                    <Cell fill={CHART_GREEN} />
                    <Cell fill={CHART_RED} />
                  </Pie>
                  <Tooltip
                    contentStyle={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 8 }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute flex flex-col items-center">
                <span className="text-2xl font-bold">{gt.win_rate}%</span>
                <span className="text-[10px] text-muted-foreground">WIN RATE</span>
              </div>
            </div>
            <div className="flex justify-center gap-6 text-xs">
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
                Wins: {gt.profit_trades}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-destructive" />
                Losses: {gt.loss_trades}
              </span>
            </div>
          </ChartCard>

          {/* P&L per Entity Bar */}
          <ChartCard title="P&L per Pool" icon={<TrendingUp className="size-4" />}>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={entities.map((e) => ({
                name: (e.name || "").slice(0, 12),
                PnL: e.net_pnl,
              }))} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                <XAxis type="number" tick={{ fill: "#888", fontSize: 11 }} />
                <YAxis dataKey="name" type="category" width={90} tick={{ fill: "#888", fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 8 }}
                  formatter={(v) => [`₹${Number(v ?? 0).toLocaleString("en-IN")}`, "P&L"]}
                />
                <Bar dataKey="PnL" animationDuration={1000}>
                  {entities.map((e, i) => (
                    <Cell key={i} fill={e.net_pnl >= 0 ? CHART_GREEN : CHART_RED} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Brokerage per Entity */}
          <ChartCard title="Brokerage Revenue" icon={<DollarSign className="size-4" />}>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={entities.map((e) => ({
                name: (e.name || "").slice(0, 12),
                Brokerage: e.brokerage,
              }))} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                <XAxis type="number" tick={{ fill: "#888", fontSize: 11 }} />
                <YAxis dataKey="name" type="category" width={90} tick={{ fill: "#888", fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 8 }}
                  formatter={(v) => [`₹${Number(v ?? 0).toLocaleString("en-IN")}`, "Brokerage"]}
                />
                <Bar dataKey="Brokerage" fill={CHART_BLUE} radius={[0, 4, 4, 0]} animationDuration={1000} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
      )}

      {/* ── Entity Cards ─────────────────────────────────────── */}
      {isFetching && !data && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      )}

      <div className="space-y-3">
        {entities.map((entity) => (
          <EntityCard key={entity.id} entity={entity} />
        ))}
        {entities.length === 0 && data && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No entities found.
          </div>
        )}
      </div>

      {data && (
        <div className="text-xs text-muted-foreground">
          {data.filter.is_lifetime
            ? "Showing lifetime totals"
            : `Filtered: ${data.filter.preset || `${data.filter.from_date} to ${data.filter.to_date}`}`}
          {" · "}
          {entities.length} entities · {gt?.user_count ?? 0} total users
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────── */
/* Sub-components                                                   */
/* ─────────────────────────────────────────────────────────────── */

function SummaryTile({
  icon, label, value, color, prefix, suffix, showSign, decimals = 2,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  color: string;
  prefix?: string;
  suffix?: string;
  showSign?: boolean;
  decimals?: number;
}) {
  const display = useAnimatedNumber(value, decimals);
  const sign = showSign && value > 0 ? "+" : showSign && value < 0 ? "" : "";
  return (
    <div className="rounded-lg border border-border/60 bg-card/40 p-4 transition-all hover:border-border">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className={`mt-2 text-xl font-bold tabular-nums ${color}`}>
        {sign}{prefix}{display}{suffix}
      </div>
    </div>
  );
}

function ChartCard({ title, icon, children }: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="relative overflow-hidden rounded-lg border border-border/60 bg-card/40 p-4">
      <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}

function EntityCard({ entity: e }: { entity: AccountEntity }) {
  const [expanded, setExpanded] = useState(false);

  const roleBadge =
    e.role === "ADMIN" ? "bg-blue-500/15 text-blue-300 border-blue-500/30" :
    e.role === "BROKER" ? "bg-purple-500/15 text-purple-300 border-purple-500/30" :
    e.role === "SUPER_ADMIN_DIRECT" ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" :
    "bg-muted/30 text-muted-foreground border-border";

  const roleLabel =
    e.role === "SUPER_ADMIN_DIRECT" ? "DIRECT" :
    e.role === "DIRECT" ? "DIRECT USERS" :
    e.role;

  return (
    <div
      className="cursor-pointer rounded-lg border border-border/60 bg-card/40 transition-all hover:border-border"
      onClick={() => setExpanded((v) => !v)}
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <Users className="size-4 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">{e.name}</span>
            <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-medium uppercase ${roleBadge}`}>
              {roleLabel}
            </span>
            {e.user_code && (
              <span className="text-[10px] text-muted-foreground">{e.user_code}</span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
            <span>{e.user_count} users</span>
            {e.broker_count != null && e.broker_count > 0 && (
              <span>{e.broker_count} brokers</span>
            )}
          </div>
        </div>
        <ChevronRight className={`size-4 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`} />
      </div>

      {/* Metrics Grid (always visible — summary row) */}
      <div className="grid grid-cols-3 gap-px border-t border-border/60 bg-border/40 md:grid-cols-4 lg:grid-cols-8">
        <MetricCell label="Deposits" value={e.deposits} prefix="₹" />
        <MetricCell label="Withdrawals" value={e.withdrawals} prefix="₹" />
        <MetricCell label="Net P&L" value={e.net_pnl} prefix="₹" pnl />
        <MetricCell label="Brokerage" value={e.brokerage} prefix="₹" />
        <MetricCell label="Trades" value={e.total_trades} />
        <MetricCell
          label="Win/Loss"
          custom={
            <span className="text-xs font-semibold">
              <span className="text-emerald-400">{e.profit_trades}</span>
              <span className="text-muted-foreground"> / </span>
              <span className="text-destructive">{e.loss_trades}</span>
            </span>
          }
        />
        <MetricCell label="Win Rate" value={e.win_rate} suffix="%" pnl decimals={1} threshold={50} />
        <MetricCell label="Balance" value={e.balance} prefix="₹" />
      </div>

      {/* Expanded detail row */}
      {expanded && (
        <div className="grid grid-cols-3 gap-px border-t border-border/60 bg-border/40 md:grid-cols-4 lg:grid-cols-6">
          <MetricCell label="Equity" value={e.equity} prefix="₹" pnl />
          <MetricCell label="Unrealized" value={e.unrealized_pnl} prefix="₹" pnl />
          <MetricCell label="Volume" value={e.volume} prefix="₹" />
          <MetricCell label="Open Pos." value={e.open_positions} />
          <MetricCell label="Net Deposit" value={e.net_deposit} prefix="₹" />
          <MetricCell label="Settlement" value={e.settlement_outstanding} prefix="₹" danger />
        </div>
      )}
    </div>
  );
}

function MetricCell({
  label, value, prefix, suffix, pnl, danger, decimals = 2, custom, threshold = 0,
}: {
  label: string;
  value?: number;
  prefix?: string;
  suffix?: string;
  pnl?: boolean;
  danger?: boolean;
  decimals?: number;
  custom?: React.ReactNode;
  threshold?: number;
}) {
  const v = value ?? 0;
  const colorClass = danger && v > 0
    ? "text-destructive"
    : pnl
      ? v > threshold ? "text-emerald-400" : v < threshold ? "text-destructive" : "text-foreground/90"
      : "text-foreground/90";

  const formatted = custom ?? (
    <span className={`text-xs font-semibold tabular-nums ${colorClass}`}>
      {pnl && v > 0 ? "+" : ""}
      {prefix}
      {Math.abs(v).toLocaleString("en-IN", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}
      {suffix}
    </span>
  );

  return (
    <div className="bg-card/40 px-3 py-2.5">
      <div className="text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5">{formatted}</div>
    </div>
  );
}

/* ── Animated number counter hook ──────────────────────────────── */
function useAnimatedNumber(target: number, decimals: number = 2): string {
  const [display, setDisplay] = useState(0);
  const frameRef = useRef<number>(0);

  useEffect(() => {
    const duration = 1200;
    const start = display;
    const diff = target - start;
    const startTime = performance.now();

    function animate(now: number) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(start + diff * eased);
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(animate);
      }
    }

    frameRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frameRef.current);
  }, [target]);

  return Math.abs(display).toLocaleString("en-IN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
