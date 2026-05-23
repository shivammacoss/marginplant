"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  KeyRound,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Repeat,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ZerodhaAutoLoginAPI,
  type ZerodhaAutoLoginStatus,
} from "@/lib/api";
import { isSuperAdmin } from "@/lib/permissions";
import { useAdminAuthStore } from "@/stores/authStore";

import { CredentialsModal } from "./CredentialsModal";

const STATUS_QUERY_KEY = ["zerodha", "auto-login", "status"] as const;

/**
 * Auto-login configuration card. Drops into the Zerodha admin page next
 * to the existing manual-login controls. Super-admin only (API also gated
 * server-side).
 *
 * Layout mirrors the polished card we use elsewhere:
 *   • Title row: heading + description + Enabled/Disabled status pill
 *   • 4-tile stat grid: Schedule, Last attempt, Last success, Consecutive failures
 *   • Trigger time row: input + Save time
 *   • Action row: Update credentials + Test login now (green CTA)
 */
export function AutoLoginPanel() {
  const admin = useAdminAuthStore((s) => s.admin);
  const qc = useQueryClient();
  const [credsOpen, setCredsOpen] = useState(false);
  const [scheduleInput, setScheduleInput] = useState<string>("");

  const statusQuery = useQuery<ZerodhaAutoLoginStatus>({
    queryKey: STATUS_QUERY_KEY,
    queryFn: () => ZerodhaAutoLoginAPI.status(),
    refetchInterval: 15_000,
    enabled: isSuperAdmin(admin),
  });

  const status = statusQuery.data;

  function applyStatusToCache(next: ZerodhaAutoLoginStatus | undefined) {
    if (next) qc.setQueryData(STATUS_QUERY_KEY, next);
  }

  const credsMut = useMutation({
    mutationFn: ZerodhaAutoLoginAPI.updateCredentials,
    onSuccess: (next) => {
      applyStatusToCache(next);
      toast.success("Credentials saved");
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Failed to save credentials"),
  });

  const toggleMut = useMutation({
    mutationFn: (enabled: boolean) => ZerodhaAutoLoginAPI.toggle(enabled),
    onSuccess: (next, enabled) => {
      applyStatusToCache(next);
      toast.success(`Auto-login ${enabled ? "enabled" : "disabled"}`);
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Toggle failed"),
  });

  const scheduleMut = useMutation({
    mutationFn: (s: string) => ZerodhaAutoLoginAPI.setSchedule(s),
    onSuccess: (next) => {
      applyStatusToCache(next);
      toast.success("Schedule updated");
      setScheduleInput("");
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Schedule update failed"),
  });

  const testMut = useMutation({
    mutationFn: () => ZerodhaAutoLoginAPI.testNow(),
    onSuccess: (resp) => {
      applyStatusToCache(resp.status);
      if (resp.result.success) {
        const ms = resp.result.duration_ms ?? 0;
        toast.success(`Login successful in ${(ms / 1000).toFixed(1)} s`);
      } else {
        toast.error(
          `Login failed at "${resp.result.stage ?? "unknown"}": ${resp.result.error ?? "unknown error"}`,
        );
      }
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Test login failed"),
  });

  if (!isSuperAdmin(admin)) return null;

  const isConfigured = !!status?.is_configured;
  const isEnabled = !!status?.is_enabled;
  const lastStatus = status?.last_status ?? "";
  const consecutiveFailures = status?.consecutive_failures ?? 0;
  const schedule = status?.schedule_time_ist ?? "07:00";
  const lastDurationSec = status?.last_duration_ms
    ? (status.last_duration_ms / 1000).toFixed(1)
    : null;

  return (
    <section className="rounded-xl border border-border/60 bg-card/40 p-5 shadow-sm backdrop-blur-sm">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="mb-5 flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400">
            <Repeat className="h-4 w-4" />
          </div>
          <div className="space-y-1">
            <h3 className="text-base font-semibold">Daily auto-login</h3>
            <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
              Refreshes the Kite access token daily before market open.
              Drives the Kite OAuth + TOTP screen with a headless browser —
              credentials are AES-256-GCM encrypted at rest.
            </p>
          </div>
        </div>
        <StatusPillLocal
          enabled={isEnabled}
          configured={isConfigured}
          lastStatus={lastStatus}
        />
      </div>

      {/* ── Stat tiles ─────────────────────────────────────────────── */}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label="Schedule (IST)"
          icon={<Clock className="h-3.5 w-3.5" />}
          value={schedule}
          subtitle="Mon–Fri"
        />
        <StatTile
          label="Last attempt"
          value={formatTs(status?.last_attempt_at)}
          subtitle={
            lastStatus === "success" ? (
              <span className="inline-flex items-center gap-1 text-emerald-400">
                <CheckCircle2 className="h-3 w-3" />
                Success
              </span>
            ) : lastStatus === "failed" ? (
              <span className="inline-flex items-center gap-1 text-destructive">
                <XCircle className="h-3 w-3" />
                {status?.last_stage ? `Failed at "${status.last_stage}"` : "Failed"}
              </span>
            ) : (
              <span className="text-muted-foreground">Never run</span>
            )
          }
        />
        <StatTile
          label="Last success"
          value={formatTs(status?.last_success_at)}
          subtitle={
            lastDurationSec ? `${lastDurationSec}s end-to-end` : "—"
          }
        />
        <StatTile
          label="Consecutive failures"
          value={consecutiveFailures.toString()}
          valueClassName={
            consecutiveFailures > 0
              ? "text-destructive"
              : "text-emerald-400"
          }
          subtitle={
            isConfigured ? (
              `Kite user ${status?.username_masked || "stored"}`
            ) : (
              <span className="text-muted-foreground">Not configured</span>
            )
          }
        />
      </div>

      {/* ── Inline error banner if last run failed ─────────────────── */}
      {lastStatus === "failed" && status?.last_error_detail && (
        <div className="mb-5 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="min-w-0">
            <div className="font-medium">
              Last run failed{status?.last_stage ? ` at "${status.last_stage}"` : ""}
              {consecutiveFailures > 1 ? ` · ${consecutiveFailures} in a row` : ""}
            </div>
            <div className="mt-0.5 break-words text-[11px] opacity-80">
              {status.last_error_detail}
            </div>
          </div>
        </div>
      )}

      {/* ── Trigger time row ───────────────────────────────────────── */}
      <div className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto] md:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="auto-login-schedule" className="text-xs font-medium">
            Trigger time (HH:MM IST)
          </Label>
          <Input
            id="auto-login-schedule"
            placeholder={schedule}
            value={scheduleInput}
            onChange={(e) => setScheduleInput(e.target.value)}
            className="font-mono"
          />
          <p className="text-[11px] text-muted-foreground">
            Kite tokens expire at 08:00 IST. Default 07:00 gives a 1-hour
            buffer plus retries before the 09:15 market open.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="md:mb-[26px]"
          disabled={!scheduleInput.trim() || scheduleMut.isPending}
          onClick={() => {
            const v = scheduleInput.trim();
            if (!/^\d{1,2}:\d{2}$/.test(v)) {
              toast.error("Use HH:MM 24-hour format (e.g. 07:00)");
              return;
            }
            scheduleMut.mutate(v);
          }}
        >
          Save time
        </Button>
      </div>

      {/* ── Action row ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setCredsOpen(true)}
        >
          <KeyRound className="mr-1.5 h-4 w-4" />
          {isConfigured ? "Update credentials" : "Save credentials"}
        </Button>

        <Button
          size="sm"
          className="bg-emerald-500 text-white shadow-sm hover:bg-emerald-600 focus-visible:ring-emerald-400"
          disabled={!isConfigured || testMut.isPending}
          onClick={() => testMut.mutate()}
        >
          {testMut.isPending ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Play className="mr-1.5 h-4 w-4 fill-current" />
          )}
          {testMut.isPending ? "Testing…" : "Test login now"}
        </Button>

        <Button
          variant={isEnabled ? "ghost" : "secondary"}
          size="sm"
          className="ml-auto"
          disabled={!isConfigured || toggleMut.isPending}
          onClick={() => toggleMut.mutate(!isEnabled)}
        >
          {isEnabled ? (
            <>
              <Pause className="mr-1.5 h-4 w-4" />
              Disable scheduler
            </>
          ) : (
            <>
              <Play className="mr-1.5 h-4 w-4" />
              Enable scheduler
            </>
          )}
        </Button>
      </div>

      <CredentialsModal
        open={credsOpen}
        onClose={() => setCredsOpen(false)}
        hasExisting={isConfigured}
        onSubmit={async (body) => {
          await credsMut.mutateAsync(body);
        }}
      />
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────── */

function StatTile({
  label,
  icon,
  value,
  subtitle,
  valueClassName,
}: {
  label: string;
  icon?: React.ReactNode;
  value: string;
  subtitle?: React.ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {icon ? <span>{icon}</span> : null}
        <span>{label}</span>
      </div>
      <div
        className={`mt-1.5 truncate text-base font-semibold ${valueClassName ?? ""}`}
        title={value}
      >
        {value || "—"}
      </div>
      {subtitle ? (
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {subtitle}
        </div>
      ) : null}
    </div>
  );
}

function StatusPillLocal({
  enabled,
  configured,
  lastStatus,
}: {
  enabled: boolean;
  configured: boolean;
  lastStatus: string;
}) {
  let label: string;
  let dotClass: string;
  let pillClass: string;
  if (!configured) {
    label = "Not configured";
    dotClass = "bg-muted-foreground";
    pillClass = "border-border bg-muted/40 text-muted-foreground";
  } else if (!enabled) {
    label = "Disabled";
    dotClass = "bg-yellow-400";
    pillClass = "border-yellow-500/30 bg-yellow-500/10 text-yellow-300";
  } else if (lastStatus === "failed") {
    label = "Enabled · last run failed";
    dotClass = "bg-destructive";
    pillClass = "border-destructive/30 bg-destructive/10 text-destructive";
  } else {
    label = "Enabled";
    dotClass = "bg-emerald-400";
    pillClass = "border-emerald-500/30 bg-emerald-500/10 text-emerald-400";
  }
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${pillClass}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
      {label}
    </span>
  );
}

function formatTs(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return iso;
  }
}
