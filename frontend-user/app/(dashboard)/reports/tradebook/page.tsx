"use client";

import { useQuery } from "@tanstack/react-query";
import { ReportsAPI } from "@/lib/api";
import { PageHeader } from "@/components/common/PageHeader";
import { DataTable, type Column } from "@/components/common/DataTable";
import { StatusPill } from "@/components/common/StatusPill";
import { ReportPdfButton } from "@/components/common/ReportPdfButton";
import { formatINR, formatPrice } from "@/lib/utils";

export default function TradebookPage() {
  const { data, isFetching } = useQuery({ queryKey: ["reports", "tradebook"], queryFn: () => ReportsAPI.tradebook() });
  const cols: Column<any>[] = [
    { key: "executed_at", header: "When", render: (r) => new Date(r.executed_at).toLocaleString() },
    { key: "trade_number", header: "Trade #", render: (r) => <span className="font-mono text-[11px]">{r.trade_number}</span> },
    { key: "symbol", header: "Symbol" },
    { key: "exchange", header: "Exch" },
    { key: "action", header: "Side", render: (r) => <StatusPill status={r.action} /> },
    { key: "quantity", header: "Qty", align: "right" },
    {
      key: "price",
      header: "Price",
      align: "right",
      // Trade price is in source-feed currency ($ for crypto/forex, ₹ otherwise).
      render: (r) => formatPrice(r.price, r.segment, r.exchange),
    },
    {
      key: "value",
      header: "Value",
      align: "right",
      render: (r) => formatPrice(r.value, r.segment, r.exchange),
    },
    // Charges are wallet-side, always INR.
    { key: "total_charges", header: "Charges", align: "right", render: (r) => formatINR(r.total_charges) },
  ];
  return (
    <div className="space-y-4">
      <PageHeader
        title="Tradebook"
        description={`${data?.length ?? 0} trades`}
        actions={<ReportPdfButton kind="tradebook" params={{ limit: 500 }} />}
      />
      <DataTable columns={cols} rows={data} keyExtractor={(r) => r.id} loading={isFetching && !data} />
    </div>
  );
}
