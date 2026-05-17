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

function AuditLogsInner() {
  const searchParams = useSearchParams();
  // `involving_user_id` is the new "events involving this user as actor
  // OR target" filter — used by the user-detail Activity link so admin
  // sees user-initiated events too. `target_user_id` kept for backward
  // compat with any existing deep links.
  const queryInvolvingUserId = searchParams?.get("involving_user_id") ?? null;
  const queryTargetUserId = searchParams?.get("target_user_id") ?? null;
  const scopedUserId = queryInvolvingUserId ?? queryTargetUserId;
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");
  const [page, setPage] = useState(1);

  const { data: scopedUser } = useQuery({
    queryKey: ["admin", "user", scopedUserId],
    queryFn: () => UsersAPI.detail(scopedUserId!),
    enabled: !!scopedUserId,
    staleTime: 5 * 60_000,
  });

  const { data, isFetching } = useQuery({
    queryKey: ["admin", "audit", { action, entityType, page, queryInvolvingUserId, queryTargetUserId }],
    queryFn: () =>
      SettingsAPI.audit({
        action: action || undefined,
        entity_type: entityType || undefined,
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
    { key: "user_id", header: "Actor", render: (r) => (r.user_id ? r.user_id.slice(-8) : "system") },
    { key: "target_user_id", header: "Target", render: (r) => (r.target_user_id ? r.target_user_id.slice(-8) : "—") },
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

      <div className="flex flex-wrap gap-2">
        <Input
          value={action}
          onChange={(e) => {
            setPage(1);
            setAction(e.target.value);
          }}
          placeholder="Filter action (e.g. APPROVE)"
          className="h-10 max-w-xs"
        />
        <Input
          value={entityType}
          onChange={(e) => {
            setPage(1);
            setEntityType(e.target.value);
          }}
          placeholder="Filter entity type (e.g. User)"
          className="h-10 max-w-xs"
        />
      </div>

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
