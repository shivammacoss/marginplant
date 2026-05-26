"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import {
  ArrowDownRight, ArrowUpRight, BarChart3, Briefcase, Calendar,
  ChevronDown, ChevronRight, Crown, DollarSign, Download,
  FileSpreadsheet, FileText, Filter, Loader2, PieChartIcon,
  RefreshCw, Search, TrendingUp, Trophy, UserPlus, Users, X,
} from "lucide-react";
import {
  AccountsAPI,
  type AccountEntity,
  type AccountsSummary,
  type BrokerTotals,
  type EntityUserRow,
  type EntityUsersResponse,
  type WeekOption,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/common/PageHeader";
import { useAdminAuthStore } from "@/stores/authStore";

const CHART_GREEN = "#10b981";
const CHART_RED = "#ef4444";
const CHART_BLUE = "#3b82f6";

type TabDef = { value: string; label: string; icon: React.ReactNode };

const SUPER_ADMIN_TABS: TabDef[] = [
  { value: "all_users", label: "All Users", icon: <Users className="size-3.5" /> },
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

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadCSV(entities: AccountEntity[], grandTotal?: AccountEntity) {
  const rows = grandTotal ? [{ ...grandTotal, name: "GRAND TOTAL", role: "TOTAL" }, ...entities] : entities;
  if (!rows.length) return;
  const headers = [
    "Name", "Role", "Users", "Deposits", "Withdrawals", "Net Deposit",
    "Realized P&L", "Unrealized P&L", "Net P&L", "Brokerage",
    "Total Trades", "Profit Trades", "Loss Trades", "Win Rate %",
    "Volume", "Balance", "Equity", "Open Positions", "Settlement",
  ];
  const csvRows = [
    headers.join(","),
    ...rows.map((e) =>
      [
        `"${e.name || ""}"`, e.role, e.user_count, e.deposits, e.withdrawals,
        e.net_deposit, e.realized_pnl, e.unrealized_pnl, e.net_pnl,
        e.brokerage, e.total_trades, e.profit_trades, e.loss_trades,
        e.win_rate, e.volume, e.balance, e.equity, e.open_positions,
        e.settlement_outstanding,
      ].join(",")
    ),
  ];
  const blob = new Blob([csvRows.join("\n")], { type: "text/csv" });
  downloadBlob(blob, `accounts_${new Date().toISOString().slice(0, 10)}.csv`);
}

/* ═══════════════════════════════════════════════════════════════════ */
/* Main Page                                                          */
/* ═══════════════════════════════════════════════════════════════════ */

export default function AccountsDashboardPage() {
  const admin = useAdminAuthStore((s) => s.admin);
  const role = admin?.role;
  const tabs = role === "SUPER_ADMIN" ? SUPER_ADMIN_TABS
    : role === "BROKER" ? BROKER_TABS
    : ADMIN_TABS;

  const [scope, setScope] = useState("all_users");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [selectedWeek, setSelectedWeek] = useState("");
  const [search, setSearch] = useState("");

  const dateParams = {
    from_date: fromDate || undefined,
    to_date: toDate || undefined,
  };

  const { data: weeks } = useQuery<WeekOption[]>({
    queryKey: ["admin", "accounts", "weeks"],
    queryFn: () => AccountsAPI.weeks(16),
    staleTime: 24 * 60 * 60 * 1000,
  });

  const { data, isFetching, refetch } = useQuery<AccountsSummary>({
    queryKey: ["admin", "accounts", "summary", scope, fromDate, toDate],
    queryFn: () =>
      AccountsAPI.summary({
        scope,
        from_date: fromDate || undefined,
        to_date: toDate || undefined,
      }),
  });

  const handleWeekChange = (val: string) => {
    setSelectedWeek(val);
    if (!val) { setFromDate(""); setToDate(""); return; }
    const w = weeks?.find((w) => w.label === val);
    if (w) { setFromDate(w.start); setToDate(w.end); }
  };

  const handleClear = () => {
    setSelectedWeek("");
    setFromDate("");
    setToDate("");
  };

  const gt = data?.grand_total;
  const entities = (data?.entities ?? []).filter((e) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      (e.name || "").toLowerCase().includes(q) ||
      (e.user_code || "").toLowerCase().includes(q)
    );
  });

  const isBrokerScope = scope === "brokers" || scope === "sub_brokers";

  return (
    <div className="space-y-5">
      <PageHeader
        title="Accounts"
        description="Manage and analyze account data and performance"
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => downloadCSV(entities, data?.grand_total)}
              disabled={!data}
            >
              <Download className="size-4 mr-1" /> CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              <RefreshCw className={`size-4 ${isFetching ? "animate-spin" : ""}`} />
            </Button>
          </div>
        }
      />

      {/* ── Search ────────────────────────────────────────── */}
      <div className="rounded-lg border border-border/60 bg-card/40 p-3">
        <label className="mb-1 block text-xs text-muted-foreground">Search</label>
        <Input
          placeholder="Search by user ID..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* ── Scope Tabs ────────────────────────────────────── */}
      <div className="flex gap-1.5">
        {tabs.map((t) => (
          <button
            key={t.value}
            onClick={() => setScope(t.value)}
            className={`inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-semibold transition-colors ${
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

      {/* ── Date Filters ──────────────────────────────────── */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border/60 bg-card/40 p-4">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">From Date</label>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => { setFromDate(e.target.value); setSelectedWeek(""); }}
            className="h-10 rounded-md border border-border bg-background px-3 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">To Date</label>
          <input
            type="date"
            value={toDate}
            onChange={(e) => { setToDate(e.target.value); setSelectedWeek(""); }}
            className="h-10 rounded-md border border-border bg-background px-3 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Select Week</label>
          <select
            value={selectedWeek}
            onChange={(e) => handleWeekChange(e.target.value)}
            className="h-10 rounded-md border border-border bg-background px-3 text-sm min-w-[180px]"
          >
            <option value="">Current Week</option>
            {weeks?.map((w) => (
              <option key={w.label} value={w.label}>{w.label}</option>
            ))}
          </select>
        </div>
        <Button
          size="sm"
          className="h-10 bg-primary text-primary-foreground"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <RefreshCw className={`size-4 mr-1 ${isFetching ? "animate-spin" : ""}`} />
          Fetch Data
        </Button>
        {(fromDate || toDate || selectedWeek) && (
          <Button variant="ghost" size="sm" className="h-10" onClick={handleClear}>
            <X className="mr-1 size-3" /> Clear Filters
          </Button>
        )}
      </div>

      {/* ── Summary Tiles ─────────────────────────────────── */}
      {gt && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <SummaryTile icon={<Users className="size-4" />} label="Total Users" value={gt.user_count ?? 0} color="text-purple-400" decimals={0} />
          <SummaryTile icon={<ArrowDownRight className="size-4" />} label="Deposits" value={gt.deposits} color="text-emerald-400" prefix="₹" />
          <SummaryTile icon={<ArrowUpRight className="size-4" />} label="Withdrawals" value={gt.withdrawals} color="text-orange-400" prefix="₹" />
          <SummaryTile icon={<TrendingUp className="size-4" />} label="Net P&L" value={gt.net_pnl} color={gt.net_pnl >= 0 ? "text-emerald-400" : "text-destructive"} prefix="₹" showSign />
          <SummaryTile icon={<DollarSign className="size-4" />} label="Brokerage" value={gt.brokerage} color="text-blue-400" prefix="₹" />
          <SummaryTile icon={<Trophy className="size-4" />} label="Win Rate" value={gt.win_rate} color={gt.win_rate >= 50 ? "text-emerald-400" : "text-destructive"} suffix="%" decimals={1} />
        </div>
      )}

      {/* ── Charts (compact) ──────────────────────────────── */}
      {gt && (() => {
        const chartData = entities.length > 0
          ? entities.slice(0, 8).map((e) => ({ name: (e.name || "").slice(0, 10), Deposits: e.deposits, Withdrawals: e.withdrawals, PnL: e.net_pnl, Brokerage: e.brokerage }))
          : [{ name: "All", Deposits: gt.deposits, Withdrawals: gt.withdrawals, PnL: gt.net_pnl, Brokerage: gt.brokerage }];
        return (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <ChartCard title="Deposits vs Withdrawals" icon={<BarChart3 className="size-3.5" />}>
            <ResponsiveContainer width="100%" height={130}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                <XAxis dataKey="name" tick={{ fill: "#888", fontSize: 9 }} />
                <YAxis tick={{ fill: "#888", fontSize: 9 }} />
                <Tooltip contentStyle={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 8, fontSize: 11 }} />
                <Bar dataKey="Deposits" fill={CHART_GREEN} radius={[3, 3, 0, 0]} />
                <Bar dataKey="Withdrawals" fill={CHART_RED} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Win / Loss" icon={<PieChartIcon className="size-3.5" />}>
            <div className="flex items-center justify-center">
              <ResponsiveContainer width="100%" height={130}>
                <PieChart>
                  <Pie
                    data={[{ name: "Wins", value: gt.profit_trades }, { name: "Losses", value: gt.loss_trades }]}
                    cx="50%" cy="50%" innerRadius={35} outerRadius={55} paddingAngle={3} dataKey="value"
                  >
                    <Cell fill={CHART_GREEN} />
                    <Cell fill={CHART_RED} />
                  </Pie>
                  <Tooltip contentStyle={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 8, fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute flex flex-col items-center">
                <span className="text-lg font-bold">{gt.win_rate}%</span>
                <span className="text-[8px] text-muted-foreground">WIN</span>
              </div>
            </div>
          </ChartCard>

          <ChartCard title="P&L per Pool" icon={<TrendingUp className="size-3.5" />}>
            <ResponsiveContainer width="100%" height={130}>
              <BarChart data={chartData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                <XAxis type="number" tick={{ fill: "#888", fontSize: 9 }} />
                <YAxis dataKey="name" type="category" width={60} tick={{ fill: "#888", fontSize: 9 }} />
                <Tooltip contentStyle={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 8, fontSize: 11 }} formatter={(v) => [`₹${Number(v ?? 0).toLocaleString("en-IN")}`, "P&L"]} />
                <Bar dataKey="PnL">
                  {chartData.map((e, i) => <Cell key={i} fill={(e.PnL ?? 0) >= 0 ? CHART_GREEN : CHART_RED} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Brokerage" icon={<DollarSign className="size-3.5" />}>
            <ResponsiveContainer width="100%" height={130}>
              <BarChart data={chartData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                <XAxis type="number" tick={{ fill: "#888", fontSize: 9 }} />
                <YAxis dataKey="name" type="category" width={60} tick={{ fill: "#888", fontSize: 9 }} />
                <Tooltip contentStyle={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 8, fontSize: 11 }} formatter={(v) => [`₹${Number(v ?? 0).toLocaleString("en-IN")}`, "Brokerage"]} />
                <Bar dataKey="Brokerage" fill={CHART_BLUE} radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
        );
      })()}

      {/* ── Loading ────────────────────────────────────────── */}
      {isFetching && !data && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      )}

      {/* ── Entity Cards ──────────────────────────────────── */}
      {isBrokerScope ? (
        <BrokerEntities entities={entities} dateParams={dateParams} />
      ) : (
        <AllUsersEntities entities={entities} />
      )}

      {data && (
        <div className="text-xs text-muted-foreground">
          {data.filter.is_lifetime
            ? "Showing lifetime totals"
            : `Filtered: ${data.filter.from_date || ""} to ${data.filter.to_date || ""}`}
          {" · "}
          {entities.length} entities · {gt?.user_count ?? 0} total users
        </div>
      )}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════════ */
/* Broker / Sub-Broker Entity Cards                                    */
/* ═══════════════════════════════════════════════════════════════════ */

const ENTITY_PAGE_SIZE = 10;

function BrokerEntities({
  entities,
  dateParams,
}: {
  entities: AccountEntity[];
  dateParams: { from_date?: string; to_date?: string };
}) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(entities.length / ENTITY_PAGE_SIZE));
  const safeP = Math.min(page, totalPages);
  const sliced = entities.slice((safeP - 1) * ENTITY_PAGE_SIZE, safeP * ENTITY_PAGE_SIZE);

  const prevLen = useRef(entities.length);
  useEffect(() => {
    if (entities.length !== prevLen.current) { setPage(1); prevLen.current = entities.length; }
  }, [entities.length]);

  if (!entities.length) return (
    <div className="py-8 text-center text-sm text-muted-foreground">No entities found.</div>
  );

  return (
    <div className="space-y-3">
      {sliced.map((entity) => (
        <BrokerEntityCard key={entity.id} entity={entity} dateParams={dateParams} />
      ))}
      {totalPages > 1 && (
        <div className="flex items-center justify-between rounded-lg border border-border/60 bg-card/40 px-4 py-2.5">
          <span className="text-xs text-muted-foreground">
            Entity Page {safeP} ({entities.length} total entities)
          </span>
          <div className="flex gap-1.5">
            <Button variant="outline" size="sm" disabled={safeP <= 1} onClick={() => setPage(safeP - 1)}>
              <ChevronRight className="size-3 rotate-180" /> Previous
            </Button>
            <Button variant="outline" size="sm" disabled={safeP >= totalPages} onClick={() => setPage(safeP + 1)}>
              Next <ChevronRight className="size-3" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function BrokerEntityCard({
  entity: e,
  dateParams,
}: {
  entity: AccountEntity;
  dateParams: { from_date?: string; to_date?: string };
}) {
  const [expanded, setExpanded] = useState(false);
  const [showTotals, setShowTotals] = useState(false);
  const [showUsers, setShowUsers] = useState(false);

  return (
    <div className="rounded-lg border border-border/60 bg-card/40 overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-card/60 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <Users className="size-5 text-primary" />
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground">
              {expanded ? "Account ID" : "Click to expand"}
            </div>
            <div className="text-base font-bold">{e.user_code || e.name}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {expanded && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={(ev) => {
                  ev.stopPropagation();
                  setExpanded(false);
                }}
              >
                <X className="size-3 mr-1" /> Collapse
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={async (ev) => {
                  ev.stopPropagation();
                  const blob = await AccountsAPI.exportBrokerTotalsExcel(e.id, dateParams);
                  downloadBlob(blob, `${e.user_code || e.name}_summary.xlsx`);
                }}
              >
                <Download className="size-3 mr-1" /> Export Excel
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={async (ev) => {
                  ev.stopPropagation();
                  const blob = await AccountsAPI.exportBrokerTotalsPdf(e.id, dateParams);
                  downloadBlob(blob, `${e.user_code || e.name}_summary.pdf`);
                }}
              >
                <FileText className="size-3 mr-1" /> Export PDF
              </Button>
            </>
          )}
          <ChevronRight className={`size-5 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`} />
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border/60">
          {/* Broker Totals Section */}
          {!showTotals ? (
            <div
              className="flex items-center gap-2 px-4 py-3 cursor-pointer hover:bg-card/60 text-sm text-muted-foreground transition-colors"
              onClick={() => setShowTotals(true)}
            >
              <TrendingUp className="size-4" />
              Click to fetch broker totals
            </div>
          ) : (
            <BrokerTotalsCard entityId={e.id} dateParams={dateParams} />
          )}

          {/* User Table Section */}
          <div className="border-t border-border/60">
            {!showUsers ? (
              <div className="flex items-center justify-center py-6">
                <div className="text-center">
                  <div className="text-sm text-muted-foreground mb-2">
                    Click below to load users for {e.user_code || e.name}
                  </div>
                  <Button
                    className="bg-primary text-primary-foreground"
                    onClick={() => setShowUsers(true)}
                  >
                    <Users className="size-4 mr-2" /> Load Users
                  </Button>
                </div>
              </div>
            ) : (
              <UserPnlTable entityId={e.id} entityName={e.user_code || e.name} dateParams={dateParams} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════════ */
/* Broker Totals Card (lazy loaded)                                    */
/* ═══════════════════════════════════════════════════════════════════ */

function BrokerTotalsCard({
  entityId,
  dateParams,
}: {
  entityId: string;
  dateParams: { from_date?: string; to_date?: string };
}) {
  const { data, isLoading } = useQuery<BrokerTotals>({
    queryKey: ["admin", "accounts", "broker-totals", entityId, dateParams.from_date, dateParams.to_date],
    queryFn: () => AccountsAPI.brokerTotals(entityId, dateParams),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 className="size-5 animate-spin text-primary" />
      </div>
    );
  }

  if (!data) return null;

  const fmt = (v: string) => {
    const n = parseFloat(v);
    const sign = n > 0 ? "+" : "";
    return `${sign}${Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };
  const color = (v: string) => {
    const n = parseFloat(v);
    return n > 0 ? "text-emerald-500" : n < 0 ? "text-destructive" : "text-foreground/80";
  };

  return (
    <div className="px-4 py-3">
      <div className="rounded-lg border border-border/40 bg-card/30 p-4 max-w-md">
        <div className="space-y-2 text-sm">
          <TotalsRow label="NET CLIENT PNL" value={data.net_client_pnl} fmt={fmt} color={color} />
          <TotalsRow label="NET CLIENT BKG" value={data.net_client_bkg} fmt={fmt} color={color} />
          <div className="border-t border-border/30 my-1" />
          <TotalsRow label="TOTAL OF BOTH" value={data.total_of_both} fmt={fmt} color={color} info />
          <TotalsRow label="− SETTLEMENT" value={data.settlement} fmt={fmt} color={color} />
          <div className="border-t border-border/30 my-1" />
          <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 flex justify-between items-center">
            <span className="text-xs font-mono font-semibold text-muted-foreground">= ACTUAL PNL</span>
            <span className={`font-bold tabular-nums ${color(data.actual_pnl)}`}>
              {fmt(data.actual_pnl)}
            </span>
          </div>
          <div className="border-t border-border/30 my-1" />
          <TotalsRow label="SHARING PNL" value={data.sharing_pnl} fmt={fmt} color={color} />
          <TotalsRow label="SHARING BKG" value={data.sharing_bkg} fmt={fmt} color={color} />
          <div className="border-t border-border/30 my-1" />
          <TotalsRow label="TOTAL DEPOSITS" value={data.total_deposits} fmt={fmt} color={() => "text-emerald-500"} />
          <TotalsRow label="TOTAL WITHDRAWALS" value={data.total_withdrawals} fmt={fmt} color={() => "text-orange-400"} />
        </div>
      </div>
    </div>
  );
}

function TotalsRow({
  label, value, fmt, color, info,
}: {
  label: string;
  value: string;
  fmt: (v: string) => string;
  color: (v: string) => string;
  info?: boolean;
}) {
  return (
    <div className="flex justify-between items-center px-3 py-1">
      <span className="text-xs font-mono font-semibold text-muted-foreground tracking-wide">
        {label} {info && <span className="text-muted-foreground/50 cursor-help" title="Net Client PNL (inverted) + Net Client BKG">ⓘ</span>}
      </span>
      <span className={`font-semibold tabular-nums ${color(value)}`}>
        {fmt(value)}
      </span>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════════ */
/* User PNL Table (lazy loaded inside broker card)                     */
/* ═══════════════════════════════════════════════════════════════════ */

function UserPnlTable({
  entityId,
  entityName,
  dateParams,
}: {
  entityId: string;
  entityName: string;
  dateParams: { from_date?: string; to_date?: string };
}) {
  const [page, setPage] = useState(1);
  const [userSearch, setUserSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(userSearch), 400);
    return () => clearTimeout(t);
  }, [userSearch]);

  useEffect(() => { setPage(1); }, [debouncedSearch]);

  const { data, isLoading } = useQuery<EntityUsersResponse>({
    queryKey: ["admin", "accounts", "entity-users", entityId, dateParams.from_date, dateParams.to_date, page, debouncedSearch],
    queryFn: () => AccountsAPI.entityUsers(entityId, {
      ...dateParams,
      page,
      page_size: 15,
      search: debouncedSearch || undefined,
    }),
  });

  const handleDownloadAll = async () => {
    const blob = await AccountsAPI.exportEntityUsersExcel(entityId, dateParams);
    downloadBlob(blob, `pnl_all_${entityName}.xlsx`);
  };

  const items = data?.items ?? [];
  const meta = data?.meta;

  return (
    <div className="p-4 space-y-3">
      {/* Download all + search */}
      <div className="flex items-center justify-between gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            placeholder="Search users..."
            value={userSearch}
            onChange={(e) => setUserSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Button variant="outline" size="sm" onClick={handleDownloadAll}>
          <Download className="size-3 mr-1" /> Download all PnL (Excel)
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="size-5 animate-spin text-primary" />
        </div>
      ) : items.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted-foreground">No users found.</div>
      ) : (
        <>
          {/* Table */}
          <div className="overflow-x-auto rounded-lg border border-border/60">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/60 bg-card/60">
                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">User ID</th>
                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">Username</th>
                  <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">Total PNL</th>
                  <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">Net PNL <InfoTip text="Sum of realized P&L from closed positions" /></th>
                  <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">Net BKG <InfoTip text="Total brokerage charged" /></th>
                  <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground">Settlement <InfoTip text="Outstanding settlement amount" /></th>
                  <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground bg-primary/5">PNL – Settlement <InfoTip text="Total PNL minus Settlement" /></th>
                  <th className="px-3 py-2.5 text-center text-xs font-semibold text-muted-foreground">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((u) => (
                  <UserPnlRow key={u.user_id} user={u} entityId={entityId} dateParams={dateParams} />
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {meta && meta.total_pages > 1 && (
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Showing page {meta.page} of {meta.total_pages} ({meta.total} total clients for {entityName})
              </span>
              <div className="flex gap-1.5">
                <Button variant="outline" size="sm" disabled={meta.page <= 1} onClick={() => setPage(meta.page - 1)}>
                  <ChevronRight className="size-3 rotate-180" /> Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className={meta.page < meta.total_pages ? "font-bold" : ""}
                  disabled={meta.page >= meta.total_pages}
                  onClick={() => setPage(meta.page + 1)}
                >
                  Next <ChevronRight className="size-3" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function UserPnlRow({
  user: u,
  entityId,
  dateParams,
}: {
  user: EntityUserRow;
  entityId: string;
  dateParams: { from_date?: string; to_date?: string };
}) {
  const pnlColor = (v: string) => {
    const n = parseFloat(v);
    return n > 0 ? "text-emerald-400" : n < 0 ? "text-destructive" : "";
  };
  const fmtMoney = (v: string) => {
    const n = parseFloat(v);
    return Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  return (
    <tr className="border-b border-border/30 hover:bg-card/60 transition-colors">
      <td className="px-3 py-2.5 font-medium">{u.user_code}</td>
      <td className="px-3 py-2.5">{u.username}</td>
      <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${pnlColor(u.total_pnl)}`}>{fmtMoney(u.total_pnl)}</td>
      <td className={`px-3 py-2.5 text-right tabular-nums ${pnlColor(u.net_pnl)}`}>{fmtMoney(u.net_pnl)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(u.net_bkg)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(u.settlement)}</td>
      <td className={`px-3 py-2.5 text-right tabular-nums font-semibold bg-primary/5 ${pnlColor(u.pnl_minus_settlement)}`}>
        {fmtMoney(u.pnl_minus_settlement)}
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center justify-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[10px] px-2"
            disabled
            title="Settlement"
          >
            <FileText className="size-3 mr-0.5" /> Settle
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[10px] px-2"
            onClick={async () => {
              const blob = await AccountsAPI.exportEntityUsersExcel(entityId, dateParams);
              downloadBlob(blob, `pnl_${u.user_code}.xlsx`);
            }}
          >
            <FileSpreadsheet className="size-3 mr-0.5" /> Excel
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[10px] px-2"
            onClick={async () => {
              const blob = await AccountsAPI.exportEntityUsersPdf(entityId, dateParams);
              downloadBlob(blob, `pnl_${u.user_code}.pdf`);
            }}
          >
            <FileText className="size-3 mr-0.5" /> PDF
          </Button>
        </div>
      </td>
    </tr>
  );
}


/* ═══════════════════════════════════════════════════════════════════ */
/* All Users Entity Cards (existing pattern, simplified)               */
/* ═══════════════════════════════════════════════════════════════════ */

const ALL_USERS_PAGE_SIZE = 15;

function AllUsersEntities({ entities }: { entities: AccountEntity[] }) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(entities.length / ALL_USERS_PAGE_SIZE));
  const safeP = Math.min(page, totalPages);
  const sliced = entities.slice((safeP - 1) * ALL_USERS_PAGE_SIZE, safeP * ALL_USERS_PAGE_SIZE);

  const prevLen = useRef(entities.length);
  useEffect(() => {
    if (entities.length !== prevLen.current) { setPage(1); prevLen.current = entities.length; }
  }, [entities.length]);

  if (!entities.length) return (
    <div className="py-8 text-center text-sm text-muted-foreground">No entities found.</div>
  );

  return (
    <div className="space-y-3">
      {sliced.map((entity) => (
        <EntityCard key={entity.id} entity={entity} />
      ))}
      {totalPages > 1 && (
        <div className="flex items-center justify-between rounded-lg border border-border/60 bg-card/40 px-4 py-2.5">
          <span className="text-xs text-muted-foreground">
            Showing {(safeP - 1) * ALL_USERS_PAGE_SIZE + 1}–{Math.min(safeP * ALL_USERS_PAGE_SIZE, entities.length)} of {entities.length}
          </span>
          <div className="flex gap-1.5">
            <Button variant="outline" size="sm" disabled={safeP <= 1} onClick={() => setPage(safeP - 1)}>
              Prev
            </Button>
            <span className="flex items-center px-2 text-xs font-medium">{safeP} / {totalPages}</span>
            <Button variant="outline" size="sm" disabled={safeP >= totalPages} onClick={() => setPage(safeP + 1)}>
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function EntityCard({ entity: e }: { entity: AccountEntity }) {
  const [expanded, setExpanded] = useState(false);

  const roleBadge =
    e.role === "ADMIN" ? "bg-blue-500/15 text-blue-300 border-blue-500/30" :
    e.role === "BROKER" ? "bg-purple-500/15 text-purple-300 border-purple-500/30" :
    e.role === "DIRECT" ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" :
    "bg-muted/30 text-muted-foreground border-border";

  return (
    <div
      className="cursor-pointer rounded-lg border border-border/60 bg-card/40 transition-all hover:border-border"
      onClick={() => setExpanded((v) => !v)}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <Users className="size-4 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">{e.name}</span>
            <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-medium uppercase ${roleBadge}`}>
              {e.role === "DIRECT" ? "DIRECT USERS" : e.role}
            </span>
            {e.user_code && <span className="text-[10px] text-muted-foreground">{e.user_code}</span>}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
            <span>{e.user_count} users</span>
          </div>
        </div>
        <ChevronRight className={`size-4 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`} />
      </div>

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


/* ═══════════════════════════════════════════════════════════════════ */
/* Shared sub-components                                               */
/* ═══════════════════════════════════════════════════════════════════ */

function InfoTip({ text }: { text: string }) {
  return (
    <span className="text-muted-foreground/50 cursor-help ml-0.5" title={text}>ⓘ</span>
  );
}

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
    <div className="rounded-lg border border-border/60 bg-card/40 p-3 transition-all hover:border-border">
      <div className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className={`mt-1.5 text-lg font-bold tabular-nums ${color}`}>
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
    <div className="relative overflow-hidden rounded-lg border border-border/60 bg-card/40 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground">
        {icon}
        {title}
      </div>
      {children}
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
