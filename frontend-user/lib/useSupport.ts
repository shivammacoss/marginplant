import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "@/lib/api";

export interface SupportContacts {
  whatsapp: string;
  email: string;
}

/**
 * Admin-managed WhatsApp + support email. Pulled from `/user/support`
 * — backed by `platform.support_whatsapp` + `platform.support_email`
 * PlatformSetting rows that the admin can edit on /admin/settings/platform.
 *
 * No hardcoded fallback — admin is the single source of truth. If
 * admin clears a value, the corresponding UI affordance disappears
 * immediately. If the backend hasn't been restarted with the new
 * route, the query errors and the section hides — the fix is "restart
 * the backend so the seed inserts default support keys", not stale
 * defaults in the JS bundle.
 *
 * Generously cached because these change at most once a quarter.
 */
export function useSupportContacts() {
  return useQuery<SupportContacts>({
    queryKey: ["support", "contacts"],
    queryFn: () => unwrap<SupportContacts>(api.get("/user/support")),
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

/** wa.me URL builder — strips formatting from the admin-stored number
 *  (spaces, dashes, leading "+") since wa.me expects digits only.
 *  Returns null for unusable input so callers can hide the link. */
export function buildWhatsappUrl(
  raw: string | undefined | null,
  prefill?: string,
): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/[^0-9]/g, "");
  if (digits.length < 8) return null;
  const text = prefill ? `?text=${encodeURIComponent(prefill)}` : "";
  return `https://wa.me/${digits}${text}`;
}

export function buildMailtoUrl(
  email: string | undefined | null,
  opts?: { subject?: string; body?: string },
): string | null {
  if (!email || !email.includes("@")) return null;
  const params: string[] = [];
  if (opts?.subject) params.push(`subject=${encodeURIComponent(opts.subject)}`);
  if (opts?.body) params.push(`body=${encodeURIComponent(opts.body)}`);
  const qs = params.length > 0 ? `?${params.join("&")}` : "";
  return `mailto:${email}${qs}`;
}
