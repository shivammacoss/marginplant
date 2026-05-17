"use client";

import { useQuery } from "@tanstack/react-query";
import { ReportsAPI } from "@/lib/api";
import { PageHeader } from "@/components/common/PageHeader";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ReportPdfButton } from "@/components/common/ReportPdfButton";
import { formatINR } from "@/lib/utils";

export default function TaxReportPage() {
  const { data } = useQuery({ queryKey: ["reports", "tax"], queryFn: () => ReportsAPI.tax() });
  const b = data?.buckets ?? {};
  return (
    <div className="space-y-4">
      <PageHeader
        title="Tax P&L"
        description="Simplified categorisation. Talk to a CA before filing — this is an indicative split."
        actions={<ReportPdfButton kind="tax" />}
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Intraday speculative</CardDescription>
            <CardTitle className="font-tabular text-xl">{formatINR(b.intraday_speculative)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>STCG (short-term)</CardDescription>
            <CardTitle className="font-tabular text-xl">{formatINR(b.stcg)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>LTCG (long-term)</CardDescription>
            <CardTitle className="font-tabular text-xl">{formatINR(b.ltcg)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>F&O business</CardDescription>
            <CardTitle className="font-tabular text-xl">{formatINR(b.fno)}</CardTitle>
          </CardHeader>
        </Card>
      </div>
    </div>
  );
}
