"use client";

import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";

/**
 * Sticky top banner that surfaces network state to the user.
 *
 * Two signals drive the visible state:
 *   1. `navigator.onLine` flips to false whenever the OS reports the
 *      device left the network (airplane mode, Wi-Fi off, mobile data
 *      lost). This is the immediate, kernel-level signal.
 *   2. A periodic ping to `/manifest.webmanifest` (cheap, cached on
 *      the SW so we don't add real bandwidth) catches the case where
 *      the device thinks it's online but the captive portal / hotspot
 *      / DNS poisoning is silently dropping every request. Without
 *      this, the user sees `navigator.onLine === true` and a perfectly
 *      blank dashboard — exactly the "net off me open bhi nahi hota"
 *      complaint.
 *
 * The banner is intentionally:
 *   • Top-of-viewport, non-dismissable while offline (it's a status
 *     read-out, not a notification).
 *   • Auto-hidden when the connection comes back so the user knows
 *     the app self-recovered.
 *   • Render-only — no API calls, no React Query churn. The actual
 *     reconnect is driven by React Query's `refetchOnReconnect` and
 *     the WS bridge's auto-reconnect; this component just informs.
 */
export function OfflineBanner() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Initial read — `navigator.onLine` is reliable on every modern
    // browser for the OS-level signal.
    setOffline(!navigator.onLine);

    const onOnline = () => setOffline(false);
    const onOffline = () => setOffline(true);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    // Backup probe every 20 s — cheap HEAD against the SW-cached
    // manifest. If the device is truly online this resolves from
    // the cache without hitting the network at all (so it's free
    // when things are healthy). If it FAILS while `navigator.onLine`
    // is still true, we know the network is wedged and surface the
    // banner anyway. If it SUCCEEDS while offline was set, we clear.
    let alive = true;
    const probe = async () => {
      try {
        const r = await fetch("/manifest.webmanifest", {
          method: "HEAD",
          cache: "no-store",
        });
        if (!alive) return;
        if (r.ok && offline) setOffline(false);
        else if (!r.ok && !offline) setOffline(true);
      } catch {
        if (alive && !offline) setOffline(true);
      }
    };
    const t = window.setInterval(probe, 20_000);

    return () => {
      alive = false;
      window.clearInterval(t);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
    // We deliberately omit `offline` from the dep array — re-arming
    // listeners every state flip would be wasteful and the closure
    // already reads the latest `offline` via setState's functional
    // form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!offline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 top-0 z-[60] flex items-center justify-center gap-2 border-b border-amber-500/40 bg-amber-500/15 px-4 py-2 text-xs font-medium text-amber-200 backdrop-blur-md md:text-sm"
    >
      <WifiOff className="h-4 w-4" aria-hidden />
      <span>
        You&rsquo;re offline. Live prices and orders are paused — the app will
        resume automatically once you&rsquo;re back online.
      </span>
    </div>
  );
}
