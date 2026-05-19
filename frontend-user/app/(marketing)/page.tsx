import Link from "next/link";
import type { Metadata } from "next";
import {
  ArrowRight,
  BarChart3,
  CandlestickChart,
  CheckCircle2,
  Globe,
  Layers,
  Lock,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Star,
  TrendingUp,
  Wallet,
  Zap,
} from "lucide-react";
import { HeroAnimation } from "@/components/marketing/HeroAnimation";
import { InstallPwaButton } from "@/components/common/InstallPwaButton";

export const metadata: Metadata = {
  title: "MarginPlant Broker — India's Modern Multi-Segment Trading Platform",
  description:
    "Trade NSE, BSE, MCX, currency, crypto and global forex on one fast terminal. Flat ₹20 brokerage, real-time risk controls, transparent statutory breakdown.",
};

const FEATURES = [
  {
    icon: CandlestickChart,
    title: "All-in-one terminal",
    body: "Equities, F&O, currencies, commodities and crypto on a single fast chart with one-click trading and saved layouts.",
  },
  {
    icon: Zap,
    title: "Sub-10 ms order flow",
    body: "Real-time Kite Connect ticks for Indian markets; AllTick for crypto + forex. Orders match in-house — no exchange-routing lag.",
  },
  {
    icon: ShieldCheck,
    title: "Auto risk controls",
    body: "Margin-call and stop-out enforced 24×7. Exit-only mode, hold-time guards, daily expiry cleanup — built into the engine, not bolted on.",
  },
  {
    icon: Wallet,
    title: "Transparent fees",
    body: "Flat ₹20 per order. STT, GST, exchange, SEBI and stamp duty itemised on every contract note — no hidden mark-ups.",
  },
  {
    icon: Smartphone,
    title: "Mobile-first design",
    body: "Bottom-nav app feel on your phone, full pro terminal on desktop. Same account, same speed, same risk system everywhere.",
  },
  {
    icon: Globe,
    title: "24×7 segments",
    body: "Indian markets follow NSE / BSE / MCX hours. Crypto and forex never sleep — trade gold, oil and BTC at 2 am from your phone.",
  },
];

const STATS = [
  { value: "9 ms", label: "Median order latency" },
  { value: "₹0", label: "Account opening" },
  { value: "14+", label: "Segments live" },
  { value: "24×7", label: "Crypto & forex" },
];

const HOW_IT_WORKS = [
  {
    n: "01",
    title: "Open in 5 minutes",
    body: "Aadhaar + PAN, selfie video, e-sign. Fully digital — no courier, no branch visit. Approved same-day.",
  },
  {
    n: "02",
    title: "Fund instantly",
    body: "UPI, IMPS, NEFT or net-banking — money lands in seconds. Withdraw to the same bank account any time.",
  },
  {
    n: "03",
    title: "Trade everything",
    body: "Equity, F&O, MCX, currency, crypto and global forex from one terminal. Switch segments without re-logging in.",
  },
  {
    n: "04",
    title: "Stay in control",
    body: "Real-time P&L, live margin, position-level risk, daily contract notes and a full ledger view — always one click away.",
  },
];

const SEGMENTS = [
  { name: "NSE Equity",    note: "Cash + delivery" },
  { name: "BSE Equity",    note: "All listed scrips" },
  { name: "NSE F&O",       note: "Index + stock" },
  { name: "BSE F&O",       note: "SENSEX, BANKEX" },
  { name: "Currency F&O",  note: "USD/EUR/GBP/JPY" },
  { name: "MCX Commodity", note: "Gold, Crude, NG" },
  { name: "Spot Forex",    note: "24×5 majors" },
  { name: "Crypto",        note: "24×7 BTC, ETH +" },
  { name: "Index Spot",    note: "NIFTY, SENSEX" },
  { name: "Bond / G-Sec",  note: "Coming soon" },
  { name: "ETF",           note: "All AMCs" },
  { name: "Mutual Funds",  note: "Direct, ₹0 commission" },
];

const TESTIMONIALS = [
  {
    quote:
      "Switched from a legacy broker after 8 years. The risk-management engine actually stops me out at the right level — I've stopped losing the overnight scare to a sluggish margin call.",
    name: "Arjun Mehta",
    role: "F&O trader · Mumbai",
  },
  {
    quote:
      "Finally a broker that doesn't shove a separate app at me for MCX and currency. One login, one P&L, and the ledger is genuinely readable.",
    name: "Priya Subramanian",
    role: "Swing trader · Bengaluru",
  },
  {
    quote:
      "The flat ₹20 is real — I checked the contract notes line-by-line. STT and stamp duty are exactly the rates SEBI publishes. No funny rounding.",
    name: "Rohit Kapoor",
    role: "Day trader · Delhi NCR",
  },
];

const TRUST_BADGES = [
  { label: "SEBI-aligned" },
  { label: "ISO 27001 (in progress)" },
  { label: "DPDP-compliant" },
  { label: "256-bit TLS" },
  { label: "MFA for admin" },
  { label: "Cold-wallet crypto" },
];

export default function HomePage() {
  return (
    <>
      {/* ── HERO ───────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-b from-primary/10 via-background to-background"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -top-32 left-1/2 -z-10 size-[700px] -translate-x-1/2 rounded-full bg-primary/15 blur-3xl"
        />

        <div className="mx-auto grid max-w-7xl items-center gap-10 px-4 pb-16 pt-12 sm:px-6 sm:pt-16 lg:grid-cols-2 lg:gap-14 lg:px-8 lg:pt-24">
          {/* LEFT — copy */}
          <div className="text-center lg:text-left">
            <span className="mp-fade-up inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
              <Sparkles className="size-3" />
              Built for serious Indian traders · Live
            </span>
            <h1 className="mp-fade-up mp-fade-up-d1 mt-5 text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl xl:text-7xl">
              Trade the
              <br className="hidden sm:block" />{" "}
              <span className="mp-gradient-text">whole market</span>
              <br /> from one terminal.
            </h1>
            <p className="mp-fade-up mp-fade-up-d2 mx-auto mt-5 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg lg:mx-0">
              Equities, F&amp;O, currencies, commodities and crypto — one
              account, one chart, one click to fire. Built for the rhythm of
              Indian markets, the speed of crypto and the discipline of serious
              capital.
            </p>

            <div className="mp-fade-up mp-fade-up-d3 mt-8 flex flex-col items-center gap-3 sm:flex-row lg:justify-start">
              <Link
                href="/register"
                className="group inline-flex h-12 items-center gap-2 rounded-md bg-primary px-7 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-all hover:bg-primary/90 hover:shadow-primary/40"
              >
                Open free account
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
              <Link
                href="/features"
                className="inline-flex h-12 items-center gap-2 rounded-md border border-border bg-background/60 px-7 text-sm font-semibold text-foreground backdrop-blur hover:bg-muted/50"
              >
                Explore the platform
              </Link>
              {/* PWA install affordance — Chrome/Edge/Samsung Internet
                  render a real button once the manifest + service worker
                  are picked up. Falls back to a Safari iOS hint on
                  iPhones. Hidden when the user is already inside the
                  installed standalone shell. */}
              <InstallPwaButton className="h-12" />
            </div>

            <div className="mp-fade-up mp-fade-up-d4 mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-muted-foreground lg:justify-start">
              <span className="inline-flex items-center gap-1.5">
                <CheckCircle2 className="size-3.5 text-buy" />
                ₹0 account opening
              </span>
              <span className="inline-flex items-center gap-1.5">
                <CheckCircle2 className="size-3.5 text-buy" />
                No AMC for year 1
              </span>
              <span className="inline-flex items-center gap-1.5">
                <CheckCircle2 className="size-3.5 text-buy" />
                Fund via UPI in seconds
              </span>
            </div>
          </div>

          {/* RIGHT — animation */}
          <div className="mp-fade-up mp-fade-up-d2 relative">
            <HeroAnimation />
          </div>
        </div>

        {/* Stats strip */}
        <div className="mx-auto max-w-6xl px-4 pb-16 sm:px-6 lg:px-8">
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border/70 sm:grid-cols-4">
            {STATS.map((s) => (
              <div
                key={s.label}
                className="bg-card/80 p-5 text-center backdrop-blur"
              >
                <div className="font-tabular text-3xl font-bold tracking-tight text-primary sm:text-4xl">
                  {s.value}
                </div>
                <div className="mt-1.5 text-xs uppercase tracking-wider text-muted-foreground">
                  {s.label}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Trust strip */}
        <div className="border-y border-border bg-muted/20">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-x-6 gap-y-3 px-4 py-4 text-xs text-muted-foreground sm:px-6 lg:px-8">
            <span className="font-semibold uppercase tracking-wider text-foreground/80">
              Trusted infra
            </span>
            {TRUST_BADGES.map((b) => (
              <span key={b.label} className="inline-flex items-center gap-1.5">
                <ShieldCheck className="size-3.5 text-primary" />
                {b.label}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ── FEATURES ──────────────────────────────────────────────── */}
      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
        <div className="max-w-2xl">
          <span className="text-xs font-semibold uppercase tracking-wider text-primary">
            Why MarginPlant
          </span>
          <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl">
            Everything you need
            <br />
            to trade <span className="mp-gradient-text">seriously</span>.
          </h2>
          <p className="mt-4 text-base text-muted-foreground sm:text-lg">
            A modern broker built ground-up for Indian regulations and global
            asset classes. No legacy desktop client, no surprise charges, no
            "premium" upsells gating real features.
          </p>
        </div>

        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => {
            const Icon = f.icon;
            return (
              <div
                key={f.title}
                className="group relative overflow-hidden rounded-2xl border border-border bg-card p-6 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-xl hover:shadow-primary/5"
              >
                <div
                  aria-hidden
                  className="pointer-events-none absolute -right-10 -top-10 size-32 rounded-full bg-primary/10 opacity-0 blur-2xl transition-opacity group-hover:opacity-100"
                />
                <div className="grid size-11 place-items-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
                  <Icon className="size-5" />
                </div>
                <h3 className="mt-5 text-base font-semibold">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {f.body}
                </p>
              </div>
            );
          })}
        </div>

        <div className="mt-10 text-center">
          <Link
            href="/features"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline"
          >
            See the full feature list <ArrowRight className="size-3.5" />
          </Link>
        </div>
      </section>

      {/* ── HOW IT WORKS ──────────────────────────────────────────── */}
      <section className="border-y border-border bg-muted/20">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
          <div className="mx-auto max-w-2xl text-center">
            <span className="text-xs font-semibold uppercase tracking-wider text-primary">
              How it works
            </span>
            <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
              From zero to your first trade in under 10 minutes.
            </h2>
            <p className="mt-3 text-muted-foreground">
              Designed for the way India actually onboards — Aadhaar, UPI,
              e-sign — without a single courier or branch visit.
            </p>
          </div>

          <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-4">
            {HOW_IT_WORKS.map((s) => (
              <div
                key={s.n}
                className="relative rounded-2xl border border-border bg-card p-6"
              >
                <div className="font-tabular text-3xl font-bold text-primary/40">
                  {s.n}
                </div>
                <h3 className="mt-3 text-base font-semibold">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {s.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── SEGMENTS BAND ─────────────────────────────────────────── */}
      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <span className="text-xs font-semibold uppercase tracking-wider text-primary">
              14+ segments
            </span>
            <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl">
              One account.
              <br />
              Every market that <span className="mp-gradient-text">matters</span>.
            </h2>
            <p className="mt-4 text-muted-foreground">
              NSE, BSE and MCX for Indian equities, derivatives and commodities.
              AllTick for global forex, crypto, metals and energy. The terminal
              auto-switches contract specs, lot sizes and statutory charges per
              segment — you just trade.
            </p>
            <ul className="mt-6 space-y-2 text-sm">
              {[
                "Equity delivery is free, F&O is flat ₹20 per leg.",
                "Crypto pairs settle to INR. No third-party wallets.",
                "MCX gold / silver / crude / natural gas live during full Indian commodity hours.",
                "Currency F&O on USDINR, EURINR, GBPINR, JPYINR.",
              ].map((t) => (
                <li key={t} className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-buy" />
                  <span className="text-muted-foreground">{t}</span>
                </li>
              ))}
            </ul>
            <Link
              href="/markets"
              className="mt-7 inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline"
            >
              Deep-dive every segment <ArrowRight className="size-3.5" />
            </Link>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {SEGMENTS.map((s) => (
              <div
                key={s.name}
                className="group rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/40"
              >
                <div className="text-sm font-semibold">{s.name}</div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {s.note}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── TESTIMONIALS ──────────────────────────────────────────── */}
      <section className="border-y border-border bg-card/40">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
          <div className="mx-auto max-w-2xl text-center">
            <span className="text-xs font-semibold uppercase tracking-wider text-primary">
              From the desk
            </span>
            <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
              Built with traders, not for marketing decks.
            </h2>
          </div>

          <div className="mt-12 grid gap-5 lg:grid-cols-3">
            {TESTIMONIALS.map((t) => (
              <figure
                key={t.name}
                className="flex h-full flex-col rounded-2xl border border-border bg-background p-6"
              >
                <div className="flex items-center gap-0.5 text-primary">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Star key={i} className="size-4 fill-primary" />
                  ))}
                </div>
                <blockquote className="mt-4 flex-1 text-sm leading-relaxed text-foreground/90">
                  “{t.quote}”
                </blockquote>
                <figcaption className="mt-5 border-t border-border pt-4">
                  <div className="text-sm font-semibold">{t.name}</div>
                  <div className="text-xs text-muted-foreground">{t.role}</div>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      {/* ── CALLOUTS ──────────────────────────────────────────────── */}
      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
        <div className="grid gap-5 lg:grid-cols-3">
          <div className="rounded-2xl border border-border bg-card p-6">
            <Lock className="size-6 text-primary" />
            <h3 className="mt-4 text-lg font-semibold">Your money, your control</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Funds in regulated escrow. Withdrawals only to the bank account
              that funded you. Two-factor mandatory for admins, optional for
              you — and we recommend turning it on.
            </p>
            <Link
              href="/security"
              className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline"
            >
              Security model <ArrowRight className="size-3.5" />
            </Link>
          </div>

          <div className="rounded-2xl border border-border bg-card p-6">
            <Layers className="size-6 text-primary" />
            <h3 className="mt-4 text-lg font-semibold">Built for India first</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              IST market hours, Indian holiday calendar, Verhoeff-checked
              Aadhaar, PAN + IFSC validation, GST-correct contract notes — the
              boring stuff done right so you never see a CA query.
            </p>
            <Link
              href="/markets"
              className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline"
            >
              Market hours <ArrowRight className="size-3.5" />
            </Link>
          </div>

          <div className="rounded-2xl border border-border bg-card p-6">
            <BarChart3 className="size-6 text-primary" />
            <h3 className="mt-4 text-lg font-semibold">Learn while you trade</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Free explainers on F&amp;O, margins, options Greeks, STT vs LTCG,
              and the actual mechanics of how your order matches. Written by
              traders, fact-checked against SEBI circulars.
            </p>
            <Link
              href="/learn"
              className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline"
            >
              Open the learn hub <ArrowRight className="size-3.5" />
            </Link>
          </div>
        </div>
      </section>

      {/* ── CTA ───────────────────────────────────────────────────── */}
      <section className="mx-auto max-w-7xl px-4 pb-24 sm:px-6 lg:px-8">
        <div className="relative overflow-hidden rounded-3xl border border-primary/30 bg-gradient-to-br from-primary/15 via-primary/5 to-background px-6 py-14 text-center sm:px-12 sm:py-20">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-24 -top-24 size-80 rounded-full bg-primary/30 blur-3xl"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-24 -left-20 size-80 rounded-full bg-primary/20 blur-3xl"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-30"
            style={{
              background:
                "radial-gradient(circle at 90% 10%, rgba(255,153,51,0.18), transparent 35%),radial-gradient(circle at 10% 90%, rgba(19,136,8,0.18), transparent 35%)",
            }}
          />
          <div className="relative">
            <TrendingUp className="mx-auto size-10 text-primary" />
            <h2 className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl">
              Markets open at 9:15.
              <br />
              <span className="mp-gradient-text">So does your account.</span>
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-base text-muted-foreground sm:text-lg">
              Open in 5 minutes. Fund via UPI in seconds. Trade with the same
              tooling the pros use — without the legacy price tag.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link
                href="/register"
                className="inline-flex h-12 items-center gap-2 rounded-md bg-primary px-7 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 hover:bg-primary/90"
              >
                Open account <ArrowRight className="size-4" />
              </Link>
              <Link
                href="/pricing"
                className="inline-flex h-12 items-center gap-2 rounded-md border border-border bg-background/80 px-7 text-sm font-semibold text-foreground backdrop-blur hover:bg-muted/50"
              >
                See pricing
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
