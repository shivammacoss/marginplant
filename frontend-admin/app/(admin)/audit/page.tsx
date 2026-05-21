"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { X as XIcon } from "lucide-react";
import { SettingsAPI, UsersAPI } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/common/PageHeader";
import { DataTable, type Column } from "@/components/common/DataTable";
import { StatusPill } from "@/components/common/StatusPill";

export default function AuditLogsPage() {
  return (
    <Suspense fallback={null}>
      <AuditLogsInner />
    </Suspense>
  );
}

/** Lightweight UA → "Chrome on macOS" style summariser. We deliberately
 *  avoid a `ua-parser-js` dep — the audit column just needs a glance-
 *  readable hint, not a perfect parse. Picks one of:
 *     Mobile-app → "iOS app" / "Android app" if the UA mentions our
 *     bundle name; otherwise falls back to browser-on-OS detection. */
function shortDevice(ua: string | null | undefined): string {
  if (!ua) return "—";
  const s = ua;
  if (/MarginPlant[-\s]?Mobile|marginplant.+Capacitor|marginplant.+Cordova/i.test(s)) {
    if (/iPhone|iPad|iOS/i.test(s)) return "iOS app";
    if (/Android/i.test(s)) return "Android app";
    return "Mobile app";
  }
  const browser =
    /Edg\//.test(s) ? "Edge" :
    /Chrome\//.test(s) && !/Chromium/.test(s) ? "Chrome" :
    /Firefox\//.test(s) ? "Firefox" :
    /Safari\//.test(s) ? "Safari" :
    /OPR\//.test(s) ? "Opera" :
    "Browser";
  const os =
    /iPhone|iPad/.test(s) ? "iOS" :
    /Android/.test(s) ? "Android" :
    /Mac OS X|Macintosh/.test(s) ? "macOS" :
    /Windows/.test(s) ? "Windows" :
    /Linux/.test(s) ? "Linux" :
    "";
  return os ? `${browser} on ${os}` : browser;
}

/** Two-line cell: full name on top, user_code in mono on the second
 *  line. Falls back to "system" / "—" when the row has no actor /
 *  target (e.g. boot-time migration audit rows have no actor). Click
 *  the cell to re-scope the entire audit page to that user. */
function UserCell({
  info,
  fallback,
}: {
  info?: { id?: string; name?: string | null; code?: string | null; role?: string | null } | null;
  fallback: string;
}) {
  if (!info || !info.id) {
    return <span className="text-xs text-muted-foreground">{fallback}</span>;
  }
  const name = info.name?.trim();
  const code = info.code?.trim();
  if (!name && !code) {
    return (
      <span className="font-mono text-[11px] text-muted-foreground">
        {info.id.slice(-8)}
      </span>
    );
  }
  return (
    <Link
      href={`/audit?involving_user_id=${info.id}`}
      className="group inline-flex flex-col leading-tight"
      title={`${name ?? ""} ${code ? `(${code})` : ""}`.trim()}
    >
      <span className="text-xs font-medium text-foreground group-hover:underline">
        {name || code || info.id.slice(-8)}
      </span>
      {code && (
        <span className="font-mono text-[10px] text-muted-foreground">
          {code}
        </span>
      )}
    </Link>
  );
}


/** Preset filter chips for the audit page. Each chip maps to a
 *  semantic category that the admin actually thinks in (Edit trade,
 *  Reopen, Deposit, etc.) — internally we hand a comma-separated list
 *  of action codes + an optional entity_type whitelist to the backend.
 *  Keeping the mapping table here (not on the backend) lets the
 *  category set evolve without a deploy.
 */
const PRESETS: {
  id: string;
  label: string;
  actions?: string[];        // matches AuditAction enum values
  entity_types?: string[];   // matches the entity_type strings the
                             // log_event helpers stamp (e.g. "Position",
                             // "DepositRequest", "WithdrawalRequest")
}[] = [
  { id: "all", label: "All" },
  {
    id: "edit_trade",
    label: "Edit trade",
    actions: ["POSITION_EDIT"],
    entity_types: ["Position"],
  },
  {
    id: "close_admin",
    label: "Close by admin",
    actions: ["SQUAREOFF", "SQUAREOFF_FORCE"],
    entity_types: ["Position"],
  },
  {
    id: "reopen",
    label: "Reopen",
    actions: ["POSITION_REOPEN"],
    entity_types: ["Position"],
  },
  {
    id: "position_delete",
    label: "Position delete",
    actions: ["POSITION_DELETE"],
    entity_types: ["Position"],
  },
  {
    id: "deposit",
    label: "Deposit",
    actions: ["APPROVE", "REJECT"],
    entity_types: ["DepositRequest"],
  },
  {
    id: "withdrawal",
    label: "Withdrawal",
    actions: ["APPROVE", "REJECT"],
    entity_types: ["WithdrawalRequest"],
  },
  {
    id: "settlement",
    label: "Settlement",
    actions: ["APPROVE", "REJECT"],
    entity_types: ["SettlementRequest"],
  },
  {
    id: "kyc",
    label: "KYC",
    actions: ["APPROVE", "REJECT", "CREATE", "UPDATE"],
    entity_types: ["KycSubmission"],
  },
  {
    id: "wallet_adjust",
    label: "Wallet adjust",
    actions: ["WALLET_ADJUST"],
  },
  {
    id: "block",
    label: "Block / Unblock",
    actions: ["BLOCK", "UNBLOCK"],
  },
  {
    id: "login",
    label: "Login",
    actions: ["LOGIN", "LOGOUT", "LOGIN_FAILED"],
  },
  {
    id: "settings",
    label: "Settings change",
    actions: ["SETTING_CHANGE"],
  },
];


function AuditLogsInner() {
  const searchParams = useSearchParams();
  // `involving_user_id` is the new "events involving this user as actor
  // OR target" filter — used by the user-detail Activity link so admin
  // sees user-initiated events too. `target_user_id` kept for backward
  // compat with any existing deep links.
  const queryInvolvingUserId = searchParams?.get("involving_user_id") ?? null;
  const queryTargetUserId = searchParams?.get("target_user_id") ?? null;
  const scopedUserId = queryInvolvingUserId ?? queryTargetUserId;
  const [preset, setPreset] = useState<string>("all");
  // Free-text fields stay as the "advanced" tier of the filter — when
  // a preset is active they're ignored on the server side (server
  // honours `action` over `actions`), so the UI hides them behind a
  // toggle to avoid the appearance of dead inputs.
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [page, setPage] = useState(1);

  // Resolve the active preset → backend params. Empty preset = no
  // category filter; advanced single-action `action` value (if any)
  // takes precedence so the back-compat path still works.
  const activePreset = PRESETS.find((p) => p.id === preset);
  const presetActions =
    !action && activePreset?.actions && activePreset.actions.length > 0
      ? activePreset.actions.join(",")
      : undefined;
  const presetEntityTypes =
    !entityType && activePreset?.entity_types && activePreset.entity_types.length > 0
      ? activePreset.entity_types.join(",")
      : undefined;

  function selectPreset(id: string) {
    setPreset(id);
    setPage(1);
  }

  const { data: scopedUser } = useQuery({
    queryKey: ["admin", "user", scopedUserId],
    queryFn: () => UsersAPI.detail(scopedUserId!),
    enabled: !!scopedUserId,
    staleTime: 5 * 60_000,
  });

  const { data, isFetching } = useQuery({
    queryKey: [
      "admin",
      "audit",
      {
        preset,
        action,
        entityType,
        fromDate,
        toDate,
        page,
        queryInvolvingUserId,
        queryTargetUserId,
      },
    ],
    queryFn: () =>
      SettingsAPI.audit({
        action: action || undefined,
        actions: presetActions,
        entity_type: entityType || undefined,
        entity_types: presetEntityTypes,
        from_date: fromDate ? new Date(fromDate).toISOString() : undefined,
        to_date: toDate
          ? new Date(`${toDate}T23:59:59.999`).toISOString()
          : undefined,
        involving_user_id: queryInvolvingUserId || undefined,
        target_user_id: queryTargetUserId || undefined,
        page,
        page_size: 50,
      }),
  });

  const cols: Column<any>[] = [
    { key: "created_at", header: "When", render: (r) => new Date(r.created_at).toLocaleString() },
    { key: "action", header: "Action", render: (r) => <StatusPill status={r.action} /> },
    { key: "entity_type", header: "Entity" },
    { key: "entity_id", header: "ID", render: (r) => <span className="font-mono text-[11px]">{r.entity_id?.slice(-12) || "—"}</span> },
    {
      // Actor — the user who initiated the action. Backend now ships
      // an `actor` object with `name` + `code` + `role`, so render the
      // friendly name with the user_code on a muted second line
      // instead of the last-8-of-ObjectId blob that used to be there.
      key: "actor",
      header: "Actor",
      render: (r) => <UserCell info={r.actor} fallback="system" />,
    },
    {
      // Target — who the action was performed on. Same enrichment as
      // Actor. Many rows have actor == target (e.g. user logs in:
      // actor=user, target=user) which is fine — both cells render
      // the same name.
      key: "target",
      header: "Target",
      render: (r) => <UserCell info={r.target} fallback="—" />,
    },
    {
      key: "metadata",
      header: "Detail",
      className: "max-w-[300px] truncate",
      render: (r) => <code className="text-[10px]">{JSON.stringify(r.metadata)}</code>,
    },
    {
      key: "ip_address",
      header: "IP",
      render: (r) => (
        <span className="font-tabular text-[11px]" title={r.ip_address ?? ""}>
          {r.ip_address || "—"}
        </span>
      ),
    },
    {
      key: "user_agent",
      header: "Device",
      render: (r) => (
        <span
          className="text-[11px]"
          // Full UA available on hover/long-press for the curious.
          title={r.user_agent ?? ""}
        >
          {shortDevice(r.user_agent)}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Audit logs" description={`${data?.meta?.total ?? 0} events`} />

      {scopedUserId && (
        <div className="inline-flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs">
          <span className="text-muted-foreground">
            {queryInvolvingUserId ? "Filtered by user (actor or target):" : "Filtered by target user:"}
          </span>
          <span className="font-semibold text-primary">
            {(scopedUser as any)?.user_code ?? scopedUserId.slice(-8)}
            {(scopedUser as any)?.full_name ? ` · ${(scopedUser as any).full_name}` : ""}
          </span>
          <Link
            href="/audit"
            className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            aria-label="Clear user filter"
          >
            <XIcon className="size-3" />
          </Link>
        </div>
      )}

      {/* Preset filter chips — each chip maps to a backend
          `actions=...` + `entity_types=...` combo so the operator
          picks "Edit trade" / "Reopen" / "Deposit" / etc. without
          having to remember enum names. The "All" chip clears
          everything to the unfiltered view. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => selectPreset(p.id)}
            className={
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors " +
              (preset === p.id
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background text-muted-foreground hover:bg-muted/40 hover:text-foreground")
            }
          >
            {p.label}
          </button>
        ))}
        <span className="mx-1 hidden h-6 w-px bg-border sm:inline-block" />
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="rounded-full border border-dashed border-border bg-background px-3 py-1 text-[11px] text-muted-foreground hover:bg-muted/40"
        >
          {showAdvanced ? "Hide advanced" : "Advanced"}
        </button>
      </div>

      {/* Date range — always visible since it's a common filter for
          "today's events" / "yesterday only" investigations. Inputs
          are HTML5 date pickers so no extra dep is needed. Empty
          either bound = open-ended. */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <label className="block text-[10px] uppercase tracking-wider text-muted-foreground">
            From
          </label>
          <Input
            type="date"
            value={fromDate}
            onChange={(e) => {
              setPage(1);
              setFromDate(e.target.value);
            }}
            className="h-9 w-[150px]"
          />
        </div>
        <div className="space-y-1">
          <label className="block text-[10px] uppercase tracking-wider text-muted-foreground">
            To
          </label>
          <Input
            type="date"
            value={toDate}
            onChange={(e) => {
              setPage(1);
              setToDate(e.target.value);
            }}
            className="h-9 w-[150px]"
          />
        </div>
        {(fromDate || toDate) && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setFromDate("");
              setToDate("");
              setPage(1);
            }}
            className="h-9"
          >
            <XIcon className="size-3" /> Clear dates
          </Button>
        )}
      </div>

      {/* Advanced free-text filters — hidden by default to keep the
          chip row clean. When a preset is active these inputs take
          precedence on the backend (single `action` beats `actions`
          CSV) so the operator can drill into a specific action code
          that the chip set doesn't cover. */}
      {showAdvanced && (
        <div className="flex flex-wrap gap-2">
          <Input
            value={action}
            onChange={(e) => {
              setPage(1);
              setAction(e.target.value);
            }}
            placeholder="Action code (e.g. ORDER_PLACE)"
            className="h-9 max-w-xs"
          />
          <Input
            value={entityType}
            onChange={(e) => {
              setPage(1);
              setEntityType(e.target.value);
            }}
            placeholder="Entity type (e.g. User)"
            className="h-9 max-w-xs"
          />
        </div>
      )}

      <DataTable columns={cols} rows={data?.items} keyExtractor={(r) => r.id} loading={isFetching && !data} />

      {(data?.meta?.total_pages ?? 1) > 1 && (
        <div className="flex justify-end gap-2 text-xs">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Prev
          </Button>
          <span className="self-center text-muted-foreground">
            {page} / {data?.meta?.total_pages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= (data?.meta?.total_pages ?? 1)}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
