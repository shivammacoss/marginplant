/* MarginPlant PWA service worker — offline-shell v2.
 *
 * Why we have one:
 *   • A live trading app must NEVER serve stale prices/orders, so
 *     /api/* and /ws/* always go straight to the network with no
 *     interception (pass-through return on those routes).
 *   • But the *app shell* (Next.js JS chunks, CSS, fonts, icons,
 *     manifest) is content-hashed and immutable — caching it makes
 *     repeat opens instant and, more importantly, makes the app
 *     *open at all* when the user has no signal.
 *   • When a navigation request fails (no network), we fall back to
 *     a precached `/offline.html` so the browser shows our branded
 *     "you're offline" screen instead of the device's grey
 *     dinosaur / "no internet" page. That's the difference between
 *     "app feels broken" and "app told me what's going on".
 *
 * Strategy summary:
 *   /api/*, /ws/*, ws/wss   → bypass (never cached, never intercepted)
 *   /_next/static/*         → cache-first (immutable hashed assets)
 *   /_next/image*           → stale-while-revalidate
 *   navigations (HTML)      → network-first, fall back to cached page
 *                             then to /offline.html
 *   other GETs              → stale-while-revalidate, fall through
 *                             to /offline.html on navigation only
 *
 * Bumping VERSION evicts every old runtime cache on activate, so a
 * single deploy is enough to migrate users off broken caches if a
 * regression ships. NEVER reuse an old version string.
 */

const VERSION = "marginplant-pwa-v2";
const PRECACHE = `${VERSION}-precache`;
const RUNTIME_STATIC = `${VERSION}-static`;
const RUNTIME_PAGES = `${VERSION}-pages`;

// Files we ALWAYS want available offline. Keep this list minimal —
// every byte here ships on first visit and on every SW update.
const PRECACHE_URLS = [
  "/offline.html",
  "/manifest.webmanifest",
  "/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE);
      // `addAll` is atomic — if any URL 404s the whole install
      // rejects, which is exactly what we want (a half-installed SW
      // is worse than no SW at all). Best-effort per-URL fetch keeps
      // the install resilient if e.g. /icon.svg gets renamed.
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            const resp = await fetch(url, { cache: "no-store" });
            if (resp.ok) await cache.put(url, resp.clone());
          } catch {
            /* skip — non-fatal */
          }
        })
      );
      // Activate immediately on first install so the offline shell
      // is available without requiring a second reload.
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop every cache that isn't part of the current VERSION so
      // a deploy doesn't leave megabytes of dead chunks behind.
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => !k.startsWith(VERSION))
          .map((k) => caches.delete(k))
      );
      // Take control of every open tab right now so users on a stale
      // SW pick up the new caching rules without a full reload.
      await self.clients.claim();
    })()
  );
});

// ── Helpers ────────────────────────────────────────────────────────
function isApiOrWs(url) {
  return (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/ws/") ||
    url.protocol === "ws:" ||
    url.protocol === "wss:"
  );
}

async function networkFirstNavigation(req) {
  // Cache the most-recent successful navigation so the user can at
  // least see the LAST page they visited if they re-open while
  // offline. Trading data inside that page will be missing (React
  // Query reconnects when navigator.onLine flips) but the shell,
  // sidebar, and last cached lists stay readable.
  const pages = await caches.open(RUNTIME_PAGES);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) pages.put(req, fresh.clone()).catch(() => {});
    return fresh;
  } catch {
    const cached = await pages.match(req);
    if (cached) return cached;
    // Final fallback — the precached offline shell.
    const offline = await caches.match("/offline.html");
    if (offline) return offline;
    return new Response("Offline", { status: 503, statusText: "Offline" });
  }
}

async function cacheFirstStatic(req) {
  const cache = await caches.open(RUNTIME_STATIC);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const resp = await fetch(req);
    if (resp && resp.ok) cache.put(req, resp.clone()).catch(() => {});
    return resp;
  } catch {
    if (hit) return hit;
    throw new Error("offline-static");
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(RUNTIME_STATIC);
  const cached = await cache.match(req);
  const fetchPromise = fetch(req)
    .then((resp) => {
      if (resp && resp.ok) cache.put(req, resp.clone()).catch(() => {});
      return resp;
    })
    .catch(() => null);
  return cached || (await fetchPromise) || Response.error();
}

// ── Fetch handler ──────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Only intercept GET — POST/PUT/DELETE/PATCH go straight to the
  // network so order placements / settlement actions are never
  // touched by the SW.
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // 1) Trading data: never intercept. Live ticks, REST API,
  //    auth/refresh, everything dynamic falls through to the
  //    network with full fidelity.
  if (isApiOrWs(url)) return;

  // Only handle same-origin requests. Cross-origin (CDNs, analytics,
  // third-party fonts) goes through the browser's default loader.
  if (url.origin !== self.location.origin) return;

  // 2) Top-level navigation requests (HTML).
  if (req.mode === "navigate") {
    event.respondWith(networkFirstNavigation(req));
    return;
  }

  // 3) Hashed Next.js chunks — immutable, cache-first.
  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/icon.svg" ||
    url.pathname === "/manifest.webmanifest"
  ) {
    event.respondWith(cacheFirstStatic(req));
    return;
  }

  // 4) Everything else (images, public assets, _next/image): SWR.
  if (req.destination === "image" || req.destination === "font" || req.destination === "style") {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // 5) Default — pass-through with a graceful offline fallback.
  event.respondWith(
    fetch(req).catch(async () => {
      const cached = await caches.match(req);
      return cached || Response.error();
    })
  );
});

// ── One-shot message handler so the page can ping the SW ───────────
// e.g. a "Force update" button in Settings posts {type:"SKIP_WAITING"}
// and reloads. Cheap to wire even though we don't expose it yet.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
