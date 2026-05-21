"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { XCircle, X as XIcon } from "lucide-react";
import { TradingAPI, UsersAPI } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/common/PageHeader";
import { DataTable, type Column } from "@/components/common/DataTable";
import { Pagination } from "@/components/common/Pagination";
import { StatusPill } from "@/components/common/StatusPill";
import { formatINR, cn } from "@/lib/utils";

function fmtPrice(value: number | string | null | undefined): string {
  const n = typeof value === "string" ? Number(value) : (value ?? 0);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

// Five tabs. The four order-bucket tabs map onto a single backend
// /admin/orders call with different status filters; "executions" hits
// /admin/trades. Operator wanted these split out (commit 21-May) so
// each bucket is a single click instead of a dropdown — Pending /
// Executed / Rejected / SL-TP / Executions.
type Tab = "pending" | "executed" | "rejected" | "sltp" | "executions";

const TABS: { id: Tab; label: string; description: string }[] = [
  {
    id: "pending",
    label: "Pending Orders",
    description: "Orders awaiting trigger or fill — PENDING, OPEN, PARTIAL.",
  },
  {
    id: "executed",
    label: "Executed Orders",
    description: "Orders that have fully filled.",
  },
  {
    id: "rejected",
    label: "Rejected Orders",
    description: "Orders rejected by validation (margin shortfall, limits, etc.).",
  },
  {
    id: "sltp",
    label: "SL / TP",
    description: "Orders carrying a stop-loss or target — SL/SL-M or bracket SL/TP.",
  },
  {
    id: "executions",
    label: "Executions",
    description: "Trade fills against orders, with brokerage charges.",
  },
];

export default function AdminOrdersPage() {
  return (
    <Suspense fallback={null}>
      <AdminOrdersInner />
    </Suspense>
  );
}

function AdminOrdersInner() {
  const searchParams = useSearchParams();
  const queryUserId = searchParams?.get("user_id") ?? null;
  const queryTab = (searchParams?.get("tab") ?? "pending") as Tab;

  const isValidTab = (t: string): t is Tab =>
    ["pending", "executed", "rejected", "sltp", "executions"].includes(t);

  const [tab, setTab] = useState<Tab>(isValidTab(queryTab) ? queryTab : "pending");
  useEffect(() => {
    if (isValidTab(queryTab)) setTab(queryTab);
  }, [queryTab]);

  const { data: scopedUser } = useQuery({
    queryKey: ["admin", "user", queryUserId],
    queryFn: () => UsersAPI.detail(queryUserId!),
    enabled: !!queryUserId,
    staleTime: 5 * 60_000,
  });

  const active = TABS.find((t) => t.id === tab)!;

  return (
    <div className="space-y-4">
      <PageHeader title="Orders monitor" description={active.description} />

      {queryUserId && (
        <div className="inline-flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs">
          <span className="text-muted-foreground">Filtered by user:</span>
          <span className="font-semibold text-primary">
            {(scopedUser as any)?.user_code ?? queryUserId.slice(-8)}
            {(scopedUser as any)?.full_name ? ` · ${(scopedUser as any).full_name}` : ""}
          </span>
          <Link
            href={`/orders?tab=${tab}`}
            className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            aria-label="Clear user filter"
          >
            <XIcon className="size-3" />
          </Link>
        </div>
      )}

      <div className="inline-flex flex-wrap rounded-md border border-border bg-muted/30 p-1 text-sm">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              "rounded px-3 py-1.5 transition-colors",
              tab === t.id ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "executions" ? (
        <TradesTable userId={queryUserId} />
      ) : (
        <OrdersTable tab={tab} userId={queryUserId} />
      )}
    </div>
  );
}

function OrdersTable({ tab, userId }: { tab: Exclude<Tab, "executions">; userId?: string | null }) {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  // Reset to page 1 when switching tab or user filter so pagination
  // never lands on an empty page in a smaller result set.
  useEffect(() => {
    setPage(1);
  }, [tab, userId]);

  // Map each tab onto the backend filter shape it expects. Pending bundles
  // three wire statuses into one tab (PENDING + OPEN + PARTIAL) via the
  // `statuses` CSV param; SL/TP uses the dedicated `sl_tp=true` flag that
  // matches SL/SL_M order types OR bracket stop_loss/target.
  const apiParams = useMemo<Record<string, any>>(() => {
    const base: Record<string, any> = {
      page,
      page_size: pageSize,
      user_id: userId || undefined,
    };
    if (tab === "pending") base.statuses = "PENDING,OPEN,PARTIAL";
    else if (tab === "executed") base.status = "EXECUTED";
    else if (tab === "rejected") base.status = "REJECTED";
    else if (tab === "sltp") base.sl_tp = true;
    return base;
  }, [tab, userId, page, pageSize]);

  const { data, isFetching } = useQuery({
    queryKey: ["admin", "orders", apiParams],
    queryFn: () => TradingAPI.orders(apiParams),
    refetchInterval: 5000,
  });

  async function cancelOrder(id: string) {
    if (!confirm("Force-cancel this order?")) return;
    try {
      await TradingAPI.forceCancel(id);
      toast.success("Cancelled");
      qc.invalidateQueries({ queryKey: ["admin", "orders"] });
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  // Column set varies by tab. The common columns sit at the front;
  // tab-specific extras are appended so the operator sees the field
  // they care about (rejection reason, bracket SL/TP, trigger price)
  // without needing to scroll a kitchen-sink table.
  const cols: Column<any>[] = useMemo(() => {
    const base: Column<any>[] = [
      {
        key: "order_number",
        header: "Order #",
        render: (r) => <span className="font-mono text-[11px]">{r.order_number}</span>,
      },
      { key: "user_code", header: "User", render: (r) => r.user_code || r.user_id.slice(-6) },
      { key: "symbol", header: "Symbol" },
      { key: "exchange", header: "Exch" },
      { key: "action", header: "Side", render: (r) => <StatusPill status={r.action} /> },
      { key: "order_type", header: "Type", render: (r) => <StatusPill status={r.order_type} /> },
      { key: "lots", header: "Lots", align: "right" },
      { key: "quantity", header: "Qty", align: "right" },
    ];

    if (tab === "pending") {
      base.push(
        { key: "price", header: "Limit", align: "right", render: (r) => fmtPrice(r.price) },
        {
          key: "trigger_price",
          header: "Trigger",
          align: "right",
          render: (r) =>
            Number(r.trigger_price ?? 0) > 0 ? fmtPrice(r.trigger_price) : <span className="text-muted-foreground">—</span>,
        },
        { key: "filled_quantity", header: "Filled", align: "right" },
        { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
      );
    } else if (tab === "executed") {
      base.push(
        { key: "average_price", header: "Fill", align: "right", render: (r) => fmtPrice(r.average_price) },
        { key: "filled_quantity", header: "Filled", align: "right" },
        {
          key: "executed_at",
          header: "Executed",
          render: (r) => (r.executed_at ? new Date(r.executed_at).toLocaleString() : "—"),
        },
      );
    } else if (tab === "rejected") {
      base.push(
        { key: "price", header: "Price", align: "right", render: (r) => fmtPrice(r.price) },
        {
          key: "rejection_reason",
          header: "Reason",
          render: (r) => (
            <span className="text-xs text-loss" title={r.rejection_reason || ""}>
              {r.rejection_reason || "—"}
            </span>
          ),
        },
        {
          key: "created_at",
          header: "When",
          render: (r) => (r.created_at ? new Date(r.created_at).toLocaleString() : "—"),
        },
      );
    } else if (tab === "sltp") {
      base.push(
        { key: "average_price", header: "Entry", align: "right", render: (r) => fmtPrice(r.average_price || r.price) },
        {
          key: "trigger_price",
          header: "Trigger",
          align: "right",
          render: (r) =>
            Number(r.trigger_price ?? 0) > 0 ? fmtPrice(r.trigger_price) : <span className="text-muted-foreground">—</span>,
        },
        {
          key: "bracket_stop_loss",
          header: "SL",
          align: "right",
          render: (r) =>
            r.bracket_stop_loss ? (
              <span className="font-tabular text-loss">{fmtPrice(r.bracket_stop_loss)}</span>
            ) : (
              <span className="text-muted-foreground">—</span>
            ),
        },
        {
          key: "bracket_target",
          header: "Target",
          align: "right",
          render: (r) =>
            r.bracket_target ? (
              <span className="font-tabular text-profit">{fmtPrice(r.bracket_target)}</span>
            ) : (
              <span className="text-muted-foreground">—</span>
            ),
        },
        { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
      );
    }

    base.push({
      key: "actions",
      header: "",
      align: "right",
      render: (r) =>
        ["OPEN", "PENDING", "PARTIAL"].includes(r.status) ? (
          <Button variant="ghost" size="icon" onClick={() => cancelOrder(r.id)} aria-label="Cancel">
            <XCircle className="size-4 text-destructive" />
          </Button>
        ) : null,
    });

    return base;
  }, [tab]);

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground">{data?.meta?.total ?? 0} orders</div>
      <DataTable columns={cols} rows={data?.items} keyExtractor={(r) => r.id} loading={isFetching && !data} />
      <Pagination
        page={page}
        pageSize={pageSize}
        total={data?.meta?.total ?? 0}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        pageSizeOptions={[25, 50, 100, 200]}
      />
    </div>
  );
}

function TradesTable({ userId }: { userId?: string | null }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const { data, isFetching } = useQuery({
    queryKey: ["admin", "trades", { userId }],
    queryFn: () => TradingAPI.trades({ limit: 1000, user_id: userId || undefined }),
    refetchInterval: 5000,
  });

  useEffect(() => {
    setPage(1);
  }, [userId]);

  const pagedRows = useMemo(() => {
    const all = (data ?? []) as any[];
    const start = (page - 1) * pageSize;
    return all.slice(start, start + pageSize);
  }, [data, page, pageSize]);

  // Executions tab intentionally has NO P&L column. Operator's 21-May
  // request: "eccuate page se pnl remoev kar dena pls ume pnl show
  // nahi karna hai" — keep this page focused on the fill itself
  // (price, qty, brokerage, time). Realised P&L lives on the Position
  // & Holdings pages.
  const cols: Column<any>[] = [
    {
      key: "trade_number",
      header: "Trade #",
      render: (r) => <span className="font-mono text-[11px]">{r.trade_number}</span>,
    },
    {
      key: "order_number",
      header: "Order #",
      render: (r) => <span className="font-mono text-[11px] text-muted-foreground">{r.order_number || "—"}</span>,
    },
    { key: "user_code", header: "User" },
    { key: "symbol", header: "Symbol" },
    { key: "action", header: "Side", render: (r) => <StatusPill status={r.action} /> },
    { key: "quantity", header: "Qty", align: "right" },
    { key: "price", header: "Fill price", align: "right", render: (r) => fmtPrice(r.price) },
    { key: "value", header: "Value", align: "right", render: (r) => formatINR(r.value) },
    {
      key: "total_charges",
      header: "Brokerage",
      align: "right",
      render: (r) => (
        <span title="Platform brokerage only. Configured under Admin → Brokerage and Segment Settings. No statutory charges are passed through.">
          {formatINR(r.total_charges)}
        </span>
      ),
    },
    { key: "executed_at", header: "When", render: (r) => new Date(r.executed_at).toLocaleString() },
  ];

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground">{data?.length ?? 0} executions</div>
      <DataTable columns={cols} rows={pagedRows} keyExtractor={(r) => r.id} loading={isFetching && !data} />
      <Pagination
        page={page}
        pageSize={pageSize}
        total={data?.length ?? 0}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        pageSizeOptions={[25, 50, 100, 200]}
      />
    </div>
  );
}
