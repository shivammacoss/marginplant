"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Receipt, ScrollText, Wallet } from "lucide-react";
import { ReportsAPI } from "@/lib/api";
import { PageHeader } from "@/components/common/PageHeader";
import { Card } from "@/components/ui/card";
import { ReportPdfButton } from "@/components/common/ReportPdfButton";
import { DateRangeBar, toIsoFrom, toIsoTo, type DateRange } from "@/components/common/DateRangeBar";
import { cn, formatINR } from "@/lib/utils";

export default function BrokerageReportPage() {
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

  const { data } = useQuery({
    queryKey: ["reports", "brokerage", params],
    queryFn: () => ReportsAPI.brokerage(params),
    placeholderData: (prev) => prev,
  });

  const t = data?.totals ?? {};
  const tradeCount = data?.trade_count ?? 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Brokerage & charges"
        description="Platform brokerage on filled trades. No statutory pass-through."
        actions={<ReportPdfButton kind="brokerage" params={params} />}
      />

      <DateRangeBar value={range} onChange={setRange} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <StatCard label="Trades" value={String(tradeCount)} icon={ScrollText} />
        <StatCard label="Brokerage" value={formatINR(t.brokerage)} icon={Receipt} />
        <StatCard
          label="Total charges"
          value={formatINR(t.total)}
          icon={Wallet}
          emphasis
        />
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon: Icon,
  emphasis = false,
}: {
  label: string;
  value: string;
  icon?: any;
  emphasis?: boolean;
}) {
  return (
    <Card className={cn("p-3 sm:p-4", emphasis && "ring-1 ring-primary/30")}>
      <div className="flex items-start justify-between gap-2">
        <span className="truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground sm:text-xs">
          {label}
        </span>
        {Icon && <Icon className="size-3.5 shrink-0 text-muted-foreground sm:size-4" />}
      </div>
      <div className="mt-1 text-base font-semibold tabular-nums sm:mt-1.5 sm:text-2xl">{value}</div>
    </Card>
  );
}
