"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Copy, X } from "lucide-react";
import { PayinOutAPI } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable, type Column } from "@/components/common/DataTable";
import { StatusPill } from "@/components/common/StatusPill";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn, formatINR } from "@/lib/utils";
import { OwnerBadge } from "@/components/admin/OwnerBadge";
import { useAdminAuthStore } from "@/stores/authStore";
import { canEdit } from "@/lib/permissions";

/**
 * One bank/UPI value + an inline copy button. Used in the
 * Withdrawals destination columns so admins can lift the holder /
 * account / IFSC / UPI into their payout tool in one click. Empty
 * values render as a muted "—" so the column stays visually aligned
 * across rows.
 */
function CopyableField({
  value,
  label,
  mono = true,
  uppercase = false,
}: {
  value?: string | null;
  label: string;
  mono?: boolean;
  uppercase?: boolean;
}) {
  if (!value) {
    return <span className="text-xs text-muted-foreground/60">—</span>;
  }
  async function doCopy() {
    try {
      await navigator.clipboard.writeText(value!);
      toast.success(`${label} copied`);
    } catch {
      // Clipboard API can fail on non-HTTPS / older browsers. Fall back
      // to selecting the text so the operator can copy manually.
      toast.error("Copy failed — long-press to select");
    }
  }
  return (
    <span className="inline-flex max-w-full items-center gap-1.5">
      <span
        className={cn(
          "truncate text-xs",
          mono && "font-mono",
          uppercase && "uppercase",
        )}
        title={value}
      >
        {value}
      </span>
      <button
        type="button"
        onClick={doCopy}
        aria-label={`Copy ${label}`}
        title={`Copy ${label}`}
        className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Copy className="size-3" />
      </button>
    </span>
  );
}

export function WithdrawalsPanel() {
  const qc = useQueryClient();
  const me = useAdminAuthStore((s) => s.admin);
  // VIEW-only sub-broker / admin shouldn't see clickable Approve / Reject.
  // Backend rejects too via require_perm("withdrawals","write"); UI just
  // matches so the user understands why nothing happens.
  const canMutate = canEdit(me, "withdrawals");
  // Default to "All" (same rationale as DepositsPanel — operator
  // flagged 21-May that landing on an empty PENDING list looked
  // like the queue was broken).
  const [status, setStatus] = useState("");
  const [approving, setApproving] = useState<{ id: string; utr: string } | null>(null);
  const [rejecting, setRejecting] = useState<{ id: string; reason: string } | null>(null);

  const { data, isFetching } = useQuery({
    queryKey: ["admin", "withdrawals", status],
    queryFn: () => PayinOutAPI.withdrawals(status || undefined),
  });

  async function approve() {
    if (!approving) return;
    try {
      await PayinOutAPI.approveWithdrawal(approving.id, { utr_number: approving.utr || undefined });
      toast.success("Approved + wallet debited");
      setApproving(null);
      qc.invalidateQueries({ queryKey: ["admin", "withdrawals"] });
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function reject() {
    if (!rejecting?.reason.trim()) {
      toast.error("Reason required");
      return;
    }
    try {
      await PayinOutAPI.rejectWithdrawal(rejecting.id, rejecting.reason);
      toast.success("Rejected");
      setRejecting(null);
      qc.invalidateQueries({ queryKey: ["admin", "withdrawals"] });
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  const cols: Column<any>[] = [
    { key: "created_at", header: "When", render: (r) => new Date(r.created_at).toLocaleString() },
    {
      key: "user",
      header: "User",
      render: (r) => (
        <div className="flex flex-col leading-tight">
          <span className="text-sm">{r.user_name || "—"}</span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {r.user_code || r.user_id?.slice(-8)}
          </span>
        </div>
      ),
    },
    { key: "owner", header: "Owner", render: (r) => <OwnerBadge row={r} me={me} /> },
    { key: "amount", header: "Amount", align: "right", render: (r) => formatINR(r.amount) },
    // ── Destination columns ─────────────────────────────────────
    // The single "Destination" cell used to cram holder · bank · IFSC
    // · UPI together, which was fine to read but painful to act on —
    // every admin tier (super-admin / admin / broker / sub-broker)
    // had to select each value and copy it by hand into their payout
    // tool. Now each field gets its own column with a Copy button
    // sitting inline next to the value. Empty fields render as "—"
    // so the table stays visually aligned across rows. Bank rows show
    // the holder / account / IFSC; UPI-only rows surface the VPA in
    // the UPI column and leave the bank columns blank.
    {
      key: "holder",
      header: "Holder",
      render: (r) => (
        <CopyableField
          value={(r.bank?.holder || r.bank?.name) ?? null}
          label="Holder name"
          mono={false}
        />
      ),
    },
    {
      key: "account_number",
      header: "Account no.",
      render: (r) => (
        <CopyableField
          value={r.bank?.account_number ?? null}
          label="Account number"
        />
      ),
    },
    {
      key: "ifsc",
      header: "IFSC",
      render: (r) => (
        <CopyableField value={r.bank?.ifsc ?? null} label="IFSC" uppercase />
      ),
    },
    {
      key: "upi_id",
      header: "UPI",
      render: (r) => (
        <CopyableField value={r.bank?.upi_id ?? null} label="UPI ID" />
      ),
    },
    {
      key: "remarks",
      header: "Remarks",
      render: (r) => r.remarks || "—",
    },
    {
      key: "utr_number",
      header: "UTR",
      render: (r) => (
        <CopyableField value={r.utr_number ?? null} label="UTR" />
      ),
    },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (r) =>
        r.status === "PENDING" ? (
          <div className="flex justify-end gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Approve"
              disabled={!canMutate}
              title={canMutate ? undefined : "View-only access"}
              onClick={() => canMutate && setApproving({ id: r.id, utr: "" })}
            >
              <Check className="size-4 text-primary" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Reject"
              disabled={!canMutate}
              title={canMutate ? undefined : "View-only access"}
              onClick={() => canMutate && setRejecting({ id: r.id, reason: "" })}
            >
              <X className="size-4 text-destructive" />
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {data?.length ?? 0} {status.toLowerCase() || "all"}
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="h-9 rounded-md border border-border bg-background px-3 text-sm"
        >
          <option value="PENDING">Pending</option>
          <option value="COMPLETED">Completed</option>
          <option value="REJECTED">Rejected</option>
          <option value="">All</option>
        </select>
      </div>
      <DataTable columns={cols} rows={data} keyExtractor={(r) => r.id} loading={isFetching && !data} />

      <Dialog open={!!approving} onOpenChange={(v) => !v && setApproving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve withdrawal</DialogTitle>
          </DialogHeader>
          <Input
            placeholder="UTR / payment reference (optional)"
            value={approving?.utr ?? ""}
            onChange={(e) => setApproving((r) => (r ? { ...r, utr: e.target.value } : r))}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproving(null)}>
              Cancel
            </Button>
            <Button onClick={approve}>Approve & debit</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!rejecting} onOpenChange={(v) => !v && setRejecting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject withdrawal</DialogTitle>
          </DialogHeader>
          <Input
            placeholder="Reason (mandatory)"
            value={rejecting?.reason ?? ""}
            onChange={(e) => setRejecting((r) => (r ? { ...r, reason: e.target.value } : r))}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejecting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={reject}>
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
