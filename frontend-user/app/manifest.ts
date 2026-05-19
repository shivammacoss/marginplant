import type { MetadataRoute } from "next";

/**
 * Web App Manifest — drives Chrome / Edge / Safari's "Add to Home
 * Screen" / "Install App" prompts. With this file present at
 * `/manifest.webmanifest` (Next 14 App Router serves it from the
 * `manifest.ts` export) and a registered service worker, the browser
 * exposes the `beforeinstallprompt` event which our
 * <InstallPwaButton> consumes.
 *
 * `display: "standalone"` strips the browser chrome on launch so the
 * installed PWA looks and feels like a native shell — no URL bar, no
 * tabs, full-screen content. `start_url: "/login"` matches the user's
 * spec: tap the home-screen icon and the login page is the first
 * surface (already-authenticated sessions get redirected onward by
 * the dashboard guard).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "MarginPlant Broker",
    short_name: "MarginPlant",
    description:
      "Trade Indian stocks, F&O, commodities, currencies, and crypto with MarginPlant Broker — fast, transparent, dark-themed.",
    start_url: "/login",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0a0a0a",
    theme_color: "#10b981",
    categories: ["finance", "business"],
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    shortcuts: [
      {
        name: "Trade",
        url: "/terminal",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "Positions",
        url: "/positions",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "Wallet",
        url: "/wallet",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
    ],
  };
}
