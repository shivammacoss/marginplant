"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlarmClock,
  CheckCircle2,
  Clock,
  KeyRound,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import {
  ZerodhaAutoLoginAPI,
  type ZerodhaAutoLoginStatus,
} from "@/lib/api";
import { isSuperAdmin } from "@/lib/permissions";
import { useAdminAuthStore } from "@/stores/authStore";

import { CredentialsModal } from "./CredentialsModal";

const STATUS_QUERY_KEY = ["zerodha", "auto-login", "status"] as const;

/**
 * Auto-login configuration card — drops into the Zerodha admin page next
 * to the existing manual-login controls. Super-admin only (the API is
 * gated server-side too).
 *
 * Surfaces:
 *   • Whether creds are saved (masked username)
 *   • Toggle to enable/disable the daily scheduler
 *   • Configurable HH:MM IST schedule time
 *   • "Test login now" button — fires the full Playwright flow on demand
 *   • Last attempt + last success timestamps, failure stage on error
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
    // Without this guard the panel would briefly query as a non-super
    // admin and pop a 403 toast before the auth store hydrates.
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

  return (
    <Card className="space-y-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-base font-semibold">
            <AlarmClock className="h-4 w-4" />
            Auto-login (daily)
          </div>
          <p className="text-xs text-muted-foreground">
            Refreshes the Kite access token automatically each weekday so
            you don&apos;t have to do the manual 2FA dance every morning.
            Skips weekends + Indian trading holidays.
          </p>
        </div>
        <StatusPillLocal
          enabled={isEnabled}
          configured={isConfigured}
          lastStatus={lastStatus}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <InfoRow
          icon={<KeyRound className="h-4 w-4" />}
          label="Credentials"
          value={
            isConfigured
              ? `Saved (${status?.username_masked || "stored"})`
              : "Not yet saved"
          }
        />
        <InfoRow
          icon={<Clock className="h-4 w-4" />}
          label="Scheduled time"
          value={`${status?.schedule_time_ist ?? "07:00"} IST`}
        />
        <InfoRow
          icon={<CheckCircle2 className="h-4 w-4" />}
          label="Last success"
          value={formatTs(status?.last_success_at)}
        />
        <InfoRow
          icon={
            lastStatus === "failed" ? (
              <XCircle className="h-4 w-4 text-destructive" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )
          }
          label="Last attempt"
          value={formatTs(status?.last_attempt_at)}
        />
      </div>

      {lastStatus === "failed" && status?.last_error_detail && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <div className="font-medium">
            Last attempt failed
            {status.last_stage ? ` at "${status.last_stage}"` : ""}
            {status.consecutive_failures > 0
              ? ` (${status.consecutive_failures} in a row)`
              : ""}
          </div>
          <div className="mt-0.5 break-words">{status.last_error_detail}</div>
        </div>
      )}

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
          variant={isEnabled ? "ghost" : "default"}
          size="sm"
          disabled={!isConfigured || toggleMut.isPending}
          onClick={() => toggleMut.mutate(!isEnabled)}
        >
          {isEnabled ? (
            <>
              <Pause className="mr-1.5 h-4 w-4" />
              Disable
            </>
          ) : (
            <>
              <Play className="mr-1.5 h-4 w-4" />
              Enable
            </>
          )}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!isConfigured || testMut.isPending}
          onClick={() => testMut.mutate()}
        >
          {testMut.isPending ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-1.5 h-4 w-4" />
          )}
          Test login now
        </Button>
      </div>

      <div className="flex items-end gap-2 border-t border-border/60 pt-3">
        <div className="flex-1 space-y-1">
          <Label htmlFor="auto-login-schedule" className="text-xs">
            Daily schedule (HH:MM IST, 24-hour)
          </Label>
          <Input
            id="auto-login-schedule"
            placeholder={status?.schedule_time_ist ?? "07:00"}
            value={scheduleInput}
            onChange={(e) => setScheduleInput(e.target.value)}
          />
        </div>
        <Button
          variant="outline"
          size="sm"
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
          Update time
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
    </Card>
  );
}

function InfoRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2">
      <div className="mt-0.5 text-muted-foreground">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <div className="truncate text-sm">{value}</div>
      </div>
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
  let className: string;
  if (!configured) {
    label = "Not configured";
    className =
      "bg-muted text-muted-foreground border-border";
  } else if (!enabled) {
    label = "Disabled";
    className =
      "bg-yellow-500/10 text-yellow-300 border-yellow-500/30";
  } else if (lastStatus === "failed") {
    label = "Enabled (last run failed)";
    className =
      "bg-destructive/10 text-destructive border-destructive/30";
  } else {
    label = "Enabled";
    className =
      "bg-emerald-500/10 text-emerald-400 border-emerald-500/30";
  }
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider ${className}`}
    >
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
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return iso;
  }
}
