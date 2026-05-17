import Link from "next/link";
import type { Metadata } from "next";
import {
  ArrowRight,
  Compass,
  Flag,
  Github,
  HeartHandshake,
  Leaf,
  Linkedin,
  Mail,
  Map,
  Rocket,
  ShieldCheck,
  Sparkles,
  Target,
  Twitter,
  Users,
} from "lucide-react";

export const metadata: Metadata = {
  title: "About",
  description:
    "MarginPlant is a modern Indian broker built by traders. Learn our story, mission, the team and the values that ship every release.",
};

const VALUES = [
  {
    icon: ShieldCheck,
    title: "Trader-first, always",
    body: "Every product call is reviewed by an active trader on the team. If it makes the desk slower, it doesn't ship — no matter how good the deck looks.",
  },
  {
    icon: Compass,
    title: "Transparent by default",
    body: "Brokerage, statutory charges, margin formula and order-matching logic are documented in plain English. No 'premium tier' to unlock the truth.",
  },
  {
    icon: HeartHandshake,
    title: "Built for India",
    body: "IST hours, Indian holiday calendar, Verhoeff-checked Aadhaar, GST-correct contract notes — the boring stuff done right so your CA never has a question.",
  },
  {
    icon: Rocket,
    title: "Move fast, don't break the ledger",
    body: "Engineering ships weekly. The ledger system is double-entry, append-only and reconciled hourly — speed never comes at the cost of your money.",
  },
];

const MILESTONES = [
  { year: "2023", title: "Founding",   body: "Three founders quit their desks at a Mumbai prop shop. Built the first matching engine prototype in 9 weeks." },
  { year: "2024", title: "Closed beta", body: "Onboarded 120 active F&O traders. Zero settlement breaks across 3.1 lakh orders." },
  { year: "2025", title: "Full launch", body: "Public registration opened. Crypto, MCX and currency F&O added. Mobile app rolled out on both stores." },
  { year: "2026", title: "Today",       body: "14+ live segments. ISO 27001 audit in flight. Working on a research-grade option-chain analyser." },
];

const TEAM = [
  { name: "Aarav Sharma",  role: "Co-founder · CEO", bio: "Ex-prop F&O trader, 9 years on NIFTY index options. Wrote the first version of the risk-enforcer engine." },
  { name: "Diya Patel",    role: "Co-founder · CTO", bio: "Built low-latency matching systems at two HFT shops. Cares unreasonably about p99 latency and append-only ledgers." },
  { name: "Kabir Joshi",   role: "Co-founder · COO", bio: "Chartered Accountant. Owns compliance, statutory contract-note generation and the SEBI filings." },
  { name: "Meera Iyer",    role: "Head of Product",  bio: "Designed the terminal. Trades a small intraday book to stay honest about every UX decision." },
  { name: "Vikram Rao",    role: "Head of Engineering", bio: "Owns the real-time tick pipeline and the WebSocket fanout. Sleeps with a PagerDuty wristband." },
  { name: "Anika Gupta",   role: "Head of Support",  bio: "Built the help desk from scratch. Median first-response time on a trading day: 84 seconds." },
];

const NUMBERS = [
  { value: "9 ms",   label: "Median order latency" },
  { value: "99.97%", label: "Uptime (last 6 mo)" },
  { value: "0",      label: "Settlement breaks since launch" },
  { value: "84 s",   label: "Median support response" },
];

export default function AboutPage() {
  return (
    <>
      <section className="relative overflow-hidden border-b border-border">
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-b from-primary/10 via-background to-background" />
        <div className="mx-auto max-w-5xl px-4 py-20 text-center sm:px-6 sm:py-24 lg:px-8">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
            <Sparkles className="size-3" /> Our story
          </span>
          <h1 className="mt-5 text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
            Built by traders.
            <br />
            <span className="mp-gradient-text">For the Indian desk.</span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
            We started MarginPlant because the brokers we used were either fast
            and opaque, or transparent and slow. None of them treated retail
            traders like the serious customers they are. So we built the one we
            wanted — and put it on the open internet for everyone.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
        <div className="grid gap-8 lg:grid-cols-2">
          <div className="rounded-2xl border border-border bg-card p-8">
            <div className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
              <Target className="size-5" />
            </div>
            <h2 className="mt-4 text-2xl font-bold tracking-tight">Mission</h2>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Give every Indian trader the same execution speed, risk tooling
              and statutory transparency that a Mumbai prop desk gets — on a
              single fast terminal, at a flat-fee price. No tiering. No
              "premium" upsells gating real features.
            </p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-8">
            <div className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
              <Flag className="size-5" />
            </div>
            <h2 className="mt-4 text-2xl font-bold tracking-tight">Vision</h2>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              An India where retail traders pick their broker on the quality
              of the platform, not the size of the advertising budget. Where
              "₹20 flat" is the floor, not a discount. Where the contract note
              reads exactly the way SEBI prescribes — line by line.
            </p>
          </div>
        </div>
      </section>

      <section className="border-y border-border bg-muted/20">
        <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8">
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border/70 sm:grid-cols-4">
            {NUMBERS.map((s) => (
              <div key={s.label} className="bg-card p-6 text-center">
                <div className="font-tabular text-2xl font-bold text-primary sm:text-3xl">
                  {s.value}
                </div>
                <div className="mt-1 text-xs uppercase tracking-wider text-muted-foreground">
                  {s.label}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
        <div className="max-w-2xl">
          <span className="text-xs font-semibold uppercase tracking-wider text-primary">
            Our values
          </span>
          <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
            How we make decisions when no one is watching.
          </h2>
          <p className="mt-3 text-muted-foreground">
            Four rules — written down, taped to the wall, debated on every PR.
          </p>
        </div>
        <div className="mt-10 grid gap-5 md:grid-cols-2">
          {VALUES.map((v) => {
            const Icon = v.icon;
            return (
              <div key={v.title} className="rounded-2xl border border-border bg-card p-6">
                <div className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
                  <Icon className="size-5" />
                </div>
                <h3 className="mt-4 text-base font-semibold">{v.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {v.body}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      <section className="border-y border-border bg-card/40">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
          <div className="max-w-2xl">
            <span className="text-xs font-semibold uppercase tracking-wider text-primary">
              The journey so far
            </span>
            <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
              Three founders, one ledger, zero shortcuts.
            </h2>
          </div>
          <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {MILESTONES.map((m) => (
              <div key={m.year} className="relative rounded-2xl border border-border bg-background p-6">
                <div className="text-xs font-semibold uppercase tracking-wider text-primary">
                  {m.year}
                </div>
                <div className="mt-2 text-lg font-bold tracking-tight">{m.title}</div>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{m.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="team" className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
        <div className="max-w-2xl">
          <span className="text-xs font-semibold uppercase tracking-wider text-primary">
            The team
          </span>
          <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
            A small team that ships every week.
          </h2>
          <p className="mt-3 text-muted-foreground">
            We're 22 people across Mumbai, Bengaluru and Pune. Half are active
            traders. The other half wishes they had time to be.
          </p>
        </div>

        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {TEAM.map((p) => (
            <div key={p.name} className="rounded-2xl border border-border bg-card p-6">
              <div className="flex items-center gap-3">
                <div className="grid size-12 place-items-center rounded-full bg-primary/15 text-primary ring-1 ring-primary/20">
                  <Users className="size-5" />
                </div>
                <div>
                  <div className="text-base font-semibold">{p.name}</div>
                  <div className="text-xs text-muted-foreground">{p.role}</div>
                </div>
              </div>
              <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{p.bio}</p>
              <div className="mt-4 flex items-center gap-3 text-muted-foreground">
                <Linkedin className="size-4 hover:text-primary" />
                <Twitter className="size-4 hover:text-primary" />
                <Github className="size-4 hover:text-primary" />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="border-y border-border bg-muted/20">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
          <div className="grid items-start gap-10 lg:grid-cols-2">
            <div>
              <span className="text-xs font-semibold uppercase tracking-wider text-primary">
                Where we work
              </span>
              <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
                Indian roots. Global infra.
              </h2>
              <p className="mt-3 text-muted-foreground">
                Our trading-day team sits across Mumbai and Bengaluru, with
                support spread to cover IST + crypto evenings. Production runs
                on AWS Mumbai (ap-south-1) for India-resident data, with a
                Singapore replica for global-segment feeds.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {[
                { city: "Mumbai HQ", body: "BKC. Engineering, compliance, trading desk." },
                { city: "Bengaluru", body: "Indiranagar. Product, design, frontend." },
                { city: "Pune",      body: "Baner. Operations + KYC." },
                { city: "Remote",    body: "Support team across Tier-2 cities." },
              ].map((o) => (
                <div key={o.city} className="rounded-xl border border-border bg-card p-5">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <Map className="size-4 text-primary" />
                    {o.city}
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{o.body}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section id="careers" className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
        <div className="rounded-3xl border border-primary/30 bg-gradient-to-br from-primary/10 via-primary/5 to-background p-8 sm:p-12">
          <div className="grid items-center gap-8 lg:grid-cols-[1fr_auto]">
            <div className="max-w-2xl">
              <Leaf className="size-10 text-primary" />
              <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
                Want to build the next desk-grade broker?
              </h2>
              <p className="mt-3 text-muted-foreground">
                We hire engineers, designers, traders-turned-PMs and compliance
                operators. If you've ever wanted to fix what's broken about
                Indian retail trading — write to us.
              </p>
            </div>
            <div className="flex flex-col items-stretch gap-3 sm:flex-row lg:flex-col">
              <Link href="mailto:careers@marginplant.com" className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-primary px-6 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
                <Mail className="size-4" /> careers@marginplant.com
              </Link>
              <Link href="/contact" className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-border bg-background px-6 text-sm font-semibold hover:bg-muted/50">
                Get in touch <ArrowRight className="size-4" />
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
