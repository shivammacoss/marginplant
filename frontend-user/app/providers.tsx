"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
            // 30 s stale window — within this, navigating around the app
            // serves data from cache (instant). After 30 s, the next mount
            // / focus / reconnect triggers a single refetch. Components
            // that need tighter freshness set their own staleTime /
            // refetchInterval (positions strip = 500 ms, wallet = 4 s,
            // option chain = 2 s, PnL summary = 10 s).
            staleTime: 30_000,
            // Keep cached data for 5 min after last use so back/forward
            // navigation is snappy.
            gcTime: 5 * 60_000,
            // Focus + reconnect refetches DO catch stale data after a
            // pause, but they only refetch what's currently mounted —
            // not the whole cache. That's the right balance for prod.
            refetchOnWindowFocus: true,
            refetchOnReconnect: true,
            // First mount of a query renders cached data immediately and
            // refetches in the background if stale — no "Loading…" flash.
            refetchOnMount: true,
            retry: (count, err: any) => {
              const status = err?.response?.status;
              if (status && status >= 400 && status < 500) return false;
              return count < 2;
            },
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
