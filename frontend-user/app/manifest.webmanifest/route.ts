import { NextRequest } from "next/server";

// Dynamic Web App Manifest for the user-facing frontend.
//
// PWA installs commit the manifest's name + icons into the OS launcher
// at install time. To get a per-tenant install icon (so end users who
// reach the site via a branded link install THAT broker's PWA, not
// the platform default) we honour `?u=<USER_CODE>` and serve a
// manifest pointed at the admin's logo + brand name.
//
// Falls back to the platform default when the param is missing or the
// branding lookup fails — preserving byte-identical behaviour for
// non-branded visitors.
//
// Coexists with the file-convention `app/manifest.ts`. Layout points
// `<link rel="manifest">` at this dynamic route (BrandingProvider sets
// the href once branding resolves) so the static manifest.ts is only
// used during dev / for tooling that reads the canonical /manifest.

export const dynamic = "force-dynamic";
export const revalidate = 0;

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/+$/, "");

const PLATFORM_DEFAULT = {
  name: "MarginPlant Broker",
  short_name: "MarginPlant",
  description:
    "Trade Indian stocks, F&O, commodities, currencies, and crypto with MarginPlant Broker.",
  start_url: "/dashboard",
  scope: "/",
  display: "standalone",
  orientation: "portrait" as const,
  background_color: "#0a0a0a",
  theme_color: "#0a0a0a",
  categories: ["finance", "business"],
  icons: [
    { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};

type Branding = { brand_name: string | null; logo_url: string | null };

async function fetchBranding(userCode: string): Promise<Branding | null> {
  if (!API_BASE || !userCode) return null;
  try {
    const res = await fetch(`${API_BASE}/api/v1/branding/by-code/${encodeURIComponent(userCode)}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const data = json?.data ?? null;
    if (!data) return null;
    return { brand_name: data.brand_name ?? null, logo_url: data.logo_url ?? null };
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const userCode = (req.nextUrl.searchParams.get("u") || "").trim().toUpperCase();
  let manifest: Record<string, unknown> = { ...PLATFORM_DEFAULT };

  if (userCode) {
    const brand = await fetchBranding(userCode);
    if (brand?.brand_name || brand?.logo_url) {
      const name = brand.brand_name?.trim() || PLATFORM_DEFAULT.name;
      const shortName = (brand.brand_name?.trim() || PLATFORM_DEFAULT.short_name).slice(0, 12);
      const logo = brand.logo_url ? `${API_BASE}${brand.logo_url}` : null;
      // Chrome Android picks same-origin icons over cross-origin ones.
      // Admin logos live on api.marginplant.com (cross-origin) so Chrome
      // was ignoring them and falling back to the platform default leaf.
      // Fix: use /api/brand-icon?u=CODE proxy (same-origin) so Chrome
      // picks the admin's logo as the launcher icon.
      //
      // `id` field: Chrome uses manifest `id` to distinguish PWAs on the
      // same origin. Without it, installing admin-A's PWA replaces
      // admin-B's because Chrome sees them as the same app.
      const proxyIcon = `/api/brand-icon?u=${encodeURIComponent(userCode)}`;
      const brandedIcons = logo
        ? [
            { src: proxyIcon, sizes: "512x512", type: "image/png", purpose: "any" },
            { src: proxyIcon, sizes: "192x192", type: "image/png", purpose: "any" },
          ]
        : [];
      manifest = {
        ...PLATFORM_DEFAULT,
        id: `/?brand=${encodeURIComponent(userCode)}`,
        start_url: `/?ref=${encodeURIComponent(userCode)}`,
        name,
        short_name: shortName,
        description: `${name} — trade Indian markets`,
        icons: [...brandedIcons, ...PLATFORM_DEFAULT.icons],
      };
    }
  }

  return new Response(JSON.stringify(manifest), {
    headers: {
      "Content-Type": "application/manifest+json; charset=utf-8",
      "Cache-Control": "private, no-store, max-age=0",
    },
  });
}
