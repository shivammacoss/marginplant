"use client";

import type {
  AdminPermissions,
  AdminUser,
  BrokerPermissions,
  PermissionLevel,
} from "@/types";

// Union of every section key the sidebar / pages might gate on. Admin
// uses the AdminPermissions subset; broker uses BrokerPermissions (which
// includes `sub_brokers`).
export type PermissionKey =
  | keyof AdminPermissions
  | keyof BrokerPermissions;

const LEVEL_ORDER: Record<PermissionLevel, number> = {
  OFF: 0,
  VIEW: 1,
  EDIT: 2,
};

function atLeast(actual: PermissionLevel, required: PermissionLevel): boolean {
  return LEVEL_ORDER[actual] >= LEVEL_ORDER[required];
}

// True when the current admin may see / use a section at the requested
// minimum level. SUPER_ADMIN always returns true. ADMIN's permissions
// are boolean → treated as EDIT when true and OFF when false. BROKER's
// permissions are tri-state and compared directly.
export function canSee(
  admin: AdminUser | null | undefined,
  perm: PermissionKey,
  minLevel: PermissionLevel = "VIEW",
): boolean {
  if (!admin) return false;
  if (admin.role === "SUPER_ADMIN") return true;
  if (admin.role === "ADMIN") {
    const ap = admin.admin_permissions;
    if (!ap) return false;
    // `brokers` and other admin keys are boolean. Admin doesn't have
    // `sub_brokers` — treat that as not granted.
    const v = (ap as any)[perm];
    if (typeof v !== "boolean") return false;
    // Boolean → EDIT when true (admin always has full edit on what they have)
    return v ? atLeast("EDIT", minLevel) : false;
  }
  if (admin.role === "BROKER") {
    const bp = admin.broker_permissions;
    if (!bp) return false;
    const v = (bp as any)[perm] as PermissionLevel | undefined;
    if (!v) return false;
    return atLeast(v, minLevel);
  }
  return false;
}

// Convenience — true only when the actor can write (EDIT) on the section.
// Use this on mutation buttons (Approve, Reject, Save, Block, Delete, …)
// to flip them to disabled with a tooltip when VIEW-only.
export function canEdit(
  admin: AdminUser | null | undefined,
  perm: PermissionKey,
): boolean {
  return canSee(admin, perm, "EDIT");
}

export function isSuperAdmin(admin: AdminUser | null | undefined): boolean {
  return admin?.role === "SUPER_ADMIN";
}

export function isAdmin(admin: AdminUser | null | undefined): boolean {
  return admin?.role === "ADMIN";
}

export function isBroker(admin: AdminUser | null | undefined): boolean {
  return admin?.role === "BROKER";
}
