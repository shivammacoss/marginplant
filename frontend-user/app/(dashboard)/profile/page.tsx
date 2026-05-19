"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  AtSign,
  Bell,
  CheckCircle2,
  ChevronRight,
  CreditCard,
  FileText,
  HelpCircle,
  IdCard,
  KeyRound,
  Lock,
  LogOut,
  Mail,
  MessageCircle,
  Palette,
  Phone,
  ReceiptText,
  Shield,
  ShieldCheck,
  ShieldOff,
  User as UserIcon,
  Wallet as WalletIcon,
} from "lucide-react";
import { ProfileAPI, AuthAPI, KycAPI } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { KycSection } from "@/components/profile/KycSection";
import { ThemeToggle } from "@/components/common/ThemeToggle";
import { useAuthStore } from "@/stores/authStore";
import {
  buildMailtoUrl,
  buildWhatsappUrl,
  useSupportContacts,
} from "@/lib/useSupport";
import { cn } from "@/lib/utils";

/**
 * Mobile-first profile screen modelled on Zerodha Kite / Groww — a
 * clean avatar header on top followed by grouped list sections
 * (Account, Security, Preferences, Support, About). Tapping any row
 * drills into a sub-screen (rendered in this same component, gated by
 * `subView` state) so the flow feels like a real mobile-app navigation
 * stack while staying on the single `/profile` route. Desktop keeps the
 * same screens but renders them stacked in a single column for now —
 * the visual treatment scales up cleanly.
 *
 * Replaces the earlier tab-based profile that the user called out as
 * "bekar sa hai yrr" — sections were a flat horizontal tab strip and
 * the cards inside felt like an admin form, not a consumer profile.
 */
type SubView =
  | "main"
  | "personal"
  | "kyc"
  | "security"
  | "appearance"
  | "support";

export default function ProfilePage() {
  const { data: me, refetch } = useQuery({ queryKey: ["me"], queryFn: () => ProfileAPI.me() });
  const { data: kyc } = useQuery({ queryKey: ["kyc"], queryFn: () => KycAPI.status() });

  const [subView, setSubView] = useState<SubView>("main");
  const [name, setName] = useState("");
  useEffect(() => {
    if (me?.full_name) setName(me.full_name);
  }, [me?.full_name]);

  if (!me) return <div className="text-sm text-muted-foreground">Loading…</div>;

  const kycStatus = (kyc?.status as string | undefined) ?? "NONE";

  // ── Sub-screens ─────────────────────────────────────────────────
  if (subView !== "main") {
    return (
      <SubScreen
        title={subViewTitle(subView)}
        onBack={() => setSubView("main")}
      >
        {subView === "personal" && (
          <PersonalForm
            me={me}
            name={name}
            setName={setName}
            onSave={() => save(name, refetch)}
          />
        )}
        {subView === "kyc" && <KycSection />}
        {subView === "security" && <SecurityForm me={me} />}
        {subView === "appearance" && <AppearanceForm />}
        {subView === "support" && <SupportLinks />}
      </SubScreen>
    );
  }

  // ── Main screen ────────────────────────────────────────────────
  return (
    <div className="space-y-4 pb-2">
      <ProfileHeader me={me} kycStatus={kycStatus} />

      <ListGroup title="Account">
        <ListRow
          icon={UserIcon}
          tone="primary"
          label="Personal information"
          sub="Name, email, mobile, user code"
          onClick={() => setSubView("personal")}
        />
        <ListRow
          icon={IdCard}
          tone="warn"
          label="KYC verification"
          sub={kycSubLabel(kycStatus)}
          badge={kycBadge(kycStatus)}
          onClick={() => setSubView("kyc")}
        />
        <ListRowLink
          icon={WalletIcon}
          tone="buy"
          label="Wallet"
          sub="Deposit, withdraw, balance"
          href="/wallet"
        />
        <ListRowLink
          icon={CreditCard}
          tone="primary"
          label="Bank accounts"
          sub="Linked payout accounts"
          href="/wallet#bank"
        />
      </ListGroup>

      <ListGroup title="Trading & reports">
        <ListRowLink
          icon={ReceiptText}
          tone="primary"
          label="Reports"
          sub="P&L · Tradebook · Margin · Brokerage · Tax"
          href="/reports/pnl"
        />
        <ListRowLink
          icon={Bell}
          tone="warn"
          label="Notifications"
          sub="Alerts, account activity, system"
          href="/notifications"
        />
        <ListRowLink
          icon={FileText}
          tone="muted"
          label="Ledger"
          sub="Cash entries, charges"
          href="/ledger"
        />
      </ListGroup>

      <ListGroup title="Security">
        <ListRow
          icon={KeyRound}
          tone="primary"
          label="Change password"
          sub="Update your account password"
          onClick={() => setSubView("security")}
        />
        <ListRowLink
          icon={Shield}
          tone={me.two_fa_enabled ? "buy" : "warn"}
          label="Two-factor authentication"
          sub={me.two_fa_enabled ? "Enabled" : "Add a second login step"}
          badge={me.two_fa_enabled ? "On" : "Off"}
          badgeTone={me.two_fa_enabled ? "buy" : "warn"}
          href="/2fa"
        />
      </ListGroup>

      <ListGroup title="Preferences">
        <ListRow
          icon={Palette}
          tone="primary"
          label="Appearance"
          sub="Switch between light and dark theme"
          onClick={() => setSubView("appearance")}
        />
      </ListGroup>

      <ListGroup title="Support">
        <ListRow
          icon={HelpCircle}
          tone="info"
          label="Help & support"
          sub="WhatsApp · email"
          onClick={() => setSubView("support")}
        />
      </ListGroup>

      <ListGroup title="About">
        <ListRowLink
          icon={FileText}
          tone="muted"
          label="Terms of service"
          href="/about"
        />
        <ListRowLink
          icon={FileText}
          tone="muted"
          label="Privacy policy"
          href="/about#privacy"
        />
      </ListGroup>

      <SignOutRow />

      <p className="px-1 pb-4 pt-2 text-center text-[10px] text-muted-foreground">
        MarginPlant Broker · v1.0.0
      </p>
    </div>
  );
}

function subViewTitle(v: SubView): string {
  switch (v) {
    case "personal":
      return "Personal information";
    case "kyc":
      return "KYC verification";
    case "security":
      return "Security";
    case "appearance":
      return "Appearance";
    case "support":
      return "Help & support";
    default:
      return "Profile";
  }
}

function kycSubLabel(status: string): string {
  switch (status) {
    case "APPROVED":
      return "Verified · all good";
    case "PENDING":
      return "Under review";
    case "RESUBMIT":
      return "Re-submit required";
    case "REJECTED":
      return "Verification rejected";
    default:
      return "Complete your KYC";
  }
}

function kycBadge(status: string): string | null {
  switch (status) {
    case "APPROVED":
      return "Verified";
    case "PENDING":
      return "Review";
    case "RESUBMIT":
      return "Action";
    case "REJECTED":
      return "Rejected";
    default:
      return "Pending";
  }
}

// ─────────────────────────────────────────────────────────────────
// Header
// ─────────────────────────────────────────────────────────────────
function ProfileHeader({ me, kycStatus }: { me: any; kycStatus: string }) {
  const initials = (me.full_name || me.user_code || "U")
    .split(" ")
    .map((s: string) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="relative px-5 pt-6 pb-5">
        {/* Subtle gradient backdrop — not the full purple band the user
            disliked. Keeps brand presence while letting text breathe. */}
        <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-br from-primary/30 via-primary/10 to-transparent pointer-events-none" />
        <div className="relative flex items-center gap-4">
          <div className="grid size-16 shrink-0 place-items-center rounded-2xl bg-primary text-xl font-bold text-primary-foreground shadow-md ring-2 ring-card">
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold">{me.full_name}</h1>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              <span className="font-mono font-medium text-foreground">{me.user_code}</span>
              {" · "}
              {me.email}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Pill tone={me.status === "ACTIVE" ? "buy" : "muted"}>{me.status}</Pill>
              <Pill tone="primary">{me.role}</Pill>
              {me.is_demo && <Pill tone="warn">DEMO</Pill>}
              <KycPill status={kycStatus} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────
// List primitives
// ─────────────────────────────────────────────────────────────────
function ListGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="px-3 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {title}
      </h2>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <ul className="divide-y divide-border">{children}</ul>
      </div>
    </section>
  );
}

type Tone = "primary" | "buy" | "sell" | "warn" | "info" | "muted";
const TONE_BG: Record<Tone, string> = {
  primary: "bg-primary/12 text-primary",
  buy: "bg-buy/12 text-buy",
  sell: "bg-sell/12 text-sell",
  warn: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  info: "bg-info/12 text-info",
  muted: "bg-muted text-muted-foreground",
};
const BADGE_TONE: Record<Tone, string> = {
  primary: "bg-primary/15 text-primary",
  buy: "bg-buy/15 text-buy",
  sell: "bg-sell/15 text-sell",
  warn: "bg-amber-500/20 text-amber-700 dark:text-amber-400",
  info: "bg-info/15 text-info",
  muted: "bg-muted text-muted-foreground",
};

function RowInner({
  icon: Icon,
  tone = "primary",
  label,
  sub,
  badge,
  badgeTone = "muted",
}: {
  icon: any;
  tone?: Tone;
  label: string;
  sub?: string;
  badge?: string | null;
  badgeTone?: Tone;
}) {
  return (
    <>
      <div className={cn("grid size-10 shrink-0 place-items-center rounded-xl", TONE_BG[tone])}>
        <Icon className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{label}</div>
        {sub && (
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{sub}</div>
        )}
      </div>
      {badge && (
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
            BADGE_TONE[badgeTone],
          )}
        >
          {badge}
        </span>
      )}
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </>
  );
}

function ListRow(props: {
  icon: any;
  tone?: Tone;
  label: string;
  sub?: string;
  badge?: string | null;
  badgeTone?: Tone;
  onClick: () => void;
}) {
  const { onClick, ...rest } = props;
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/30 active:bg-muted/50"
      >
        <RowInner {...rest} />
      </button>
    </li>
  );
}

function ListRowLink(props: {
  icon: any;
  tone?: Tone;
  label: string;
  sub?: string;
  badge?: string | null;
  badgeTone?: Tone;
  href: string;
}) {
  const { href, ...rest } = props;
  return (
    <li>
      <Link
        href={href}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/30 active:bg-muted/50"
      >
        <RowInner {...rest} />
      </Link>
    </li>
  );
}

function SignOutRow() {
  const logout = useAuthStore((s) => s.logout);
  async function go() {
    try {
      await logout();
    } finally {
      window.location.href = "/login";
    }
  }
  return (
    <button
      type="button"
      onClick={go}
      className="flex w-full items-center justify-center gap-2 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm font-semibold text-destructive transition-colors hover:bg-destructive/10"
    >
      <LogOut className="size-4" />
      Sign out
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────
// Sub-screen frame
// ─────────────────────────────────────────────────────────────────
function SubScreen({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 pb-1">
        <button
          type="button"
          onClick={onBack}
          className="grid size-9 place-items-center rounded-full border border-border bg-card text-muted-foreground hover:bg-muted/40"
          aria-label="Back"
        >
          <ArrowLeft className="size-4" />
        </button>
        <h1 className="text-base font-semibold">{title}</h1>
      </div>
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Personal info form
// ─────────────────────────────────────────────────────────────────
function PersonalForm({
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
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="space-y-4">
        <Field label="Full name">
          <Input value={name} onChange={(e) => setName(e.target.value)} className="h-11" />
        </Field>
        <ReadRow icon={AtSign} label="Email" value={me.email} />
        <ReadRow icon={Phone} label="Mobile" value={me.mobile} />
        <ReadRow
          icon={IdCard}
          label="User code"
          value={<span className="font-mono">{me.user_code}</span>}
        />
        <div className="grid grid-cols-2 gap-3">
          <Fact label="Account" value={me.is_demo ? "Demo" : "Live"} />
          <Fact label="Role" value={me.role} />
          <Fact
            label="Status"
            value={me.status}
            tone={me.status === "ACTIVE" ? "buy" : "muted"}
          />
          <Fact
            label="2FA"
            value={me.two_fa_enabled ? "Enabled" : "Disabled"}
            tone={me.two_fa_enabled ? "buy" : "muted"}
          />
          {me.last_login_at && (
            <Fact
              label="Last login"
              value={new Date(me.last_login_at).toLocaleString("en-IN", {
                dateStyle: "medium",
                timeStyle: "short",
              })}
              wide
            />
          )}
          <Fact
            label="Joined"
            value={new Date(me.created_at).toLocaleDateString("en-IN", {
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
            wide
          />
        </div>
        <div className="pt-1">
          <Button onClick={onSave}>Save changes</Button>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────
// Security form
// ─────────────────────────────────────────────────────────────────
function SecurityForm({ me }: { me: any }) {
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
    <div className="space-y-4">
      <section className="rounded-xl border border-border bg-card p-4">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Lock className="size-4 text-primary" /> Change password
        </h3>
        <div className="space-y-3">
          <Field label="Current password">
            <Input
              type="password"
              value={pwd.current_password}
              onChange={(e) =>
                setPwd((p) => ({ ...p, current_password: e.target.value }))
              }
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
          <Button onClick={changePassword} loading={busy} className="w-full">
            <KeyRound className="size-4" /> Update password
          </Button>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-4">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Shield className="size-4 text-primary" /> Two-factor authentication
        </h3>
        <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/20 p-3">
          <div
            className={cn(
              "grid size-10 shrink-0 place-items-center rounded-full",
              me.two_fa_enabled ? "bg-buy/15 text-buy" : "bg-muted text-muted-foreground",
            )}
          >
            {me.two_fa_enabled ? (
              <ShieldCheck className="size-5" />
            ) : (
              <ShieldOff className="size-5" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">
              2FA is {me.two_fa_enabled ? "enabled" : "disabled"}
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {me.two_fa_enabled
                ? "Authenticator app is required at login."
                : "Protect your account by requiring a 6-digit code from an authenticator app on every login."}
            </p>
          </div>
        </div>
        <div className="mt-3">
          <Button asChild variant={me.two_fa_enabled ? "outline" : "default"} className="w-full">
            <a href="/2fa">{me.two_fa_enabled ? "Manage 2FA" : "Set up 2FA"}</a>
          </Button>
        </div>
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Appearance + Support
// ─────────────────────────────────────────────────────────────────
function AppearanceForm() {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-primary/12 text-primary">
            <Palette className="size-5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium">Theme</div>
            <p className="text-[11px] text-muted-foreground">
              Switch between light and dark
            </p>
          </div>
        </div>
        <ThemeToggle />
      </div>
    </section>
  );
}

function SupportLinks() {
  const { data: support } = useSupportContacts();
  const waUrl = buildWhatsappUrl(
    support?.whatsapp,
    "Hi, I need help with my MarginPlant account",
  );
  const mailUrl = buildMailtoUrl(support?.email, {
    subject: "MarginPlant support request",
  });
  if (!waUrl && !mailUrl) {
    return (
      <section className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
        Support channels haven't been configured yet. Please contact your broker.
      </section>
    );
  }
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <ul className="divide-y divide-border">
        {waUrl && (
          <li>
            <a
              href={waUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 px-3 py-3 transition-colors hover:bg-muted/30"
            >
              <div className="grid size-10 place-items-center rounded-xl bg-[#25D366]/15 text-[#25D366]">
                <MessageCircle className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">WhatsApp support</div>
                <p className="truncate text-[11px] text-muted-foreground">
                  {support?.whatsapp}
                </p>
              </div>
              <ChevronRight className="size-4 text-muted-foreground" />
            </a>
          </li>
        )}
        {mailUrl && (
          <li>
            <a
              href={mailUrl}
              className="flex items-center gap-3 px-3 py-3 transition-colors hover:bg-muted/30"
            >
              <div className="grid size-10 place-items-center rounded-xl bg-primary/12 text-primary">
                <Mail className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">Email support</div>
                <p className="truncate text-[11px] text-muted-foreground">
                  {support?.email}
                </p>
              </div>
              <ChevronRight className="size-4 text-muted-foreground" />
            </a>
          </li>
        )}
      </ul>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────
// Save helper + atoms
// ─────────────────────────────────────────────────────────────────
async function save(name: string, refetch: () => any) {
  try {
    await ProfileAPI.update({ full_name: name });
    toast.success("Profile updated");
    refetch();
  } catch (e: any) {
    toast.error(e.message);
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">{label}</Label>
      {children}
    </div>
  );
}

function ReadRow({
  icon: Icon,
  label,
  value,
}: {
  icon: any;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2.5 text-sm">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <div className="truncate text-sm">{value}</div>
      </div>
    </div>
  );
}

function Fact({
  label,
  value,
  tone,
  wide,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "buy" | "muted";
  wide?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-muted/20 px-3 py-2",
        wide && "col-span-2",
      )}
    >
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 text-sm font-semibold",
          tone === "buy" && "text-buy",
          tone === "muted" && "text-muted-foreground",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function Pill({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "primary" | "buy" | "warn" | "muted";
}) {
  const tones: Record<string, string> = {
    primary: "bg-primary/15 text-primary",
    buy: "bg-buy/15 text-buy",
    warn: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    muted: "bg-muted text-muted-foreground",
  };
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

function KycPill({ status }: { status: string }) {
  const cfg: Record<
    string,
    { label: string; tone: "primary" | "buy" | "warn" | "muted"; icon: any }
  > = {
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
        tones[c.tone],
      )}
    >
      <Icon className="size-3" /> {c.label}
    </span>
  );
}
