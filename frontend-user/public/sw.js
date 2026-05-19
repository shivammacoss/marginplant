/* MarginPlant PWA service worker — minimal-but-installable.
 *
 * The browser only fires `beforeinstallprompt` (and exposes the "Install
 * app" affordance) when a manifest + a service worker that handles
 * `fetch` are both registered for the page. We don't need offline-first
 * for a live-trading app — stale prices are worse than no prices — so
 * this SW does network-first, falls back to nothing if offline.
 *
 * Skipping cache for /api/* and the /ws/* websocket upgrade requests
 * keeps every order placement, quote and tick going straight to the
 * backend without intermediate staleness.
 */
const VERSION = "marginplant-pwa-v1";

self.addEventListener("install", (event) => {
  // Take over immediately on first install so the install prompt becomes
  // available without a reload.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Clean up any older caches if we ever start using them. Currently a
  // no-op, but keeping the boilerplate so adding a precache later is one
  // line away.
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Only handle GET — leave POST/PUT/DELETE strictly to the network.
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Skip API + WS — trading data must never come from a cache.
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/ws/") ||
    url.protocol === "ws:" ||
    url.protocol === "wss:"
  ) {
    return;
  }
  // Plain network — no caching for now. The presence of this handler
  // alone is what unlocks the install prompt; we'll add a runtime
  // cache for static chunks in a follow-up if first-paint feels slow.
  event.respondWith(fetch(req).catch(() => Response.error()));
});
