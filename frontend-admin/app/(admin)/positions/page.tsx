"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertOctagon, CalendarDays, Info, Pencil, RotateCcw, Search, TrendingDown, TrendingUp, Trash2, X, X as XIcon } from "lucide-react";
import { TradingAPI, UsersAPI } from "@/lib/api";
import { useMarketStream } from "@/lib/useMarketStream";
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
import { Pagination } from "@/components/common/Pagination";
import { NettingEntriesDialog } from "@/components/admin/NettingEntriesDialog";
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
 *  hours/days. Granularity is PRECISE down to the second so a "0s"
 *  misclick and a "47s" panic-close are visibly different — operator
 *  flagged 22-May that "<1m" collapsed too many useful states into one
 *  bucket. Format ladder:
 *    under 1 min → "Xs"
 *    under 1 hr  → "Xm Ys"   (or "Xm" when Y == 0)
 *    under 1 day → "Xh Ym"   (or "Xh" when Y == 0)
 *    anything else → "Xd Yh" (or "Xd" when Y == 0) */
function fmtHoldingTime(
  opened: string | Date | null | undefined,
  closed: string | Date | null | undefined,
): string {
  const a = parseDate(opened);
  const b = parseDate(closed);
  if (!a || !b) return "—";
  const ms = b.getTime() - a.getTime();
  if (ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const secPart = totalSec % 60;
  if (totalMin < 60) {
    return secPart > 0 ? `${totalMin}m ${secPart}s` : `${totalMin}m`;
  }
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

  // Live PnL overlay — subscribe to every open position's instrument
  // token via the WS pump (250 ms server tick, throttled to ~500 ms
  // display by the hook). Without this the admin table refreshed at
  // the REST poll's 5 s cadence while the user app screen the admin
  // was comparing against ticked sub-second — operators complained
  // "PnL admin me slow ho raha hai". Overlay rebuilds `ltp` +
  // `unrealized_pnl` per row using the same close-side rule the
  // backend matching engine fills at (long → bid, short → ask, LTP
  // fallback) so the number lines up exactly with what the user app
  // shows.
  const openTokens = useMemo(
    () =>
      Array.from(
        new Set(
          (openRows ?? [])
            .map((r: any) => String(r.instrument_token ?? r.token ?? ""))
            .filter(Boolean),
        ),
      ),
    [openRows],
  );
  // Only subscribe while the user is on the Open tab — Closed tab
  // rows have frozen prices and the WS noise would be pure waste.
  const liveQuotes = useMarketStream(tab === "open" ? openTokens : []);

  const openRowsLive = useMemo(() => {
    if (tab !== "open" || liveQuotes.size === 0) return openRows;
    return (openRows ?? []).map((r: any) => {
      const tok = String(r.instrument_token ?? r.token ?? "");
      const live = tok ? liveQuotes.get(tok) : undefined;
      if (!live) return r;
      const qty = Number(r.quantity ?? 0);
      const isLong = qty >= 0;
      const liveLtp = Number(live.ltp ?? 0) || Number(r.ltp) || 0;
      const bid = Number(live.bid ?? 0);
      const ask = Number(live.ask ?? 0);
      const closePrice = (isLong ? bid : ask) || liveLtp;
      if (!closePrice) return r;
      const avg = Number(r.avg_price ?? 0);
      const newPnl =
        Number.isFinite(avg) && Number.isFinite(qty)
          ? (closePrice - avg) * qty
          : Number(r.unrealized_pnl ?? 0);
      return { ...r, ltp: closePrice, unrealized_pnl: newPnl };
    });
  }, [openRows, liveQuotes, tab]);

  const rawRowsLive = tab === "open" ? openRowsLive : closedRows;

  // Free-text search across user_code, user_name, last 8 of user_id,
  // and symbol — admins typing "CL49179" should narrow the table to
  // that user's rows, and typing "BTCUSD" should narrow to that
  // instrument. Client-side because rows are already loaded; this
  // also keeps the search snappy without firing extra REST calls.
  const [search, setSearch] = useState("");
  const data = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rawRowsLive;
    return (rawRowsLive ?? []).filter((r: any) => {
      const code = String(r.user_code ?? "").toLowerCase();
      const name = String(r.user_name ?? "").toLowerCase();
      const uidTail = String(r.user_id ?? "").slice(-8).toLowerCase();
      const sym = String(r.symbol ?? "").toLowerCase();
      return code.includes(q) || name.includes(q) || uidTail.includes(q) || sym.includes(q);
    });
  }, [rawRowsLive, search]);

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

  async function remove(id: string, sym: string, status?: string, qty?: number) {
    // Delete on OPEN rows is a sharper edge than delete on closed rows:
    // the backend will RELEASE the locked margin back to available_balance
    // but will NOT book any PnL (the position never closed at a real
    // market price). Closed rows still get their realised PnL reversed
    // via the existing REVERSAL ledger entry. Show the right warning so
    // the operator picks the right tool.
    const isOpenForceDelete =
      status === "OPEN" && qty != null && Math.abs(Number(qty)) > 1e-9;
    const message = isOpenForceDelete
      ? (
        `Force-delete OPEN position ${sym}?\n\n` +
        `This will:\n` +
        `  • Release the locked margin back to the user's wallet\n` +
        `  • NOT book any PnL (the position never closed at a market price)\n` +
        `  • Delete the row permanently\n\n` +
        `Use ONLY for stale / corrupt rows. For a normal exit, click Close instead.`
      )
      : `Permanently delete position ${sym}? This wipes the record without squaring off — use only for bad data.`;
    if (!confirm(message)) return;
    try {
      await TradingAPI.deletePosition(id);
      toast.success(
        isOpenForceDelete
          ? "Position deleted · margin released to wallet"
          : "Position deleted",
      );
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
  // Position-id of the row whose Netting Entries drilldown is open. `null`
  // when the dialog is closed. Drives both Open + Closed tabs since the
  // backend endpoint supports both.
  const [nettingId, setNettingId] = useState<string | null>(null);
  const [form, setForm] = useState<{
    avg_price: string;
    quantity: string;
    opened_at: string;
    stop_loss: string;
    target: string;
    // Closed-only fields. Editing realized_pnl on a closed row writes
    // a REVERSAL ledger entry on the backend so the wallet running
    // balance stays consistent with the new figure on the trade card.
    realized_pnl: string;
    close_reason: string;
  }>({
    avg_price: "",
    quantity: "",
    opened_at: "",
    stop_loss: "",
    target: "",
    realized_pnl: "",
    close_reason: "",
  });
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
      realized_pnl: editing.realized_pnl != null ? String(editing.realized_pnl) : "",
      close_reason: editing.close_reason ?? "",
    });
  }, [editing]);

  async function saveEdit() {
    if (!editing) return;
    const isClosed = editing.status === "CLOSED";
    const patch: Record<string, any> = {};
    // Open-row edits are meaningless on closed rows (avg/qty/opened_at/SL/TP
    // describe a live position). Only forward them when the row is still
    // OPEN — otherwise the backend would reject `quantity` change on a
    // CLOSED row anyway.
    if (!isClosed) {
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
    } else {
      // Closed-row corrections — admin can override realised P&L
      // (wallet auto-adjusts via REVERSAL) and relabel close_reason.
      if (
        form.realized_pnl !== "" &&
        Number(form.realized_pnl) !== Number(editing.realized_pnl ?? 0)
      ) {
        patch.realized_pnl = Number(form.realized_pnl);
      }
      if (form.close_reason !== (editing.close_reason ?? "")) {
        patch.close_reason = form.close_reason || null;
      }
    }

    if (Object.keys(patch).length === 0) {
      toast.info("Nothing changed");
      setEditing(null);
      return;
    }
    setSaving(true);
    try {
      await TradingAPI.editPosition(editing.id, patch);
      toast.success(
        isClosed
          ? "Closed trade updated — wallet auto-adjusted via reversal"
          : "Position updated — user terminal will refresh live",
      );
      qc.invalidateQueries({ queryKey: ["admin", "positions"] });
      setEditing(null);
    } catch (e: any) {
      toast.error(e.message || "Edit failed");
    } finally {
      setSaving(false);
    }
  }

  async function reopen(p: any) {
    // Reopen confirmation — this writes a wallet REVERSAL of the
    // realised P&L and restores the position to OPEN with re-blocked
    // margin. Show the exact reversal amount in the confirm so the
    // admin knows the wallet impact before clicking through.
    const realized = Number(p.realized_pnl ?? 0);
    const direction = realized > 0 ? "debit" : "credit";
    const msg =
      `Reopen ${p.symbol}?\n\n` +
      `This will:\n` +
      `  • Set the position back to OPEN with the original ${Math.abs(
        Number(p.opening_quantity ?? p.quantity ?? 0),
      )} qty\n` +
      `  • ${direction.charAt(0).toUpperCase() + direction.slice(1)} ` +
      `₹${Math.abs(realized).toFixed(2)} on the user's wallet (REVERSAL)\n` +
      `  • Re-block the margin\n` +
      `\nUse only to undo a wrong close (false stop-out, misclick).`;
    if (!window.confirm(msg)) return;
    try {
      await TradingAPI.reopenPosition(p.id);
      toast.success(`${p.symbol} reopened — wallet reversed`);
      qc.invalidateQueries({ queryKey: ["admin", "positions"] });
    } catch (e: any) {
      toast.error(e.message || "Reopen failed");
    }
  }

  // Apply the same in-page search to the OPEN rows so the Open PNL
  // card matches the table even when the admin's on the Closed tab
  // — typing "CL49179" should narrow both the visible rows AND the
  // PNL aggregate to that user's exposure.
  const filteredOpenRows = useMemo(() => {
    // Use the WS-overlaid `openRowsLive` so the Open-PnL header tile
    // ticks at the same 500 ms cadence as the table rows below — was
    // `openRows` (raw REST) which made the header lag 5 s behind the
    // body and confused operators ("number niche change ho rha, upar
    // wahi pe ruka hai").
    const base = openRowsLive ?? openRows ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return base;
    return base.filter((r: any) => {
      const code = String(r.user_code ?? "").toLowerCase();
      const name = String(r.user_name ?? "").toLowerCase();
      const uidTail = String(r.user_id ?? "").slice(-8).toLowerCase();
      const sym = String(r.symbol ?? "").toLowerCase();
      return code.includes(q) || name.includes(q) || uidTail.includes(q) || sym.includes(q);
    });
  }, [openRowsLive, openRows, search]);

  const totalPnl = filteredOpenRows.reduce(
    (s: number, r: any) => s + Number(r.unrealized_pnl || 0),
    0
  );

  // Client-side pagination — backend returns up to 500 rows in one shot.
  // Slicing on the client keeps the DOM small (50–200 rows per page) so
  // the table stays smooth on accounts with hundreds of closed positions.
  // Live PnL on the Open tab still works because openRowsLive is computed
  // BEFORE pagination — totalPnl tile remains the full visible-rows sum.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  useEffect(() => {
    setPage(1);
  }, [tab, queryUserId, search]);
  const pagedData = useMemo(() => {
    const all = data ?? [];
    const start = (page - 1) * pageSize;
    return all.slice(start, start + pageSize);
  }, [data, page, pageSize]);

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
      // Direction the user opened on. `opened_side` is stable across the
      // position's lifecycle (preserved by position_service even after a
      // full close drops `quantity` to 0), so the Closed Trades view shows
      // the original BUY/SELL just as clearly as the Open Trades view.
      key: "opened_side",
      header: "Side",
      render: (r: any) => {
        const raw = (r.opened_side || (Number(r.quantity) >= 0 ? "BUY" : "SELL"))
          .toString()
          .toUpperCase();
        const isBuy = raw === "BUY";
        return (
          <span
            className={cn(
              "inline-flex min-w-[44px] items-center justify-center rounded px-1.5 py-0.5 text-[11px] font-semibold",
              isBuy
                ? "bg-emerald-500/15 text-emerald-500"
                : "bg-red-500/15 text-red-500",
            )}
          >
            {raw}
          </span>
        );
      },
    },
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
      // Volume = total lot count (contracts ÷ lot_size). Renders "—" for
      // equity rows where lot_size is 1 (Qty already conveys the size).
      // Cell carries a small (i) icon as a visual affordance — clicking
      // anywhere in the row opens the per-position Netting Entries
      // breakdown, and admins were missing the click cue without an
      // explicit indicator. Tabular-nums alignment keeps a column of
      // mixed integer / decimal values visually clean.
      key: "volume",
      header: "Volume",
      align: "right" as const,
      render: (r: any) => {
        const isClosed = r.status === "CLOSED";
        const rawQty = isClosed
          ? Math.abs(Number(r.opening_quantity ?? 0))
          : Math.abs(Number(r.quantity));
        const lotSize = Number(r.lot_size ?? r.instrument?.lot_size ?? 1) || 1;
        if (lotSize <= 1 || rawQty <= 0) {
          return (
            <span className="inline-flex items-center justify-end gap-1.5">
              <span>—</span>
              <Info
                className="size-3 text-muted-foreground/60"
                aria-label="Click row to view netting entries"
              />
            </span>
          );
        }
        const lots = rawQty / lotSize;
        const text = Number.isInteger(lots) ? String(lots) : lots.toFixed(2);
        return (
          <span
            className="inline-flex items-center justify-end gap-1.5"
            title="Click row to view netting entries"
          >
            <span className="tabular-nums">{text}</span>
            <Info className="size-3 text-primary/70" />
          </span>
        );
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
      // GROSS realised P&L — straight from `position.realized_pnl`,
      // before brokerage / other charges are subtracted. The "Net
      // P&L" column further right does the subtraction explicitly
      // so the admin can see the arithmetic happen on screen:
      //
      //     REALIZED (gross) − BROKERAGE = NET P&L
      //
      // Previously this column quietly displayed net by subtracting
      // charges, which confused operators who reconciled the row
      // (e.g. open 317.85 → close 324.15 × 60 lots = ₹378 gross, but
      // the column showed ₹258 because we'd already netted out
      // ₹120 of brokerage). Showing gross here keeps the column's
      // name honest and lets the new Net P&L column carry the
      // final figure.
      render: (r: any) => {
        const gross = Number(r.realized_pnl ?? 0);
        return (
          <span className={pnlColor(gross)}>
            {formatINR(gross)}
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
    {
      // Total brokerage paid across this position's lifecycle (open
      // leg + close leg if closed). Backend's `charges` field already
      // sums every Trade row within the position's open-close window
      // — see _charges_for() in admin/trading.py. User feedback:
      // "margin column hata ke total close+open brokerage dikhao" —
      // margin tells the admin nothing on the Closed tab (it's 0
      // there anyway) and on the Open tab it duplicates info already
      // visible in the user's wallet strip; total brokerage is what
      // the admin actually audits.
      key: "charges",
      header: "Brokerage",
      align: "right" as const,
      render: (r: any) => (
        <span
          title="Total brokerage (open leg + close leg)"
          className="tabular-nums"
        >
          {formatINR(Number(r.charges ?? 0))}
        </span>
      ),
    },
    {
      // Net P&L — the bottom-line number the admin actually cares
      // about: gross realised minus brokerage / other charges. Lives
      // right after the Brokerage column so the math
      //     REALIZED − BROKERAGE = NET P&L
      // reads left-to-right on a single row. Same definition the
      // PnlCard tiles above use, so per-row sums reconcile against
      // the "This Week's Net P&L" total without an explanation.
      key: "net_pnl",
      header: "Net P&L",
      align: "right" as const,
      render: (r: any) => {
        const gross = Number(r.realized_pnl ?? 0);
        const charges = Number(r.charges ?? 0);
        const net = gross - charges;
        return (
          <span
            className={`${pnlColor(net)} font-semibold`}
            title={`Realized ${formatINR(gross)} − Brokerage ${formatINR(charges)}`}
          >
            {formatINR(net)}
          </span>
        );
      },
    },
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
      // `e.stopPropagation()` on every action button so clicking them
      // doesn't also fire the row-level netting drilldown dialog (the
      // <tr> has its own onClick now). Without this, "Close" would
      // squareoff AND pop open the breakdown — visually noisy and the
      // edit form would land on a faded background.
      render: (r: any) => (
        <div
          className="flex items-center justify-end gap-1.5"
          onClick={(e) => e.stopPropagation()}
        >
          {r.status === "OPEN" && (
            <>
              <Button
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditing(r);
                }}
                className="h-7 gap-1 rounded-md bg-blue-600 px-2.5 text-xs font-semibold text-white hover:bg-blue-700"
              >
                <Pencil className="size-3.5" /> Edit
              </Button>
              <Button
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  squareoff(r.id);
                }}
                className="h-7 gap-1 rounded-md bg-destructive px-2.5 text-xs font-semibold text-destructive-foreground hover:bg-destructive/90"
              >
                <X className="size-3.5" /> Close
              </Button>
            </>
          )}
          {r.status === "CLOSED" && (
            <>
              {/* Edit closed trade — admin can correct realised P&L
                  and relabel close_reason. Wallet auto-adjusts via
                  REVERSAL on the backend so the running balance
                  stays consistent with the new figure. */}
              <Button
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditing(r);
                }}
                aria-label="Edit closed trade"
                title="Edit realised P&L / close reason"
                className="h-7 gap-1 rounded-md bg-blue-600 px-2.5 text-xs font-semibold text-white hover:bg-blue-700"
              >
                <Pencil className="size-3.5" /> Edit
              </Button>
              {/* Reopen — flip CLOSED → OPEN with the original qty,
                  reverse the wallet P&L impact, re-block margin.
                  Used to undo a false stop-out / misclick close. */}
              <Button
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  reopen(r);
                }}
                aria-label="Reopen position"
                title="Reopen this position (reverses wallet P&L)"
                className="h-7 gap-1 rounded-md bg-amber-600 px-2.5 text-xs font-semibold text-white hover:bg-amber-700"
              >
                <RotateCcw className="size-3.5" /> Reopen
              </Button>
            </>
          )}
          <Button
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              remove(r.id, r.symbol, r.status, r.quantity);
            }}
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
          label="This Week's Net P&L"
          value={pnl?.week_realised ?? 0}
          hint="Sun → today (IST) — net of brokerage"
          icon={(pnl?.week_realised ?? 0) >= 0 ? TrendingUp : TrendingDown}
        />
        <PnlCard
          label="Last Week's Net P&L"
          value={pnl?.last_week_pnl ?? 0}
          hint="Previous Sun → Sat — net of brokerage"
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
        rows={pagedData}
        keyExtractor={(r) => r.id}
        loading={isFetching && !data}
        onRowClick={(r: any) => setNettingId(String(r.id))}
        rowClassName={(r) =>
          tab === "open" && Number(r.unrealized_pnl) < -Number(r.margin_used) * 0.5
            ? "bg-destructive/5"
            : tab === "open" && Number(r.unrealized_pnl) < -Number(r.margin_used) * 0.25
              ? "bg-atm/5"
              : undefined
        }
      />

      <Pagination
        page={page}
        pageSize={pageSize}
        total={data?.length ?? 0}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        pageSizeOptions={[25, 50, 100, 200]}
      />

      {/* Row-click opens the per-position fill breakdown. Same dialog
          serves Open + Closed tabs — the backend endpoint handles both
          statuses and the modal renders identically. */}
      <NettingEntriesDialog
        positionId={nettingId}
        onClose={() => setNettingId(null)}
      />

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editing?.status === "CLOSED" ? "Edit closed trade" : "Edit position"}
            </DialogTitle>
            <DialogDescription>
              {editing
                ? `${editing.symbol} · ${editing.product_type} · qty ${editing.quantity}`
                : ""}
              <br />
              <span className="text-[11px]">
                {editing?.status === "CLOSED"
                  ? "Wallet auto-adjusts via REVERSAL when realised P&L changes."
                  : "User receives a live update — no refresh needed."}
              </span>
            </DialogDescription>
          </DialogHeader>

          {editing?.status === "CLOSED" ? (
            <div className="grid gap-3 py-2 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label>Realised P&L (signed)</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={form.realized_pnl}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, realized_pnl: e.target.value }))
                  }
                  placeholder="e.g. 258.00 for a profit, -540.00 for a loss"
                />
                <p className="text-[10px] text-muted-foreground">
                  Difference vs current value is posted to the user's wallet
                  as a REVERSAL transaction.
                </p>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label>Closed by (relabel)</Label>
                <select
                  value={form.close_reason}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, close_reason: e.target.value }))
                  }
                  className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                >
                  <option value="">— unset —</option>
                  <option value="USER">USER (user-initiated)</option>
                  <option value="SL_HIT">SL_HIT (stop-loss hit)</option>
                  <option value="TP_HIT">TP_HIT (target hit)</option>
                  <option value="STOP_OUT">STOP_OUT (risk auto-flatten)</option>
                  <option value="ADMIN">ADMIN (manual close)</option>
                  <option value="EOD">EOD (auto-rollover)</option>
                </select>
              </div>
            </div>
          ) : (
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
          )}

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

