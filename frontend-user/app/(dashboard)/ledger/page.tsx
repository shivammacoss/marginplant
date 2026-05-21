"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { LedgerAPI } from "@/lib/api";
import { PageHeader } from "@/components/common/PageHeader";
import { Pagination } from "@/components/common/Pagination";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatINR, pnlColor } from "@/lib/utils";

type LedgerRow = {
  id: string;
  date: string;
  type: string;
  label: string;
  is_settlement: boolean;
  particulars: string;
  debit: number;
  credit: number;
  balance: number;
  reference_type?: string | null;
  reference_id?: string | null;
};

export default function UserLedgerPage() {
  const { data, isFetching } = useQuery({
    queryKey: ["ledger"],
    queryFn: () => LedgerAPI.list(),
  });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const allRows = (data?.rows ?? []) as LedgerRow[];
  const totalSettlementBooked = Number(data?.total_settlement_booked ?? 0);
  const pagedRows = useMemo(() => {
    const start = (page - 1) * pageSize;
    return allRows.slice(start, start + pageSize);
  }, [allRows, page, pageSize]);

  return (
    <div className="space-y-4">
      <PageHeader title="Ledger" description={`${data?.count ?? 0} entries`} />

      {/* Summary cards — 3 standard tiles plus a fourth "Settlement
          booked" tile that only appears when there is one. Surfacing
          the settlement total at the top of the page keeps the user
          from having to scan the table to figure out how much was
          booked against settlement in this window. */}
      <div
        className={cn(
          "grid grid-cols-2 gap-3",
          totalSettlementBooked > 0 ? "md:grid-cols-4" : "md:grid-cols-3"
        )}
      >
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Opening balance</CardDescription>
            <CardTitle className="font-tabular text-xl">
              {formatINR(data?.opening_balance)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Closing balance</CardDescription>
            <CardTitle className="font-tabular text-xl">
              {formatINR(data?.closing_balance)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Net change</CardDescription>
            <CardTitle
              className={`font-tabular text-xl ${pnlColor((data?.closing_balance ?? 0) - (data?.opening_balance ?? 0))}`}
            >
              {formatINR((data?.closing_balance ?? 0) - (data?.opening_balance ?? 0))}
            </CardTitle>
          </CardHeader>
        </Card>
        {totalSettlementBooked > 0 && (
          <Card className="border-amber-500/40 bg-amber-500/10">
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5 text-amber-700 dark:text-amber-300">
                <AlertCircle className="size-3.5" /> Settlement booked
              </CardDescription>
              <CardTitle className="font-tabular text-xl font-bold text-amber-700 dark:text-amber-300">
                {formatINR(totalSettlementBooked)}
              </CardTitle>
              <p className="pt-1 text-[10px] text-muted-foreground">
                Informational — not deducted from your balance.
              </p>
            </CardHeader>
          </Card>
        )}
      </div>

      {/* Ledger table — every row reads
            DATE · CATEGORY · DETAIL · DEBIT · CREDIT · BALANCE
          The CATEGORY pill colour-codes the row at a glance:
            • Settlement booked → amber, bold (stands out as a
              "this is what you owed on paper")
            • Realised P&L     → green/red based on sign
            • Brokerage / Adjustment → muted neutral
          The Balance column is the running available_balance, always
          continuous so the user can audit row-by-row. */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-[11px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-semibold">Date</th>
              <th className="px-3 py-2 text-left font-semibold">Category</th>
              <th className="px-3 py-2 text-left font-semibold">Detail</th>
              <th className="px-3 py-2 text-right font-semibold">Debit</th>
              <th className="px-3 py-2 text-right font-semibold">Credit</th>
              <th className="px-3 py-2 text-right font-semibold">Balance</th>
            </tr>
          </thead>
          <tbody>
            {isFetching && !data ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-8 text-center text-xs text-muted-foreground"
                >
                  Loading…
                </td>
              </tr>
            ) : pagedRows.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-8 text-center text-xs text-muted-foreground"
                >
                  No transactions yet.
                </td>
              </tr>
            ) : (
              pagedRows.map((r) => (
                <LedgerRowView key={r.id} row={r} />
              ))
            )}
          </tbody>
        </table>
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

function LedgerRowView({ row }: { row: LedgerRow }) {
  const isSettlement = row.is_settlement;
  const isPnl = row.type === "PNL";
  const isCredit = row.credit > 0;
  const pnlSign = isPnl ? (row.credit > 0 ? 1 : -1) : 0;

  return (
    <tr
      className={cn(
        "border-t border-border/60 transition-colors hover:bg-muted/15",
        // Highlight settlement rows so the user spots them instantly.
        isSettlement && "bg-amber-500/10 hover:bg-amber-500/15"
      )}
    >
      <td className="whitespace-nowrap px-3 py-2 font-tabular text-xs text-muted-foreground">
        {new Date(row.date).toLocaleString()}
      </td>
      <td className="px-3 py-2">
        <CategoryPill
          label={row.label}
          isSettlement={isSettlement}
          isPnl={isPnl}
          pnlSign={pnlSign}
        />
      </td>
      <td className="px-3 py-2 text-xs">
        <span
          className={cn(
            "block max-w-[420px] truncate",
            isSettlement && "font-semibold text-amber-700 dark:text-amber-300"
          )}
          title={row.particulars}
        >
          {row.particulars}
        </span>
      </td>
      <td
        className={cn(
          "whitespace-nowrap px-3 py-2 text-right font-tabular tabular-nums",
          row.debit > 0 && "text-destructive",
          isSettlement && row.debit > 0 && "font-bold"
        )}
      >
        {row.debit > 0 ? formatINR(row.debit) : ""}
      </td>
      <td
        className={cn(
          "whitespace-nowrap px-3 py-2 text-right font-tabular tabular-nums",
          row.credit > 0 && "text-emerald-600 dark:text-emerald-400"
        )}
      >
        {row.credit > 0 ? formatINR(row.credit) : ""}
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right font-tabular tabular-nums font-semibold">
        {formatINR(row.balance)}
      </td>
    </tr>
  );
}

function CategoryPill({
  label,
  isSettlement,
  isPnl,
  pnlSign,
}: {
  label: string;
  isSettlement: boolean;
  isPnl: boolean;
  pnlSign: number;
}) {
  let cls =
    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide";
  if (isSettlement) {
    cls += " bg-amber-500/20 text-amber-700 dark:text-amber-300";
  } else if (isPnl && pnlSign > 0) {
    cls += " bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
  } else if (isPnl && pnlSign < 0) {
    cls += " bg-rose-500/15 text-rose-700 dark:text-rose-300";
  } else {
    cls += " bg-muted text-muted-foreground";
  }
  return <span className={cls}>{label}</span>;
}
