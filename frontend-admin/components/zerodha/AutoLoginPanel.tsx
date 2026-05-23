"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlarmClock,
  AlertTriangle,
  CheckCircle2,
  Clock,
  KeyRound,
  Loader2,
  Pause,
  Play,
  ShieldCheck,
  Timer,
  XCircle,
  Zap,
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

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Daily Kite auto-login console — super-admin-only card on /zerodha.
 *
 * Three-zone layout:
 *   1. Hero — gradient panel with the live countdown to the next scheduled
 *      run + a token-health summary (latest success, duration, consecutive
 *      failures). This is the operator's "is everything OK?" glance.
 *   2. Stat strip — schedule, Kite user mask, last attempt — quick facts
 *      that surface why the hero shows what it does.
 *   3. Controls — trigger-time editor + Save + the action row (Update
 *      credentials / Test login / Enable-Disable).
 */
export function AutoLoginPanel() {
  const admin = useAdminAuthStore((s) => s.admin);
  const qc = useQueryClient();
  const [credsOpen, setCredsOpen] = useState(false);
  const [scheduleInput, setScheduleInput] = useState<string>("");

  // Bumped every second so the countdown ticks live. setInterval is
  // cheap — the formatter does nothing more than a few date subtractions.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

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

  const healthState: "good" | "warning" | "bad" | "off" = !isConfigured
    ? "off"
    : !isEnabled
      ? "warning"
      : lastStatus === "failed"
        ? "bad"
        : "good";

  const nextRun = computeNextRun(schedule, nowTick);
  const countdown = formatCountdown(nextRun.deltaMs);

  return (
    <section className="overflow-hidden rounded-2xl border border-border/60 bg-card/40 shadow-sm">
      {/* ── 1. Hero (gradient + countdown + health) ─────────────────── */}
      <div
        className={`relative isolate overflow-hidden border-b border-border/60 px-5 py-5 ${heroBgClass(healthState)}`}
      >
        {/* Decorative blur orb — pure CSS, no images */}
        <div
          aria-hidden
          className={`pointer-events-none absolute -right-12 -top-16 h-48 w-48 rounded-full opacity-30 blur-3xl ${heroOrbClass(healthState)}`}
        />

        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${heroIconBgClass(healthState)}`}
            >
              <AlarmClock className={`h-5 w-5 ${heroIconColorClass(healthState)}`} />
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold">Daily auto-login</h3>
                <HealthPill state={healthState} />
              </div>
              <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
                Refreshes the Kite access token daily before market open.
                Drives the OAuth + TOTP screen with a headless browser —
                credentials are AES-256-GCM encrypted at rest.
              </p>
            </div>
          </div>
        </div>

        <div className="relative mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* Next-run countdown */}
          <div className="rounded-xl border border-white/5 bg-background/40 p-4 backdrop-blur-sm">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              <Timer className="h-3 w-3" />
              Next run
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span
                className={`font-mono text-3xl font-semibold tracking-tight ${
                  isEnabled ? "text-foreground" : "text-muted-foreground"
                }`}
              >
                {isEnabled && isConfigured ? countdown.primary : "Paused"}
              </span>
              {isEnabled && isConfigured && (
                <span className="text-xs text-muted-foreground">
                  {countdown.suffix}
                </span>
              )}
            </div>
            <div className="mt-1.5 text-[11px] text-muted-foreground">
              {isEnabled && isConfigured ? (
                <>
                  at <span className="font-medium text-foreground">{schedule} IST</span> ·{" "}
                  {nextRun.dateLabel}
                </>
              ) : !isConfigured ? (
                "Save Kite credentials to arm the scheduler"
              ) : (
                "Scheduler is disabled — enable below to resume"
              )}
            </div>
            <ProgressBar
              percent={isEnabled && isConfigured ? countdown.progressPct : 0}
              state={healthState}
            />
          </div>

          {/* Token health summary */}
          <div className="rounded-xl border border-white/5 bg-background/40 p-4 backdrop-blur-sm">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              <ShieldCheck className="h-3 w-3" />
              Token health
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              {lastStatus === "success" ? (
                <span className="text-3xl font-semibold tracking-tight text-emerald-400">
                  Healthy
                </span>
              ) : lastStatus === "failed" ? (
                <span className="text-3xl font-semibold tracking-tight text-destructive">
                  Attention
                </span>
              ) : (
                <span className="text-3xl font-semibold tracking-tight text-muted-foreground">
                  Idle
                </span>
              )}
              {lastDurationSec && lastStatus === "success" && (
                <span className="text-xs text-muted-foreground">
                  · {lastDurationSec}s
                </span>
              )}
            </div>
            <div className="mt-1.5 text-[11px] text-muted-foreground">
              {status?.last_success_at ? (
                <>
                  Last refresh{" "}
                  <span className="font-medium text-foreground">
                    {formatTs(status.last_success_at)}
                  </span>
                </>
              ) : (
                "No successful run yet — try a Test login"
              )}
            </div>
            <div className="mt-3 flex items-center gap-1.5 text-[11px]">
              <span
                className={`inline-flex h-1.5 w-1.5 rounded-full ${
                  consecutiveFailures === 0 ? "bg-emerald-400" : "bg-destructive"
                }`}
              />
              <span className="text-muted-foreground">
                {consecutiveFailures === 0
                  ? "0 consecutive failures"
                  : `${consecutiveFailures} consecutive failure${consecutiveFailures === 1 ? "" : "s"}`}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ── 2. Stat strip ──────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-px bg-border/40 md:grid-cols-4">
        <StatCell
          label="Schedule"
          icon={<Clock className="h-3.5 w-3.5" />}
          value={`${schedule} IST`}
          subtitle="Mon–Fri (excl. holidays)"
        />
        <StatCell
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
                {status?.last_stage ? `Failed @ ${status.last_stage}` : "Failed"}
              </span>
            ) : (
              <span className="text-muted-foreground">Never run</span>
            )
          }
        />
        <StatCell
          label="Last success"
          value={formatTs(status?.last_success_at)}
          subtitle={lastDurationSec ? `${lastDurationSec}s end-to-end` : "—"}
        />
        <StatCell
          label="Kite user"
          value={isConfigured ? status?.username_masked || "Saved" : "Not configured"}
          subtitle={
            consecutiveFailures > 0 ? (
              <span className="text-destructive">
                {consecutiveFailures} consec. failure{consecutiveFailures === 1 ? "" : "s"}
              </span>
            ) : (
              "Credentials encrypted at rest"
            )
          }
        />
      </div>

      {/* Inline error banner if the last run failed */}
      {lastStatus === "failed" && status?.last_error_detail && (
        <div className="mx-5 mt-5 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="min-w-0">
            <div className="font-medium">
              Last run failed{status?.last_stage ? ` at "${status.last_stage}"` : ""}
            </div>
            <div className="mt-0.5 break-words text-[11px] opacity-80">
              {status.last_error_detail}
            </div>
          </div>
        </div>
      )}

      {/* ── 3. Controls ────────────────────────────────────────────── */}
      <div className="space-y-4 p-5">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto] md:items-end">
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

        <div className="flex flex-wrap items-center gap-2 border-t border-border/40 pt-4">
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
            className="bg-gradient-to-br from-emerald-500 to-emerald-600 text-white shadow-md shadow-emerald-500/20 hover:from-emerald-400 hover:to-emerald-500 focus-visible:ring-emerald-400 disabled:from-emerald-500/40 disabled:to-emerald-600/40 disabled:shadow-none"
            disabled={!isConfigured || testMut.isPending}
            onClick={() => testMut.mutate()}
          >
            {testMut.isPending ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Zap className="mr-1.5 h-4 w-4" />
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
/* Sub-components                                                       */
/* ─────────────────────────────────────────────────────────────────── */

function StatCell({
  label,
  icon,
  value,
  subtitle,
}: {
  label: string;
  icon?: React.ReactNode;
  value: string;
  subtitle?: React.ReactNode;
}) {
  return (
    <div className="bg-card/40 px-4 py-3.5">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {icon ? <span>{icon}</span> : null}
        <span>{label}</span>
      </div>
      <div className="mt-1.5 truncate text-sm font-semibold" title={value}>
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

function HealthPill({ state }: { state: "good" | "warning" | "bad" | "off" }) {
  const map = {
    good: {
      label: "Enabled",
      pill: "border-emerald-500/30 bg-emerald-500/15 text-emerald-300",
      dot: "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)] animate-pulse",
    },
    warning: {
      label: "Disabled",
      pill: "border-yellow-500/30 bg-yellow-500/10 text-yellow-300",
      dot: "bg-yellow-400",
    },
    bad: {
      label: "Last run failed",
      pill: "border-destructive/30 bg-destructive/10 text-destructive",
      dot: "bg-destructive animate-pulse",
    },
    off: {
      label: "Not configured",
      pill: "border-border bg-muted/40 text-muted-foreground",
      dot: "bg-muted-foreground/60",
    },
  } as const;
  const m = map[state];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${m.pill}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  );
}

function ProgressBar({
  percent,
  state,
}: {
  percent: number;
  state: "good" | "warning" | "bad" | "off";
}) {
  const fillClass =
    state === "good"
      ? "bg-emerald-400"
      : state === "bad"
        ? "bg-destructive"
        : state === "warning"
          ? "bg-yellow-400"
          : "bg-muted-foreground/40";
  return (
    <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-border/50">
      <div
        className={`h-full transition-[width] duration-500 ease-out ${fillClass}`}
        style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
      />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────── */
/* Helpers                                                              */
/* ─────────────────────────────────────────────────────────────────── */

function heroBgClass(state: "good" | "warning" | "bad" | "off") {
  switch (state) {
    case "good":
      return "bg-gradient-to-br from-emerald-500/10 via-emerald-500/5 to-transparent";
    case "warning":
      return "bg-gradient-to-br from-yellow-500/10 via-yellow-500/5 to-transparent";
    case "bad":
      return "bg-gradient-to-br from-destructive/15 via-destructive/5 to-transparent";
    default:
      return "bg-gradient-to-br from-muted/30 via-muted/10 to-transparent";
  }
}

function heroOrbClass(state: "good" | "warning" | "bad" | "off") {
  switch (state) {
    case "good":
      return "bg-emerald-400";
    case "warning":
      return "bg-yellow-400";
    case "bad":
      return "bg-destructive";
    default:
      return "bg-muted-foreground";
  }
}

function heroIconBgClass(state: "good" | "warning" | "bad" | "off") {
  switch (state) {
    case "good":
      return "bg-emerald-500/15";
    case "warning":
      return "bg-yellow-500/15";
    case "bad":
      return "bg-destructive/15";
    default:
      return "bg-muted/30";
  }
}

function heroIconColorClass(state: "good" | "warning" | "bad" | "off") {
  switch (state) {
    case "good":
      return "text-emerald-400";
    case "warning":
      return "text-yellow-400";
    case "bad":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
}

/**
 * Returns the next IST datetime at HH:MM (skipping past today's slot if
 * the time has already elapsed), the ms delta from now, and a short
 * "Mon, 24 May" date label for display. Pure function — driven by the
 * `now` argument so the parent component can re-render via a tick.
 */
function computeNextRun(
  scheduleHHMM: string,
  now: number,
): { target: Date; deltaMs: number; dateLabel: string } {
  const [hStr, mStr] = scheduleHHMM.split(":");
  const h = Number.parseInt(hStr ?? "7", 10) || 7;
  const m = Number.parseInt(mStr ?? "0", 10) || 0;

  // Build "now in IST" by adding the offset to UTC.
  const nowIst = new Date(now + IST_OFFSET_MS);
  const target = new Date(nowIst);
  target.setUTCHours(h, m, 0, 0);
  if (target.getTime() <= nowIst.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  const deltaMs = target.getTime() - nowIst.getTime();

  const dateLabel = target.toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

  return { target, deltaMs, dateLabel };
}

function formatCountdown(deltaMs: number): {
  primary: string;
  suffix: string;
  progressPct: number;
} {
  if (deltaMs <= 0) {
    return { primary: "00:00:00", suffix: "any moment", progressPct: 100 };
  }
  const totalSec = Math.floor(deltaMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const primary =
    h >= 1
      ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  const suffix = h >= 1 ? "hh:mm:ss" : "mm:ss";
  // Progress = how much of the 24-hour cycle has elapsed since the LAST
  // run. With only the next-run time known, we approximate by mapping
  // remaining time against a 24-hour window.
  const dayMs = 24 * 60 * 60 * 1000;
  const elapsed = dayMs - Math.min(deltaMs, dayMs);
  const progressPct = (elapsed / dayMs) * 100;
  return { primary, suffix, progressPct };
}

function formatTs(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return iso;
  }
}
