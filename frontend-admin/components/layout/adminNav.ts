/**
 * Single source of truth for the admin navigation tree.
 *
 * Both the desktop sidebar (`AdminSidebar`) and the mobile drawer
 * (`AdminMobileDrawer`) consume `useAdminNav()` so the two surfaces
 * NEVER drift out of sync — same items, same labels, same permission
 * gates. Critical: a sub-admin who can't see /backup on desktop must
 * also not see it in the mobile drawer.
 */

import {
  Activity,
  Banknote,
  Calendar,
  ClipboardList,
  Cog,
  DatabaseBackup,
  FileText,
  Layers,
  History,
  Home,
  ListChecks,
  ListOrdered,
  MessageCircle,
  Plug,
  ShieldCheck,
  Users,
  Crown,
  Wallet,
  Handshake,
  BarChart3,
  type LucideIcon,
} from "lucide-react";
import { canSee, isSuperAdmin, type PermissionKey } from "@/lib/permissions";
import { useAdminAuthStore } from "@/stores/authStore";

export type AdminNavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  perm?: PermissionKey;
  brokerPerm?: PermissionKey;
  brokerLabel?: string;
  superOnly?: boolean;
  adminTierOnly?: boolean;
  hideForSuperAdmin?: boolean;
};

export type AdminNavGroup = { title: string; items: AdminNavItem[] };

export const ADMIN_NAV_GROUPS: AdminNavGroup[] = [
  {
    title: "Overview",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: Home },
      { href: "/accounts-dashboard", label: "Accounts", icon: BarChart3 },
    ],
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
      { href: "/reports/tradebook", label: "Tradebook PDF", icon: FileText, perm: "reports" },
    ],
  },
  {
    title: "Management",
    items: [
      { href: "/management/sub-admins", label: "Admin Management", icon: Crown, superOnly: true },
      { href: "/management/settlements", label: "Settlements", icon: Wallet, superOnly: true },
      {
        href: "/management/brokers",
        label: "Brokers",
        icon: Crown,
        perm: "brokers",
        brokerPerm: "sub_brokers",
        brokerLabel: "Sub-brokers",
        hideForSuperAdmin: true,
      },
      { href: "/management/pnl-sharing", label: "P&L Sharing", icon: Handshake },
    ],
  },
  {
    title: "System",
    items: [
      { href: "/settings/platform", label: "Platform settings", icon: Cog, superOnly: true },
      { href: "/settings/branding", label: "Branding", icon: Cog, adminTierOnly: true },
      { href: "/holidays", label: "Holiday calendar", icon: Calendar, superOnly: true },
      { href: "/backup", label: "Backup & EOD", icon: DatabaseBackup, superOnly: true },
      { href: "/support", label: "Support", icon: MessageCircle },
      { href: "/audit", label: "Audit logs", icon: History },
    ],
  },
];

/** Pure helper: filter nav for a given admin (role + permissions). */
export function filterAdminNav(
  admin: ReturnType<typeof useAdminAuthStore.getState>["admin"]
): AdminNavGroup[] {
  return ADMIN_NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((it) => {
      if (it.hideForSuperAdmin && isSuperAdmin(admin)) return false;
      if (it.adminTierOnly) return admin?.role === "ADMIN";
      if (it.superOnly) return isSuperAdmin(admin);
      if (it.perm) {
        const effective =
          admin?.role === "BROKER" && it.brokerPerm ? it.brokerPerm : it.perm;
        return canSee(admin, effective);
      }
      return true;
    }),
  })).filter((g) => g.items.length > 0);
}

/** Hook variant — bound to the auth store. */
export function useAdminNav(): AdminNavGroup[] {
  const admin = useAdminAuthStore((s) => s.admin);
  return filterAdminNav(admin);
}

/** Resolve label for an item given the current admin role. */
export function resolveNavLabel(
  it: AdminNavItem,
  admin: ReturnType<typeof useAdminAuthStore.getState>["admin"]
): string {
  return admin?.role === "BROKER" && it.brokerLabel ? it.brokerLabel : it.label;
}
