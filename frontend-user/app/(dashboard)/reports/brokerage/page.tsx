"use client";

import { useQuery } from "@tanstack/react-query";
import { ReportsAPI } from "@/lib/api";
import { PageHeader } from "@/components/common/PageHeader";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ReportPdfButton } from "@/components/common/ReportPdfButton";
import { formatINR } from "@/lib/utils";

export default function BrokerageReportPage() {
  const { data } = useQuery({ queryKey: ["reports", "brokerage"], queryFn: () => ReportsAPI.brokerage() });
  const t = data?.totals ?? {};
  const items = [
    ["Brokerage", t.brokerage],
    ["Total", t.total],
  ] as const;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Brokerage & charges"
        description="Last 30 days"
        actions={<ReportPdfButton kind="brokerage" />}
      />
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
