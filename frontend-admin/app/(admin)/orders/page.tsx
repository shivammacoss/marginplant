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
import { StatusPill } from "@/components/common/StatusPill";
import { formatINR, cn } from "@/lib/utils";

/** Bare grouped-number price formatter — no ₹/$ prefix on instrument
 *  prices (Open / Close / LTP / Fill). `formatINR` is still used for
 *  Value / Brokerage / P&L cells because those are explicit INR amounts. */
function fmtPrice(value: number | string | null | undefined): string {
  const n = typeof value === "string" ? Number(value) : (value ?? 0);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

type Tab = "orders" | "executions";

export default function AdminOrdersPage() {
  // useSearchParams must sit inside Suspense for the static prerender to
  // succeed (Next 14 App Router contract). The inner component owns the
  // tab state too so it can hydrate from `?tab=` on first paint.
  return (
    <Suspense fallback={null}>
      <AdminOrdersInner />
    </Suspense>
  );
}

function AdminOrdersInner() {
  const searchParams = useSearchParams();
  const queryUserId = searchParams?.get("user_id") ?? null;
  const queryTab = (searchParams?.get("tab") ?? "orders") as Tab;

  const [tab, setTab] = useState<Tab>(queryTab === "executions" ? "executions" : "orders");
  // Sync state when the URL changes (e.g. user clicks the user-detail
  // "View trades" button while already on /orders).
  useEffect(() => {
    setTab(queryTab === "executions" ? "executions" : "orders");
  }, [queryTab]);

  // Resolve the user's code/name for the filter pill so the admin sees
  // who they're filtering by — not just an opaque ObjectId.
  const { data: scopedUser } = useQuery({
    queryKey: ["admin", "user", queryUserId],
    queryFn: () => UsersAPI.detail(queryUserId!),
    enabled: !!queryUserId,
    staleTime: 5 * 60_000,
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Orders monitor"
        description={
          tab === "orders"
            ? "User-placed orders — current status, side, type, quantity, fills."
            : "Trade executions — actual fills against orders, with charges."
        }
      />

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

      <div className="inline-flex rounded-md border border-border bg-muted/30 p-1 text-sm">
        {(["orders", "executions"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "rounded px-3 py-1.5 capitalize transition-colors",
              tab === t ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t === "orders" ? "Orders" : "Executions"}
          </button>
        ))}
      </div>

      {tab === "orders" ? (
        <OrdersTable userId={queryUserId} />
      ) : (
        <TradesTable userId={queryUserId} />
      )}
    </div>
  );
}

function OrdersTable({ userId }: { userId?: string | null }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);

  const { data, isFetching } = useQuery({
    queryKey: ["admin", "orders", { status, page, userId }],
    queryFn: () =>
      TradingAPI.orders({
        status: status || undefined,
        user_id: userId || undefined,
        page,
        page_size: 50,
      }),
    refetchInterval: 5000,
  });

  // Live LTP per token for the P&L column. Uses the admin-only batch
  // quote endpoint; refreshes every 5s alongside the orders list.
  const orderTokens = useMemo(() => {
    const set = new Set<string>();
    for (const o of (data?.items ?? []) as any[]) {
      const tok = o.token || o.instrument_token;
      if (tok) set.add(String(tok));
    }
    return Array.from(set);
  }, [data]);

  const { data: quotes } = useQuery({
    queryKey: ["admin", "order-quotes", orderTokens.sort().join(",")],
    queryFn: () => TradingAPI.orderQuotes(orderTokens),
    enabled: orderTokens.length > 0,
    refetchInterval: 5000,
    staleTime: 4000,
  });

  const ltpByToken = useMemo(() => {
    const m: Record<string, number> = {};
    for (const q of (quotes ?? []) as any[]) {
      const ltp = Number(q.ltp ?? 0);
      if (ltp > 0 && q.token) m[String(q.token)] = ltp;
    }
    return m;
  }, [quotes]);

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

  const cols: Column<any>[] = [
    { key: "order_number", header: "Order #", render: (r) => <span className="font-mono text-[11px]">{r.order_number}</span> },
    { key: "user_code", header: "User", render: (r) => r.user_code || r.user_id.slice(-6) },
    { key: "symbol", header: "Symbol" },
    { key: "exchange", header: "Exch" },
    { key: "action", header: "Side", render: (r) => <StatusPill status={r.action} /> },
    { key: "order_type", header: "Type", render: (r) => <StatusPill status={r.order_type} /> },
    { key: "lots", header: "Lots", align: "right" },
    {
      // Entry fill price — what this order actually executed at.
      key: "average_price",
      header: "Open",
      align: "right",
      render: (r) => fmtPrice(r.average_price),
    },
    {
      // Current LTP for the instrument — for already-closed positions this is
      // effectively the close price (position_service freezes ltp at close).
      // For still-open exposure, it's the live mark.
      key: "close_price",
      header: "Close / LTP",
      align: "right",
      render: (r) => {
        if (!["EXECUTED", "PARTIAL"].includes(r.status)) {
          return <span className="text-muted-foreground">—</span>;
        }
        const tok = r.token || r.instrument_token;
        const ltp = tok ? ltpByToken[String(tok)] : undefined;
        if (!ltp) return <span className="text-muted-foreground">—</span>;
        return <span className="font-tabular">{fmtPrice(ltp)}</span>;
      },
    },
    {
      key: "pnl",
      header: "P&L",
      align: "right",
      // Priority is the FROZEN `realized_pnl_inr` returned by the API —
      // that's the closing-leg trade's stamped pnl_inr (net of brokerage,
      // FX-converted for USD-quoted instruments). Showing this means a
      // closed order's P&L stops moving with the live tick — fixes the
      // "trade close ho gaya, P&L kyon flicker kar raha hai" issue.
      //
      // Opening legs have realized_pnl_inr = null (the realized P&L lives
      // on the future closing leg). For those we still want a useful live
      // mark, so we fall back to (LTP − avg) × qty × direction in INR,
      // tagged with a small "live" hint so the admin can tell at a glance
      // which numbers tick.
      render: (r) => {
        if (!["EXECUTED", "PARTIAL"].includes(r.status)) {
          return <span className="text-muted-foreground">—</span>;
        }
        const realized = r.realized_pnl_inr;
        if (realized !== null && realized !== undefined) {
          return <PnlCell value={Number(realized)} title="Realized P&L (frozen at close)" />;
        }
        const tok = r.token || r.instrument_token;
        const ltp = tok ? ltpByToken[String(tok)] : undefined;
        const avg = Number(r.average_price ?? 0);
        const qty = Number(r.filled_quantity ?? r.quantity ?? 0);
        if (!ltp || !avg || !qty) return <span className="text-muted-foreground">—</span>;
        const direction = String(r.action).toUpperCase() === "BUY" ? 1 : -1;
        const pnl = direction * (ltp - avg) * qty;
        return (
          <PnlCell
            value={pnl}
            live
            title={`Live MTM (opening leg): LTP ${ltp} − Avg ${avg} × ${qty}`}
          />
        );
      },
    },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (r) =>
        ["OPEN", "PENDING", "PARTIAL"].includes(r.status) ? (
          <Button variant="ghost" size="icon" onClick={() => cancelOrder(r.id)} aria-label="Cancel">
            <XCircle className="size-4 text-destructive" />
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">{data?.meta?.total ?? 0} orders</div>
        <select
          value={status}
          onChange={(e) => {
            setPage(1);
            setStatus(e.target.value);
          }}
          className="h-9 rounded-md border border-border bg-background px-3 text-sm"
        >
          <option value="">All statuses</option>
          <option value="OPEN">Open</option>
          <option value="EXECUTED">Executed</option>
          <option value="CANCELLED">Cancelled</option>
          <option value="REJECTED">Rejected</option>
        </select>
      </div>
      <DataTable columns={cols} rows={data?.items} keyExtractor={(r) => r.id} loading={isFetching && !data} />
      {(data?.meta?.total_pages ?? 1) > 1 && (
        <div className="flex justify-end gap-2 text-xs">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Prev
          </Button>
          <span className="self-center text-muted-foreground">
            {page} / {data?.meta?.total_pages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= (data?.meta?.total_pages ?? 1)}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

function TradesTable({ userId }: { userId?: string | null }) {
  const { data, isFetching } = useQuery({
    queryKey: ["admin", "trades", { userId }],
    queryFn: () =>
      TradingAPI.trades({ limit: 200, user_id: userId || undefined }),
    refetchInterval: 5000,
  });

  // Same live-LTP overlay pattern as the Orders tab — gives admins a "what
  // would this fill be worth right now" P&L next to each execution.
  const tradeTokens = useMemo(() => {
    const set = new Set<string>();
    for (const t of (data ?? []) as any[]) {
      const tok = t.instrument_token || t.token;
      if (tok) set.add(String(tok));
    }
    return Array.from(set);
  }, [data]);

  const { data: quotes } = useQuery({
    queryKey: ["admin", "trade-quotes", tradeTokens.sort().join(",")],
    queryFn: () => TradingAPI.orderQuotes(tradeTokens),
    enabled: tradeTokens.length > 0,
    refetchInterval: 5000,
    staleTime: 4000,
  });

  const ltpByToken = useMemo(() => {
    const m: Record<string, number> = {};
    for (const q of (quotes ?? []) as any[]) {
      const ltp = Number(q.ltp ?? 0);
      if (ltp > 0 && q.token) m[String(q.token)] = ltp;
    }
    return m;
  }, [quotes]);

  const cols: Column<any>[] = [
    { key: "trade_number", header: "Trade #", render: (r) => <span className="font-mono text-[11px]">{r.trade_number}</span> },
    { key: "order_number", header: "Order #", render: (r) => <span className="font-mono text-[11px] text-muted-foreground">{r.order_number || "—"}</span> },
    { key: "user_code", header: "User" },
    { key: "symbol", header: "Symbol" },
    { key: "action", header: "Side", render: (r) => <StatusPill status={r.action} /> },
    { key: "quantity", header: "Qty", align: "right" },
    { key: "price", header: "Open", align: "right", render: (r) => fmtPrice(r.price) },
    {
      key: "close_price",
      header: "Close / LTP",
      align: "right",
      render: (r) => {
        const tok = r.instrument_token || r.token;
        const ltp = tok ? ltpByToken[String(tok)] : undefined;
        if (!ltp) return <span className="text-muted-foreground">—</span>;
        return <span className="font-tabular">{fmtPrice(ltp)}</span>;
      },
    },
    { key: "value", header: "Value", align: "right", render: (r) => formatINR(r.value) },
    {
      key: "pnl",
      header: "P&L",
      align: "right",
      // Same freeze-on-close semantics as the Orders tab: a closing-leg
      // Trade has `pnl_inr` stamped at fill time (FX-baked, net of
      // brokerage), so we render that frozen value and stop the LTP-driven
      // jitter for already-closed trades. Opening-leg fills have
      // pnl_inr = null — we fall back to a live (LTP − fill_price) × qty
      // mark tagged with a pulse dot so the admin can see it's live.
      render: (r) => {
        if (r.pnl_inr !== null && r.pnl_inr !== undefined) {
          return (
            <PnlCell
              value={Number(r.pnl_inr)}
              title="Realized P&L (frozen at fill)"
            />
          );
        }
        const tok = r.instrument_token || r.token;
        const ltp = tok ? ltpByToken[String(tok)] : undefined;
        const tradePrice = Number(r.price ?? 0);
        const qty = Number(r.quantity ?? 0);
        if (!ltp || !tradePrice || !qty) {
          return <span className="text-muted-foreground">—</span>;
        }
        const direction = String(r.action).toUpperCase() === "BUY" ? 1 : -1;
        const pnl = direction * (ltp - tradePrice) * qty;
        return (
          <PnlCell
            value={pnl}
            live
            title={`Live MTM (opening leg): LTP ${ltp} − Fill ${tradePrice} × ${qty}`}
          />
        );
      },
    },
    {
      key: "total_charges",
      header: "Brokerage",
      align: "right",
      // The only charge on this platform — configured under Admin → Brokerage
      // (per-segment rate) and Admin → Segment Settings (commission_type +
      // commission_value override). No statutory pass-through.
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
      <DataTable columns={cols} rows={data} keyExtractor={(r) => r.id} loading={isFetching && !data} />
    </div>
  );
}

/** Shared red/green P&L cell with a subtle background tint so the colour
 *  reads at a glance even on dense tables. The `live` flag tags rows
 *  whose P&L is still moving with the LTP (opening leg of an open
 *  position) with a tiny pulsing dot — anything without it is FROZEN
 *  realized P&L from the closing-leg trade and won't flicker. */
function PnlCell({
  value,
  title,
  live = false,
}: {
  value: number;
  title?: string;
  live?: boolean;
}) {
  const isProfit = value > 0;
  const isLoss = value < 0;
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-tabular font-bold tabular-nums",
        isProfit && "bg-profit/10 text-profit",
        isLoss && "bg-loss/10 text-loss",
        !isProfit && !isLoss && "text-muted-foreground"
      )}
    >
      {live && (
        <span
          aria-hidden
          className="size-1.5 animate-pulse rounded-full bg-current"
        />
      )}
      <span>
        {isProfit ? "+" : ""}
        {formatINR(value)}
      </span>
    </span>
  );
}
