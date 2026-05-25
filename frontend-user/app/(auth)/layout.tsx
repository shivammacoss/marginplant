"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { BrandLogo } from "@/components/layout/BrandLogo";
import { useBranding } from "@/lib/branding-context";

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
  const { branding } = useBranding();
  // Wordmark used in the mobile-only header + footer. Falls back to the
  // platform default ("MarginPlant Broker") when no tenant branding has
  // resolved — preserves byte-identical UX for non-branded visitors.
  const tenantName = (branding?.brand_name ?? "").trim();
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
            © {new Date().getFullYear()}{" "}
            {branding === null ? (
              <span className="inline-block h-4 w-32 animate-pulse rounded bg-muted/30 align-middle" />
            ) : (
              tenantName || "MarginPlant Broker"
            )}{" "}
            · All rights reserved
          </div>
        </div>
        <div className="flex flex-col items-center justify-center p-6 lg:pt-6">
          {/* Mobile-only branded header — shows the tenant logo + name
              on phones (desktop has the full brand panel on the left).
              While branding is still loading (branding === null), we
              render a subtle shimmer placeholder instead of the platform
              default. This eliminates the "MarginPlant Broker flashes
              for 1 second on custom domains" issue — users on
              stockcafe.live never see the wrong brand name. */}
          <div className="mb-6 flex w-full flex-col items-center gap-2 text-center lg:hidden">
            {branding === null ? (
              /* Branding still loading — shimmer placeholder */
              <>
                <div className="h-16 w-16 animate-pulse rounded-2xl bg-muted/50" />
                <div className="h-5 w-28 animate-pulse rounded bg-muted/50" />
                <div className="h-3 w-44 animate-pulse rounded bg-muted/30" />
              </>
            ) : (
              /* Branding resolved (or confirmed as platform default) */
              <>
                <div className="rounded-2xl bg-gradient-to-br from-primary/20 via-primary/10 to-transparent p-3">
                  <BrandLogo href={null} size="lg" iconOnly />
                </div>
                <span className="text-lg font-semibold tracking-tight">
                  {tenantName ? (
                    <span className="text-foreground">{tenantName}</span>
                  ) : (
                    <>
                      <span className="text-primary">MarginPlant</span>
                      <span className="text-foreground"> Broker</span>
                    </>
                  )}
                </span>
                <p className="max-w-xs text-xs text-muted-foreground">
                  Trade Indian markets — fast, fair, focused.
                </p>
              </>
            )}
          </div>
          <div className="w-full max-w-md">{children}</div>
        </div>
      </div>
    </main>
  );
}
