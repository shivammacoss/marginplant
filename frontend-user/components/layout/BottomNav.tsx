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
 */
export function BottomNav() {
  const pathname = usePathname();
  return (
    <nav
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 backdrop-blur",
        "md:hidden",
        "supports-[backdrop-filter]:bg-background/80"
      )}
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="grid grid-cols-5">
        {items.map((it) => {
          const active = pathname === it.href || pathname?.startsWith(it.href + "/");
          const Icon = it.icon;
          if (it.accent) {
            return (
              <li key={it.href} className="relative">
                <Link
                  href={it.href}
                  className="-mt-5 mx-auto flex h-14 w-14 flex-col items-center justify-center gap-0.5 rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/30 ring-4 ring-background"
                >
                  <Icon className="size-5" />
                  <span className="text-[9px] font-semibold uppercase tracking-wider">{it.label}</span>
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
