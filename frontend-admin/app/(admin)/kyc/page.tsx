"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Eye, FileText, X } from "lucide-react";
import { KycAPI } from "@/lib/api";
import { API_URL } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PageHeader } from "@/components/common/PageHeader";
import { DataTable, type Column } from "@/components/common/DataTable";
import { cn } from "@/lib/utils";

type KycStatus = "PENDING" | "APPROVED" | "REJECTED" | "RESUBMIT";

const STATUS_TABS: { key: KycStatus; label: string }[] = [
  { key: "PENDING", label: "Pending" },
  { key: "APPROVED", label: "Approved" },
  { key: "REJECTED", label: "Rejected" },
];

export default function AdminKycPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<KycStatus>("PENDING");
  const { data, isFetching } = useQuery({
    queryKey: ["admin", "kyc", tab],
    queryFn: () => KycAPI.list(tab),
    refetchInterval: 5000,
  });

  const [reviewing, setReviewing] = useState<any | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [adminRemark, setAdminRemark] = useState("");
  const [acting, setActing] = useState(false);

  function openReview(row: any) {
    setReviewing(row);
    setRejectReason("");
    setAdminRemark("");
  }

  async function approve() {
    if (!reviewing) return;
    setActing(true);
    try {
      await KycAPI.approve(reviewing.id, adminRemark.trim() || undefined);
      toast.success("KYC approved — user notified live");
      qc.invalidateQueries({ queryKey: ["admin", "kyc"] });
      setReviewing(null);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setActing(false);
    }
  }

  async function reject() {
    if (!reviewing) return;
    if (rejectReason.trim().length < 5) {
      toast.error("Provide a rejection reason (min 5 chars)");
      return;
    }
    setActing(true);
    try {
      await KycAPI.reject(reviewing.id, rejectReason.trim(), adminRemark.trim() || undefined);
      toast.success("KYC rejected — user notified live");
      qc.invalidateQueries({ queryKey: ["admin", "kyc"] });
      setReviewing(null);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setActing(false);
    }
  }

  const cols: Column<any>[] = [
    {
      key: "user_code",
      header: "User",
      render: (r) => (
        <div className="leading-tight">
          <div className="font-medium">{r.user_name || "—"}</div>
          <div className="text-[10px] text-muted-foreground">
            {r.user_code} · {r.user_email}
          </div>
        </div>
      ),
    },
    { key: "id_proof_type", header: "ID proof", render: (r) => prettyProof(r.id_proof_type) },
    { key: "id_proof_number", header: "ID number", render: (r) => r.id_proof_number || "—" },
    {
      key: "address_proof_type",
      header: "Address proof",
      render: (r) => prettyProof(r.address_proof_type),
    },
    {
      key: "submitted_at",
      header: "Submitted",
      render: (r) =>
        r.submitted_at ? new Date(r.submitted_at).toLocaleString() : "—",
    },
    {
      key: "status",
      header: "Status",
      render: (r) => <StatusBadge status={r.status} />,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (r) => (
        <Button variant="outline" size="sm" onClick={() => openReview(r)}>
          <Eye className="size-3.5" /> Review
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="KYC review queue"
        description={`${data?.length ?? 0} ${tab.toLowerCase()} submission${data?.length === 1 ? "" : "s"}`}
      />

      <div className="flex items-center gap-1 border-b border-border">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "relative px-3 py-2 text-xs font-medium transition-colors",
              tab === t.key
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
            {tab === t.key && (
              <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-t bg-primary" />
            )}
          </button>
        ))}
      </div>

      <DataTable
        columns={cols}
        rows={data}
        keyExtractor={(r) => r.id}
        loading={isFetching && !data}
        empty={`No ${tab.toLowerCase()} submissions.`}
      />

      <Dialog open={!!reviewing} onOpenChange={(o) => !o && setReviewing(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Review KYC submission</DialogTitle>
            <DialogDescription>
              {reviewing
                ? `${reviewing.user_name || "—"} · ${reviewing.user_code} · ${reviewing.user_email}`
                : ""}
            </DialogDescription>
          </DialogHeader>

          {reviewing && (
            <div className="grid grid-cols-1 gap-4 py-2 sm:grid-cols-2">
              <ProofCard
                label="Identity proof"
                kind={reviewing.id_proof_type}
                number={reviewing.id_proof_number}
                url={reviewing.id_proof_url}
              />
              <ProofCard
                label="Address proof"
                kind={reviewing.address_proof_type}
                url={reviewing.address_proof_url}
              />

              <Card className="sm:col-span-2">
                <CardHeader>
                  <CardTitle className="text-sm">Stated address</CardTitle>
                  <CardDescription className="text-[11px]">
                    Should match the address proof above.
                  </CardDescription>
                </CardHeader>
                <CardContent className="text-sm">
                  <pre className="whitespace-pre-wrap font-sans">{reviewing.address_text}</pre>
                </CardContent>
              </Card>

              {reviewing.status === "PENDING" && (
                <div className="space-y-3 sm:col-span-2">
                  <div className="space-y-1.5">
                    <Label>Admin remark (optional, shown to user)</Label>
                    <Input
                      value={adminRemark}
                      onChange={(e) => setAdminRemark(e.target.value)}
                      placeholder="e.g. PAN verified against income-tax records"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Rejection reason (only when rejecting, min 5 chars)</Label>
                    <Input
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      placeholder="e.g. Address proof is older than 3 months"
                    />
                  </div>
                </div>
              )}

              {reviewing.status !== "PENDING" && (
                <div className="rounded-md border border-border bg-muted/20 p-3 text-xs sm:col-span-2">
                  <div>
                    <span className="text-muted-foreground">Status:</span>{" "}
                    <StatusBadge status={reviewing.status} />
                  </div>
                  {reviewing.reviewed_at && (
                    <div className="text-muted-foreground">
                      Reviewed {new Date(reviewing.reviewed_at).toLocaleString()}
                    </div>
                  )}
                  {reviewing.admin_remark && (
                    <div className="text-muted-foreground">
                      Remark: {reviewing.admin_remark}
                    </div>
                  )}
                  {reviewing.rejection_reason && (
                    <div className="text-destructive">
                      Reason: {reviewing.rejection_reason}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewing(null)} disabled={acting}>
              Close
            </Button>
            {reviewing?.status === "PENDING" && (
              <>
                <Button variant="destructive" onClick={reject} loading={acting}>
                  <X className="size-4" /> Reject
                </Button>
                <Button onClick={approve} loading={acting}>
                  <Check className="size-4" /> Approve
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProofCard({
  label,
  kind,
  number,
  url,
}: {
  label: string;
  kind: string;
  number?: string;
  url: string;
}) {
  const isPdf = url?.toLowerCase().endsWith(".pdf");
  const fullUrl = `${API_URL}${url}`;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{label}</CardTitle>
        <CardDescription className="text-[11px]">
          {prettyProof(kind)}
          {number ? ` · ${number}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isPdf ? (
          <a
            href={fullUrl}
            target="_blank"
            rel="noreferrer"
            className="flex h-40 items-center justify-center gap-2 rounded-md border border-border bg-muted/20 text-sm text-muted-foreground hover:bg-muted/30"
          >
            <FileText className="size-5" /> Open PDF
          </a>
        ) : (
          <a href={fullUrl} target="_blank" rel="noreferrer" title="Open full size">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={fullUrl}
              alt={label}
              className="max-h-48 w-full rounded-md border border-border bg-muted/20 object-contain"
            />
          </a>
        )}
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    PENDING: "bg-atm/15 text-atm",
    APPROVED: "bg-buy/15 text-buy",
    REJECTED: "bg-destructive/15 text-destructive",
    RESUBMIT: "bg-destructive/15 text-destructive",
  };
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", map[status] ?? "bg-muted text-muted-foreground")}>
      {status}
    </span>
  );
}

function prettyProof(v?: string): string {
  if (!v) return "—";
  return v.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
