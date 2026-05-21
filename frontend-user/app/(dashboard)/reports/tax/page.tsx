"use client";

import { useQuery } from "@tanstack/react-query";
import { CandlestickChart, Coins, Landmark, TrendingUp } from "lucide-react";
import { ReportsAPI } from "@/lib/api";
import { PageHeader } from "@/components/common/PageHeader";
import { Card } from "@/components/ui/card";
import { ReportPdfButton } from "@/components/common/ReportPdfButton";
import { cn, formatINR, pnlColor } from "@/lib/utils";

export default function TaxReportPage() {
  const { data } = useQuery({ queryKey: ["reports", "tax"], queryFn: () => ReportsAPI.tax() });
  const b = data?.buckets ?? {};

  const buckets: { label: string; value: number; icon: any; hint: string }[] = [
    {
      label: "Intraday speculative",
      value: Number(b.intraday_speculative ?? 0),
      icon: TrendingUp,
      hint: "Same-day equity squareoff",
    },
    {
      label: "STCG",
      value: Number(b.stcg ?? 0),
      icon: Coins,
      hint: "Equity / delivery held < 12 months",
    },
    {
      label: "LTCG",
      value: Number(b.ltcg ?? 0),
      icon: Landmark,
      hint: "Equity held > 12 months",
    },
    {
      label: "F&O business",
      value: Number(b.fno ?? 0),
      icon: CandlestickChart,
      hint: "Futures + options realised",
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Tax P&L"
        description="Indicative bucket split — confirm with your CA before filing."
        actions={<ReportPdfButton kind="tax" />}
      />

      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
        These categories are an indicative split based on segment and side. Real
        capital-gains computation depends on holding period (FIFO), grandfathering
        rules, and other factors not covered here. Use this as a starting point —
        not as a filing-ready statement.
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {buckets.map((bucket) => (
          <TaxCard key={bucket.label} {...bucket} />
        ))}
      </div>
    </div>
  );
}

function TaxCard({
  label,
  value,
  icon: Icon,
  hint,
}: {
  label: string;
  value: number;
  icon?: any;
  hint?: string;
}) {
  return (
    <Card className="p-3 sm:p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground sm:text-xs">
          {label}
        </span>
        {Icon && <Icon className={cn("size-3.5 shrink-0 sm:size-4", pnlColor(value))} />}
      </div>
      <div className={cn("mt-1 text-lg font-semibold tabular-nums sm:mt-1.5 sm:text-2xl", pnlColor(value))}>
        {value > 0 ? "+" : ""}
        {formatINR(value)}
      </div>
      {hint && <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>}
    </Card>
  );
}
