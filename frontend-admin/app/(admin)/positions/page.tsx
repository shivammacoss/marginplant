"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertOctagon, CalendarDays, Pencil, Search, TrendingDown, TrendingUp, Trash2, X, X as XIcon } from "lucide-react";
import { TradingAPI, UsersAPI } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PageHeader } from "@/components/common/PageHeader";
import { DataTable, type Column } from "@/components/common/DataTable";
import { StatusPill } from "@/components/common/StatusPill";
import { cn, formatINR, pnlColor } from "@/lib/utils";
import { OwnerBadge } from "@/components/admin/OwnerBadge";
import { useAdminAuthStore } from "@/stores/authStore";

/** Bare grouped-number price — no ₹ / $ prefix on any instrument price
 *  (avg / LTP / close). `quote` accepted for call-site compatibility but
 *  ignored. Forex pairs render with 4 decimals, everything else 2. */
function fmtFeedPrice(value: string | number | null | undefined, _quote?: string) {
  const n = typeof value === "string" ? Number(value) : (value ?? 0);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

/** Backend serialises naive UTC; add `Z` if missing before parsing. */
function parseDate(v: string | Date | null | undefined): Date | null {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const hasTz = /[zZ]|[+-]\d{2}:?\d{2}$/.test(v);
  const d = new Date(hasTz ? v : v + "Z");
  return isNaN(d.getTime()) ? null : d;
}

// Color + label for the close_reason chip. Legal tags come from
// Position.close_reason in marginplant_ind/backend/app/models/position.py.
const CLOSE_REASON_META: Record<
  string,
  { label: string; cls: string }
> = {
  USER: { label: "User", cls: "bg-blue-500/10 text-blue-400 ring-blue-500/30" },
  SL_HIT: {
    label: "Stop Loss",
    cls: "bg-destructive/10 text-destructive ring-destructive/30",
  },
  TP_HIT: {
    label: "Target",
    cls: "bg-buy/10 text-buy ring-buy/30",
  },
  STOP_OUT: {
    label: "Stop-out",
    cls: "bg-amber-500/10 text-amber-400 ring-amber-500/30",
  },
  AUTO: {
    label: "Auto",
    cls: "bg-muted/40 text-muted-foreground ring-border",
  },
};

function CloseReasonChip({ reason }: { reason?: string | null }) {
  if (!reason)
    return <span className="text-muted-foreground/60 text-xs">—</span>;
  const meta = CLOSE_REASON_META[reason] ?? {
    label: reason,
    cls: "bg-muted/40 text-muted-foreground ring-border",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset",
        meta.cls,
      )}
    >
      {meta.label}
    </span>
  );
}

// "Opened" column now shows the absolute IST timestamp the trade actually
// started, not the relative duration ("7m" / "13m") it had before. Admin
// asked for "kab open hua, date ke saath" — so the cell renders as
// "17 May, 22:34" (DD MMM, HH:mm in IST 24-h). Backend serialises
// opened_at as naive UTC; parseDate() pins the `Z` so the conversion to
// Asia/Kolkata happens correctly.
function fmtOpenedAt(v: string | Date | null | undefined): string {
  const d = parseDate(v);
  if (!d) return "—";
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  });
}

/** Human-readable duration between two timestamps. Used by the Closed
 *  Trades tab's "Holding Time" column so admins can spot positions that
 *  were squared off in seconds (likely a misclick) vs ones held for
 *  hours/days. Granularity adapts to magnitude: seconds → "<1m",
 *  minutes → "Xm", under a day → "Xh Ym", longer → "Xd Yh". */
function fmtHoldingTime(
  opened: string | Date | null | undefined,
  closed: string | Date | null | undefined,
): string {
  const a = parseDate(opened);
  const b = parseDate(closed);
  if (!a || !b) return "—";
  const ms = b.getTime() - a.getTime();
  if (ms < 0) return "—";
  if (ms < 60_000) return "<1m";
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const totalHr = Math.floor(totalMin / 60);
  const minPart = totalMin % 60;
  if (totalHr < 24) return minPart > 0 ? `${totalHr}h ${minPart}m` : `${totalHr}h`;
  const days = Math.floor(totalHr / 24);
  const hrPart = totalHr % 24;
  return hrPart > 0 ? `${days}d ${hrPart}h` : `${days}d`;
}

export default function AdminPositionsPage() {
  // useSearchParams must sit inside Suspense for the static prerender
  // to succeed (Next 14 App Router contract).
  return (
    <Suspense fallback={null}>
      <AdminPositionsInner />
    </Suspense>
  );
}

function AdminPositionsInner() {
  const qc = useQueryClient();
  const me = useAdminAuthStore((s) => s.admin);
  const searchParams = useSearchParams();
  const queryUserId = searchParams?.get("user_id") ?? null;
  const [tab, setTab] = useState<"open" | "closed">("open");

  // Resolve the scoped user's code/name for the filter pill — opaque
  // ObjectIds are useless to an admin scanning the page.
  const { data: scopedUser } = useQuery({
    queryKey: ["admin", "user", queryUserId],
    queryFn: () => UsersAPI.detail(queryUserId!),
    enabled: !!queryUserId,
    staleTime: 5 * 60_000,
  });

  const { data: openRows, isFetching: openLoading } = useQuery({
    queryKey: ["admin", "positions", "OPEN", queryUserId],
    queryFn: () => TradingAPI.positions({ status: "OPEN", user_id: queryUserId || undefined }),
    refetchInterval: 5000,
  });

  const { data: closedRows, isFetching: closedLoading } = useQuery({
    queryKey: ["admin", "positions", "CLOSED", queryUserId],
    queryFn: () => TradingAPI.positions({ status: "CLOSED", user_id: queryUserId || undefined }),
    refetchInterval: 10000,
    enabled: tab === "closed",
  });

  const rawRows = tab === "open" ? openRows : closedRows;
  const isFetching = tab === "open" ? openLoading : closedLoading;

  // Free-text search across user_code, user_name, last 8 of user_id,
  // and symbol — admins typing "CL49179" should narrow the table to
  // that user's rows, and typing "BTCUSD" should narrow to that
  // instrument. Client-side because rows are already loaded; this
  // also keeps the search snappy without firing extra REST calls.
  const [search, setSearch] = useState("");
  const data = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rawRows;
    return (rawRows ?? []).filter((r: any) => {
      const code = String(r.user_code ?? "").toLowerCase();
      const name = String(r.user_name ?? "").toLowerCase();
      const uidTail = String(r.user_id ?? "").slice(-8).toLowerCase();
      const sym = String(r.symbol ?? "").toLowerCase();
      return code.includes(q) || name.includes(q) || uidTail.includes(q) || sym.includes(q);
    });
  }, [rawRows, search]);

  // PnL summary (today / current week / last week) — auto-refreshes with
  // the table. Honours the user filter so the dashboard tiles narrow to
  // the same user the per-row table is filtered to (otherwise the tile
  // shows platform-wide totals while the table shows one user — a
  // confusing mismatch the user repeatedly hit on the Closed tab).
  const { data: pnl } = useQuery({
    queryKey: ["admin", "positions", "pnl-summary", queryUserId],
    queryFn: () => TradingAPI.pnlSummary(queryUserId ? { user_id: queryUserId } : undefined),
    refetchInterval: 10000,
  });

  async function squareoff(id: string) {
    if (!confirm("Square off this position at market?")) return;
    try {
      await TradingAPI.squareoff(id);
      toast.success("Squared off");
      qc.invalidateQueries({ queryKey: ["admin", "positions"] });
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function remove(id: string, sym: string) {
    if (!confirm(`Permanently delete position ${sym}? This wipes the record without squaring off — use only for bad data.`)) return;
    try {
      await TradingAPI.deletePosition(id);
      toast.success("Position deleted");
      qc.invalidateQueries({ queryKey: ["admin", "positions"] });
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function emergencyAll() {
    if (!confirm("⚠ EMERGENCY: Square off ALL open positions across the platform?")) return;
    try {
      const r = await TradingAPI.emergencySquareoffAll();
      toast.success(`Squared off ${r.placed}/${r.total} positions`);
      qc.invalidateQueries({ queryKey: ["admin", "positions"] });
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  // ── Edit modal ────────────────────────────────────────────────────
  const [editing, setEditing] = useState<any | null>(null);
  const [form, setForm] = useState<{
    avg_price: string;
    quantity: string;
    opened_at: string;
    stop_loss: string;
    target: string;
  }>({ avg_price: "", quantity: "", opened_at: "", stop_loss: "", target: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) return;
    setForm({
      avg_price: String(editing.avg_price ?? ""),
      quantity: String(editing.quantity ?? ""),
      opened_at: editing.opened_at
        ? new Date(parseDate(editing.opened_at) ?? editing.opened_at).toISOString().slice(0, 16)
        : "",
      stop_loss: editing.stop_loss != null ? String(editing.stop_loss) : "",
      target: editing.target != null ? String(editing.target) : "",
    });
  }, [editing]);

  async function saveEdit() {
    if (!editing) return;
    const patch: Record<string, any> = {};
    if (form.avg_price !== "" && form.avg_price !== String(editing.avg_price))
      patch.avg_price = form.avg_price;
    if (form.quantity !== "" && Number(form.quantity) !== Number(editing.quantity))
      patch.quantity = Number(form.quantity);
    if (form.opened_at) {
      const iso = new Date(form.opened_at).toISOString();
      if (iso !== editing.opened_at) patch.opened_at = iso;
    }
    if (form.stop_loss === "") patch.stop_loss = null;
    else if (Number(form.stop_loss) !== Number(editing.stop_loss ?? 0))
      patch.stop_loss = Number(form.stop_loss);
    if (form.target === "") patch.target = null;
    else if (Number(form.target) !== Number(editing.target ?? 0))
      patch.target = Number(form.target);

    if (Object.keys(patch).length === 0) {
      toast.info("Nothing changed");
      setEditing(null);
      return;
    }
    setSaving(true);
    try {
      await TradingAPI.editPosition(editing.id, patch);
      toast.success("Position updated — user terminal will refresh live");
      qc.invalidateQueries({ queryKey: ["admin", "positions"] });
      setEditing(null);
    } catch (e: any) {
      toast.error(e.message || "Edit failed");
    } finally {
      setSaving(false);
    }
  }

  // Apply the same in-page search to the OPEN rows so the Open PNL
  // card matches the table even when the admin's on the Closed tab
  // — typing "CL49179" should narrow both the visible rows AND the
  // PNL aggregate to that user's exposure.
  const filteredOpenRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return openRows ?? [];
    return (openRows ?? []).filter((r: any) => {
      const code = String(r.user_code ?? "").toLowerCase();
      const name = String(r.user_name ?? "").toLowerCase();
      const uidTail = String(r.user_id ?? "").slice(-8).toLowerCase();
      const sym = String(r.symbol ?? "").toLowerCase();
      return code.includes(q) || name.includes(q) || uidTail.includes(q) || sym.includes(q);
    });
  }, [openRows, search]);

  const totalPnl = filteredOpenRows.reduce(
    (s: number, r: any) => s + Number(r.unrealized_pnl || 0),
    0
  );

  // ── Original column set, plus a new "Hold Time" + polished action buttons ──
  const cols: Column<any>[] = [
    {
      key: "user",
      header: "User",
      render: (r: any) => (
        <div className="flex flex-col leading-tight">
          <span className="text-sm">{r.user_name || "—"}</span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {r.user_code || r.user_id?.slice(-6)}
          </span>
        </div>
      ),
    },
    { key: "owner", header: "Owner", render: (r: any) => <OwnerBadge row={r} me={me} /> },
    { key: "symbol", header: "Symbol" },
    { key: "exchange", header: "Exch" },
    {
      key: "quantity",
      header: "Qty",
      align: "right" as const,
      // For CLOSED rows `quantity` is 0 (FIFO flattens it on the close leg).
      // `opening_quantity` is preserved by position_service — that's the size
      // the user actually traded. Direction comes from `opened_side` so the
      // colour stays correct even though the signed qty is 0.
      render: (r: any) => {
        const isClosed = r.status === "CLOSED";
        const displayQty = isClosed
          ? Math.abs(Number(r.opening_quantity ?? 0))
          : Number(r.quantity);
        const direction = isClosed
          ? String(r.opened_side || "").toUpperCase() === "SELL"
            ? -1
            : 1
          : Number(r.quantity) >= 0
            ? 1
            : -1;
        return (
          <span className={direction >= 0 ? "text-buy" : "text-sell"}>
            {displayQty}
          </span>
        );
      },
    },
    {
      // Lot count column — derives lots from contracts so admins reading the
      // blotter don't have to mental-math QTY/lot_size for every segment
      // (NIFTY OPT lot=75, BANKNIFTY 35, CRUDEOIL 100, MCXM ones smaller,
      // etc.). Falls back to "—" when lot_size is missing or 1 (equities).
      key: "lots",
      header: "Lots",
      align: "right" as const,
      render: (r: any) => {
        const isClosed = r.status === "CLOSED";
        const rawQty = isClosed
          ? Math.abs(Number(r.opening_quantity ?? 0))
          : Math.abs(Number(r.quantity));
        const lotSize = Number(r.lot_size ?? r.instrument?.lot_size ?? 1) || 1;
        if (lotSize <= 1 || rawQty <= 0) return <span>—</span>;
        const lots = rawQty / lotSize;
        // Show whole lots when divisible, else 2-decimal (for fractional
        // forex/crypto). Tabular nums keep the column aligned across rows.
        const text = Number.isInteger(lots) ? String(lots) : lots.toFixed(2);
        return <span className="tabular-nums">{text}</span>;
      },
    },
    {
      key: "avg_price",
      header: "Open Price",
      align: "right" as const,
      render: (r: any) => fmtFeedPrice(r.avg_price, r.currency_quote),
    },
    {
      // For closed positions, `ltp` was set to the actual close price by
      // position_service.apply_trade — so the same field doubles as "Close".
      // Header swaps too so the Closed Trades tab reads just "Close"
      // (user feedback: "close price likho bs upar me") and the Open
      // Trades tab still reads "LTP" since that's the live mark.
      key: "ltp",
      header: tab === "closed" ? "Close" : "LTP",
      align: "right" as const,
      render: (r: any) => (
        <span title={r.status === "CLOSED" ? "Closing price" : "Live LTP"}>
          {fmtFeedPrice(r.ltp, r.currency_quote)}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (r: any) => <StatusPill status={r.status} />,
    },
    {
      key: "realized_pnl",
      header: "Realized",
      align: "right" as const,
      // NET realised — gross realized_pnl minus the brokerage / other
      // charges stamped on this position's lifecycle trades. The
      // backend ships both fields; we subtract here so the admin and
      // the user's APK card show IDENTICAL ₹ amounts on the same
      // trade (APK has been net-of-charges since the user-facing
      // /positions/closed endpoint started subtracting them — see
      // backend/app/api/v1/user/positions.py:closed_positions).
      // Hover-title carries the gross + charges decomposition so
      // admins can still see the underlying components when reconciling.
      render: (r: any) => {
        const gross = Number(r.realized_pnl ?? 0);
        const charges = Number(r.charges ?? 0);
        const net = gross - charges;
        return (
          <span
            className={pnlColor(net)}
            title={`Gross ${formatINR(gross)} − Charges ${formatINR(charges)}`}
          >
            {formatINR(net)}
          </span>
        );
      },
    },
    // M2M column is only meaningful on OPEN positions (mark-to-market on
    // the still-live price). For CLOSED rows it's mathematically 0 by
    // definition (qty = 0), so we hide the column entirely on the Closed
    // Trades tab — user explicitly asked for it removed there ("close
    // trade se m2m bhi remove kar dena"). The realised number on the
    // closed row already tells the full story.
    ...(tab === "closed"
      ? []
      : [
          {
            key: "unrealized_pnl",
            header: "M2M",
            align: "right" as const,
            render: (r: any) => (
              <span className={pnlColor(r.unrealized_pnl)}>
                {formatINR(r.unrealized_pnl)}
              </span>
            ),
          },
        ]),
    { key: "margin_used", header: "Margin", align: "right" as const, render: (r: any) => formatINR(r.margin_used) },
    {
      key: "opened_at",
      header: "Opened",
      render: (r: any) => (
        <span className="whitespace-nowrap font-tabular">
          {fmtOpenedAt(r.opened_at)}
        </span>
      ),
    },
    // Holding Time — only meaningful on the Closed Trades tab where
    // both ends of the window exist. Helps the admin spot 30-second
    // misclicks vs multi-hour intentional holds at a glance.
    ...(tab === "closed"
      ? [
          {
            key: "holding_time",
            header: "Holding Time",
            align: "right" as const,
            render: (r: any) => (
              <span
                className="whitespace-nowrap font-tabular text-muted-foreground"
                title={r.closed_at ?? undefined}
              >
                {fmtHoldingTime(r.opened_at, r.closed_at)}
              </span>
            ),
          },
        ]
      : []),
    // Only meaningful for CLOSED rows. Renders the close_reason as a
    // color-coded chip so super-admins can spot at a glance which
    // closes were user-initiated vs bracket auto-fires vs stop-outs.
    {
      key: "close_reason",
      header: "Closed By",
      render: (r: any) =>
        r.status === "CLOSED" ? (
          <CloseReasonChip reason={r.close_reason} />
        ) : (
          <span className="text-muted-foreground/40">—</span>
        ),
    },
    {
      key: "actions",
      header: "",
      align: "right" as const,
      render: (r: any) => (
        <div className="flex items-center justify-end gap-1.5">
          {r.status === "OPEN" && (
            <>
              <Button
                size="sm"
                onClick={() => setEditing(r)}
                className="h-7 gap-1 rounded-md bg-blue-600 px-2.5 text-xs font-semibold text-white hover:bg-blue-700"
              >
                <Pencil className="size-3.5" /> Edit
              </Button>
              <Button
                size="sm"
                onClick={() => squareoff(r.id)}
                className="h-7 gap-1 rounded-md bg-destructive px-2.5 text-xs font-semibold text-destructive-foreground hover:bg-destructive/90"
              >
                <X className="size-3.5" /> Close
              </Button>
            </>
          )}
          <Button
            size="sm"
            onClick={() => remove(r.id, r.symbol)}
            aria-label="Delete record"
            title="Delete record (no square-off)"
            className="size-7 rounded-md bg-destructive/15 p-0 text-destructive ring-1 ring-inset ring-destructive/30 hover:bg-destructive hover:text-destructive-foreground hover:ring-destructive"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ),
    },
  ].filter(
    // Defensive belt-and-braces filter: even if the conditional spread
    // above (which inserts the M2M col only on the open tab) ever
    // regresses, this guarantees the M2M column never reaches the
    // table on the Closed Trades tab. User explicitly asked for the
    // column to disappear there twice — keeping both gates ensures
    // a single stray rewrite can't bring it back.
    (c) => !(tab === "closed" && c.key === "unrealized_pnl"),
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Position Management"
        description={`${openRows?.length ?? 0} open · Live M2M: ${formatINR(totalPnl)}`}
        actions={
          <Button variant="destructive" onClick={emergencyAll}>
            <AlertOctagon className="size-4" /> Emergency square-off all
          </Button>
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
            href="/positions"
            className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            aria-label="Clear user filter"
          >
            <XIcon className="size-3" />
          </Link>
        </div>
      )}

      {/* ── PnL summary cards ─────────────────────────────────────── */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {/* Open PNL: use the live, filter-aware sum of the visible
            open-trade rows rather than the platform-wide summary
            endpoint. The summary endpoint sums ALL open positions
            across every user — so when the page was scoped via
            `?user_id=…` the card kept showing the global number while
            the table below showed only the scoped user's. `totalPnl`
            is recomputed from `openRows` which already honours the
            user filter, so the card and the table now stay in
            lockstep regardless of scope. */}
        <PnlCard
          label="Open PNL"
          value={totalPnl}
          hint={
            queryUserId
              ? "Unrealised M2M on this user's open positions"
              : "Unrealised M2M on currently open positions"
          }
          icon={totalPnl >= 0 ? TrendingUp : TrendingDown}
        />
        <PnlCard
          label="This Week's Closed PNL"
          value={pnl?.week_realised ?? 0}
          hint="Sun → today (IST) — realised only"
          icon={(pnl?.week_realised ?? 0) >= 0 ? TrendingUp : TrendingDown}
        />
        <PnlCard
          label="Last Week's Closed PNL"
          value={pnl?.last_week_pnl ?? 0}
          hint="Previous Sun → Sat — realised only"
          icon={CalendarDays}
        />
      </section>

      {/* ── Tabs + in-page user/symbol search ──────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-md border border-border bg-muted/30 p-1 text-sm">
          {(["open", "closed"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                "rounded px-3 py-1.5 transition-colors",
                tab === t ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t === "open" ? "Open Trades" : "Closed Trades"}
            </button>
          ))}
        </div>

        <div className="relative ml-auto w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search user code / name / symbol"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 pr-8"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          )}
        </div>

        {search && (
          <div className="basis-full text-xs text-muted-foreground">
            Showing {data?.length ?? 0} of {rawRows?.length ?? 0} {tab === "open" ? "open" : "closed"} rows · search "{search}"
          </div>
        )}
      </div>

      <DataTable
        columns={cols}
        rows={data}
        keyExtractor={(r) => r.id}
        loading={isFetching && !data}
        rowClassName={(r) =>
          tab === "open" && Number(r.unrealized_pnl) < -Number(r.margin_used) * 0.5
            ? "bg-destructive/5"
            : tab === "open" && Number(r.unrealized_pnl) < -Number(r.margin_used) * 0.25
              ? "bg-atm/5"
              : undefined
        }
      />

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit position</DialogTitle>
            <DialogDescription>
              {editing
                ? `${editing.symbol} · ${editing.product_type} · qty ${editing.quantity}`
                : ""}
              <br />
              <span className="text-[11px]">User receives a live update — no refresh needed.</span>
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 py-2 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Entry price</Label>
              <Input
                type="number"
                step="0.05"
                value={form.avg_price}
                onChange={(e) => setForm((p) => ({ ...p, avg_price: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Quantity (signed)</Label>
              <Input
                type="number"
                step="any"
                value={form.quantity}
                onChange={(e) => setForm((p) => ({ ...p, quantity: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Opened at</Label>
              <Input
                type="datetime-local"
                value={form.opened_at}
                onChange={(e) => setForm((p) => ({ ...p, opened_at: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Stop loss (blank = clear)</Label>
              <Input
                type="number"
                step="0.05"
                value={form.stop_loss}
                onChange={(e) => setForm((p) => ({ ...p, stop_loss: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Target (blank = clear)</Label>
              <Input
                type="number"
                step="0.05"
                value={form.target}
                onChange={(e) => setForm((p) => ({ ...p, target: e.target.value }))}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={saveEdit} loading={saving}>
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// PnL summary card
// ─────────────────────────────────────────────────────────────────
function PnlCard({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string;
  value: number | string;
  hint?: string;
  icon?: any;
}) {
  const n = Number(value ?? 0);
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between pb-2">
        <CardDescription>{label}</CardDescription>
        {Icon && <Icon className={cn("size-4", pnlColor(n))} />}
      </CardHeader>
      <CardContent className="space-y-1">
        <div className={cn("font-tabular text-2xl font-semibold", pnlColor(n))}>
          {formatINR(n)}
        </div>
        {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

