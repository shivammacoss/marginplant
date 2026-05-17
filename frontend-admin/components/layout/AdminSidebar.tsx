"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  Banknote,
  Calendar,
  ClipboardList,
  Cog,
  DatabaseBackup,
  Layers,
  History,
  Home,
  ListChecks,
  ListOrdered,
  Plug,
  ShieldCheck,
  Users,
  Crown,
  Wallet,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { canSee, isSuperAdmin, type PermissionKey } from "@/lib/permissions";
import { useAdminAuthStore } from "@/stores/authStore";
import { BrandLogo } from "@/components/layout/BrandLogo";

// Each nav item declares either a `perm` (admin needs that flag, or
// broker needs `brokerPerm` if provided otherwise same key), or
// `superOnly` (super-admin only). Items with neither are visible to any
// authenticated admin (e.g. Dashboard). The `brokerPerm` override lets
// us route the "Brokers" nav to admin.brokers vs. broker.sub_brokers.
type NavItem = {
  href: string;
  label: string;
  icon: any;
  perm?: PermissionKey;
  brokerPerm?: PermissionKey;
  // Alternate label when a BROKER is viewing. Lets the "Brokers" item
  // render as "Sub-brokers" inside a broker session without splitting
  // the route or duplicating the nav entry.
  brokerLabel?: string;
  superOnly?: boolean;
  // Suppress the item for SUPER_ADMIN. Used for "Brokers" — super-admin
  // doesn't create brokers (admins do); they manage admins via Sub-admins.
  hideForSuperAdmin?: boolean;
};

const groups: { title: string; items: NavItem[] }[] = [
  {
    title: "Overview",
    items: [{ href: "/dashboard", label: "Dashboard", icon: Home }],
  },
  {
    title: "Users",
    items: [
      { href: "/users", label: "All users", icon: Users, perm: "users" },
      { href: "/kyc", label: "KYC review", icon: ShieldCheck, perm: "kyc" },
    ],
  },
  {
    title: "Payments",
    items: [
      { href: "/payments", label: "Payments", icon: Banknote, perm: "deposits" },
    ],
  },
  {
    title: "Risk & Settings",
    items: [
      { href: "/risk-management", label: "Risk Management", icon: ShieldCheck, perm: "risk" },
      { href: "/segment-settings", label: "Segment Settings", icon: Layers, perm: "segment_settings" },
    ],
  },
  {
    title: "Trading",
    items: [
      { href: "/orders", label: "Orders", icon: ListOrdered, perm: "trading_view" },
      { href: "/positions", label: "Positions", icon: Activity, perm: "trading_view" },
      { href: "/instruments", label: "Instruments", icon: ListChecks, superOnly: true },
      { href: "/zerodha", label: "Zerodha Connect", icon: Plug, superOnly: true },
    ],
  },
  {
    title: "Reports",
    items: [
      { href: "/reports/users", label: "User reports", icon: Users, perm: "reports" },
      { href: "/reports/financial", label: "Financial", icon: Banknote, perm: "reports" },
      { href: "/reports/trades", label: "Trades", icon: ClipboardList, perm: "reports" },
    ],
  },
  {
    title: "Management",
    items: [
      { href: "/management/sub-admins", label: "Admin Management", icon: Crown, superOnly: true },
      { href: "/management/settlements", label: "Settlements", icon: Wallet, superOnly: true },
      // Brokers menu — admin only when admin_permissions.brokers === true,
      // broker only when broker_permissions.sub_brokers >= VIEW. Hidden for
      // super-admin because super-admin manages admins, not brokers (admins
      // create brokers).
      { href: "/management/brokers", label: "Brokers", icon: Crown, perm: "brokers", brokerPerm: "sub_brokers", brokerLabel: "Sub-brokers", hideForSuperAdmin: true },
    ],
  },
  {
    title: "System",
    items: [
      { href: "/settings/platform", label: "Platform settings", icon: Cog, superOnly: true },
      { href: "/holidays", label: "Holiday calendar", icon: Calendar, superOnly: true },
      { href: "/backup", label: "Backup & EOD", icon: DatabaseBackup, superOnly: true },
      { href: "/audit", label: "Audit logs", icon: History, superOnly: true },
    ],
  },
];

export function AdminSidebar() {
  const pathname = usePathname();
  const admin = useAdminAuthStore((s) => s.admin);

  const visible = groups
    .map((g) => ({
      ...g,
      items: g.items.filter((it) => {
        // Explicit hide for super-admin (e.g. Brokers nav — super-admin
        // doesn't create brokers, admins do).
        if (it.hideForSuperAdmin && isSuperAdmin(admin)) return false;
        if (it.superOnly) return isSuperAdmin(admin);
        if (it.perm) {
          // Broker sessions use brokerPerm if provided (e.g. "Brokers" nav
          // maps to admin.brokers vs. broker.sub_brokers).
          const effective =
            admin?.role === "BROKER" && it.brokerPerm
              ? it.brokerPerm
              : it.perm;
          return canSee(admin, effective);
        }
        return true;
      }),
    }))
    .filter((g) => g.items.length > 0);

  return (
    <aside className="sticky top-0 z-30 hidden h-screen w-64 flex-col border-r border-border bg-card md:flex">
      <div className="flex h-14 items-center border-b border-border px-4">
        <BrandLogo size="sm" />
      </div>

      <nav className="flex-1 space-y-4 overflow-y-auto px-2 py-3 scrollbar-thin">
        {visible.map((g) => (
          <div key={g.title} className="space-y-1">
            <div className="px-2 text-[10px] uppercase tracking-wider text-muted-foreground">{g.title}</div>
            {g.items.map((it) => {
              const active = pathname === it.href || pathname?.startsWith(it.href + "/");
              const Icon = it.icon;
              return (
                <Link
                  key={it.href}
                  href={it.href}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                    active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="truncate">
                    {admin?.role === "BROKER" && it.brokerLabel ? it.brokerLabel : it.label}
                  </span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
