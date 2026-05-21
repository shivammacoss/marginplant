"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CreditCard,
  Lock,
  Receipt,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { ReportsAPI } from "@/lib/api";
import { PageHeader } from "@/components/common/PageHeader";
import { Card } from "@/components/ui/card";
import { ReportPdfButton } from "@/components/common/ReportPdfButton";
import { cn, formatINR, pnlColor } from "@/lib/utils";

export default function MarginReportPage() {
  const { data } = useQuery({ queryKey: ["reports", "margin"], queryFn: () => ReportsAPI.margin() });

  // Group cards into two clusters so the page reads as "what you have"
  // vs. "what you've done". On mobile they stack 2-up; on desktop the
  // wallet cluster sits up top, with cumulative figures below.
  const wallet = [
    { label: "Available balance", value: data?.available_balance, icon: Wallet, tone: "primary" as const },
    { label: "Used margin", value: data?.used_margin, icon: Lock },
    { label: "Credit limit", value: data?.credit_limit, icon: CreditCard },
  ];

  const realized = Number(data?.realized_pnl ?? 0);
  const unrealized = Number(data?.unrealized_pnl ?? 0);
  const pnl = [
    {
      label: "Realized P&L",
      value: data?.realized_pnl,
      icon: realized >= 0 ? TrendingUp : TrendingDown,
      tone: realized >= 0 ? ("profit" as const) : ("loss" as const),
    },
    {
      label: "Unrealized P&L",
      value: data?.unrealized_pnl,
      icon: unrealized >= 0 ? TrendingUp : TrendingDown,
      tone: unrealized >= 0 ? ("profit" as const) : ("loss" as const),
    },
  ];

  const cashflow = [
    { label: "Total deposits", value: data?.total_deposits, icon: ArrowDownToLine },
    { label: "Total withdrawals", value: data?.total_withdrawals, icon: ArrowUpFromLine },
    { label: "Total brokerage", value: data?.total_brokerage, icon: Receipt },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Margin report"
        description="Wallet snapshot + lifetime cashflow."
        actions={<ReportPdfButton kind="margin" />}
      />

      <Section title="Wallet">
        <Grid items={wallet} />
      </Section>

      <Section title="Profit & loss">
        <Grid items={pnl} />
      </Section>

      <Section title="Cashflow">
        <Grid items={cashflow} />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

type Tone = "default" | "primary" | "profit" | "loss";
function Grid({ items }: { items: { label: string; value: any; icon?: any; tone?: Tone }[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
      {items.map((it) => (
        <Stat key={it.label} {...it} />
      ))}
    </div>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: any;
  icon?: any;
  tone?: Tone;
}) {
  const n = Number(value ?? 0);
  const toneClass =
    tone === "primary"
      ? "text-primary"
      : tone === "profit"
      ? "text-profit"
      : tone === "loss"
      ? "text-loss"
      : "";
  const emphasis = tone === "primary";
  return (
    <Card className={cn("p-3 sm:p-4", emphasis && "ring-1 ring-primary/30")}>
      <div className="flex items-start justify-between gap-2">
        <span className="truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground sm:text-xs">
          {label}
        </span>
        {Icon && (
          <Icon
            className={cn(
              "size-3.5 shrink-0 sm:size-4",
              tone === "default" ? "text-muted-foreground" : toneClass,
            )}
          />
        )}
      </div>
      <div
        className={cn(
          "mt-1 text-base font-semibold tabular-nums sm:mt-1.5 sm:text-2xl",
          tone === "profit" || tone === "loss" ? pnlColor(n) : toneClass,
        )}
      >
        {formatINR(value)}
      </div>
    </Card>
  );
}
