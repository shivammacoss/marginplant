"use client";

import { useEffect, useState } from "react";
import { Download, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * "Install App" button. Visible only when Chrome / Edge / Samsung
 * Internet fires `beforeinstallprompt` AND the user hasn't already
 * installed the PWA. iOS Safari doesn't fire this event — for those
 * users we surface a tiny hint instead with the manual Share →
 * "Add to Home Screen" path (the standard iOS install flow).
 *
 * Variants:
 *   default — full-pill primary button suitable for marketing CTA
 *   compact — smaller variant for the login page footer
 */
export function InstallPwaButton({
  variant = "default",
  className,
}: {
  variant?: "default" | "compact";
  className?: string;
}) {
  const [available, setAvailable] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [isIos, setIsIos] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Already running as an installed PWA? Hide the button entirely.
    const standalone =
      window.matchMedia?.("(display-mode: standalone)").matches ||
      (window.navigator as any).standalone === true;
    if (standalone) {
      setInstalled(true);
      return;
    }

    // iOS Safari support: no beforeinstallprompt, only manual install
    // via Share → Add to Home Screen. Detect to render an instruction
    // hint instead of an interactive button.
    const ua = window.navigator.userAgent;
    const iOS = /iPad|iPhone|iPod/.test(ua) && !(window as any).MSStream;
    if (iOS) setIsIos(true);

    // PwaRegister stashes the event on window — pick it up if it
    // fired before we mounted, then listen for future fires.
    if ((window as any).__mpInstallPrompt) setAvailable(true);
    const onAvail = () => setAvailable(true);
    const onInstalled = () => {
      setAvailable(false);
      setInstalled(true);
    };
    window.addEventListener("mp:install-available", onAvail);
    window.addEventListener("mp:installed", onInstalled);
    return () => {
      window.removeEventListener("mp:install-available", onAvail);
      window.removeEventListener("mp:installed", onInstalled);
    };
  }, []);

  if (installed) return null;

  async function fire() {
    const evt = (window as any).__mpInstallPrompt as
      | InstallPromptEvent
      | undefined;
    if (!evt) return;
    try {
      await evt.prompt();
      const choice = await evt.userChoice;
      if (choice?.outcome === "accepted") {
        (window as any).__mpInstallPrompt = null;
        setAvailable(false);
      }
    } catch {
      // Swallow — browser may reject if the user dismissed twice already.
    }
  }

  if (isIos && !available) {
    return (
      <div
        className={cn(
          "rounded-xl border border-border bg-card p-3 text-xs text-muted-foreground",
          className,
        )}
      >
        <div className="flex items-start gap-2">
          <Smartphone className="mt-0.5 size-4 shrink-0 text-primary" />
          <div>
            <div className="text-sm font-semibold text-foreground">
              Install MarginPlant on iPhone
            </div>
            <p className="mt-0.5">
              Tap the Share icon in Safari and choose{" "}
              <strong>Add to Home Screen</strong>.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!available) return null;

  if (variant === "compact") {
    return (
      <button
        type="button"
        onClick={fire}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary hover:bg-primary/20",
          className,
        )}
      >
        <Download className="size-3.5" />
        Install app
      </button>
    );
  }

  return (
    <Button
      onClick={fire}
      className={cn("h-11 gap-2 px-5 text-sm font-semibold", className)}
    >
      <Download className="size-4" /> Install MarginPlant app
    </Button>
  );
}
