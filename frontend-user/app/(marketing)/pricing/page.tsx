import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, Check } from "lucide-react";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Transparent flat-fee brokerage. ₹0 account opening. Full statutory breakdown on every trade.",
};

const BROKERAGE = [
  { segment: "Equity Delivery (CNC)", rate: "₹0", note: "Free for all delivery trades" },
  { segment: "Equity Intraday (MIS)", rate: "₹20 / order", note: "or 0.03% — whichever is lower" },
  { segment: "Equity F&O", rate: "₹20 / order", note: "Futures + options, flat" },
  { segment: "Currency F&O", rate: "₹20 / order", note: "USDINR, EURINR, GBPINR, JPYINR" },
  { segment: "Commodity (MCX)", rate: "₹20 / order", note: "Gold, Silver, Crude Oil, Natural Gas, …" },
  { segment: "Crypto", rate: "0.10%", note: "Both legs · 24×7 markets" },
  { segment: "Forex (CDS spot)", rate: "Spread only", note: "No additional brokerage on the spread" },
];

const ACCOUNT = [
  { item: "Account opening", value: "₹0", highlight: true },
  { item: "Annual maintenance (year 1)", value: "₹0", highlight: true },
  { item: "Annual maintenance (year 2+)", value: "₹300/yr" },
  { item: "Deposit fees", value: "₹0" },
  { item: "Withdrawal fees", value: "₹0", note: "Up to 5 free withdrawals / month" },
  { item: "Demat transaction (sell)", value: "₹13.5 / scrip" },
  { item: "Call & trade", value: "₹50 / executed order" },
];

const STATUTORY = [
  { label: "STT", desc: "Securities Transaction Tax — equity 0.1% delivery (both sides), intraday 0.025% (sell), F&O futures 0.02% (sell), options 0.1% (sell on premium)." },
  { label: "Exchange charges", desc: "NSE / BSE / MCX transaction fee — slab-based, ~0.00345% notional." },
  { label: "GST", desc: "18% on (brokerage + exchange + SEBI charges)." },
  { label: "SEBI charges", desc: "₹10 per crore of notional." },
  { label: "Stamp duty", desc: "Equity delivery 0.015%, intraday 0.003%, F&O 0.002% (state-dependent)." },
  { label: "DP charges", desc: "₹13.5 + GST per scrip per day on debit (demat sell)." },
];

export default function PricingPage() {
  return (
    <>
      {/* Hero */}
      <section className="border-b border-border bg-gradient-to-b from-primary/5 to-background">
        <div className="mx-auto max-w-7xl px-4 py-16 text-center sm:px-6 sm:py-20 lg:px-8">
          <span className="text-xs font-semibold uppercase tracking-wider text-primary">
            Pricing
          </span>
          <h1 className="mt-2 text-4xl font-bold tracking-tight sm:text-5xl">
            Flat ₹20 / order.
            <br />
            <span className="text-primary">No fine print.</span>
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-base text-muted-foreground sm:text-lg">
            Whether you trade 1 share or 1 lakh, brokerage stays flat. Statutory
            charges (STT, GST, exchange, SEBI, stamp) are itemised on every
            trade — no hidden mark-ups.
          </p>
          <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/register"
              className="inline-flex h-11 items-center gap-2 rounded-md bg-primary px-6 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
            >
              Open account <ArrowRight className="size-4" />
            </Link>
            <Link
              href="#statutory"
              className="inline-flex h-11 items-center rounded-md border border-border px-6 text-sm font-semibold text-foreground hover:bg-muted/40"
            >
              Statutory breakdown
            </Link>
          </div>
        </div>
      </section>

      {/* Brokerage table */}
      <section className="mx-auto max-w-5xl px-4 py-16 sm:px-6 lg:px-8">
        <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Brokerage by segment</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          One flat rate per order in each segment. No tiered pricing, no
          volume-based discounts to chase.
        </p>

        <div className="mt-6 overflow-hidden rounded-xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left font-semibold">Segment</th>
                <th className="px-4 py-3 text-right font-semibold">Rate</th>
                <th className="hidden px-4 py-3 text-left font-semibold sm:table-cell">Note</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {BROKERAGE.map((r) => (
                <tr key={r.segment} className="hover:bg-muted/20">
                  <td className="px-4 py-3 font-medium">{r.segment}</td>
                  <td className="px-4 py-3 text-right font-tabular font-semibold text-primary">{r.rate}</td>
                  <td className="hidden px-4 py-3 text-muted-foreground sm:table-cell">{r.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Account fees */}
      <section className="border-y border-border bg-muted/20 py-16">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Account fees</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            What you actually pay to run an account with us.
          </p>

          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {ACCOUNT.map((r) => (
              <div
                key={r.item}
                className={
                  "flex items-center justify-between rounded-lg border bg-card px-4 py-3 " +
                  (r.highlight ? "border-primary/40 bg-primary/5" : "border-border")
                }
              >
                <div>
                  <div className="text-sm font-medium">{r.item}</div>
                  {r.note && (
                    <div className="text-[11px] text-muted-foreground">{r.note}</div>
                  )}
                </div>
                <div
                  className={
                    "font-tabular text-base font-semibold " +
                    (r.highlight ? "text-primary" : "text-foreground")
                  }
                >
                  {r.value}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Statutory charges */}
      <section id="statutory" className="mx-auto max-w-5xl px-4 py-16 sm:px-6 lg:px-8">
        <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
          Statutory & exchange charges
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          These are levied by the government / exchange — every Indian broker
          charges these, we just show them transparently on every trade.
        </p>

        <div className="mt-6 space-y-3">
          {STATUTORY.map((s) => (
            <div key={s.label} className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center gap-2">
                <Check className="size-4 text-primary" />
                <span className="text-sm font-semibold">{s.label}</span>
              </div>
              <p className="mt-1 pl-6 text-[13px] leading-relaxed text-muted-foreground">{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="bg-primary/5 py-14">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-4 text-center sm:flex-row sm:px-6 sm:text-left lg:px-8">
          <div>
            <h2 className="text-2xl font-bold">Ready when you are.</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Open in under 5 minutes — start trading the same day.
            </p>
          </div>
          <Link
            href="/register"
            className="inline-flex h-11 items-center gap-2 rounded-md bg-primary px-6 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
          >
            Open account <ArrowRight className="size-4" />
          </Link>
        </div>
      </section>
    </>
  );
}
