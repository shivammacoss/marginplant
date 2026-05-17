import Link from "next/link";
import type { Metadata } from "next";
import {
  ArrowRight,
  CircleHelp,
  CreditCard,
  IndianRupee,
  Landmark,
  Receipt,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Wallet,
} from "lucide-react";

export const metadata: Metadata = {
  title: "FAQs",
  description:
    "Common questions about opening an account, brokerage, statutory charges, margin, withdrawals, taxes and security on MarginPlant.",
};

type FAQ = { q: string; a: string };
type Section = { icon: any; key: string; title: string; faqs: FAQ[] };

const SECTIONS: Section[] = [
  {
    icon: CreditCard,
    key: "account",
    title: "Opening an account",
    faqs: [
      {
        q: "What do I need to open an account?",
        a: "Aadhaar, PAN, a selfie video, and a bank account in your name. The whole flow is digital — no courier, no branch visit. You can complete it in 5 minutes from your phone.",
      },
      {
        q: "Is there an account opening fee?",
        a: "No. ₹0 to open. No annual maintenance for the first year. From year 2 onwards, AMC is ₹300/year.",
      },
      {
        q: "Can NRIs open an account?",
        a: "Currently we onboard Indian residents only. NRI accounts (NRE/NRO) are on the roadmap for late 2026.",
      },
      {
        q: "Why was my KYC rejected?",
        a: "The two most common reasons are: (1) PAN-Aadhaar not linked on income-tax portal, (2) selfie video mismatch with Aadhaar photo. Fix the first on incometax.gov.in; re-record the second in better light. The rejection email lists the exact reason.",
      },
    ],
  },
  {
    icon: IndianRupee,
    key: "brokerage",
    title: "Brokerage & charges",
    faqs: [
      {
        q: "How much is the brokerage?",
        a: "Equity delivery (CNC) is ₹0. Equity intraday (MIS) is ₹20 / order or 0.03% — whichever is lower. F&O, currency F&O and MCX are ₹20 / order flat. Crypto is 0.10% per leg. Direct mutual funds are ₹0.",
      },
      {
        q: "What are the statutory charges on top of brokerage?",
        a: "STT/CTT (segment-dependent), exchange transaction charges (~0.00345%), SEBI fee (₹10/crore), stamp duty (0.015% delivery / 0.003% intraday / 0.002% F&O — state-dependent), and 18% GST on (brokerage + exchange + SEBI charges). Every charge is itemised on the contract note.",
      },
      {
        q: "Why does the contract note show DP charges?",
        a: "DP charges (₹13.5 + GST) apply per scrip per day on debit — i.e., when you sell a delivery holding. They're charged by the depository (CDSL/NSDL), not by us. Buy-side delivery has no DP charge.",
      },
      {
        q: "Are there any hidden charges?",
        a: "No. Every line on your contract note maps to a SEBI-prescribed levy or our flat brokerage. There's no 'platform fee', no 'inactivity fee', and no per-segment subscription.",
      },
    ],
  },
  {
    icon: Wallet,
    key: "funds",
    title: "Funds & withdrawals",
    faqs: [
      {
        q: "How do I add funds?",
        a: "UPI, IMPS, NEFT or net-banking. UPI/IMPS deposits reflect in seconds. NEFT depends on your bank's cycle. There are no deposit fees.",
      },
      {
        q: "How fast are withdrawals?",
        a: "Withdrawals are settled to your linked bank account within working-day hours (T+0 for crypto/spot, T+1 for equity/F&O margin release per SEBI). Up to 5 withdrawals per month are free. Beyond that, ₹10 per withdrawal.",
      },
      {
        q: "Why can't I withdraw the full balance?",
        a: "Funds blocked as margin against open positions are not withdrawable. The 'available for withdrawal' figure in your dashboard is what's actually free. Settlement money from equity sells unlocks per the T+1 cycle.",
      },
      {
        q: "Can I withdraw to a different bank account?",
        a: "No. Withdrawals only go to the bank account that funded your deposit. This is a regulatory requirement and a fraud-prevention control.",
      },
    ],
  },
  {
    icon: Landmark,
    key: "trading",
    title: "Trading & orders",
    faqs: [
      {
        q: "What order types are supported?",
        a: "Market, Limit, Stop-Loss Market (SL-M), Stop-Loss Limit (SL-L), Good-Till-Triggered (GTT), Cover Order (CO), and Bracket Order (BO). The terminal greys out anything not allowed in the current segment / market state.",
      },
      {
        q: "When are GTT orders triggered?",
        a: "GTT triggers when the last-traded price crosses your trigger level. The trigger is checked every 1.5 seconds against the live tick. Once triggered, the resulting limit/market order is fired through our matching engine.",
      },
      {
        q: "Can I trade outside market hours?",
        a: "Indian segments (NSE/BSE/MCX/CDS) trade only during their published session hours. After-market orders (AMO) can be placed and are queued for the next open. Crypto and spot forex are open 24×7 / 24×5.",
      },
      {
        q: "What happens if my F&O margin shortfall persists?",
        a: "At 80% margin used, your account enters exit-only mode (no new entries). At 90%, the risk engine starts squaring positions in FIFO order until margin used falls back under 70%. All actions are logged and visible in the ledger.",
      },
    ],
  },
  {
    icon: Receipt,
    key: "tax",
    title: "Taxes & reports",
    faqs: [
      {
        q: "Where do I download my tax P&L?",
        a: "Dashboard → Reports → Tax P&L. You get a per-financial-year breakdown across STCG, LTCG, intraday speculation and F&O business income. Available as PDF + CSV.",
      },
      {
        q: "How is crypto taxed?",
        a: "Section 115BBH applies a flat 30% tax on net VDA gains. We also deduct 1% TDS on the sell side under Section 194S — visible on every crypto contract note. Losses cannot be set off against other heads.",
      },
      {
        q: "When are contract notes sent?",
        a: "Within T+1 working day, by email, signed digitally. You can also download every historic contract note from Reports → Contract notes.",
      },
      {
        q: "Will I get a Form 26AS / AIS feed?",
        a: "Yes. STT, TDS on dividends, and 1% crypto TDS are reported to the income-tax department as per SEBI / CBDT timelines. Check your AIS on the IT portal; ours typically appears within 30 days of the quarter end.",
      },
    ],
  },
  {
    icon: ShieldCheck,
    key: "security",
    title: "Security & data",
    faqs: [
      {
        q: "Is 2FA mandatory?",
        a: "2FA is mandatory for admins. For regular trading accounts it's optional — but we strongly recommend turning it on. Set up under Profile → Security → Enable 2FA.",
      },
      {
        q: "I lost my phone with the authenticator app. Now what?",
        a: "Use one of your backup recovery codes (generated at 2FA enrolment) to log in, then re-enrol with the new device. If you've lost the codes too, contact support@marginplant.com from your registered email — we verify identity before resetting.",
      },
      {
        q: "Where is my data stored?",
        a: "All India-resident user data is stored in AWS Mumbai (ap-south-1). Backups are encrypted. We are DPDP-aligned and you can request a data export or deletion from your dashboard.",
      },
      {
        q: "How are my funds protected?",
        a: "Funds sit in a SEBI-prescribed escrow / settlement bank account, segregated from our working capital. Withdrawals can only go back to the bank account that funded you.",
      },
    ],
  },
  {
    icon: Smartphone,
    key: "platform",
    title: "Platform & apps",
    faqs: [
      {
        q: "Are the mobile and web apps the same account?",
        a: "Yes. One account, one funded balance, one P&L. Login from web, the phone, or both — orders sync over WebSockets in real time.",
      },
      {
        q: "Which browsers are supported?",
        a: "Chrome, Edge, Firefox, Safari on their current and previous major versions. Brave works fine if you disable shields on our domain.",
      },
      {
        q: "Do you have a trading API?",
        a: "An open API is on the roadmap for 2026. Today's terminal already exposes WebSocket market data and order events to logged-in sessions; the public REST/WS docs are coming with the API beta.",
      },
      {
        q: "What if the platform goes down during a trade?",
        a: "Submit the affected order details to support@marginplant.com. Our infra team has detailed audit logs of every tick and order event for 1 year. Genuine platform-side issues are made whole as per SEBI guidelines.",
      },
    ],
  },
];

export default function FaqPage() {
  return (
    <>
      <section className="relative overflow-hidden border-b border-border">
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-b from-primary/10 via-background to-background" />
        <div className="mx-auto max-w-5xl px-4 py-20 text-center sm:px-6 sm:py-24 lg:px-8">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
            <Sparkles className="size-3" /> Help centre
          </span>
          <h1 className="mt-5 text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
            Questions, answered.
            <br />
            <span className="mp-gradient-text">Without the fine print.</span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
            The same questions traders email us most — answered in plain
            English. If yours isn't here, drop us a line and we'll add it.
          </p>
        </div>
      </section>

      <section className="border-b border-border bg-muted/20">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          <nav className="flex flex-wrap items-center gap-2">
            {SECTIONS.map((s) => {
              const Icon = s.icon;
              return (
                <a
                  key={s.key}
                  href={`#${s.key}`}
                  className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-semibold transition-colors hover:border-primary/40 hover:text-primary"
                >
                  <Icon className="size-3.5" />
                  {s.title}
                </a>
              );
            })}
          </nav>
        </div>
      </section>

      {SECTIONS.map((s) => {
        const Icon = s.icon;
        return (
          <section
            key={s.key}
            id={s.key}
            className="mx-auto max-w-5xl scroll-mt-24 px-4 py-14 sm:px-6 sm:py-16 lg:px-8"
          >
            <div className="flex items-center gap-3">
              <div className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
                <Icon className="size-5" />
              </div>
              <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">{s.title}</h2>
            </div>

            <div className="mt-8 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
              {s.faqs.map((f, i) => (
                <details
                  key={f.q}
                  className="group"
                  open={i === 0}
                >
                  <summary className="flex cursor-pointer list-none items-start justify-between gap-4 p-5 transition-colors hover:bg-muted/30">
                    <div className="flex items-start gap-3">
                      <CircleHelp className="mt-0.5 size-4 shrink-0 text-primary" />
                      <span className="text-base font-semibold">{f.q}</span>
                    </div>
                    <span className="mt-1 grid size-6 shrink-0 place-items-center rounded-full border border-border text-muted-foreground transition-transform group-open:rotate-45">
                      +
                    </span>
                  </summary>
                  <div className="px-5 pb-5 pl-12 text-sm leading-relaxed text-muted-foreground">
                    {f.a}
                  </div>
                </details>
              ))}
            </div>
          </section>
        );
      })}

      <section className="mx-auto max-w-7xl px-4 pb-24 sm:px-6 lg:px-8">
        <div className="rounded-3xl border border-primary/30 bg-gradient-to-br from-primary/15 via-primary/5 to-background p-10 text-center sm:p-14">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Still stuck?</h2>
          <p className="mx-auto mt-3 max-w-xl text-muted-foreground">
            Write to us. Median first reply on a trading day: 84 seconds. We
            don't use ticket numbers — a real person signs off every response.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/contact" className="inline-flex h-12 items-center gap-2 rounded-md bg-primary px-7 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
              Contact us <ArrowRight className="size-4" />
            </Link>
            <Link href="/learn" className="inline-flex h-12 items-center gap-2 rounded-md border border-border bg-background px-7 text-sm font-semibold hover:bg-muted/50">
              Browse the Learn hub
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
