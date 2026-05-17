"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/common/PageHeader";
import { DepositsPanel } from "@/components/admin/payments/DepositsPanel";
import { WithdrawalsPanel } from "@/components/admin/payments/WithdrawalsPanel";
import { RejectedPanel } from "@/components/admin/payments/RejectedPanel";
import { HistoryPanel } from "@/components/admin/payments/HistoryPanel";
import { BankAccountsPanel } from "@/components/admin/payments/BankAccountsPanel";
import { cn } from "@/lib/utils";
import { useAdminAuthStore } from "@/stores/authStore";
import { canSee, type PermissionKey } from "@/lib/permissions";

type Tab = "deposits" | "withdrawals" | "history" | "rejected" | "banks";

type TabDef = {
  id: Tab;
  label: string;
  description: string;
  // When set, the tab is hidden unless `canSee(admin, perm)` returns true.
  // Read access only — write access (Add bank button, Approve/Reject) is
  // checked inside each panel via `canEdit`.
  perm?: PermissionKey;
};

const TABS: TabDef[] = [
  { id: "deposits", label: "Deposits", description: "User-initiated deposit requests — review proof, approve to credit wallet, or reject with reason.", perm: "deposits" },
  { id: "withdrawals", label: "Withdrawals", description: "User withdrawal requests — verify bank, approve with UTR to debit, or reject with reason.", perm: "withdrawals" },
  { id: "history", label: "History", description: "Unified ledger of every deposit and withdrawal across all users — filterable by type, status, user or UTR." },
  { id: "rejected", label: "Rejected", description: "Read-only history of all rejected deposits and withdrawals with the reason given." },
  { id: "banks", label: "Bank Accounts", description: "Bank accounts, UPI IDs and QR codes shown to users on the deposit form.", perm: "banks" },
];

export default function PaymentsPage() {
  const sp = useSearchParams();
  const admin = useAdminAuthStore((s) => s.admin);

  // Filter tabs to what this admin/broker may see.
  const visibleTabs = useMemo(
    () => TABS.filter((t) => !t.perm || canSee(admin, t.perm)),
    [admin],
  );

  const initialTab = (sp.get("tab") as Tab) || visibleTabs[0]?.id || "deposits";
  const [tab, setTab] = useState<Tab>(initialTab);
  const meta = visibleTabs.find((t) => t.id === tab) ?? visibleTabs[0];

  if (!meta) {
    return (
      <div className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
        You don't have permission to view any Payments section.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Payments" description={meta.description} />

      <div className="sticky top-0 z-20 -mx-4 overflow-x-auto border-b border-border bg-background/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/60 scrollbar-thin">
        <div className="inline-flex min-w-full gap-1">
          {visibleTabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                "whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium transition-colors",
                tab === t.id
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "deposits" && <DepositsPanel />}
      {tab === "withdrawals" && <WithdrawalsPanel />}
      {tab === "history" && <HistoryPanel />}
      {tab === "rejected" && <RejectedPanel />}
      {tab === "banks" && <BankAccountsPanel />}
    </div>
  );
}
