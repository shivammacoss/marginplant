"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Plus, Search, TrendingDown, TrendingUp } from "lucide-react";
import { UsersAPI } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/common/PageHeader";
import { DataTable, type Column } from "@/components/common/DataTable";
import { StatusPill } from "@/components/common/StatusPill";
import { UserActionMenu, LiveTradeStatsDialog } from "@/components/admin/UserActionMenu";
import { OwnerBadge } from "@/components/admin/OwnerBadge";
import { LedgerSheet } from "@/components/admin/LedgerSheet";
import { useAdminAuthStore } from "@/stores/authStore";

/**
 * Cadence at which the admin Users table re-fetches per-user live stats
 * (available balance, open P&L, equity).
 *
 * Customer-facing terminals throttle their websocket display at 200 ms
 * (matches the 250 ms backend tick loop). For the admin overview table,
 * 1.5 s strikes a balance: fast enough for "live" feel + red/green color
 * shifts, slow enough that 50-row tables don't hammer the backend.
 *
 * Per row the backend does ONE wallet query + ONE positions query for
 * the whole page (batched via $in), then parallel LTP fan-out across
 * unique tokens — so the per-tick cost scales with unique tokens, not
 * row count.
 */
const LIVE_STATS_REFETCH_MS = 1500;

type LiveStat = {
  user_id: string;
  available_balance: string;
  open_pnl: string;
  equity: string;
  used_margin: string;
  credit_limit: string;
};

export default function AdminUsersPage() {
  const me = useAdminAuthStore((s) => s.admin);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("");
  const [page, setPage] = useState(1);
  const [ledgerUser, setLedgerUser] = useState<any | null>(null);
  const [statsUser, setStatsUser] = useState<any | null>(null);
  const pageSize = 20;

  const { data, isFetching } = useQuery({
    queryKey: ["admin", "users", { q, status, page, pageSize }],
    queryFn: () =>
      UsersAPI.list({
        q: q || undefined,
        status: status || undefined,
        page,
        page_size: pageSize,
      }),
  });

  // ── Live stats poll ─────────────────────────────────────────────
  // Drives the AVAILABLE / OPEN P&L / EQUITY columns. We pass the ids
  // of the current page so the backend only computes for what's
  // visible. Skips the request entirely while the page list is still
  // loading.
  const visibleUserIds = useMemo<string[]>(
    () => (data?.items ?? []).map((u: any) => u.id),
    [data?.items],
  );

  const liveStatsQuery = useQuery({
    queryKey: ["admin", "users", "live-stats", visibleUserIds.join(",")],
    queryFn: () => UsersAPI.liveStats(visibleUserIds),
    enabled: visibleUserIds.length > 0,
    refetchInterval: LIVE_STATS_REFETCH_MS,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });

  const liveStatsMap = useMemo<Record<string, LiveStat>>(() => {
    const m: Record<string, LiveStat> = {};
    for (const row of liveStatsQuery.data?.items ?? []) {
      m[row.user_id] = row;
    }
    return m;
  }, [liveStatsQuery.data]);

  /**
   * Pick the freshest value for a given user/field. Prefers the live
   * poll, falls back to the value embedded in the user list payload
   * (the static wallet snapshot) so the column never blinks to "—"
   * during the first 1.5 s after page load.
   */
  function pickAvailable(r: any): number {
    const live = liveStatsMap[r.id]?.available_balance;
    if (live != null) return Number(live);
    return Number(r.wallet?.available_balance ?? 0);
  }

  function pickOpenPnl(r: any): number | null {
    const live = liveStatsMap[r.id]?.open_pnl;
    return live != null ? Number(live) : null;
  }

  function pickEquity(r: any): number | null {
    const live = liveStatsMap[r.id]?.equity;
    if (live != null) return Number(live);
    return null;
  }

  const columns: Column<any>[] = [
    {
      key: "user_code",
      header: "Code",
      render: (r) => <span className="font-mono text-xs">{r.user_code}</span>,
    },
    { key: "full_name", header: "Name" },
    {
      key: "email",
      header: "Email",
      className: "max-w-[240px] truncate",
    },
    { key: "mobile", header: "Mobile" },
    {
      key: "owner",
      header: "Owner",
      render: (r) => <OwnerBadge row={r} me={me} />,
    },
    {
      key: "status",
      header: "Status",
      render: (r) => <StatusPill status={r.status} />,
    },
    {
      key: "ledger",
      header: "LEDGER",
      align: "center",
      render: (r: any) => (
        <Button
          size="sm"
          variant="outline"
          className="h-7 w-7 p-0 font-mono font-semibold border-primary/50 text-primary hover:bg-primary hover:text-primary-foreground"
          title="View ledger / Adjust wallet"
          onClick={(e) => {
            e.stopPropagation();
            setLedgerUser(r);
          }}
        >
          L
        </Button>
      ),
    },
    {
      key: "stats",
      header: "STATS",
      align: "center",
      render: (r: any) => (
        <Button
          size="sm"
          variant="outline"
          className="h-7 w-7 p-0 font-mono font-semibold border-info/50 text-info hover:bg-info hover:text-info-foreground"
          title="Live trading stats"
          onClick={(e) => {
            e.stopPropagation();
            setStatsUser(r);
          }}
        >
          S
        </Button>
      ),
    },
    {
      key: "positions",
      header: "POSITION",
      align: "center",
      render: (r: any) => (
        <Button
          asChild
          size="sm"
          variant="outline"
          className="h-7 w-7 p-0 font-mono font-semibold border-atm/50 text-atm hover:bg-atm hover:text-atm-foreground"
          title="View positions"
          onClick={(e) => e.stopPropagation()}
        >
          <Link href={`/positions?user_id=${r.id}`}>P</Link>
        </Button>
      ),
    },
    {
      key: "available",
      header: "AVAILABLE",
      align: "right",
      render: (r: any) => (
        <MoneyCell value={pickAvailable(r)} muted />
      ),
    },
    {
      key: "open_pnl",
      header: "OPEN P&L",
      align: "right",
      render: (r: any) => <PnlCell value={pickOpenPnl(r)} />,
    },
    {
      key: "equity",
      header: "LEFT BALANCE",
      align: "right",
      render: (r: any) => <EquityCell available={pickAvailable(r)} equity={pickEquity(r)} />,
    },
    {
      key: "settlement",
      header: "Settlement",
      align: "right",
      render: (r) => {
        const v = Number(r.wallet?.settlement_outstanding ?? 0);
        return v > 0 ? (
          <span className="text-sm font-semibold tabular-nums text-destructive">
            ₹{v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        );
      },
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (r) => (
        <div className="flex justify-end">
          <UserActionMenu user={r} />
        </div>
      ),
    },
  ];

  const total = data?.meta?.total ?? 0;
  const totalPages = data?.meta?.total_pages ?? 1;

  return (
    <div className="space-y-4">
      <PageHeader
        title="All users"
        description={`${total} users`}
        actions={
          <Button asChild>
            <Link href="/users/new">
              <Plus className="size-4" /> New user
            </Link>
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => {
              setPage(1);
              setQ(e.target.value);
            }}
            placeholder="Search code / email / mobile / name"
            className="pl-9"
          />
        </div>
        <select
          value={status}
          onChange={(e) => {
            setPage(1);
            setStatus(e.target.value);
          }}
          className="h-10 rounded-md border border-border bg-background px-3 text-sm"
        >
          <option value="">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="PENDING">Pending</option>
          <option value="BLOCKED">Blocked</option>
          <option value="CLOSED">Closed</option>
        </select>
        <LiveBadge fetching={liveStatsQuery.isFetching} />
      </div>

      <DataTable
        columns={columns}
        rows={data?.items}
        keyExtractor={(r) => r.id}
        loading={isFetching && !data}
        empty="No users match the current filters."
      />

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
          <span>
            Page {page} of {totalPages}
          </span>
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Prev
          </Button>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      )}

      <LedgerSheet
        open={!!ledgerUser}
        onClose={() => setLedgerUser(null)}
        user={ledgerUser}
      />
      {statsUser && (
        <LiveTradeStatsDialog
          open={!!statsUser}
          userId={statsUser.id}
          userCode={statsUser.user_code}
          fullName={statsUser.full_name || ""}
          onClose={() => setStatsUser(null)}
        />
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────── */
/* Cells                                                                */
/* ─────────────────────────────────────────────────────────────────── */

function MoneyCell({ value, muted }: { value: number; muted?: boolean }) {
  return (
    <span
      className={`text-sm font-semibold tabular-nums ${
        muted ? "text-foreground/90" : ""
      }`}
    >
      ₹{value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
    </span>
  );
}

/**
 * Open P&L cell — green for profit, red for loss, muted for exactly 0
 * (or while live stats are still loading). The arrow icon is tinted to
 * match so the cell remains scannable at a glance across many rows.
 */
function PnlCell({ value }: { value: number | null }) {
  if (value == null) {
    return <span className="text-sm text-muted-foreground">—</span>;
  }
  if (value === 0) {
    return (
      <span className="text-sm font-semibold tabular-nums text-muted-foreground">
        ₹0.00
      </span>
    );
  }
  const positive = value > 0;
  const formatted = `₹${Math.abs(value).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
  return (
    <span
      className={`inline-flex items-center justify-end gap-1 text-sm font-semibold tabular-nums ${
        positive ? "text-emerald-400" : "text-destructive"
      }`}
    >
      {positive ? (
        <TrendingUp className="h-3.5 w-3.5" />
      ) : (
        <TrendingDown className="h-3.5 w-3.5" />
      )}
      {positive ? "+" : "−"}
      {formatted}
    </span>
  );
}

/**
 * "Left balance" — what the user's effective equity is right now
 * (available + open P&L). Colors against the available baseline:
 *   • emerald when equity > available (open P&L is profitable)
 *   • red     when equity < available (open P&L is loss)
 *   • neutral when equal (no open positions / break-even)
 */
function EquityCell({
  available,
  equity,
}: {
  available: number;
  equity: number | null;
}) {
  if (equity == null) {
    return <MoneyCell value={available} muted />;
  }
  const delta = equity - available;
  const tone =
    delta > 0
      ? "text-emerald-400"
      : delta < 0
        ? "text-destructive"
        : "text-foreground/90";
  return (
    <span className={`text-sm font-semibold tabular-nums ${tone}`}>
      ₹{equity.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
    </span>
  );
}

/**
 * Small "Live" indicator above the table — pulses a green dot while the
 * 1.5s poll is in-flight so operators can see at a glance that the
 * live columns are refreshing.
 */
function LiveBadge({ fetching }: { fetching: boolean }) {
  return (
    <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-emerald-300">
      <span className="relative inline-flex h-1.5 w-1.5">
        <span
          className={`absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 ${
            fetching ? "animate-ping" : ""
          }`}
        />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
      </span>
      Live · {(LIVE_STATS_REFETCH_MS / 1000).toFixed(1)}s
    </span>
  );
}
