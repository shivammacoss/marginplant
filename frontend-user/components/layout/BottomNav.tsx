"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  CandlestickChart,
  Home,
  LineChart,
  ListOrdered,
  User,
} from "lucide-react";
import { cn } from "@/lib/utils";

const items = [
  { href: "/dashboard", label: "Home", icon: Home },
  { href: "/marketwatch", label: "Market", icon: LineChart },
  { href: "/terminal", label: "Trade", icon: CandlestickChart, accent: true },
  // /positions is the unified blotter (Position / Active / Closed /
  // Cancelled / Rejected tabs all live there). The old /orders route
  // is being phased out — keeping the icon as "Orders" until users
  // adapt, but the destination is the new positions page.
  { href: "/positions", label: "Orders", icon: ListOrdered },
  { href: "/profile", label: "Profile", icon: User },
];

/**
 * Mobile-only bottom tab bar. Hidden ≥ md so the desktop sidebar is the
 * single nav surface there. Sits above the page in a translucent sticky
 * footer with safe-area padding.
 *
 * `compact` (used on the terminal/chart page) renders the bar as a
 * centered pill with side margins instead of edge-to-edge — keeps the
 * chart canvas visually wider while still giving thumb-reach navigation.
 */
export function BottomNav({ compact = false }: { compact?: boolean } = {}) {
  const pathname = usePathname();
  return (
    <nav
      className={cn(
        "fixed bottom-0 z-40 bg-background/95 backdrop-blur",
        "md:hidden",
        "supports-[backdrop-filter]:bg-background/80",
        compact
          ? "left-1/2 mb-2 w-[min(92vw,360px)] -translate-x-1/2 rounded-full border border-border shadow-lg shadow-black/20"
          : "inset-x-0 border-t border-border",
      )}
      style={{ paddingBottom: compact ? undefined : "env(safe-area-inset-bottom)" }}
    >
      <ul className={cn("grid grid-cols-5", compact && "rounded-full overflow-hidden")}>
        {items.map((it) => {
          const active = pathname === it.href || pathname?.startsWith(it.href + "/");
          const Icon = it.icon;
          if (it.accent) {
            return (
              <li key={it.href} className="relative">
                <Link
                  href={it.href}
                  className={cn(
                    "mx-auto flex flex-col items-center justify-center gap-0.5 rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/30 ring-4 ring-background",
                    compact ? "h-11 w-11 -mt-3" : "h-14 w-14 -mt-5",
                  )}
                >
                  <Icon className={compact ? "size-4" : "size-5"} />
                  <span className={cn("font-semibold uppercase tracking-wider", compact ? "text-[8px]" : "text-[9px]")}>{it.label}</span>
                </Link>
              </li>
            );
          }
          return (
            <li key={it.href}>
              <Link
                href={it.href}
                className={cn(
                  "flex flex-col items-center justify-center gap-0.5 transition-colors",
                  compact ? "h-12 text-[9px]" : "h-14 text-[10px]",
                  active ? "text-primary" : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className={cn(compact ? "size-4" : "size-5", active && "scale-110")} />
                <span className="font-medium">{it.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
