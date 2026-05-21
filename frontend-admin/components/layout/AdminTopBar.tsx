"use client";

import { LogOut, ShieldAlert } from "lucide-react";
import { useAdminAuthStore } from "@/stores/authStore";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/common/ThemeToggle";
import { NotificationBell } from "@/components/layout/NotificationBell";

export function AdminTopBar() {
  const admin = useAdminAuthStore((s) => s.admin);
  const logout = useAdminAuthStore((s) => s.logout);

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur">
      <div className="hidden text-xs text-muted-foreground sm:block">
        Signed in as <span className="text-foreground">{admin?.full_name ?? "Admin"}</span> ·{" "}
        <span className="text-primary">
          {admin?.role === "BROKER" && admin?.assigned_broker_id
            ? "SUB-BROKER"
            : admin?.role}
        </span>
      </div>
      <div className="ml-auto inline-flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1 text-xs text-destructive">
        <ShieldAlert className="size-3" />
        Live system — actions are audited
      </div>
      {/* Notification bell — sits between the audit banner and the
          theme toggle. Polls /admin/notifications/unread-count every
          10 s for the badge; full list loads only when the dropdown
          opens. */}
      <NotificationBell />
      <ThemeToggle />
      <Button
        variant="ghost"
        size="icon"
        aria-label="Sign out"
        onClick={() => logout().then(() => (window.location.href = "/login"))}
      >
        <LogOut className="size-4" />
      </Button>
    </header>
  );
}
