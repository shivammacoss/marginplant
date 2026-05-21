"use client";

import { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  BarChart3,
  FileSpreadsheet,
  Receipt,
} from "lucide-react";
import { cn } from "@/lib/utils";

// Four report sub-pages. Tax used to be a fifth tab but the operator
// dropped it on 21-May — the bucket split was indicative only (no real
// FIFO / holding-period calc, no statutory pass-through), so showing
// users a number they couldn't actually use for filing was a footgun.
const TABS = [
  { href: "/reports/pnl", label: "P&L", icon: BarChart3 },
  { href: "/reports/tradebook", label: "Tradebook", icon: FileSpreadsheet },
  { href: "/reports/brokerage", label: "Brokerage", icon: Receipt },
  { href: "/reports/margin", label: "Margin", icon: Activity },
];

export default function ReportsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="space-y-4">
      {/* Horizontally scrollable on phone so all five pills are reachable
          without breaking onto two rows in a tight 360-wide viewport. */}
      <nav className="-mx-1 overflow-x-auto scrollbar-thin">
        <div className="inline-flex min-w-full gap-1 rounded-lg border border-border bg-card p-1 text-sm">
          {TABS.map((t) => {
            const active = pathname === t.href || pathname?.startsWith(t.href + "/");
            const Icon = t.icon;
            return (
              <Link
                key={t.href}
                href={t.href}
                className={cn(
                  "flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 font-medium transition-colors",
                  active
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                )}
              >
                <Icon className="size-3.5" />
                <span>{t.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
      {children}
    </div>
  );
}
