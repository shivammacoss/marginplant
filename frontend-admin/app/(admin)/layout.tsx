"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAdminAuthStore } from "@/stores/authStore";
import { AdminSidebar } from "@/components/layout/AdminSidebar";
import { AdminTopBar } from "@/components/layout/AdminTopBar";
import { AdminPrefetcher } from "@/components/layout/AdminPrefetcher";
import { AdminWsBridge } from "@/components/common/AdminWsBridge";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const admin = useAdminAuthStore((s) => s.admin);
  const hydrated = useAdminAuthStore((s) => s.hydrated);
  const refreshMe = useAdminAuthStore((s) => s.refreshMe);

  useEffect(() => {
    if (hydrated && !admin) router.replace("/login");
  }, [hydrated, admin, router]);

  // Refresh the cached admin object once on mount so any permissions
  // granted server-side after the last login (e.g. super-admin ticked
  // `brokers` for this sub-admin) become visible without a logout/login.
  // Errors are silent — the store handles that internally.
  useEffect(() => {
    if (hydrated && admin) void refreshMe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  if (!hydrated) {
    return <div className="grid h-screen place-items-center text-sm text-muted-foreground">Loading…</div>;
  }
  if (!admin) return null;

  return (
    <div className="grid min-h-screen grid-cols-1 md:grid-cols-[auto_1fr]">
      <AdminPrefetcher />
      {/* Live event bridge — subscribes to /ws/admin and invalidates the
          relevant React Query keys whenever a position closes / deposit
          lands / withdrawal is requested / KYC is submitted. Replaces the
          F5-after-every-action workflow with real-time updates across
          every open admin/broker tab. */}
      <AdminWsBridge />
      <AdminSidebar />
      <div className="flex min-h-screen flex-col">
        <AdminTopBar />
        <main className="flex-1 overflow-y-auto bg-background scrollbar-thin">
          <div className="mx-auto max-w-screen-2xl p-4 md:p-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
