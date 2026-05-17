"use client";

import { QueryClient, QueryClientProvider, keepPreviousData } from "@tanstack/react-query";
import { useState } from "react";
import { ThemeProvider, useTheme } from "next-themes";
import { Toaster } from "sonner";

function ThemedToaster() {
  const { resolvedTheme } = useTheme();
  return (
    <Toaster
      theme={(resolvedTheme === "light" ? "light" : "dark") as "light" | "dark"}
      position="top-right"
      toastOptions={{
        style: {
          background: "hsl(var(--card))",
          border: "1px solid hsl(var(--border))",
          color: "hsl(var(--foreground))",
        },
      }}
    />
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // 60 s stale window — navigating within this paints from cache
            // with no refetch. Lists that change live (positions, orders,
            // pnl summary) keep their own `refetchInterval` and aren't
            // affected by this.
            staleTime: 60_000,
            // Keep cached pages warm for 30 min so the admin can hop
            // around the sidebar without re-fetching the same data on
            // every visit. Combined with the prefetcher in the admin
            // layout, the second visit to any page is instant.
            gcTime: 30 * 60_000,
            refetchOnWindowFocus: true,
            refetchOnReconnect: true,
            refetchOnMount: true,
            // Paint the previous page's data while the new key fetches —
            // kills the "Loading…" flash when sidebar nav swaps params
            // (e.g. /kyc tab switch, /positions OPEN ↔ CLOSED).
            placeholderData: keepPreviousData,
            retry: (count, err: any) =>
              err?.response?.status >= 400 && err?.response?.status < 500 ? false : count < 2,
          },
        },
      })
  );

  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      disableTransitionOnChange
    >
      <QueryClientProvider client={client}>
        {children}
        <ThemedToaster />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
