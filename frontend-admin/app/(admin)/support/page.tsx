"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { MessageCircle, Save } from "lucide-react";
import { SupportAPI } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/common/PageHeader";
import { useAdminAuthStore } from "@/stores/authStore";

/** Builds the wa.me link from a raw input the way the apk's
 *  `buildWhatsappUrl` does — strip non-digits, require 8+ length, then
 *  prepend the wa.me prefix. Returns null when the input is unusable
 *  so the preview row hides the link entirely. */
function buildWaPreview(raw: string): string | null {
  const digits = String(raw || "").replace(/[^0-9]/g, "");
  if (digits.length < 8) return null;
  return `https://wa.me/${digits}`;
}

const ROLE_HINT: Record<string, string> = {
  SUPER_ADMIN:
    "You're the platform's root admin. The number you set here is the LAST-RESORT fallback for every user whose broker chain hasn't configured their own.",
  ADMIN:
    "You're a sub-admin. The number you set here is shown to YOUR pool of users (clients + your brokers' clients) unless a downstream broker overrides it with their own.",
  BROKER:
    "You're a broker. The number you set here is shown to YOUR clients (and any sub-brokers' clients who haven't set their own). Leave blank to inherit from your parent admin.",
};

export default function AdminSupportPage() {
  const qc = useQueryClient();
  const me = useAdminAuthStore((s) => s.admin);

  const { data, isFetching } = useQuery({
    queryKey: ["admin", "support"],
    queryFn: () => SupportAPI.get(),
  });

  // Form state — hydrated from the server on first load, then left alone
  // so a background refetch can't clobber an in-progress edit.
  const [draft, setDraft] = useState<string>("");
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (!data || hydrated) return;
    setDraft(data.whatsapp || "");
    setHydrated(true);
  }, [data, hydrated]);

  const saveMut = useMutation({
    mutationFn: (val: string) => SupportAPI.set(val),
    onSuccess: (resp) => {
      toast.success("Support number updated");
      qc.setQueryData(["admin", "support"], resp);
      // Invalidate the user-side support cache so any apk session that
      // hits /user/support next sees the fresh value without waiting
      // for the 10-minute query staleTime to expire.
      qc.invalidateQueries({ queryKey: ["support", "contacts"] });
    },
    onError: (e: any) => {
      toast.error(e?.message || "Could not save the number");
    },
  });

  const role = me?.role || data?.role || "";
  const hint =
    ROLE_HINT[role] ||
    "Set the WhatsApp number your downstream users will see on the Contact-support button.";
  const waPreview = buildWaPreview(draft);
  const trimmed = draft.trim();
  const serverVal = (data?.whatsapp || "").trim();
  const isDirty = trimmed !== serverVal;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Support contact"
        description="Per-admin WhatsApp number shown to your users on the Add-funds / Contact-support button. Cascades down the broker hierarchy — leave blank to inherit from your parent admin."
      />

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageCircle className="size-5 text-primary" />
            Your support WhatsApp
          </CardTitle>
          <CardDescription>{hint}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              WhatsApp number (include country code, e.g. +91 98765 43210)
            </label>
            <input
              type="tel"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="+91 98765 43210"
              disabled={isFetching && !hydrated}
              className="h-10 w-full rounded-md border border-border bg-muted/20 px-3 text-sm outline-none placeholder:text-muted-foreground focus:border-primary disabled:opacity-50"
            />
            <p className="text-[11px] text-muted-foreground">
              Spaces, dashes and the leading + are kept verbatim. The apk's
              wa.me link strips them automatically.
            </p>
          </div>

          {/* Preview of how the link will resolve. Helps the admin spot a
              missing country code or wrong digit count BEFORE saving. */}
          <div className="rounded-md border border-border bg-muted/10 px-3 py-2 text-xs">
            <div className="text-muted-foreground">Preview</div>
            {trimmed === "" ? (
              <div className="mt-0.5 text-foreground">
                <span className="font-medium">Cleared</span> — your users will
                fall back to your parent admin's number (or the platform
                default if you're a super-admin).
              </div>
            ) : waPreview ? (
              <div className="mt-0.5 break-all font-tabular text-primary">{waPreview}</div>
            ) : (
              <div className="mt-0.5 text-loss">
                Too short to be a valid WhatsApp number. Add the country code.
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              onClick={() => saveMut.mutate(trimmed)}
              loading={saveMut.isPending}
              disabled={!isDirty || saveMut.isPending || (trimmed !== "" && !waPreview)}
            >
              <Save className="size-4" />
              Save
            </Button>
            {isDirty && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setDraft(serverVal)}
                disabled={saveMut.isPending}
              >
                Reset
              </Button>
            )}
            {!isDirty && hydrated && serverVal && (
              <span className="text-xs text-muted-foreground">
                Saved · users see this number now
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
