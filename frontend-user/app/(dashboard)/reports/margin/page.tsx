"use client";

import { useQuery } from "@tanstack/react-query";
import { ReportsAPI } from "@/lib/api";
import { PageHeader } from "@/components/common/PageHeader";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ReportPdfButton } from "@/components/common/ReportPdfButton";
import { formatINR } from "@/lib/utils";

export default function MarginReportPage() {
  const { data } = useQuery({ queryKey: ["reports", "margin"], queryFn: () => ReportsAPI.margin() });
  const items = [
    ["Available balance", data?.available_balance],
    ["Used margin", data?.used_margin],
    ["Realized P&L", data?.realized_pnl],
    ["Unrealized P&L", data?.unrealized_pnl],
    ["Credit limit", data?.credit_limit],
    ["Total deposits", data?.total_deposits],
    ["Total withdrawals", data?.total_withdrawals],
    ["Total brokerage", data?.total_brokerage],
  ] as const;
  return (
    <div className="space-y-4">
      <PageHeader title="Margin report" actions={<ReportPdfButton kind="margin" />} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {items.map(([k, v]) => (
          <Card key={k}>
            <CardHeader className="pb-2">
              <CardDescription>{k}</CardDescription>
              <CardTitle className="font-tabular text-xl">{formatINR(v)}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>
    </div>
  );
}
