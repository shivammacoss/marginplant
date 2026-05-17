"use client";

import { useQuery } from "@tanstack/react-query";
import { LedgerAPI } from "@/lib/api";
import { PageHeader } from "@/components/common/PageHeader";
import { DataTable, type Column } from "@/components/common/DataTable";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatINR, pnlColor } from "@/lib/utils";

export default function UserLedgerPage() {
  const { data, isFetching } = useQuery({ queryKey: ["ledger"], queryFn: () => LedgerAPI.list() });

  const cols: Column<any>[] = [
    { key: "date", header: "Date", render: (r) => new Date(r.date).toLocaleString() },
    { key: "particulars", header: "Particulars", className: "max-w-[400px] truncate" },
    {
      key: "debit",
      header: "Debit",
      align: "right",
      render: (r) => (r.debit ? formatINR(r.debit) : ""),
    },
    {
      key: "credit",
      header: "Credit",
      align: "right",
      render: (r) => (r.credit ? formatINR(r.credit) : ""),
    },
    {
      key: "balance",
      header: "Balance",
      align: "right",
      render: (r) => <span className={pnlColor(r.balance)}>{formatINR(r.balance)}</span>,
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Ledger" description={`${data?.count ?? 0} entries`} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Opening balance</CardDescription>
            <CardTitle className="font-tabular text-xl">{formatINR(data?.opening_balance)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Closing balance</CardDescription>
            <CardTitle className="font-tabular text-xl">{formatINR(data?.closing_balance)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Net change</CardDescription>
            <CardTitle className={`font-tabular text-xl ${pnlColor((data?.closing_balance ?? 0) - (data?.opening_balance ?? 0))}`}>
              {formatINR((data?.closing_balance ?? 0) - (data?.opening_balance ?? 0))}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>
      <DataTable columns={cols} rows={data?.rows} keyExtractor={(r) => r.id} loading={isFetching && !data} />
    </div>
  );
}
