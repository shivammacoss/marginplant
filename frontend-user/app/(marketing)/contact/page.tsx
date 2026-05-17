"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ArrowRight,
  Building2,
  Calendar,
  CheckCircle2,
  Clock,
  HelpCircle,
  IndianRupee,
  Landmark,
  LifeBuoy,
  Mail,
  MapPin,
  MessageSquare,
  Phone,
  Send,
  Sparkles,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";

const CHANNELS = [
  {
    icon: Mail,
    title: "Email",
    primary: "support@marginplant.com",
    href: "mailto:support@marginplant.com",
    desc: "Replies within 84 seconds median on a trading day, 4 hours after-hours.",
  },
  {
    icon: Phone,
    title: "Phone",
    primary: "+91 80 6900 0000",
    href: "tel:+918069000000",
    desc: "Mon–Sat · 08:30 – 22:00 IST · IVR routes you to the right desk.",
  },
  {
    icon: MessageSquare,
    title: "Live chat",
    primary: "In the app",
    href: "/login",
    desc: "Logged-in chat with a human — opens during market hours, on-call after.",
  },
];

const DESKS = [
  { icon: LifeBuoy, name: "General support",  email: "support@marginplant.com",   hours: "Mon–Sat · 08:30 – 22:00 IST" },
  { icon: HelpCircle, name: "KYC & onboarding", email: "kyc@marginplant.com",      hours: "Mon–Fri · 09:30 – 18:00 IST" },
  { icon: Wallet,   name: "Brokerage & ledger", email: "brokerage@marginplant.com", hours: "Mon–Fri · 09:30 – 18:00 IST" },
  { icon: Landmark, name: "Compliance",        email: "compliance@marginplant.com", hours: "Mon–Fri · 10:00 – 18:00 IST" },
  { icon: IndianRupee, name: "Grievance",      email: "grievance@marginplant.com", hours: "Replies in T+2 working days" },
  { icon: Calendar, name: "Press & partnerships", email: "press@marginplant.com",  hours: "Best-effort response" },
];

const OFFICES = [
  {
    city: "Mumbai HQ",
    addr: "5th Floor, Equinox Business Park, BKC, Bandra East, Mumbai 400051",
    note: "Compliance, trading desk, executive team",
  },
  {
    city: "Bengaluru",
    addr: "WeWork Embassy GolfLinks, Domlur, Bengaluru 560071",
    note: "Product, design, frontend engineering",
  },
  {
    city: "Pune",
    addr: "PanCard Club Road, Baner, Pune 411045",
    note: "Operations, KYC team, support hub",
  },
];

const GRIEVANCE_CHAIN = [
  { step: "Level 1", who: "Customer Support",   email: "support@marginplant.com",  sla: "T+1 working day" },
  { step: "Level 2", who: "Compliance Officer", email: "compliance@marginplant.com", sla: "T+3 working days" },
  { step: "Level 3", who: "Grievance Officer",  email: "grievance@marginplant.com", sla: "T+7 working days" },
  { step: "Level 4", who: "SEBI SCORES",        email: "scores.sebi.gov.in",        sla: "Per SEBI timelines" },
];

export default function ContactPage() {
  const [form, setForm] = useState({ name: "", email: "", subject: "general", message: "" });
  const [sending, setSending] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.email || !form.message) {
      toast.error("Naam, email aur message bharo bhai.");
      return;
    }
    setSending(true);
    try {
      // No backend wiring here — that's a separate ticket. Simulate.
      await new Promise((r) => setTimeout(r, 700));
      toast.success("Got it. We'll write back within 4 working hours.");
      setForm({ name: "", email: "", subject: "general", message: "" });
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <section className="relative overflow-hidden border-b border-border">
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-b from-primary/10 via-background to-background" />
        <div className="mx-auto max-w-5xl px-4 py-20 text-center sm:px-6 sm:py-24 lg:px-8">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
            <Sparkles className="size-3" /> We answer fast
          </span>
          <h1 className="mt-5 text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
            Talk to a human.
            <br />
            <span className="mp-gradient-text">In under 90 seconds.</span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
            Most queries are resolved by the first reply. Pick the channel that
            suits you — email, phone, in-app chat, or the form below.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="grid gap-5 lg:grid-cols-3">
          {CHANNELS.map((c) => {
            const Icon = c.icon;
            return (
              <Link
                key={c.title}
                href={c.href}
                className="group rounded-2xl border border-border bg-card p-6 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-xl hover:shadow-primary/5"
              >
                <div className="grid size-12 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/20">
                  <Icon className="size-6" />
                </div>
                <div className="mt-5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {c.title}
                </div>
                <div className="mt-1 text-lg font-bold tracking-tight text-foreground group-hover:text-primary">
                  {c.primary}
                </div>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{c.desc}</p>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="border-y border-border bg-muted/20">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
          <div className="grid items-start gap-12 lg:grid-cols-[1.2fr_1fr]">
            <div>
              <span className="text-xs font-semibold uppercase tracking-wider text-primary">Write to us</span>
              <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">Send a detailed message.</h2>
              <p className="mt-3 text-muted-foreground">
                For anything that needs context — a tax query, a withdrawal
                review, a feature request. The right desk picks it up.
              </p>

              <form onSubmit={onSubmit} className="mt-8 grid gap-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="name" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Your name
                    </label>
                    <input
                      id="name"
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      placeholder="Anika Sharma"
                      className="mt-1.5 h-11 w-full rounded-md border border-border bg-background px-3.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                  </div>
                  <div>
                    <label htmlFor="email" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Email
                    </label>
                    <input
                      id="email"
                      type="email"
                      value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })}
                      placeholder="you@email.com"
                      className="mt-1.5 h-11 w-full rounded-md border border-border bg-background px-3.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="subject" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Subject
                  </label>
                  <select
                    id="subject"
                    value={form.subject}
                    onChange={(e) => setForm({ ...form, subject: e.target.value })}
                    className="mt-1.5 h-11 w-full rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  >
                    <option value="general">General question</option>
                    <option value="kyc">KYC / Onboarding</option>
                    <option value="brokerage">Brokerage / Ledger query</option>
                    <option value="risk">Risk / Margin issue</option>
                    <option value="security">Security concern</option>
                    <option value="grievance">File a grievance</option>
                    <option value="press">Press / Partnership</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="message" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Message
                  </label>
                  <textarea
                    id="message"
                    rows={6}
                    value={form.message}
                    onChange={(e) => setForm({ ...form, message: e.target.value })}
                    placeholder="Tell us everything — the more context the faster the resolution."
                    className="mt-1.5 w-full rounded-md border border-border bg-background px-3.5 py-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>

                <button
                  type="submit"
                  disabled={sending}
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-primary px-7 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                >
                  {sending ? "Sending…" : <>Send message <Send className="size-4" /></>}
                </button>
                <p className="text-xs text-muted-foreground">
                  We reply from a real person, signed off with their name and
                  role. No "Hi there, your ticket #1234567 has been escalated".
                </p>
              </form>
            </div>

            <aside className="space-y-5">
              <div className="rounded-2xl border border-border bg-card p-6">
                <Clock className="size-5 text-primary" />
                <h3 className="mt-3 text-base font-semibold">Response targets</h3>
                <ul className="mt-3 space-y-2 text-sm">
                  {[
                    ["Trading-day queries",  "84 s median"],
                    ["After-hours email",    "4 hours"],
                    ["KYC follow-ups",       "T+1 working day"],
                    ["Grievances",           "T+3 working days"],
                  ].map(([k, v]) => (
                    <li key={k} className="flex items-center justify-between gap-2 border-b border-border pb-2 last:border-0 last:pb-0">
                      <span className="text-muted-foreground">{k}</span>
                      <span className="font-medium text-foreground">{v}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="rounded-2xl border border-primary/30 bg-primary/5 p-6">
                <CheckCircle2 className="size-5 text-primary" />
                <h3 className="mt-3 text-base font-semibold">In a hurry?</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  Logged-in chat is the fastest path during market hours. Risk
                  events on your account jump the queue automatically.
                </p>
                <Link
                  href="/login"
                  className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline"
                >
                  Login &amp; chat <ArrowRight className="size-3.5" />
                </Link>
              </div>
            </aside>
          </div>
        </div>
      </section>

      <section id="kyc" className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
        <div className="max-w-2xl">
          <span className="text-xs font-semibold uppercase tracking-wider text-primary">Specialist desks</span>
          <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">Route your query, save a round-trip.</h2>
          <p className="mt-3 text-muted-foreground">
            Six specialist mailboxes. Each is monitored by people who actually
            own that area — not a triage layer.
          </p>
        </div>
        <div id="brokerage" className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {DESKS.map((d) => {
            const Icon = d.icon;
            return (
              <Link
                key={d.name}
                href={`mailto:${d.email}`}
                className="group rounded-2xl border border-border bg-card p-6 transition-all hover:-translate-y-0.5 hover:border-primary/40"
              >
                <div className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
                  <Icon className="size-5" />
                </div>
                <h3 className="mt-4 text-base font-semibold">{d.name}</h3>
                <p className="mt-1 text-sm font-medium text-primary group-hover:underline">{d.email}</p>
                <p className="mt-2 text-xs text-muted-foreground">{d.hours}</p>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="border-y border-border bg-card/40">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
          <div className="max-w-2xl">
            <span className="text-xs font-semibold uppercase tracking-wider text-primary">Visit us</span>
            <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">Three Indian offices, one trading floor.</h2>
            <p className="mt-3 text-muted-foreground">
              Walk-in is by appointment — write first so we have someone the right person to meet you.
            </p>
          </div>
          <div className="mt-10 grid gap-5 lg:grid-cols-3">
            {OFFICES.map((o) => (
              <div key={o.city} className="rounded-2xl border border-border bg-background p-6">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Building2 className="size-4 text-primary" />
                  {o.city}
                </div>
                <p className="mt-3 flex items-start gap-2 text-sm leading-relaxed text-foreground/90">
                  <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  {o.addr}
                </p>
                <p className="mt-3 text-xs text-muted-foreground">{o.note}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
        <div className="max-w-2xl">
          <span className="text-xs font-semibold uppercase tracking-wider text-primary">Grievance redressal</span>
          <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">A clear escalation path. Every step.</h2>
          <p className="mt-3 text-muted-foreground">
            Per SEBI guidelines, every broker must publish a grievance escalation
            chain with timelines. Ours is below — and we honour each SLA in
            writing.
          </p>
        </div>
        <div className="mt-10 overflow-hidden rounded-2xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left font-semibold">Level</th>
                <th className="px-4 py-3 text-left font-semibold">Who</th>
                <th className="hidden px-4 py-3 text-left font-semibold sm:table-cell">Contact</th>
                <th className="px-4 py-3 text-right font-semibold">SLA</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-card">
              {GRIEVANCE_CHAIN.map((g) => (
                <tr key={g.step}>
                  <td className="px-4 py-3 font-semibold">{g.step}</td>
                  <td className="px-4 py-3">{g.who}</td>
                  <td className="hidden px-4 py-3 text-muted-foreground sm:table-cell">{g.email}</td>
                  <td className="px-4 py-3 text-right font-medium text-primary">{g.sla}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
