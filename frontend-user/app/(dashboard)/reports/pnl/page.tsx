"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowUpRight, BarChart3, Receipt, TrendingDown, TrendingUp } from "lucide-react";
import { ReportsAPI } from "@/lib/api";
import { PageHeader } from "@/components/common/PageHeader";
import { DataTable, type Column } from "@/components/common/DataTable";
import { ReportPdfButton } from "@/components/common/ReportPdfButton";
import { DateRangeBar, toIsoFrom, toIsoTo, type DateRange } from "@/components/common/DateRangeBar";
import { Card } from "@/components/ui/card";
import { cn, formatINR, pnlColor } from "@/lib/utils";

export default function PnlReportPage() {
  // Default to last 30 days so first paint matches the historical
  // page title ("Last 30 days · By symbol") and the backend default.
  const [range, setRange] = useState<DateRange>(() => {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 30);
    const iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { from: iso(from), to: iso(to) };
  });

  const params = useMemo(
    () => ({ from_date: toIsoFrom(range.from), to_date: toIsoTo(range.to) }),
    [range],
  );

  const { data, isFetching } = useQuery({
    queryKey: ["reports", "pnl", params],
    queryFn: () => ReportsAPI.pnl(params),
    placeholderData: (prev) => prev,
  });

  const rows = (data?.by_symbol ?? []) as any[];
  const netPnl = Number(data?.net_pnl ?? 0);
  const grossPnl = Number((data?.total_sell_value ?? 0) - (data?.total_buy_value ?? 0));
  const charges = Number(data?.total_charges ?? 0);

  const cols: Column<any>[] = [
    { key: "symbol", header: "Symbol", render: (r) => <span className="font-medium">{r.symbol}</span> },
    { key: "buy_qty", header: "Buy qty", align: "right" },
    { key: "sell_qty", header: "Sell qty", align: "right" },
    { key: "buy_value", header: "Buy value", align: "right", render: (r) => formatINR(r.buy_value) },
    { key: "sell_value", header: "Sell value", align: "right", render: (r) => formatINR(r.sell_value) },
    { key: "charges", header: "Charges", align: "right", render: (r) => <span className="text-muted-foreground">{formatINR(r.charges)}</span> },
    {
      key: "pnl",
      header: "Net P&L",
      align: "right",
      render: (r) => (
        <span className={cn("font-semibold tabular-nums", pnlColor(r.pnl))}>
          {Number(r.pnl) > 0 ? "+" : ""}
          {formatINR(r.pnl)}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="P&L report"
        description="Realised profit & loss grouped by symbol."
        actions={<ReportPdfButton kind="pnl" params={params} />}
      />

      <DateRangeBar value={range} onChange={setRange} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Trades"
          value={String(data?.total_trades ?? 0)}
          icon={BarChart3}
        />
        <Stat
          label="Gross P&L"
          value={formatINR(grossPnl)}
          icon={grossPnl >= 0 ? ArrowUpRight : ArrowDownLeft}
          tone={grossPnl >= 0 ? "profit" : grossPnl < 0 ? "loss" : "muted"}
        />
        <Stat
          label="Charges"
          value={formatINR(charges)}
          icon={Receipt}
          tone="muted"
        />
        <Stat
          label="Net P&L"
          value={formatINR(netPnl)}
          icon={netPnl >= 0 ? TrendingUp : TrendingDown}
          tone={netPnl >= 0 ? "profit" : netPnl < 0 ? "loss" : "muted"}
          emphasis
        />
      </div>

      {/* Desktop: standard table. Mobile: stacked cards because a 7-column
          table on a 360-wide screen forces horizontal scrolling — the
          operator's 21-May UX feedback was specifically that this page
          looked broken on phone. */}
      <div className="hidden md:block">
        <DataTable
          columns={cols}
          rows={rows}
          keyExtractor={(r) => r.symbol}
          loading={isFetching && !data}
          empty="No trades in the selected period."
        />
      </div>
      <div className="md:hidden">
        <MobileSymbolList rows={rows} loading={isFetching && !data} />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
  tone = "default",
  emphasis = false,
}: {
  label: string;
  value: string;
  icon?: any;
  tone?: "default" | "profit" | "loss" | "muted";
  emphasis?: boolean;
}) {
  const toneClass =
    tone === "profit"
      ? "text-profit"
      : tone === "loss"
      ? "text-loss"
      : tone === "muted"
      ? "text-muted-foreground"
      : "";
  return (
    <Card className={cn("p-3 sm:p-4", emphasis && "ring-1 ring-primary/30")}>
      <div className="flex items-start justify-between gap-2">
        <span className="truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground sm:text-xs">
          {label}
        </span>
        {Icon && <Icon className={cn("size-3.5 shrink-0 sm:size-4", toneClass)} />}
      </div>
      <div className={cn("mt-1 text-base font-semibold tabular-nums sm:mt-1.5 sm:text-2xl", toneClass)}>
        {value}
      </div>
    </Card>
  );
}

function MobileSymbolList({ rows, loading }: { rows: any[]; loading: boolean }) {
  if (loading && rows.length === 0) {
    return (
      <Card className="p-6 text-center text-sm text-muted-foreground">Loading…</Card>
    );
  }
  if (rows.length === 0) {
    return (
      <Card className="p-6 text-center text-sm text-muted-foreground">
        No trades in the selected period.
      </Card>
    );
  }
  return (
    <div className="space-y-2">
      {rows.map((r) => {
        const pnl = Number(r.pnl ?? 0);
        return (
          <Card key={r.symbol} className="p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold">{r.symbol}</span>
              <span className={cn("font-semibold tabular-nums", pnlColor(pnl))}>
                {pnl > 0 ? "+" : ""}
                {formatINR(pnl)}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <Row label="Buy qty" value={String(r.buy_qty ?? 0)} />
              <Row label="Sell qty" value={String(r.sell_qty ?? 0)} />
              <Row label="Buy value" value={formatINR(r.buy_value)} />
              <Row label="Sell value" value={formatINR(r.sell_value)} />
              <Row label="Charges" value={formatINR(r.charges)} muted />
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function Row({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("tabular-nums", muted && "text-muted-foreground")}>{value}</span>
    </div>
  );
}
