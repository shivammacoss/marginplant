"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ReportsAPI } from "@/lib/api";
import { PageHeader } from "@/components/common/PageHeader";
import { DataTable, type Column } from "@/components/common/DataTable";
import { Pagination } from "@/components/common/Pagination";
import { StatusPill } from "@/components/common/StatusPill";
import { ReportPdfButton } from "@/components/common/ReportPdfButton";
import { DateRangeBar, toIsoFrom, toIsoTo, type DateRange } from "@/components/common/DateRangeBar";
import { Card } from "@/components/ui/card";
import { cn, formatINR, formatPrice } from "@/lib/utils";

export default function TradebookPage() {
  const [range, setRange] = useState<DateRange>(() => {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 30);
    const iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { from: iso(from), to: iso(to) };
  });

  const params = useMemo(
    () => ({ from_date: toIsoFrom(range.from), to_date: toIsoTo(range.to), limit: 1000 }),
    [range],
  );

  const { data, isFetching } = useQuery({
    queryKey: ["reports", "tradebook", params],
    queryFn: () => ReportsAPI.tradebook(params),
    placeholderData: (prev) => prev,
  });

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  // Range change → bounce back to page 1 so pagination never lands on
  // a page that no longer exists in the smaller filtered set.
  useEffect(() => {
    setPage(1);
  }, [range.from, range.to]);

  const allRows = (data ?? []) as any[];
  const pagedRows = useMemo(() => {
    const start = (page - 1) * pageSize;
    return allRows.slice(start, start + pageSize);
  }, [allRows, page, pageSize]);

  const cols: Column<any>[] = [
    { key: "executed_at", header: "When", render: (r) => new Date(r.executed_at).toLocaleString() },
    {
      key: "trade_number",
      header: "Trade #",
      render: (r) => <span className="font-mono text-[11px] text-muted-foreground">{r.trade_number}</span>,
    },
    { key: "symbol", header: "Symbol", render: (r) => <span className="font-medium">{r.symbol}</span> },
    { key: "exchange", header: "Exch" },
    { key: "action", header: "Side", render: (r) => <StatusPill status={r.action} /> },
    { key: "quantity", header: "Qty", align: "right" },
    {
      key: "price",
      header: "Price",
      align: "right",
      render: (r) => formatPrice(r.price, r.segment, r.exchange),
    },
    {
      key: "value",
      header: "Value",
      align: "right",
      render: (r) => formatPrice(r.value, r.segment, r.exchange),
    },
    {
      key: "total_charges",
      header: "Charges",
      align: "right",
      render: (r) => <span className="text-muted-foreground">{formatINR(r.total_charges)}</span>,
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Tradebook"
        description={`${allRows.length} ${allRows.length === 1 ? "trade" : "trades"} in the selected period.`}
        actions={
          <div className="flex gap-2">
            <ReportPdfButton kind="tradebook" params={{ ...params }} label="Simple PDF" />
            <ReportPdfButton kind="tradebook/full" params={{ from_date: toIsoFrom(range.from), to_date: toIsoTo(range.to) }} label="Full Tradebook" />
          </div>
        }
      />

      <DateRangeBar value={range} onChange={setRange} />

      {/* Desktop table */}
      <div className="hidden md:block">
        <DataTable
          columns={cols}
          rows={pagedRows}
          keyExtractor={(r) => r.id}
          loading={isFetching && !data}
          empty="No trades in the selected period."
        />
      </div>
      {/* Mobile stack */}
      <div className="md:hidden">
        <MobileTradeList rows={pagedRows} loading={isFetching && !data} />
      </div>

      <Pagination
        page={page}
        pageSize={pageSize}
        total={allRows.length}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        pageSizeOptions={[25, 50, 100, 200]}
      />
    </div>
  );
}

function MobileTradeList({ rows, loading }: { rows: any[]; loading: boolean }) {
  if (loading && rows.length === 0) {
    return <Card className="p-6 text-center text-sm text-muted-foreground">Loading…</Card>;
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
      {rows.map((r) => (
        <Card key={r.id} className="p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate font-semibold">{r.symbol}</div>
              <div className="text-[11px] text-muted-foreground">
                {new Date(r.executed_at).toLocaleString()}
              </div>
            </div>
            <StatusPill status={r.action} />
          </div>
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <Row label="Qty" value={String(r.quantity ?? 0)} />
            <Row
              label="Price"
              value={formatPrice(r.price, r.segment, r.exchange)}
            />
            <Row
              label="Value"
              value={formatPrice(r.value, r.segment, r.exchange)}
            />
            <Row label="Charges" value={formatINR(r.total_charges)} muted />
          </div>
        </Card>
      ))}
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
