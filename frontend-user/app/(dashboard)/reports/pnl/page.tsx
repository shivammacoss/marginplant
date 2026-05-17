"use client";

import { useQuery } from "@tanstack/react-query";
import { ReportsAPI } from "@/lib/api";
import { PageHeader } from "@/components/common/PageHeader";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/common/DataTable";
import { ReportPdfButton } from "@/components/common/ReportPdfButton";
import { formatINR, pnlColor } from "@/lib/utils";

export default function PnlReportPage() {
  const { data, isFetching } = useQuery({ queryKey: ["reports", "pnl"], queryFn: () => ReportsAPI.pnl() });
  const cols: Column<any>[] = [
    { key: "symbol", header: "Symbol" },
    { key: "buy_qty", header: "Buy qty", align: "right" },
    { key: "sell_qty", header: "Sell qty", align: "right" },
    { key: "buy_value", header: "Buy value", align: "right", render: (r) => formatINR(r.buy_value) },
    { key: "sell_value", header: "Sell value", align: "right", render: (r) => formatINR(r.sell_value) },
    { key: "charges", header: "Charges", align: "right", render: (r) => formatINR(r.charges) },
    {
      key: "pnl",
      header: "P&L",
      align: "right",
      render: (r) => <span className={pnlColor(r.pnl)}>{formatINR(r.pnl)}</span>,
    },
  ];
  return (
    <div className="space-y-4">
      <PageHeader
        title="P&L report"
        description="Last 30 days · By symbol"
        actions={<ReportPdfButton kind="pnl" />}
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Trades" value={String(data?.total_trades ?? 0)} />
        <Stat label="Buy value" value={formatINR(data?.total_buy_value)} />
        <Stat label="Sell value" value={formatINR(data?.total_sell_value)} />
        <Stat label="Net P&L" value={formatINR(data?.net_pnl)} className={pnlColor(data?.net_pnl)} />
      </div>
      <DataTable columns={cols} rows={data?.by_symbol} keyExtractor={(r) => r.symbol} loading={isFetching && !data} />
    </div>
  );
}

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className={`font-tabular text-xl ${className ?? ""}`}>{value}</CardTitle>
      </CardHeader>
    </Card>
  );
}
