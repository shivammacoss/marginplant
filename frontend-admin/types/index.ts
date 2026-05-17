export type AdminRole = "SUPER_ADMIN" | "ADMIN" | "BROKER";

// Section toggles that gate the admin sidebar for sub-admins. SUPER_ADMIN
// ignores these and always sees every section. Field names must match
// backend `AdminPermissions` (app/models/user.py) exactly.
export interface AdminPermissions {
  users: boolean;
  kyc: boolean;
  deposits: boolean;
  withdrawals: boolean;
  segment_settings: boolean;
  risk: boolean;
  netting: boolean;
  trading_view: boolean;
  ledger: boolean;
  reports: boolean;
  brokerage: boolean;
  // Gates access to the broker management page. Super-admin always has it;
  // admin only if super-admin granted it.
  brokers: boolean;
  // Gates the Bank Accounts tab on the Payments page.
  banks: boolean;
}

// Tri-state permission level (admin → broker grant, or broker → sub-broker).
// Sub-admin permissions (super-admin → admin grant) stay boolean and use
// AdminPermissions above — only the broker tier uses this enum.
export type PermissionLevel = "OFF" | "VIEW" | "EDIT";

// Section toggles for brokers — same keys as AdminPermissions plus the
// `sub_brokers` key that gates broker → sub-broker creation. Mirrors backend
// `BrokerPermissions` (app/models/user.py).
export interface BrokerPermissions {
  users: PermissionLevel;
  kyc: PermissionLevel;
  deposits: PermissionLevel;
  withdrawals: PermissionLevel;
  segment_settings: PermissionLevel;
  risk: PermissionLevel;
  netting: PermissionLevel;
  trading_view: PermissionLevel;
  ledger: PermissionLevel;
  reports: PermissionLevel;
  brokerage: PermissionLevel;
  sub_brokers: PermissionLevel;
  // VIEW = see existing banks in own pool; EDIT = add / update / delete.
  banks: PermissionLevel;
}

export interface AdminUser {
  id: string;
  user_code: string;
  email: string;
  full_name: string;
  role: AdminRole;
  last_login_at: string | null;
  // Populated only for role === "ADMIN" (sub-admins). null/undefined for super-admin.
  admin_permissions?: AdminPermissions | null;
  pnl_share_pct?: string | null;
  // Populated only for role === "BROKER".
  broker_permissions?: BrokerPermissions | null;
  // When role === "BROKER" and this is set, the broker was created under
  // another broker — i.e., they're a sub-broker. UI flips the role chip.
  assigned_broker_id?: string | null;
}

export interface AdminTokenPair {
  access_token: string;
  refresh_token: string;
  token_type: "bearer";
  expires_in: number;
  admin: AdminUser;
}

export interface ApiResponse<T> {
  success: boolean;
  data: T | null;
  message?: string | null;
}
export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}
