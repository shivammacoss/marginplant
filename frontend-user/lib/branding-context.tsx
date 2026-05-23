"use client";

/**
 * White-label `<BrandingProvider>` for the user-facing app.
 *
 * Lifecycle (3 steps, runs once per page load):
 *
 *   1. INITIAL LOAD — On mount, decide which lookup to fire:
 *        - If `?ref=<user_code>` is in the URL → /branding/by-code.
 *        - Else if hostname is NOT the platform host →
 *          /branding/by-domain (custom-domain visitor).
 *        - Else if a logged-in user token exists →
 *          /user/users/me/branding (returns admin's brand).
 *        - Else → no branding, render default platform UI.
 *
 *   2. POST-LOGIN REDIRECT (gated, never fires for legacy users) —
 *      A user whose `signup_origin` is BRANDED_REFERRAL or
 *      CUSTOM_DOMAIN AND whose admin has a READY custom_domain gets
 *      redirected from `marginplant.com/dashboard` to
 *      `https://<admin.custom_domain>/dashboard#wl=<session>`.
 *      Existing 10k users have `signup_origin = null` → this path is
 *      physically unreachable for them.
 *
 *   3. APPLY favicon + title — runs whenever the resolved brand
 *      changes. Falls back to platform defaults on null branding.
 *
 * The provider is a NO-OP (renders children unchanged) when
 * `BRANDING_ENABLED=false` on the backend — every endpoint returns
 * 503 / null and the favicon swap silently skips.
 */

import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { API_URL, APP_NAME, STORAGE_KEYS } from "./constants";
import { buildWlSessionHash, consumeWlSessionHandoff } from "./wl-handoff";

export type Branding = {
  admin_id: string;
  user_code: string;
  brand_name: string | null;
  logo_url: string | null;
  custom_domain: string | null;
  custom_domain_status: string | null;
};

type BrandingContextValue = {
  branding: Branding | null;
  loading: boolean;
  /** Re-fetch the logged-in user's branding (called after login). */
  refresh: () => Promise<void>;
};

const Ctx = createContext<BrandingContextValue>({
  branding: null,
  loading: false,
  refresh: async () => {},
});

const PLATFORM_HOSTS = new Set<string>(
  [
    "marginplant.com",
    "www.marginplant.com",
    "localhost",
    "127.0.0.1",
    // dev / preview origins
    typeof window !== "undefined" ? window.location.hostname : "",
  ]
    .filter(Boolean)
    .map((h) => h.toLowerCase()),
);

function isPlatformHost(host: string): boolean {
  const h = host.toLowerCase();
  if (PLATFORM_HOSTS.has(h)) return true;
  // Also treat any *.vercel.app / *.netlify.app preview as platform.
  return /\.(vercel|netlify|fly)\.(app|dev)$/.test(h);
}

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_URL}/api/v1${path}`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
    });
    if (!res.ok) return null;
    const body = await res.json();
    // Backend wraps everything in {data, message}.
    return (body?.data ?? null) as T | null;
  } catch {
    return null;
  }
}

async function fetchBrandingByCode(code: string): Promise<Branding | null> {
  return fetchJson<Branding>(`/branding/by-code/${encodeURIComponent(code)}`);
}

async function fetchBrandingByDomain(domain: string): Promise<Branding | null> {
  return fetchJson<Branding>(
    `/branding/by-domain?domain=${encodeURIComponent(domain)}`,
  );
}

async function fetchMyBranding(token: string): Promise<{
  branding: Branding | null;
  signup_origin: string | null;
} | null> {
  try {
    const res = await fetch(`${API_URL}/api/v1/user/users/me/branding`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      credentials: "omit",
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.data ?? null;
  } catch {
    return null;
  }
}

function applyBrandingChrome(brand: Branding | null): void {
  if (typeof document === "undefined") return;
  // Title — fall back to platform default when null/empty.
  const baseTitle = brand?.brand_name?.trim() || APP_NAME;
  if (document.title !== baseTitle) {
    document.title = baseTitle;
  }
  // Favicon swap. Next.js (app/icon.svg) bakes a <link rel="icon">
  // into SSR output that the browser reads BEFORE our React code
  // runs — so just appending a new link doesn't visibly change the
  // tab icon (browser keeps using the SSR one). To actually replace
  // it we:
  //   1. Stash the original <link rel="icon"> hrefs ONCE on a
  //      data-attribute we can read back later (so non-branded
  //      visitors / branding-cleared sessions get the platform
  //      icon back instead of a 404).
  //   2. When a tenant logo is present → rewrite EVERY existing
  //      icon link's href to the tenant URL (and tag it as ours).
  //   3. When branding clears → restore the original href from
  //      the stash.
  const head = document.head;
  if (!head) return;
  const targetHref = brand?.logo_url
    ? `${API_URL}${brand.logo_url}`
    : null;
  const allIcons = head.querySelectorAll<HTMLLinkElement>(
    'link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]',
  );
  // CRITICAL: do NOT remove/replace these <link> nodes — Next.js's
  // metadata system owns them via React, and any out-of-tree mutation
  // (cloneNode/replaceWith) leaves React's reconciler with a stale
  // reference. The next render then crashes with
  //   "Cannot read properties of null (reading 'removeChild')"
  // bricking the page on every nav. We mutate `href` in place only —
  // browsers DO pick up the swap on the next favicon read (tab focus,
  // navigation, or manual refresh). For immediate visual swap we
  // append a non-managed extra <link> below.
  allIcons.forEach((el) => {
    if (!el.dataset.brandingOriginal) {
      el.dataset.brandingOriginal = el.getAttribute("href") || "";
    }
    if (targetHref) {
      if (el.getAttribute("href") !== targetHref) {
        el.setAttribute("href", targetHref);
      }
      el.setAttribute("data-branding", "1");
    } else {
      const original = el.dataset.brandingOriginal || "";
      if (original && el.getAttribute("href") !== original) {
        el.setAttribute("href", original);
      }
      el.removeAttribute("data-branding");
    }
  });
  // Append a SINGLE extra branding-owned <link> at the end of <head>
  // (browsers pick the last applicable icon). This one is fully
  // outside the React tree (id-tagged) so we can safely add/remove it
  // without breaking reconciliation. Reuse if already present.
  const OWN_ID = "branding-favicon-runtime";
  const existing = head.querySelector<HTMLLinkElement>(`link#${OWN_ID}`);
  if (targetHref) {
    if (existing) {
      if (existing.getAttribute("href") !== targetHref) {
        existing.setAttribute("href", targetHref);
      }
    } else {
      const link = document.createElement("link");
      link.id = OWN_ID;
      link.rel = "icon";
      link.href = targetHref;
      if (targetHref.endsWith(".svg")) link.type = "image/svg+xml";
      else if (targetHref.endsWith(".png")) link.type = "image/png";
      else if (targetHref.endsWith(".webp")) link.type = "image/webp";
      else if (targetHref.endsWith(".jpg") || targetHref.endsWith(".jpeg"))
        link.type = "image/jpeg";
      head.appendChild(link);
    }
  } else if (existing) {
    existing.remove();
  }

  // ── PWA manifest ────────────────────────────────────────────────
  // Repoint the manifest <link> at the dynamic per-tenant route so
  // when the visitor clicks "Install app" the OS launcher picks up
  // the broker's brand name + logo (not the platform default). When
  // branding clears, restore the canonical manifest path.
  const manifestEl = head.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (manifestEl) {
    const code = brand?.user_code?.trim();
    const desired = code
      ? `/manifest.webmanifest?u=${encodeURIComponent(code)}`
      : "/manifest.webmanifest";
    if (manifestEl.getAttribute("href") !== desired) {
      manifestEl.setAttribute("href", desired);
    }
  }
}

export function BrandingProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [branding, setBranding] = useState<Branding | null>(null);
  const [loading, setLoading] = useState(true);
  const handoffConsumed = useRef(false);

  // Step 0 — consume `#wl=` handoff before anything else, so any
  // /me/branding call below sees the freshly-handed-off token.
  if (typeof window !== "undefined" && !handoffConsumed.current) {
    handoffConsumed.current = true;
    try {
      consumeWlSessionHandoff();
    } catch {
      /* ignore */
    }
  }

  const refresh = useCallback(async () => {
    if (typeof window === "undefined") return;
    setLoading(true);
    try {
      const ref = searchParams?.get("ref");
      const host = window.location.hostname;
      let brand: Branding | null = null;

      if (ref) {
        brand = await fetchBrandingByCode(ref);
      } else if (!isPlatformHost(host)) {
        brand = await fetchBrandingByDomain(host);
      } else {
        const token = window.localStorage.getItem(STORAGE_KEYS.accessToken);
        if (token) {
          const me = await fetchMyBranding(token);
          brand = me?.branding ?? null;

          // Step 2 — gated cross-origin redirect. Only fires when:
          //   - signup_origin ∈ {BRANDED_REFERRAL, CUSTOM_DOMAIN}
          //   - admin has a READY custom_domain
          //   - we're currently on the platform host (already true here)
          //   - path is not under /admin/* (admin panel stays on platform)
          const origin = me?.signup_origin;
          if (
            brand?.custom_domain &&
            brand?.custom_domain_status === "READY" &&
            (origin === "BRANDED_REFERRAL" || origin === "CUSTOM_DOMAIN") &&
            !window.location.pathname.startsWith("/admin")
          ) {
            const hash = buildWlSessionHash() ?? "";
            const target =
              `https://${brand.custom_domain}` +
              window.location.pathname +
              window.location.search +
              hash;
            window.location.replace(target);
            return; // bail — we're navigating away
          }
        }
      }
      setBranding(brand);
      applyBrandingChrome(brand);
    } finally {
      setLoading(false);
    }
  }, [searchParams]);

  useEffect(() => {
    refresh();
    // Re-fetch when the user logs in or out in another tab.
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEYS.accessToken) {
        refresh();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [refresh]);

  return (
    <Ctx.Provider value={{ branding, loading, refresh }}>{children}</Ctx.Provider>
  );
}

export function useBranding(): BrandingContextValue {
  return useContext(Ctx);
}
