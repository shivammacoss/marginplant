import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { Providers } from "./providers";
import "./globals.css";

// Inter is what ChatGPT / Linear / Vercel / Stripe / most modern fintech
// dashboards use. Self-hosted via `next/font` so no extra request hits
// fonts.googleapis at runtime — the .woff2 ships from /_next/static and
// the font-display: swap behaviour comes free with the helper. The full
// 400/500/600/700 range covers every body / button / heading / numeric
// weight used across the app.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "MarginPlant Broker — Indian Trading Platform",
    template: "%s · MarginPlant Broker",
  },
  description:
    "Trade Indian stocks, F&O, commodities, currencies, and crypto with MarginPlant Broker — fast, transparent, dark-themed.",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={inter.variable}>
      <body className="font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
