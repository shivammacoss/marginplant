"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  FileText,
  Home,
  Upload,
  X,
} from "lucide-react";
import { KycAPI } from "@/lib/api";
import { API_URL } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

const ID_PROOFS = [
  { value: "PAN", label: "PAN card" },
  { value: "AADHAAR", label: "Aadhaar card" },
  { value: "PASSPORT", label: "Passport" },
  { value: "VOTER_ID", label: "Voter ID" },
  { value: "DRIVING_LICENSE", label: "Driving license" },
] as const;

const ADDR_PROOFS = [
  { value: "AADHAAR", label: "Aadhaar card" },
  { value: "UTILITY_BILL", label: "Utility bill (electricity / gas / water)" },
  { value: "BANK_STATEMENT", label: "Bank statement" },
  { value: "PASSPORT", label: "Passport" },
  { value: "DRIVING_LICENSE", label: "Driving license" },
] as const;

type Status = "NONE" | "PENDING" | "APPROVED" | "REJECTED" | "RESUBMIT";

/**
 * KYC verification block for the user profile page.
 *
 * Flow:
 *   - **NONE / REJECTED**  → render the submit form. On submit it uploads the
 *     two proof images, then POSTs the metadata to /user/kyc/submit.
 *   - **PENDING**          → "under review" banner with timestamps.
 *   - **APPROVED**         → green verified card showing what was approved.
 *
 * The component subscribes to React Query's `["kyc"]` cache; when admin
 * approves/rejects, the WS bridge (`UserWsBridge`) invalidates that key and
 * the banner flips here without a manual refresh.
 */
export function KycSection() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<any>({
    queryKey: ["kyc"],
    queryFn: () => KycAPI.status(),
    refetchInterval: 30_000, // safety net in addition to the WS push
  });

  const status: Status = (data?.status as Status) ?? "NONE";

  // ── Form state ─────────────────────────────────────────────
  const [idType, setIdType] = useState<string>("PAN");
  const [idNumber, setIdNumber] = useState<string>("");
  const [addrType, setAddrType] = useState<string>("AADHAAR");
  const [addressText, setAddressText] = useState<string>("");

  const [idProofUrl, setIdProofUrl] = useState<string>("");
  const [addrProofUrl, setAddrProofUrl] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);

  // Reset form when status flips back to a state where the form is shown
  useEffect(() => {
    if (status === "REJECTED" || status === "NONE") {
      setIdProofUrl("");
      setAddrProofUrl("");
    }
  }, [status]);

  const submitMut = useMutation({
    mutationFn: (body: any) => KycAPI.submit(body),
    onSuccess: () => {
      toast.success("KYC submitted — admin will review shortly");
      qc.invalidateQueries({ queryKey: ["kyc"] });
    },
    onError: (e: any) => toast.error(e.message || "Submission failed"),
  });

  async function onSubmit() {
    if (!idProofUrl || !addrProofUrl) {
      toast.error("Upload both proof documents");
      return;
    }
    if (addressText.trim().length < 10) {
      toast.error("Address must be at least 10 characters");
      return;
    }
    setSubmitting(true);
    try {
      await submitMut.mutateAsync({
        id_proof_type: idType,
        id_proof_number: idNumber.trim() || undefined,
        id_proof_url: idProofUrl,
        address_proof_type: addrType,
        address_proof_url: addrProofUrl,
        address_text: addressText.trim(),
      });
    } finally {
      setSubmitting(false);
    }
  }

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>KYC verification</CardTitle>
          <CardDescription>Loading status…</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          KYC verification <StatusBadge status={status} />
        </CardTitle>
        <CardDescription>
          Upload an identity proof and an address proof. Trades unlock once an
          admin approves your submission.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {status === "APPROVED" && (
          <div className="flex items-start gap-3 rounded-md border border-buy/40 bg-buy/10 p-3 text-sm">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-buy" />
            <div>
              <div className="font-semibold text-buy">Verified</div>
              <div className="text-xs text-muted-foreground">
                Approved {data?.reviewed_at ? new Date(data.reviewed_at).toLocaleString() : ""}.
                {data?.admin_remark ? ` Admin: "${data.admin_remark}"` : ""}
              </div>
              <div className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                <KvRow label="ID proof" value={prettyProof(data?.id_proof_type)} />
                <KvRow label="ID number" value={data?.id_proof_number || "—"} />
                <KvRow label="Address proof" value={prettyProof(data?.address_proof_type)} />
                <KvRow label="Address" value={data?.address_text || "—"} className="sm:col-span-2" />
              </div>
            </div>
          </div>
        )}

        {status === "PENDING" && (
          <div className="flex items-start gap-3 rounded-md border border-atm/40 bg-atm/10 p-3 text-sm">
            <Clock className="mt-0.5 size-4 shrink-0 text-atm" />
            <div>
              <div className="font-semibold text-atm">Under review</div>
              <div className="text-xs text-muted-foreground">
                Submitted {data?.submitted_at ? new Date(data.submitted_at).toLocaleString() : ""}.
                You&apos;ll see a live update here once an admin acts on it.
              </div>
            </div>
          </div>
        )}

        {status === "REJECTED" && (
          <div className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="flex-1">
              <div className="font-semibold text-destructive">Rejected — please resubmit</div>
              <div className="text-xs text-muted-foreground">
                {data?.rejection_reason || "Admin did not approve the previous submission."}
                {data?.admin_remark ? ` (${data.admin_remark})` : ""}
              </div>
            </div>
          </div>
        )}

        {/* Submit form is shown for NONE and REJECTED states */}
        {(status === "NONE" || status === "REJECTED") && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Identity proof type</Label>
                <select
                  value={idType}
                  onChange={(e) => setIdType(e.target.value)}
                  className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus:border-primary"
                >
                  {ID_PROOFS.map((p) => (
                    <option key={p.value} value={p.value} className="bg-popover">
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label>ID number (optional)</Label>
                <Input
                  value={idNumber}
                  onChange={(e) => setIdNumber(e.target.value)}
                  placeholder="ABCDE1234F"
                  maxLength={32}
                />
              </div>
              <ProofUpload
                icon={<FileText className="size-4" />}
                label="Identity proof image"
                url={idProofUrl}
                onChange={setIdProofUrl}
              />
              <ProofUpload
                icon={<Home className="size-4" />}
                label="Address proof image"
                url={addrProofUrl}
                onChange={setAddrProofUrl}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Address proof type</Label>
              <select
                value={addrType}
                onChange={(e) => setAddrType(e.target.value)}
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus:border-primary sm:max-w-md"
              >
                {ADDR_PROOFS.map((p) => (
                  <option key={p.value} value={p.value} className="bg-popover">
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label>Full address (must match the proof)</Label>
              <textarea
                value={addressText}
                onChange={(e) => setAddressText(e.target.value)}
                placeholder="Flat / House no., Street, Area, City, State, PIN"
                rows={3}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary"
              />
            </div>

            <div className="flex justify-end">
              <Button onClick={onSubmit} loading={submitting}>
                Submit for verification
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const map: Record<Status, { label: string; className: string }> = {
    NONE: { label: "Not submitted", className: "bg-muted text-muted-foreground" },
    PENDING: { label: "Pending", className: "bg-atm/15 text-atm" },
    APPROVED: { label: "Verified", className: "bg-buy/15 text-buy" },
    REJECTED: { label: "Rejected", className: "bg-destructive/15 text-destructive" },
    RESUBMIT: { label: "Resubmit", className: "bg-destructive/15 text-destructive" },
  };
  const m = map[status];
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", m.className)}>
      {m.label}
    </span>
  );
}

function KvRow({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}

function prettyProof(v?: string): string {
  if (!v) return "—";
  return v.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function ProofUpload({
  icon,
  label,
  url,
  onChange,
}: {
  icon: React.ReactNode;
  label: string;
  url: string;
  onChange: (url: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  async function pick(file: File) {
    if (!file) return;
    setBusy(true);
    try {
      const r = await KycAPI.uploadProof(file);
      onChange(r.url);
      toast.success(`${label} uploaded`);
    } catch (e: any) {
      toast.error(e.message || "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1.5">
        {icon} {label}
      </Label>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,application/pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) pick(f);
        }}
      />
      {url ? (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/20 p-2">
          {url.toLowerCase().endsWith(".pdf") ? (
            <FileText className="size-4 text-muted-foreground" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`${API_URL}${url}`}
              alt="proof preview"
              className="h-12 w-16 rounded border border-border object-cover"
            />
          )}
          <span className="flex-1 truncate text-xs text-muted-foreground">
            {url.split("/").pop()}
          </span>
          <button
            type="button"
            aria-label="Clear upload"
            onClick={() => onChange("")}
            className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          className="w-full justify-start"
          onClick={() => fileRef.current?.click()}
          loading={busy}
        >
          <Upload className="size-4" /> Upload image / PDF
        </Button>
      )}
    </div>
  );
}
