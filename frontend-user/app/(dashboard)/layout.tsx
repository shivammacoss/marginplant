"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/stores/authStore";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { StatusBar } from "@/components/layout/StatusBar";
import { BottomNav } from "@/components/layout/BottomNav";
import { UserWsBridge } from "@/components/common/UserWsBridge";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const hydrated = useAuthStore((s) => s.hydrated);

  useEffect(() => {
    if (hydrated && !user) router.replace("/login");
  }, [hydrated, user, router]);

  if (!hydrated) {
    return (
      <div className="grid h-screen place-items-center text-sm text-muted-foreground">Loading…</div>
    );
  }
  if (!user) return null;

  return (
    <div className="grid min-h-screen grid-cols-1 md:grid-cols-[auto_1fr]">
      <UserWsBridge />
      {/* Sidebar shows ≥ md only (already gated inside the component too). */}
      <Sidebar />
      <div className="flex min-h-screen flex-col">
        <TopBar />
        <main className="flex-1 overflow-y-auto bg-background scrollbar-thin">
          {/* Bottom-nav adds ~3.5rem of fixed height on mobile, so add safe
              bottom padding to the scroll area to prevent content clipping. */}
          <div className="mx-auto max-w-screen-2xl p-4 pb-24 md:p-6 md:pb-6">{children}</div>
        </main>
        <StatusBar />
        <BottomNav />
      </div>
    </div>
  );
}
