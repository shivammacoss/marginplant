"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, X } from "lucide-react";
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
import { formatINR } from "@/lib/utils";
import { OwnerBadge } from "@/components/admin/OwnerBadge";
import { useAdminAuthStore } from "@/stores/authStore";
import { canEdit } from "@/lib/permissions";

export function WithdrawalsPanel() {
  const qc = useQueryClient();
  const me = useAdminAuthStore((s) => s.admin);
  // VIEW-only sub-broker / admin shouldn't see clickable Approve / Reject.
  // Backend rejects too via require_perm("withdrawals","write"); UI just
  // matches so the user understands why nothing happens.
  const canMutate = canEdit(me, "withdrawals");
  const [status, setStatus] = useState("PENDING");
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
    {
      key: "bank",
      header: "Destination",
      render: (r) => {
        const b = r.bank ?? {};
        // UPI mode → show the VPA (and a QR link if user uploaded one).
        if (b.upi_id) {
          return (
            <span className="flex items-center gap-2">
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-primary">
                UPI
              </span>
              <span className="font-mono text-xs">{b.upi_id}</span>
              {b.qr_url && (
                <a
                  href={b.qr_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] text-primary underline"
                >
                  QR
                </a>
              )}
            </span>
          );
        }
        // Bank mode → name + last 4 + IFSC.
        if (b.account_number) {
          return (
            <span className="flex items-center gap-2">
              <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                Bank
              </span>
              <span>
                {b.name || "—"} · ••••{String(b.account_number).slice(-4)}
                {b.ifsc ? <span className="ml-1 text-[11px] text-muted-foreground">{b.ifsc}</span> : null}
              </span>
            </span>
          );
        }
        return "—";
      },
    },
    { key: "remarks", header: "Remarks", render: (r) => r.remarks || "—" },
    { key: "utr_number", header: "UTR", render: (r) => r.utr_number || "—" },
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
