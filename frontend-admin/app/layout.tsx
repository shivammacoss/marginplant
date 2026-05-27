import type { Metadata, Viewport } from "next";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "MarginPlant Broker Admin", template: "%s · MarginPlant Broker Admin" },
  description: "Super-admin control panel for the MarginPlant Broker trading platform.",
  icons: { icon: "/icon.svg" },
  // Dynamic manifest — served by app/manifest.webmanifest/route.ts.
  // AdminBrandingChrome rewrites this <link>'s href at runtime to
  // `?u=<USER_CODE>` once auth hydrates so PWA installs pick up the
  // tenant's name + logo. Default platform manifest is served when the
  // param is missing (e.g. super-admin or anonymous /login install).
  manifest: "/manifest.webmanifest",
  robots: { index: false, follow: false },
};

// PWA viewport policy.
//   - viewportFit "cover" + safe-area utilities (see globals.css) make
//     the app sit edge-to-edge on iOS notch devices.
//   - userScalable:false + maximumScale:1 disable pinch-zoom so the
//     dashboard behaves like a native app (Operator complaint: tables
//     would accidentally pinch-zoom while scrolling, throwing off the
//     layout).
//   - We rely on per-element font-size for accessibility instead of
//     browser zoom, which is what admin tools normally do (Bloomberg,
//     Kite back-office, etc.).
export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  width: "device-width",
  initialScale: 1,
  minimumScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // translate="no" + .notranslate stops Chrome's auto-translate prompt
    // from rewriting financial labels (operator flagged: "₹ Margin used"
    // was becoming "₹ Marja usada" in Spanish locale Chrome and the
    // numbers got reformatted incorrectly).
    <html lang="en" translate="no" className="notranslate" suppressHydrationWarning>
      <head>
        {/* Belt + braces — meta-level translate opt-out covers older
            mobile Chrome where the html attribute alone was ignored. */}
        <meta name="google" content="notranslate" />
        {/* iOS PWA polish — gives the standalone install a native feel:
            no Safari chrome, dark status-bar text on the emerald header. */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="MP Admin" />
        {/* Prevent iOS auto-detection of phone numbers in the UI which
            otherwise wraps user mobiles into blue tappable spans and
            breaks the table layout. We surface explicit tel: links
            ourselves where calling is intended. */}
        <meta name="format-detection" content="telephone=no" />
      </head>
      <body className="font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
