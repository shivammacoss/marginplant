import Link from "next/link";
import { Sprout } from "lucide-react";

const COLS: { title: string; links: { href: string; label: string }[] }[] = [
  {
    title: "Product",
    links: [
      { href: "/features", label: "Features" },
      { href: "/markets", label: "Markets" },
      { href: "/pricing", label: "Pricing" },
      { href: "/security", label: "Security" },
      { href: "/register", label: "Open an account" },
    ],
  },
  {
    title: "Company",
    links: [
      { href: "/about", label: "About us" },
      { href: "/about#team", label: "Team" },
      { href: "/about#careers", label: "Careers" },
      { href: "/contact", label: "Contact" },
    ],
  },
  {
    title: "Resources",
    links: [
      { href: "/learn", label: "Learn" },
      { href: "/faq", label: "FAQs" },
      { href: "/contact", label: "Help centre" },
      { href: "/contact#kyc", label: "KYC help" },
    ],
  },
  {
    title: "Legal",
    links: [
      { href: "/legal/terms", label: "Terms of use" },
      { href: "/legal/privacy", label: "Privacy policy" },
      { href: "/legal/disclosures", label: "Risk disclosures" },
      { href: "/legal/grievance", label: "Grievance redressal" },
    ],
  },
];

export function MarketingFooter() {
  return (
    <footer className="border-t border-border bg-card/40">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 gap-8 lg:grid-cols-5">
          {/* Brand block */}
          <div className="col-span-2 lg:col-span-1">
            <Link href="/" className="flex items-center gap-2">
              <span className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground">
                <Sprout className="size-4" />
              </span>
              <span className="text-base font-semibold tracking-tight">
                MarginPlant <span className="text-muted-foreground">Broker</span>
              </span>
            </Link>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              India's modern multi-segment trading platform — Equities, F&O,
              Currencies, Commodities and Crypto on a single fast terminal.
            </p>
          </div>

          {COLS.map((col) => (
            <div key={col.title}>
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {col.title}
              </div>
              <ul className="mt-3 space-y-2">
                {col.links.map((l) => (
                  <li key={l.href + l.label}>
                    <Link
                      href={l.href}
                      className="text-sm text-foreground/80 transition-colors hover:text-foreground"
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-10 border-t border-border pt-6 text-[11px] leading-relaxed text-muted-foreground">
          <p>
            <span className="font-semibold text-foreground">Disclaimer:</span>{" "}
            Investments in securities markets are subject to market risks; read
            all related documents carefully before investing. Brokerage will not
            exceed SEBI prescribed limits. Past performance is not indicative of
            future returns.
          </p>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <span>© {new Date().getFullYear()} MarginPlant Broker. All rights reserved.</span>
            <span>SEBI Registration: pending · NSE / BSE / MCX member: pending</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
