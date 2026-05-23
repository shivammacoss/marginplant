"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Menu, Sprout, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBranding } from "@/lib/branding-context";
import { API_URL } from "@/lib/constants";

const NAV_LINKS = [
  { href: "/features", label: "Features" },
  { href: "/markets", label: "Markets" },
  { href: "/pricing", label: "Pricing" },
  { href: "/security", label: "Security" },
  { href: "/learn", label: "Learn" },
  { href: "/about", label: "About" },
];

export function MarketingNav() {
  const pathname = usePathname();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  // Whitelabel-aware brand mark. When the visitor is on a tenant
  // custom domain (or arrived via ?ref=) BrandingProvider has resolved
  // the broker's brand_name + uploaded logo. We mirror BrandLogo.tsx's
  // logic here instead of importing it directly so this nav can keep
  // its tighter sizing / typography (the broker name slots into the
  // existing 8 px tile + 16 px wordmark layout without a redesign).
  const { branding } = useBranding();
  const customName = (branding?.brand_name ?? "").trim();
  const logoSrc = branding?.logo_url ? `${API_URL}${branding.logo_url}` : null;

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Close mobile menu on route change
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <header
      className={cn(
        "sticky top-0 z-50 transition-all",
        scrolled
          ? "border-b border-border/60 bg-background/80 backdrop-blur-md"
          : "bg-transparent"
      )}
    >
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        {/* Brand — tenant-aware. Falls back to "MarginPlant Broker"
            wordmark when no branding has resolved (platform host or
            anon visitor on a custom domain before /by-domain returns). */}
        <Link href="/" className="flex items-center gap-2">
          <span
            className={cn(
              "grid size-8 place-items-center rounded-md",
              logoSrc
                ? "bg-primary/10"
                : "bg-primary text-primary-foreground",
            )}
          >
            {logoSrc ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoSrc}
                alt={customName || "Logo"}
                className="size-6 rounded object-contain"
              />
            ) : (
              <Sprout className="size-4" />
            )}
          </span>
          <span className="text-base font-semibold tracking-tight">
            {customName ? (
              <span className="text-foreground">{customName}</span>
            ) : (
              <>
                MarginPlant <span className="text-muted-foreground">Broker</span>
              </>
            )}
          </span>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden items-center gap-1 md:flex">
          {NAV_LINKS.map((l) => {
            const active = l.href === "/" ? pathname === "/" : pathname?.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  active
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>

        {/* CTAs */}
        <div className="hidden items-center gap-2 md:flex">
          <Link
            href="/login"
            className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            Login
          </Link>
          <Link
            href="/register"
            className="rounded-md bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Open account
          </Link>
        </div>

        {/* Mobile menu trigger */}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="grid size-9 place-items-center rounded-md border border-border text-muted-foreground md:hidden"
          aria-label={open ? "Close menu" : "Open menu"}
        >
          {open ? <X className="size-4" /> : <Menu className="size-4" />}
        </button>
      </div>

      {/* Mobile dropdown */}
      {open && (
        <div className="border-t border-border bg-background md:hidden">
          <nav className="mx-auto flex max-w-7xl flex-col gap-1 px-4 py-3 sm:px-6">
            {NAV_LINKS.map((l) => {
              const active = l.href === "/" ? pathname === "/" : pathname?.startsWith(l.href);
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  className={cn(
                    "rounded-md px-3 py-2 text-sm font-medium",
                    active
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  )}
                >
                  {l.label}
                </Link>
              );
            })}
            <div className="mt-2 flex gap-2 border-t border-border pt-3">
              <Link
                href="/login"
                className="flex-1 rounded-md border border-border px-3 py-2 text-center text-sm font-medium text-foreground"
              >
                Login
              </Link>
              <Link
                href="/register"
                className="flex-1 rounded-md bg-primary px-3 py-2 text-center text-sm font-semibold text-primary-foreground"
              >
                Open account
              </Link>
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
