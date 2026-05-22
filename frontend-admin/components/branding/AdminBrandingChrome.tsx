"use client";

import { useEffect } from "react";
import { useAdminAuthStore } from "@/stores/authStore";
import { API_URL, APP_NAME } from "@/lib/constants";

// Applies tenant white-label chrome (browser tab title + favicon) on
// the admin panel for ADMIN / BROKER users whose authStore carries
// `brand_name` / `logo_url`. Super-admins always see the platform
// default. The favicon swap rewrites every existing
// <link rel="icon"> the SSR HTML shipped with — appending a new node
// alone doesn't visibly change the tab icon because the browser has
// already committed the SSR-supplied icon. We stash the original href
// once on a data-attribute so that signing out / SUPER_ADMIN sessions
// cleanly restore the platform sprout.
//
// Mounted inside `<Providers>` so it lives for the whole admin app.
export function AdminBrandingChrome() {
  const admin = useAdminAuthStore((s) => s.admin);
  const role = admin?.role;
  const brandName = (admin?.brand_name ?? "").trim();
  const logoPath = admin?.logo_url ?? null;

  // SUPER_ADMIN never gets tenant chrome — always platform default.
  const isTenant = role === "ADMIN" || role === "BROKER";
  const tenantName = isTenant && brandName ? brandName : null;
  const tenantLogo =
    isTenant && logoPath
      ? logoPath.startsWith("http")
        ? logoPath
        : `${API_URL}${logoPath}`
      : null;

  useEffect(() => {
    if (typeof document === "undefined") return;

    // ── Title ───────────────────────────────────────────────────────
    const title = tenantName || APP_NAME;
    if (document.title !== title) document.title = title;

    // ── Favicon ────────────────────────────────────────────────────
    const head = document.head;
    if (!head) return;
    const icons = head.querySelectorAll<HTMLLinkElement>(
      'link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]',
    );
    icons.forEach((el) => {
      if (!el.dataset.brandingOriginal) {
        el.dataset.brandingOriginal = el.getAttribute("href") || "";
      }
      if (tenantLogo) {
        el.setAttribute("href", tenantLogo);
        el.setAttribute("data-branding", "1");
      } else {
        const original = el.dataset.brandingOriginal || "";
        if (original) el.setAttribute("href", original);
        delete el.dataset.branding;
      }
      // Force the browser to pick up the new href instead of the
      // SSR-cached one — same dance the user-frontend does.
      const clone = el.cloneNode(true) as HTMLLinkElement;
      el.replaceWith(clone);
    });
  }, [tenantName, tenantLogo]);

  return null;
}
