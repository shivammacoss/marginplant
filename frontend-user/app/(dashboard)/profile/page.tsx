"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AtSign,
  CheckCircle2,
  IdCard,
  KeyRound,
  Phone,
  ShieldCheck,
  ShieldOff,
  User as UserIcon,
} from "lucide-react";
import { ProfileAPI, AuthAPI, KycAPI } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { KycSection } from "@/components/profile/KycSection";
import { cn } from "@/lib/utils";

type Tab = "overview" | "kyc" | "security";

export default function ProfilePage() {
  const { data: me, refetch } = useQuery({ queryKey: ["me"], queryFn: () => ProfileAPI.me() });
  const { data: kyc } = useQuery({ queryKey: ["kyc"], queryFn: () => KycAPI.status() });

  const [tab, setTab] = useState<Tab>("overview");
  const [name, setName] = useState("");
  useEffect(() => {
    if (me?.full_name) setName(me.full_name);
  }, [me?.full_name]);

  if (!me) return <div className="text-sm text-muted-foreground">Loading…</div>;

  const initials = (me.full_name || me.user_code || "U")
    .split(" ")
    .map((s: string) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const kycStatus = (kyc?.status as string | undefined) ?? "NONE";

  return (
    <div className="space-y-5">
      {/* ── Avatar header ───────────────────────────────────────
         Avatar straddles the dark band; name/code/email always sit BELOW
         the band fold so dark text never lands on dark purple. Works
         identically on mobile + desktop — only the avatar size scales up. */}
      <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        {/* Decorative purple band */}
        <div className="h-24 bg-gradient-to-r from-primary via-primary to-primary/80" />
        <div className="px-5 pb-5">
          {/* Avatar straddles the band — pulled up so half sits over the band. */}
          <div className="-mt-12 mb-3 sm:-mt-14">
            <div className="grid size-24 place-items-center rounded-2xl bg-primary text-3xl font-bold text-primary-foreground shadow-lg ring-4 ring-card sm:size-28">
              {initials}
            </div>
          </div>

          {/* Name + meta — BELOW the avatar, never overlaps the band */}
          <h1 className="text-xl font-semibold tracking-tight md:text-2xl">{me.full_name}</h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1 text-sm text-muted-foreground">
            <span className="font-mono font-medium text-foreground">{me.user_code}</span>
            <span className="hidden sm:inline">·</span>
            <span className="break-all">{me.email}</span>
          </p>

          {/* Status pills */}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <Pill tone={me.status === "ACTIVE" ? "buy" : "muted"}>{me.status}</Pill>
            <Pill tone="primary">{me.role}</Pill>
            {me.is_demo && <Pill tone="warn">DEMO</Pill>}
            <KycPill status={kycStatus} />
          </div>
        </div>
      </section>

      {/* ── Tabs ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-1 rounded-xl border border-border bg-card p-1">
        {(
          [
            { id: "overview", label: "Overview", icon: UserIcon },
            { id: "kyc", label: "KYC verification", icon: IdCard },
            { id: "security", label: "Security", icon: ShieldCheck },
          ] as const
        ).map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                "inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              )}
            >
              <Icon className="size-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* ── Tab content ──────────────────────────────────────── */}
      {tab === "overview" && (
        <OverviewTab me={me} name={name} setName={setName} onSave={() => save(name, refetch)} />
      )}
      {tab === "kyc" && <KycSection />}
      {tab === "security" && <SecurityTab me={me} />}
    </div>
  );
}

async function save(name: string, refetch: () => any) {
  try {
    await ProfileAPI.update({ full_name: name });
    toast.success("Profile updated");
    refetch();
  } catch (e: any) {
    toast.error(e.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// Overview tab
// ─────────────────────────────────────────────────────────────────
function OverviewTab({
  me,
  name,
  setName,
  onSave,
}: {
  me: any;
  name: string;
  setName: (v: string) => void;
  onSave: () => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <SectionCard title="Personal information" description="Used on contract notes and your profile">
        <Field label="Full name">
          <Input value={name} onChange={(e) => setName(e.target.value)} className="h-11" />
        </Field>
        <ReadRow icon={AtSign} label="Email" value={me.email} />
        <ReadRow icon={Phone} label="Mobile" value={me.mobile} />
        <ReadRow icon={IdCard} label="User code" value={<span className="font-mono">{me.user_code}</span>} />
        <div className="pt-2">
          <Button onClick={onSave}>Save changes</Button>
        </div>
      </SectionCard>

      <SectionCard
        title="Account quick facts"
        description="Snapshot of your account status"
        className="bg-gradient-to-br from-card to-muted/40"
      >
        <div className="space-y-3">
          <FactRow label="Account type" value={me.is_demo ? "Demo" : "Live"} />
          <FactRow label="Role" value={me.role} />
          <FactRow label="Status" value={me.status} tone={me.status === "ACTIVE" ? "buy" : undefined} />
          <FactRow label="2FA" value={me.two_fa_enabled ? "Enabled" : "Disabled"} tone={me.two_fa_enabled ? "buy" : "muted"} />
          {me.last_login_at && (
            <FactRow
              label="Last login"
              value={new Date(me.last_login_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
            />
          )}
          <FactRow
            label="Joined"
            value={new Date(me.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}
          />
        </div>
      </SectionCard>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Security tab
// ─────────────────────────────────────────────────────────────────
function SecurityTab({ me }: { me: any }) {
  const [pwd, setPwd] = useState({ current_password: "", new_password: "" });
  const [busy, setBusy] = useState(false);

  async function changePassword() {
    if (pwd.new_password.length < 8) return toast.error("Min 8 characters");
    setBusy(true);
    try {
      await AuthAPI.changePassword(pwd);
      toast.success("Password changed");
      setPwd({ current_password: "", new_password: "" });
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <SectionCard title="Password" description="Change your account password">
        <Field label="Current password">
          <Input
            type="password"
            value={pwd.current_password}
            onChange={(e) => setPwd((p) => ({ ...p, current_password: e.target.value }))}
            className="h-11"
          />
        </Field>
        <Field label="New password">
          <Input
            type="password"
            value={pwd.new_password}
            onChange={(e) => setPwd((p) => ({ ...p, new_password: e.target.value }))}
            className="h-11"
          />
          <p className="text-[11px] text-muted-foreground">Minimum 8 characters.</p>
        </Field>
        <div className="pt-2">
          <Button onClick={changePassword} loading={busy}>
            <KeyRound className="size-4" /> Update password
          </Button>
        </div>
      </SectionCard>

      <SectionCard title="Two-factor authentication" description="Add a second layer to your login">
        <div className="rounded-xl border border-border bg-muted/20 p-4">
          <div className="flex items-start gap-3">
            <div
              className={cn(
                "grid size-10 place-items-center rounded-full",
                me.two_fa_enabled ? "bg-buy/15 text-buy" : "bg-muted text-muted-foreground"
              )}
            >
              {me.two_fa_enabled ? <ShieldCheck className="size-5" /> : <ShieldOff className="size-5" />}
            </div>
            <div className="flex-1">
              <div className="text-sm font-semibold">
                2FA is {me.two_fa_enabled ? "enabled" : "disabled"}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {me.two_fa_enabled
                  ? "Your account uses an authenticator app for the second step."
                  : "Protect your account by requiring a 6-digit code from an authenticator app on every login."}
              </p>
            </div>
            <Button asChild variant={me.two_fa_enabled ? "outline" : "default"} size="sm">
              <a href="/2fa">{me.two_fa_enabled ? "Manage" : "Set up"}</a>
            </Button>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Reusable visual primitives
// ─────────────────────────────────────────────────────────────────
function SectionCard({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-xl border border-border bg-card p-5 shadow-sm", className)}>
      <div className="mb-4">
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && <p className="text-[11px] text-muted-foreground">{description}</p>}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      {children}
    </div>
  );
}

function ReadRow({ icon: Icon, label, value }: { icon: any; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2.5 text-sm">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="truncate text-sm">{value}</div>
      </div>
    </div>
  );
}

function FactRow({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "buy" | "muted" }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          "font-semibold",
          tone === "buy" && "text-buy",
          tone === "muted" && "text-muted-foreground"
        )}
      >
        {value}
      </span>
    </div>
  );
}

function Pill({ children, tone }: { children: React.ReactNode; tone: "primary" | "buy" | "warn" | "muted" }) {
  const tones: Record<string, string> = {
    primary: "bg-primary/15 text-primary",
    buy: "bg-buy/15 text-buy",
    warn: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    muted: "bg-muted text-muted-foreground",
  };
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider", tones[tone])}>
      {children}
    </span>
  );
}

function KycPill({ status }: { status: string }) {
  const cfg: Record<string, { label: string; tone: "primary" | "buy" | "warn" | "muted"; icon: any }> = {
    NONE: { label: "KYC pending", tone: "warn", icon: ShieldOff },
    PENDING: { label: "KYC under review", tone: "warn", icon: ShieldOff },
    APPROVED: { label: "KYC verified", tone: "buy", icon: CheckCircle2 },
    REJECTED: { label: "KYC rejected", tone: "muted", icon: ShieldOff },
    RESUBMIT: { label: "Resubmit KYC", tone: "warn", icon: ShieldOff },
  };
  const c = cfg[status] || cfg.NONE;
  const Icon = c.icon;
  const tones: Record<string, string> = {
    primary: "bg-primary/15 text-primary",
    buy: "bg-buy/15 text-buy",
    warn: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    muted: "bg-muted text-muted-foreground",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
        tones[c.tone]
      )}
    >
      <Icon className="size-3" /> {c.label}
    </span>
  );
}
