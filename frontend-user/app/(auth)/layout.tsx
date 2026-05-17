"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { BrandLogo } from "@/components/layout/BrandLogo";

// Marketing-split layout is wrapped in a Suspense boundary so the inner
// component can read `useSearchParams()` (Next.js 14 requires this). The
// fallback is a plain background div — there's no "form" content to skeleton
// here since the inner component decides which layout to render anyway.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense
      fallback={<main className="min-h-screen w-full bg-background" />}
    >
      <AuthLayoutInner>{children}</AuthLayoutInner>
    </Suspense>
  );
}

function AuthLayoutInner({ children }: { children: React.ReactNode }) {
  const searchParams = useSearchParams();
  // Admin "Login as user" pops a new tab carrying both tokens in the
  // URL — when that's the case the marketing-split layout (the left
  // "Trade Indian markets" panel + the form column) was flashing for
  // ~1s while the login page completed the handoff. Detect impersonation
  // here and render just a centered loader so the user never sees the
  // login UI on the way to /dashboard.
  const isImpersonating = !!(
    searchParams?.get("access") && searchParams?.get("refresh")
  );

  if (isImpersonating) {
    return (
      <main className="grid min-h-screen w-full place-items-center bg-background">
        {children}
      </main>
    );
  }

  return (
    <main className="min-h-screen w-full bg-background">
      <div className="grid min-h-screen w-full grid-cols-1 lg:grid-cols-2">
        <div className="hidden flex-col justify-between bg-gradient-to-br from-primary/15 via-card to-background p-12 lg:flex">
          <BrandLogo href="/" size="md" />
          <div className="space-y-4">
            <h1 className="text-4xl font-bold leading-tight">
              Trade Indian markets — fast, fair, focused.
            </h1>
            <p className="max-w-md text-muted-foreground">
              Live equities, F&amp;O, commodities, currencies and crypto. One dark dashboard,
              built for serious traders.
            </p>
          </div>
          <div className="text-sm text-muted-foreground">
            © {new Date().getFullYear()} MarginPlant Broker · All rights reserved
          </div>
        </div>
        <div className="flex items-center justify-center p-6">
          <div className="w-full max-w-md">{children}</div>
        </div>
      </div>
    </main>
  );
}
