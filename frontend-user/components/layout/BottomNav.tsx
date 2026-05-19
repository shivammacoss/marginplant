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
 * Edge-to-edge, full-width — the previous "compact pill" mode was
 * rejected by the user ("ye jo box ke andar rakh hai waisa mat rakh
 * yrr"). One consistent shape across every mobile route now.
 */
export function BottomNav() {
  const pathname = usePathname();
  return (
    <nav
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 backdrop-blur",
        "md:hidden",
        "supports-[backdrop-filter]:bg-background/80",
      )}
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="grid grid-cols-5">
        {items.map((it) => {
          const active = pathname === it.href || pathname?.startsWith(it.href + "/");
          const Icon = it.icon;
          if (it.accent) {
            // TRADE tab — matches the surrounding icons in size, just
            // tinted primary so it still reads as the "main action"
            // without a giant circle dominating the bar. User
            // feedback after the previous iteration: "ek jda bada
            // circle nahi chiaye, jitne baki sab icon hai utna hi
            // trade bhi dikhe". Small filled circle wraps only the
            // icon (size-8) — same vertical rhythm as Home/Market/
            // Orders/Profile.
            return (
              <li key={it.href}>
                <Link
                  href={it.href}
                  className={cn(
                    "flex h-14 flex-col items-center justify-center gap-0.5 text-[10px] transition-colors",
                    active ? "text-primary" : "text-primary/85 hover:text-primary",
                  )}
                >
                  <span className="grid size-8 place-items-center rounded-full bg-primary/15 text-primary">
                    <Icon className="size-5" />
                  </span>
                  <span className="font-semibold uppercase tracking-wider">{it.label}</span>
                </Link>
              </li>
            );
          }
          return (
            <li key={it.href}>
              <Link
                href={it.href}
                className={cn(
                  "flex h-14 flex-col items-center justify-center gap-0.5 text-[10px] transition-colors",
                  active ? "text-primary" : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className={cn("size-5", active && "scale-110")} />
                <span className="font-medium">{it.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
