"use client";

import { Sprout } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { useAdminAuthStore } from "@/stores/authStore";

interface BrandLogoProps {
  href?: string | null;
  size?: "sm" | "md" | "lg";
  showAdminBadge?: boolean;
  className?: string;
}

export function BrandLogo({ href = "/dashboard", size = "md", showAdminBadge = true, className }: BrandLogoProps) {
  const admin = useAdminAuthStore((s) => s.admin);
  const role = admin?.role;
  // Sub-broker = BROKER whose own creator was another broker (parent
  // broker id stamped on the user doc). Only the chip label flips —
  // routes, permissions, and APIs are identical to a top-level broker.
  const isSubBroker = role === "BROKER" && !!admin?.assigned_broker_id;

  const sizes = {
    sm: { wrap: "text-sm", icon: "size-5", badge: "p-1" },
    md: { wrap: "text-lg", icon: "size-6", badge: "p-1.5" },
    lg: { wrap: "text-2xl", icon: "size-8", badge: "p-2" },
  }[size];

  // Role-aware chip — colour + label switch by tier so the brand bar
  // mirrors the "Signed in as … · ROLE" line in the top bar.
  //   SUPER_ADMIN → bold green "Super Admin"
  //   BROKER      → blue "Broker" (or "Sub-broker" when nested)
  //   ADMIN       → red "Admin" (default for any other admin-tier role)
  const badge =
    role === "SUPER_ADMIN"
      ? { label: "Super Admin", cls: "bg-primary/15 font-bold text-primary" }
      : role === "BROKER"
        ? {
            label: isSubBroker ? "Sub-broker" : "Broker",
            cls: "bg-blue-500/15 font-bold text-blue-500",
          }
        : { label: "Admin", cls: "bg-destructive/15 text-destructive" };

  const content = (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-tight", sizes.wrap, className)}>
      <span className={cn("rounded-md bg-primary/15 text-primary", sizes.badge)}>
        <Sprout className={sizes.icon} strokeWidth={2.5} />
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-foreground">
          <span className="text-primary">MarginPlant</span> Broker
        </span>
        {showAdminBadge && (
          <span
            className={cn(
              "mt-0.5 self-start rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider",
              badge.cls,
            )}
          >
            {badge.label}
          </span>
        )}
      </span>
    </span>
  );

  if (href) {
    return (
      <Link href={href} className="outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md">
        {content}
      </Link>
    );
  }
  return content;
}
