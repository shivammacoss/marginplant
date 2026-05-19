"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";

/**
 * Keeps the Android status-bar / PWA chrome colour in sync with the
 * current app theme. The static `<meta name="theme-color">` injected by
 * Next.js can only react to `prefers-color-scheme`, so when the user
 * forces light/dark from Profile → Preferences (overriding the OS) the
 * status bar would otherwise stay on the system-default colour — leading
 * to a green or near-black band above a white app surface (the user
 * flagged this as "mere sabse top me green color a rha hai esko theme se
 * match karo").
 *
 * This component watches `resolvedTheme` and rewrites the
 * `<meta name="theme-color">` tag in place. `#ffffff` for light,
 * `#0a0a0a` for dark — same constants as the static fallbacks declared
 * in `app/layout.tsx`'s `viewport.themeColor`, so the look is identical
 * whether the browser picked the media-query fallback or this runtime
 * override is active.
 */
export function ThemeColorSync() {
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    if (typeof document === "undefined") return;
    const colour = resolvedTheme === "light" ? "#ffffff" : "#0a0a0a";

    // Remove the two media-keyed metas Next.js emitted from
    // viewport.themeColor — otherwise the browser would keep honouring
    // them (an explicit static tag wins over a runtime-set one only if
    // the static one's media query DOESN'T match).
    document
      .querySelectorAll('meta[name="theme-color"]')
      .forEach((el) => el.parentElement?.removeChild(el));

    const meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.content = colour;
    document.head.appendChild(meta);
  }, [resolvedTheme]);

  return null;
}
