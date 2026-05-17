"use client";

import type { AdminUser } from "@/types";

type Row = {
  assigned_admin_id?: string | null;
  assigned_admin_name?: string | null;
  assigned_broker_id?: string | null;
  assigned_broker_name?: string | null;
  // True when assigned_broker is itself a sub-broker (sits under another
  // broker). Drives the chip label "Sub-broker: <name>" vs. "Broker: <name>".
  assigned_broker_is_sub?: boolean | null;
};

/** Compact pill used in admin tables (Users / Deposits / Withdrawals /
 * Positions) to label each row as "Self" or "Broker: <name>" — and for
 * super-admin viewing, also "Admin: <name>".
 *
 * Self = the row belongs directly to the viewing admin's pool (no broker
 * in between). Broker = the row's user is in some broker's subtree; we
 * show the broker name so the admin can tell at a glance whose user it is.
 */
export function OwnerBadge({
  row,
  me,
}: {
  row: Row;
  me: AdminUser | null | undefined;
}) {
  if (row.assigned_broker_id) {
    const label = row.assigned_broker_name || `…${row.assigned_broker_id.slice(-6)}`;
    // Sub-broker chips use a slightly different tint so admins can tell
    // at a glance which rows came through a nested broker vs. a top-level one.
    const isSub = !!row.assigned_broker_is_sub;
    const cls = isSub
      ? "bg-indigo-500/10 text-indigo-400 ring-indigo-500/30"
      : "bg-blue-500/10 text-blue-400 ring-blue-500/30";
    return (
      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${cls}`}>
        <span className="text-[10px] uppercase tracking-wide opacity-70">
          {isSub ? "Sub-broker" : "Broker"}
        </span>
        <span>{label}</span>
      </span>
    );
  }
  // No broker. If a super-admin is viewing and the row belongs to a sub-admin,
  // surface that too. For sub-admin viewing their own pool the row is "Self".
  if (me?.role === "SUPER_ADMIN" && row.assigned_admin_id) {
    const label = row.assigned_admin_name || `…${row.assigned_admin_id.slice(-6)}`;
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-400 ring-1 ring-inset ring-amber-500/30">
        <span className="text-[10px] uppercase tracking-wide opacity-70">Admin</span>
        <span>{label}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400 ring-1 ring-inset ring-emerald-500/30">
      Self
    </span>
  );
}
