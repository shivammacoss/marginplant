"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Building2,
  CheckCircle2,
  ChevronRight,
  Clock,
  Copy,
  CreditCard,
  Loader2,
  Mail,
  MessageCircle,
  Plus,
  QrCode,
  Upload,
  Wallet as WalletIcon,
  X,
  XCircle,
  AlertCircle,
} from "lucide-react";
import { WalletAPI } from "@/lib/api";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { UpiQR, buildUpiUri } from "@/components/common/UpiQR";
import { cn, formatINR, pnlColor } from "@/lib/utils";
import {
  buildMailtoUrl,
  buildWhatsappUrl,
  useSupportContacts,
} from "@/lib/useSupport";

// ─────────────────────────────────────────────────────────────────
// Official-style UPI logo mark (orange/green chevrons + UPI text).
// Inline SVG so no asset bundling needed.
// ─────────────────────────────────────────────────────────────────
function UpiLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 80 80"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="UPI"
      role="img"
    >
      <rect width="80" height="80" rx="14" fill="#fff" stroke="#e5e5e5" />
      {/* Orange chevron (left) */}
      <polygon points="18,16 36,16 26,50 8,50" fill="#f47920" />
      {/* Green chevron (right) */}
      <polygon points="38,16 56,16 46,50 28,50" fill="#75bf43" />
      {/* Outlined chevron */}
      <polygon points="40,16 64,16 54,50 30,50" fill="none" stroke="#0f3470" strokeWidth="2.5" />
      {/* UPI wordmark */}
      <text
        x="40"
        y="68"
        textAnchor="middle"
        fontFamily="system-ui, sui, sans-serif"
        fontSize="12"
        fontWeight="800"
        fill="#0f3470"
        letterSpacing="1"
      >
        UPI
      </text>
    </svg>
  );
}

export default function WalletPage() {
  const qc = useQueryClient();
  const { data: summary } = useQuery({
    queryKey: ["wallet-summary"],
    queryFn: () => WalletAPI.summary(),
    // 3 s so the balance flips within one heartbeat of admin approval —
    // 8 s felt like the wallet was frozen after a deposit was approved.
    refetchInterval: 3000,
  });
  const { data: txns } = useQuery({
    queryKey: ["wallet-txns"],
    queryFn: () => WalletAPI.transactions(50),
    refetchInterval: 5000,
  });
  const { data: deposits } = useQuery({
    queryKey: ["my-deposits"],
    queryFn: () => WalletAPI.myDeposits(),
    // Pending → Approved transition lives on the deposits row; poll fast so
    // the user sees the status change without hitting refresh.
    refetchInterval: 3000,
  });
  const { data: withdrawals } = useQuery({
    queryKey: ["my-withdrawals"],
    queryFn: () => WalletAPI.myWithdrawals(),
    refetchInterval: 5000,
  });
  const { data: companyBanks } = useQuery({ queryKey: ["company-banks"], queryFn: () => WalletAPI.companyBanks() });
  const { data: myBanks } = useQuery({ queryKey: ["my-banks"], queryFn: () => WalletAPI.myBankAccounts() });

  // ── Dialogs ─────────────────────────────────────────────────────
  const [depositOpen, setDepositOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [bankOpen, setBankOpen] = useState(false);

  // ── Form state ──────────────────────────────────────────────────
  const [dep, setDep] = useState({
    amount: "",
    utr_number: "",
    payment_mode: "UPI",
    screenshot_url: "",
    user_remark: "",
    bank_account_id: "",
  });
  const [wd, setWd] = useState({
    amount: "",
    mode: "UPI" as "UPI" | "BANK",
    upi_id: "",
    qr_url: "",
    bank_name: "",
    account_number: "",
    ifsc_code: "",
    account_holder: "",
    remarks: "",
  });
  const [wdQrUploading, setWdQrUploading] = useState(false);
  const [newBank, setNewBank] = useState({ bank_name: "", account_holder: "", account_number: "", ifsc_code: "" });
  const [qrPreview, setQrPreview] = useState<{ upiId: string; payee?: string; amount?: number } | null>(null);

  // Auto-pick the default (or first) company bank when dialog opens
  useEffect(() => {
    if (depositOpen && companyBanks?.length && !dep.bank_account_id) {
      const def = companyBanks.find((b: any) => b.is_default) ?? companyBanks[0];
      setDep((d) => ({ ...d, bank_account_id: def.id }));
    }
  }, [depositOpen, companyBanks]);

  const selectedBank = companyBanks?.find((b: any) => b.id === dep.bank_account_id) ?? companyBanks?.[0];

  // ── Helpers ────────────────────────────────────────────────────
  function copyText(text: string, label: string) {
    navigator.clipboard.writeText(text).then(
      () => toast.success(`${label} copied`),
      () => toast.error("Copy failed")
    );
  }

  const [uploading, setUploading] = useState(false);
  async function uploadScreenshot(file: File) {
    if (!file.type.startsWith("image/")) {
      toast.error("Pick an image file");
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      toast.error("File too large (max 15 MB)");
      return;
    }
    setUploading(true);
    try {
      // Phone screenshots are often 3–8 MB; compressing client-side cuts the
      // upload from "felt slow" (seconds) to instant on a 4G connection, and
      // keeps disk usage small on the server.
      const toUpload = await compressImage(file);
      const r = await WalletAPI.uploadScreenshot(toUpload);
      setDep((d) => ({ ...d, screenshot_url: r.url }));
      toast.success("Screenshot uploaded");
    } catch (e: any) {
      toast.error(e.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function submitDeposit() {
    if (!dep.amount || Number(dep.amount) <= 0) return toast.error("Amount required");
    if (!dep.bank_account_id) return toast.error("Pick a payment method");
    // UTR is OPTIONAL — admin approves on screenshot + manual verification
    // anyway. Forcing UTR up-front blocked users who paid first then
    // came back later to copy the txn ref.
    try {
      const payload = {
        ...dep,
        amount: Number(dep.amount),
        utr_number: dep.utr_number.trim() || undefined,
      };
      await WalletAPI.createDeposit(payload as any);
      toast.success("Deposit submitted — awaiting admin approval");
      setDepositOpen(false);
      setDep({ amount: "", utr_number: "", payment_mode: "UPI", screenshot_url: "", user_remark: "", bank_account_id: "" });
      // Refresh the pending list immediately so the new request appears
      // without waiting for the 3 s poll. wallet-summary/txns also touched
      // so the pending-count tile updates in lock-step.
      qc.invalidateQueries({ queryKey: ["my-deposits"] });
      qc.invalidateQueries({ queryKey: ["wallet-summary"] });
      qc.invalidateQueries({ queryKey: ["wallet-txns"] });
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function submitWithdrawal() {
    if (!wd.amount || Number(wd.amount) <= 0) return toast.error("Amount required");

    const bank: Record<string, string> = {};
    if (wd.mode === "UPI") {
      const vpa = wd.upi_id.trim();
      if (!vpa || !vpa.includes("@")) return toast.error("Enter a valid UPI ID (e.g. name@bank)");
      bank.upi_id = vpa;
      if (wd.qr_url) bank.qr_url = wd.qr_url;
    } else {
      if (!wd.account_number.trim()) return toast.error("Account number required");
      if (!wd.ifsc_code.trim()) return toast.error("IFSC required");
      if (!wd.account_holder.trim()) return toast.error("Account holder name required");
      bank.name = wd.bank_name.trim();
      bank.account_number = wd.account_number.trim();
      bank.ifsc = wd.ifsc_code.trim().toUpperCase();
      bank.holder = wd.account_holder.trim();
    }

    try {
      await WalletAPI.createWithdrawal({
        amount: Number(wd.amount),
        remarks: wd.remarks,
        bank,
      });
      toast.success("Withdrawal requested");
      setWithdrawOpen(false);
      setWd({
        amount: "",
        mode: "UPI",
        upi_id: "",
        qr_url: "",
        bank_name: "",
        account_number: "",
        ifsc_code: "",
        account_holder: "",
        remarks: "",
      });
      qc.invalidateQueries({ queryKey: ["my-withdrawals"] });
      qc.invalidateQueries({ queryKey: ["wallet-summary"] });
      qc.invalidateQueries({ queryKey: ["wallet-txns"] });
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function addBank() {
    try {
      await WalletAPI.addBankAccount(newBank);
      toast.success("Bank added");
      setBankOpen(false);
      setNewBank({ bank_name: "", account_holder: "", account_number: "", ifsc_code: "" });
      qc.invalidateQueries({ queryKey: ["my-banks"] });
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  // (UPI deeplink generation removed — payment is manual via the user's
  // own UPI app; we only show a static "UPI accepted" badge.)

  return (
    <div className="space-y-5">
      {/* ── Hero balance card ──────────────────────────────────── */}
      <section className="overflow-hidden rounded-2xl bg-gradient-to-br from-primary via-primary to-primary/85 p-5 text-primary-foreground shadow-lg shadow-primary/20">
        <div className="flex items-start justify-between">
          <div className="space-y-0.5">
            <div className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider opacity-80">
              <WalletIcon className="size-3.5" /> Available balance
            </div>
            <div className="font-tabular text-3xl font-bold md:text-4xl">
              {/* Never display a negative balance on the user-facing hero —
                  any shortfall is surfaced as settlement_outstanding in
                  the banner below. */}
              {formatINR(Math.max(0, Number(summary?.available_balance ?? 0)))}
            </div>
            <div className="text-[11px] opacity-80">Wallet · {selectedBank?.account_holder ?? "MarginPlant Broker"}</div>
          </div>
          <div className="hidden gap-2 sm:flex">
            <Dialog open={depositOpen} onOpenChange={setDepositOpen}>
              <DialogTrigger asChild>
                <button className="inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-xs font-semibold text-primary shadow-sm transition hover:bg-white/90">
                  <ArrowDownToLine className="size-3.5" /> Add funds
                </button>
              </DialogTrigger>
              {/* dialog body below */}
            </Dialog>
            <Dialog open={withdrawOpen} onOpenChange={setWithdrawOpen}>
              <DialogTrigger asChild>
                <button className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-4 py-2 text-xs font-semibold text-primary-foreground backdrop-blur transition hover:bg-white/25">
                  <ArrowUpToLine className="size-3.5" /> Withdraw
                </button>
              </DialogTrigger>
            </Dialog>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-3 divide-x divide-white/15 text-center">
          <HeroStat label="Used margin" value={formatINR(summary?.used_margin ?? 0)} />
          <HeroStat label="Credit limit" value={formatINR(summary?.credit_limit ?? 0)} />
          <HeroStat label="Realized P&L" value={formatINR(summary?.realized_pnl ?? 0)} />
        </div>
      </section>

      {/* ── Settlement outstanding banner (only when > 0) ─────────── */}
      {Number(summary?.settlement_outstanding ?? 0) > 0 && (
        <section className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-4">
          <AlertCircle className="size-5 shrink-0 text-destructive mt-0.5" />
          <div className="flex-1">
            <div className="text-xs font-semibold uppercase tracking-wider text-destructive">
              Outstanding settlement
            </div>
            <div className="font-tabular text-2xl font-bold text-destructive mt-0.5">
              {formatINR(summary?.settlement_outstanding ?? 0)}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              Auto-deducted from your next deposit before crediting available balance.
            </div>
          </div>
        </section>
      )}

      {/* ── Mobile-only action row (desktop has them in the hero) ── */}
      <div className="grid grid-cols-2 gap-3 sm:hidden">
        <Button onClick={() => setDepositOpen(true)} className="h-12 rounded-xl">
          <ArrowDownToLine className="size-4" /> Add funds
        </Button>
        <Button onClick={() => setWithdrawOpen(true)} variant="outline" className="h-12 rounded-xl">
          <ArrowUpToLine className="size-4" /> Withdraw
        </Button>
      </div>

      {/* ── Stat tiles (totals) ───────────────────────────────── */}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Total deposits" value={formatINR(summary?.total_deposits ?? 0)} />
        <StatTile label="Total withdrawals" value={formatINR(summary?.total_withdrawals ?? 0)} />
        <StatTile
          label="Pending deposits"
          value={String((deposits ?? []).filter((d: any) => d.status === "PENDING").length)}
          hint="awaiting admin approval"
        />
        <StatTile
          label="Pending withdrawals"
          value={String((withdrawals ?? []).filter((d: any) => d.status === "PENDING").length)}
          hint="awaiting admin approval"
        />
      </section>

      {/* ── Recent activity + Bank accounts ─────────────────── */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {(() => {
          // Wallet page transaction history is the deposit/withdrawal ledger
          // PLUS settlement-outstanding events (booked + recovered) — both
          // are wallet-level, non-trade activities. TRADE / BROKERAGE /
          // CHARGES / PNL live on the dedicated /reports and /ledger pages
          // and used to swamp this panel after a single active session.
          // Filtering here (rather than the API) keeps the existing 50-row
          // fetch usable for any future "all transactions" view without a
          // second round trip.
          const cashOnlyTxns = (txns ?? []).filter((t: any) => {
            const tt = String(t?.transaction_type ?? "").toUpperCase();
            return (
              tt === "DEPOSIT" ||
              tt === "WITHDRAWAL" ||
              tt === "SETTLEMENT_OUTSTANDING_BOOKED" ||
              tt === "SETTLEMENT_OUTSTANDING_RECOVERY"
            );
          });
          return (
        <PanelCard title="Transaction history" subtitle={`Last ${cashOnlyTxns.length} entries`} className="lg:col-span-2">
          {cashOnlyTxns.length === 0 ? (
            <EmptyState message="No deposits or withdrawals yet" />
          ) : (
            <ul className="divide-y divide-border">
              {cashOnlyTxns.slice(0, 8).map((t: any) => (
                <li key={t.id} className="flex items-center justify-between py-2.5">
                  <div className="flex items-center gap-3">
                    <div className="grid size-9 place-items-center rounded-full bg-muted">
                      <CreditCard className="size-4 text-muted-foreground" />
                    </div>
                    <div>
                      <div className="text-sm font-medium">{t.narration ?? t.transaction_type}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {new Date(t.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={cn("font-tabular text-sm font-semibold", pnlColor(t.amount))}>
                      {Number(t.amount) >= 0 ? "+" : ""}
                      {formatINR(t.amount)}
                    </div>
                    <div className="text-[10px] text-muted-foreground">{formatINR(t.balance_after)} bal</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </PanelCard>
          );
        })()}

        <PanelCard
          title="My bank accounts"
          subtitle={`${(myBanks ?? []).length} linked`}
          action={
            <Dialog open={bankOpen} onOpenChange={setBankOpen}>
              <DialogTrigger asChild>
                <button className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline">
                  <Plus className="size-3.5" /> Add
                </button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add bank account</DialogTitle>
                  <DialogDescription>For withdrawals into your account.</DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                  {(["bank_name", "account_holder", "account_number", "ifsc_code"] as const).map((k) => (
                    <Field key={k} label={k.replace(/_/g, " ")}>
                      <Input
                        value={(newBank as any)[k]}
                        onChange={(e) => setNewBank((b) => ({ ...b, [k]: e.target.value }))}
                        className={k === "ifsc_code" ? "uppercase" : undefined}
                      />
                    </Field>
                  ))}
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setBankOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={addBank}>Add</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          }
        >
          {(myBanks ?? []).length === 0 ? (
            <EmptyState message="No bank accounts yet" hint="Add one to enable withdrawals." />
          ) : (
            <ul className="space-y-2">
              {(myBanks ?? []).map((b: any) => (
                <li key={b.id} className="rounded-lg border border-border bg-muted/20 p-3 text-xs">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="font-medium">{b.bank_name}</div>
                      <div className="text-muted-foreground">{b.account_holder}</div>
                    </div>
                    <Building2 className="size-4 text-muted-foreground" />
                  </div>
                  <div className="mt-2 font-mono text-[11px]">
                    A/C •••• {String(b.account_number).slice(-4)} · IFSC {b.ifsc_code}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </PanelCard>
      </section>

      {/* ── Deposit/Withdrawal request lists ─────────────────────── */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <RequestList title="Deposit requests" rows={deposits} kind="deposit" />
        <RequestList title="Withdrawal requests" rows={withdrawals} kind="withdrawal" />
      </section>

      {/* ── Add funds dialog ──────────────────────────────────── */}
      <Dialog open={depositOpen} onOpenChange={setDepositOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <DialogTitle>Add funds</DialogTitle>
                <DialogDescription>Pay → enter UTR → submit. Admin will approve in minutes.</DialogDescription>
              </div>
              {/* Support chat — opens admin-managed WhatsApp (preferred)
                  or mailto fallback. The deposit flow is the highest-
                  abandonment funnel; surfacing support here means a
                  stuck user doesn't have to close the dialog to ask
                  for help. */}
              <DepositSupportButton />
            </div>
          </DialogHeader>

          {/* Step indicator */}
          <div className="grid gap-4 md:grid-cols-2">
            {/* ─ Left: payment method ─────────────────── */}
            <div className="space-y-3">
              <SectionLabel num={1} title="Pay using" />

              {(companyBanks?.length ?? 0) === 0 ? (
                <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
                  No payment methods configured yet.
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2">
                  {companyBanks!.map((b: any) => {
                    const active = b.id === dep.bank_account_id;
                    return (
                      <button
                        key={b.id}
                        type="button"
                        onClick={() => setDep((d) => ({ ...d, bank_account_id: b.id }))}
                        className={cn(
                          "flex items-center gap-3 rounded-lg border p-3 text-left text-xs transition",
                          active
                            ? "border-primary bg-primary/5 ring-2 ring-primary/30"
                            : "border-border bg-card hover:border-primary/40"
                        )}
                      >
                        <div className="grid size-9 place-items-center rounded-full bg-primary/10 text-primary">
                          <Building2 className="size-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-semibold">{b.bank_name}</div>
                          <div className="truncate text-muted-foreground">{b.account_holder}</div>
                        </div>
                        {b.is_default && (
                          <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[9px] font-semibold text-primary">
                            DEFAULT
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              {selectedBank && (
                <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3 text-xs">
                  <CopyRow label="A/C No." value={selectedBank.account_number} onCopy={copyText} />
                  <CopyRow label="IFSC" value={selectedBank.ifsc_code} onCopy={copyText} />
                  <CopyRow label="Holder" value={selectedBank.account_holder} onCopy={copyText} />
                  {selectedBank.upi_id && (
                    <CopyRow label="UPI ID" value={selectedBank.upi_id} onCopy={copyText} highlight />
                  )}
                  {selectedBank.upi_id && (
                    <button
                      type="button"
                      onClick={() =>
                        setQrPreview({
                          upiId: selectedBank.upi_id,
                          payee: selectedBank.account_holder,
                          amount: Number(dep.amount) || undefined,
                        })
                      }
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline"
                    >
                      <QrCode className="size-3" /> Show QR code
                    </button>
                  )}
                </div>
              )}

              {/* "We accept UPI" badge — static, always visible. No button. */}
              <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/20 p-3">
                <UpiLogo className="size-10 shrink-0" />
                <div className="min-w-0 text-xs">
                  <div className="font-semibold text-foreground">UPI accepted</div>
                  <div className="text-muted-foreground">
                    GPay · PhonePe · Paytm · BHIM and any UPI-enabled bank app
                  </div>
                </div>
              </div>
            </div>

            {/* ─ Right: amount + UTR + screenshot ────────── */}
            <div className="space-y-3">
              <SectionLabel num={2} title="Confirm your payment" />
              <Field label="Amount (₹)">
                <Input
                  type="number"
                  inputMode="decimal"
                  value={dep.amount}
                  onChange={(e) => setDep((d) => ({ ...d, amount: e.target.value }))}
                  className="h-11 text-lg font-semibold"
                  placeholder="500"
                />
              </Field>

              {/* Quick amount pills */}
              <div className="flex flex-wrap gap-1.5">
                {[500, 1000, 5000, 10000, 25000].map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setDep((d) => ({ ...d, amount: String(v) }))}
                    className="rounded-full border border-border bg-muted/30 px-3 py-1 text-[11px] font-medium hover:border-primary/40 hover:bg-primary/5"
                  >
                    +₹{v.toLocaleString("en-IN")}
                  </button>
                ))}
              </div>

              <Field label="Payment mode">
                <select
                  value={dep.payment_mode}
                  onChange={(e) => setDep((d) => ({ ...d, payment_mode: e.target.value }))}
                  className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
                >
                  <option>UPI</option>
                  <option>NEFT</option>
                  <option>RTGS</option>
                  <option>IMPS</option>
                  <option>BANK_TRANSFER</option>
                </select>
              </Field>

              <Field label="UTR / Transaction reference (optional)">
                <Input
                  value={dep.utr_number}
                  onChange={(e) => setDep((d) => ({ ...d, utr_number: e.target.value }))}
                  placeholder="From your bank/UPI app receipt"
                />
              </Field>

              <Field label="Payment screenshot">
                {dep.screenshot_url ? (
                  <div className="relative inline-block">
                    <img
                      src={dep.screenshot_url.startsWith("http") ? dep.screenshot_url : `${API_URL}${dep.screenshot_url}`}
                      alt="Payment proof"
                      className="max-h-32 rounded-md border border-border object-contain"
                    />
                    <button
                      type="button"
                      onClick={() => setDep((d) => ({ ...d, screenshot_url: "" }))}
                      className="absolute -right-2 -top-2 rounded-full bg-destructive p-0.5 text-white shadow"
                      aria-label="Remove screenshot"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ) : (
                  <label
                    className={cn(
                      "flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/20 px-3 py-4 text-xs text-muted-foreground hover:border-primary/40 hover:bg-primary/5",
                      uploading && "pointer-events-none opacity-60"
                    )}
                  >
                    {uploading ? (
                      <>
                        <Loader2 className="size-4 animate-spin" /> Uploading…
                      </>
                    ) : (
                      <>
                        <Upload className="size-4" /> Click to upload (max 5 MB)
                      </>
                    )}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) uploadScreenshot(f);
                        e.target.value = "";
                      }}
                    />
                  </label>
                )}
              </Field>
              <Field label="Remarks (optional)">
                <Input
                  value={dep.user_remark}
                  onChange={(e) => setDep((d) => ({ ...d, user_remark: e.target.value }))}
                />
              </Field>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDepositOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submitDeposit}>
              <CheckCircle2 className="size-4" /> Submit for approval
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Withdraw dialog ───────────────────────────────────── */}
      <Dialog open={withdrawOpen} onOpenChange={setWithdrawOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Withdraw funds</DialogTitle>
            <DialogDescription>
              Enter your UPI ID or bank details. Admin approves before payout.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Field label="Amount (₹)">
              <Input
                type="number"
                value={wd.amount}
                onChange={(e) => setWd((d) => ({ ...d, amount: e.target.value }))}
                className="h-11 text-lg font-semibold"
              />
            </Field>

            {/* Mode toggle */}
            <div className="grid grid-cols-2 gap-1 rounded-md border border-border p-1">
              {(["UPI", "BANK"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setWd((d) => ({ ...d, mode: m }))}
                  className={
                    "h-9 rounded text-sm font-medium transition-colors " +
                    (wd.mode === m
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent")
                  }
                >
                  {m === "UPI" ? "UPI" : "Bank transfer"}
                </button>
              ))}
            </div>

            {wd.mode === "UPI" ? (
              <>
                <Field label="UPI ID">
                  <Input
                    placeholder="name@bank"
                    value={wd.upi_id}
                    onChange={(e) => setWd((d) => ({ ...d, upi_id: e.target.value }))}
                  />
                </Field>
                <Field label="QR (optional)">
                  <div className="flex items-center gap-2">
                    <input
                      id="wd-qr-input"
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={async (e) => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        if (!f.type.startsWith("image/")) {
                          toast.error("Pick an image file");
                          return;
                        }
                        if (f.size > 15 * 1024 * 1024) {
                          toast.error("File too large (max 15 MB)");
                          return;
                        }
                        setWdQrUploading(true);
                        try {
                          const toUpload = await compressImage(f);
                          const r = await WalletAPI.uploadScreenshot(toUpload);
                          setWd((d) => ({ ...d, qr_url: r.url }));
                          toast.success("QR uploaded");
                        } catch (err: any) {
                          toast.error(err.message || "Upload failed");
                        } finally {
                          setWdQrUploading(false);
                          e.target.value = "";
                        }
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => document.getElementById("wd-qr-input")?.click()}
                      disabled={wdQrUploading}
                    >
                      {wdQrUploading ? "Uploading…" : wd.qr_url ? "Replace QR" : "Upload QR"}
                    </Button>
                    {wd.qr_url && (
                      <a
                        href={wd.qr_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-primary underline"
                      >
                        Preview
                      </a>
                    )}
                  </div>
                </Field>
              </>
            ) : (
              <>
                <Field label="Account holder name">
                  <Input
                    value={wd.account_holder}
                    onChange={(e) => setWd((d) => ({ ...d, account_holder: e.target.value }))}
                  />
                </Field>
                <Field label="Account number">
                  <Input
                    value={wd.account_number}
                    onChange={(e) => setWd((d) => ({ ...d, account_number: e.target.value }))}
                  />
                </Field>
                <Field label="IFSC code">
                  <Input
                    className="uppercase"
                    maxLength={11}
                    value={wd.ifsc_code}
                    onChange={(e) =>
                      setWd((d) => ({ ...d, ifsc_code: e.target.value.toUpperCase() }))
                    }
                  />
                </Field>
                <Field label="Bank name (optional)">
                  <Input
                    value={wd.bank_name}
                    onChange={(e) => setWd((d) => ({ ...d, bank_name: e.target.value }))}
                  />
                </Field>
              </>
            )}

            <Field label="Remarks (optional)">
              <Input value={wd.remarks} onChange={(e) => setWd((d) => ({ ...d, remarks: e.target.value }))} />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWithdrawOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submitWithdrawal}>Request withdrawal</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── QR preview ────────────────────────────────────────── */}
      <Dialog open={!!qrPreview} onOpenChange={(v) => !v && setQrPreview(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Scan to pay</DialogTitle>
          </DialogHeader>
          {qrPreview && (
            <div className="flex flex-col items-center gap-2 pb-2">
              <UpiQR
                upiId={qrPreview.upiId}
                payeeName={qrPreview.payee}
                amount={qrPreview.amount}
                size={256}
              />
              <div className="text-xs text-muted-foreground">
                Open any UPI app and scan{qrPreview.amount ? ` — ₹${qrPreview.amount} pre-filled` : ""}.
              </div>
              <div className="font-mono text-[11px] text-primary">{qrPreview.upiId}</div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────
function HeroStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-2">
      <div className="text-[10px] uppercase tracking-wider opacity-75">{label}</div>
      <div className="mt-0.5 font-tabular text-sm font-semibold">{value}</div>
    </div>
  );
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 font-tabular text-lg font-semibold">{value}</div>
      {hint && <div className="mt-0.5 text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

function PanelCard({
  title,
  subtitle,
  action,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-xl border border-border bg-card p-4", className)}>
      <div className="mb-3 flex items-start justify-between">
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          {subtitle && <p className="text-[11px] text-muted-foreground">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function EmptyState({ message, hint }: { message: string; hint?: string }) {
  return (
    <div className="py-8 text-center">
      <div className="text-sm text-muted-foreground">{message}</div>
      {hint && <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

function SectionLabel({ num, title }: { num: number; title: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="grid size-5 place-items-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
        {num}
      </span>
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs capitalize">{label}</Label>
      {children}
    </div>
  );
}

function CopyRow({
  label,
  value,
  onCopy,
  highlight,
}: {
  label: string;
  value: string;
  onCopy: (text: string, label: string) => void;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}:</span>
      <span className="flex items-center gap-1.5">
        <span className={cn("font-mono", highlight && "text-primary font-semibold")}>{value}</span>
        <button
          type="button"
          onClick={() => onCopy(value, label)}
          className="text-muted-foreground hover:text-foreground"
          aria-label={`Copy ${label}`}
        >
          <Copy className="size-3" />
        </button>
      </span>
    </div>
  );
}

function RequestList({
  title,
  rows,
  kind,
}: {
  title: string;
  rows: any[] | undefined;
  kind: "deposit" | "withdrawal";
}) {
  return (
    <PanelCard title={title} subtitle={`${(rows ?? []).length} total`}>
      {(rows ?? []).length === 0 ? (
        <EmptyState message={`No ${kind} requests yet`} />
      ) : (
        <ul className="divide-y divide-border">
          {rows!.slice(0, 6).map((r: any) => {
            const status = r.status as string;
            const StatusIcon =
              status === "APPROVED" || status === "COMPLETED"
                ? CheckCircle2
                : status === "REJECTED"
                  ? XCircle
                  : Clock;
            const tone =
              status === "APPROVED" || status === "COMPLETED"
                ? "text-buy"
                : status === "REJECTED"
                  ? "text-sell"
                  : "text-amber-600 dark:text-amber-400";
            return (
              <li key={r.id} className="flex items-center justify-between py-2.5 text-xs">
                <div className="flex items-center gap-2.5">
                  <StatusIcon className={cn("size-4", tone)} />
                  <div>
                    <div className="font-tabular font-semibold">{formatINR(r.amount)}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {new Date(r.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
                    </div>
                  </div>
                </div>
                <span className={cn("rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold", tone)}>
                  {status}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </PanelCard>
  );
}

// Canvas-based JPEG re-encode for payment screenshots. Caps the long edge at
// 1600 px (a phone screenshot is usually 1080–1290 px wide, so this is a
// no-op for native res but keeps a stray 4 K screenshot from going up at
// 8 MB). q=0.88 keeps UPI ref numbers / UTR text legible — visually
// indistinguishable from the original at typical viewing zoom.
async function compressImage(file: File): Promise<File> {
  // Already small or not a raster format → upload as-is (PDFs, tiny PNGs).
  if (file.size < 400 * 1024 || !file.type.startsWith("image/")) return file;

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(new Error("read failed"));
    fr.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("decode failed"));
    im.src = dataUrl;
  });

  const MAX_EDGE = 1600;
  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return file;
  ctx.drawImage(img, 0, 0, w, h);

  const blob: Blob | null = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.88),
  );
  if (!blob) return file;
  // If compression somehow ballooned the size (rare — only happens on
  // already-JPEG with very low entropy), fall back to the original.
  if (blob.size >= file.size) return file;

  const baseName = (file.name.replace(/\.[^.]+$/, "") || "screenshot") + ".jpg";
  return new File([blob], baseName, { type: "image/jpeg", lastModified: Date.now() });
}

/**
 * Compact Support pill rendered in the Add-funds dialog header.
 * WhatsApp is the preferred channel (deposit issues are usually back-
 * and-forth — UTR not visible, screenshot blurry, etc — so chat works
 * better than email). Falls back to email when no WhatsApp is
 * configured; renders nothing when neither is set.
 */
function DepositSupportButton() {
  const { data: support } = useSupportContacts();
  const waUrl = buildWhatsappUrl(
    support?.whatsapp,
    "Hi, I need help adding funds to my MarginPlant account",
  );
  const mailUrl = buildMailtoUrl(support?.email, {
    subject: "MarginPlant deposit help",
  });
  if (!waUrl && !mailUrl) return null;
  const target = waUrl ?? mailUrl!;
  const isWa = !!waUrl;
  return (
    <a
      href={target}
      target={isWa ? "_blank" : undefined}
      rel={isWa ? "noopener noreferrer" : undefined}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors",
        isWa
          ? "border-[#25D366]/30 bg-[#25D366]/10 text-[#25D366] hover:bg-[#25D366]/20"
          : "border-primary/30 bg-primary/10 text-primary hover:bg-primary/20",
      )}
    >
      {isWa ? <MessageCircle className="size-3" /> : <Mail className="size-3" />}
      Support
    </a>
  );
}
