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

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
