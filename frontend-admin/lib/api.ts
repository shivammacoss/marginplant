"use client";

import axios, { AxiosError, AxiosRequestConfig, InternalAxiosRequestConfig } from "axios";
import { ADMIN_API_KEY, API_URL, STORAGE_KEYS } from "./constants";
import type { AdminTokenPair, ApiResponse } from "@/types";

export const api = axios.create({
  baseURL: `${API_URL}/api/v1`,
  withCredentials: false,
  timeout: 30_000,
});

let refreshPromise: Promise<string | null> | null = null;

function getAccessToken() {
  return typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEYS.accessToken) : null;
}
function getRefreshToken() {
  return typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEYS.refreshToken) : null;
}
export function setTokens(access: string, refresh: string) {
  window.localStorage.setItem(STORAGE_KEYS.accessToken, access);
  window.localStorage.setItem(STORAGE_KEYS.refreshToken, refresh);
}
export function clearTokens() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEYS.accessToken);
  window.localStorage.removeItem(STORAGE_KEYS.refreshToken);
  window.localStorage.removeItem(STORAGE_KEYS.user);
}

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  if (config.headers) {
    if (ADMIN_API_KEY) config.headers["X-Admin-Api-Key"] = ADMIN_API_KEY;
    const tok = getAccessToken();
    if (tok) config.headers.Authorization = `Bearer ${tok}`;
  }
  return config;
});

async function refreshAccessToken(): Promise<string | null> {
  const refresh = getRefreshToken();
  if (!refresh) return null;
  try {
    const headers: Record<string, string> = {};
    if (ADMIN_API_KEY) headers["X-Admin-Api-Key"] = ADMIN_API_KEY;
    const r = await axios.post<ApiResponse<AdminTokenPair>>(
      `${API_URL}/api/v1/admin/auth/refresh`,
      { refresh_token: refresh },
      { headers, timeout: 15_000 }
    );
    const pair = r.data.data;
    if (!pair) return null;
    setTokens(pair.access_token, pair.refresh_token);
    return pair.access_token;
  } catch {
    clearTokens();
    return null;
  }
}

api.interceptors.response.use(
  (resp) => resp,
  async (error: AxiosError) => {
    const original = error.config as (AxiosRequestConfig & { _retry?: boolean }) | undefined;
    const status = error.response?.status;
    if (status === 401 && original && !original._retry) {
      original._retry = true;
      refreshPromise ||= refreshAccessToken().finally(() => {
        refreshPromise = null;
      });
      const newToken = await refreshPromise;
      if (newToken) {
        original.headers = { ...(original.headers || {}), Authorization: `Bearer ${newToken}` };
        return api.request(original);
      }
      if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
        window.location.href = "/login";
      }
    }
    return Promise.reject(error);
  }
);

export class ApiError extends Error {
  code: string;
  details?: Record<string, unknown>;
  constructor(message: string, code: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "ApiError";
  }
}

export async function unwrap<T>(p: Promise<{ data: ApiResponse<T> }>): Promise<T> {
  try {
    const res = await p;
    if (!res.data?.success || res.data.data == null) {
      throw new ApiError(res.data?.message || "Unknown error", "UNKNOWN");
    }
    return res.data.data as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const ax = err as AxiosError<{ error?: { code?: string; message?: string; details?: Record<string, unknown> } }>;
    const e = ax.response?.data?.error;
    throw new ApiError(e?.message || ax.message || "Network error", e?.code || "NETWORK", e?.details);
  }
}

export const AdminAuthAPI = {
  login: (body: { identifier: string; password: string; two_fa_code?: string }) =>
    unwrap<AdminTokenPair>(api.post("/admin/auth/login", body)),
  refresh: (refresh_token: string) => unwrap<AdminTokenPair>(api.post("/admin/auth/refresh", { refresh_token })),
  logout: (refresh_token?: string) => unwrap<any>(api.post("/admin/auth/logout", { refresh_token })),
  me: () => unwrap<any>(api.get("/admin/auth/me")),
};

export const DashboardAPI = {
  stats: () => unwrap<any>(api.get("/admin/dashboard/stats")),
  riskAlerts: () => unwrap<any[]>(api.get("/admin/dashboard/risk-alerts")),
};

export const UsersAPI = {
  list: (params?: any) => unwrap<{ items: any[]; meta: any }>(api.get("/admin/users", { params })),
  detail: (id: string) => unwrap<any>(api.get(`/admin/users/${id}`)),
  create: (body: any) => unwrap<any>(api.post("/admin/users", body)),
  update: (id: string, body: any) => unwrap<any>(api.put(`/admin/users/${id}`, body)),
  block: (id: string, reason?: string) => unwrap<any>(api.post(`/admin/users/${id}/block`, { reason })),
  unblock: (id: string) => unwrap<any>(api.post(`/admin/users/${id}/unblock`)),
  resetPassword: (id: string, new_password: string) =>
    unwrap<any>(api.post(`/admin/users/${id}/reset-password`, { new_password })),
  walletAdjust: (id: string, body: { amount: number; narration: string; transaction_type?: string }) =>
    unwrap<any>(api.post(`/admin/users/${id}/wallet-adjust`, body)),
  creditLimit: (id: string, body: { delta: number; narration: string }) =>
    api.patch(`/admin/users/${id}/credit-limit`, body).then((r) => r.data?.data ?? r.data),
  killSwitch: (id: string, reason?: string) =>
    api.post(`/admin/users/${id}/kill-switch`, { reason }).then((r) => r.data?.data ?? r.data),
  impersonate: (id: string) =>
    api.post(`/admin/users/${id}/impersonate`).then((r) => r.data?.data ?? r.data),
  delete: (id: string) => unwrap<any>(api.delete(`/admin/users/${id}`)),
  liveTradeStats: (id: string) =>
    unwrap<any>(api.get(`/admin/users/${id}/live-trade-stats`)),
};

export const RiskAPI = {
  getGlobal: () => unwrap<any>(api.get("/admin/risk/global")),
  updateGlobal: (patch: any) => unwrap<any>(api.put("/admin/risk/global", { patch })),
  getUser: (userId: string) => unwrap<any>(api.get(`/admin/risk/user/${userId}`)),
  upsertUser: (userId: string, patch: any) =>
    unwrap<any>(api.put(`/admin/risk/user/${userId}`, { patch })),
  deleteUser: (userId: string) => unwrap<any>(api.delete(`/admin/risk/user/${userId}`)),
  copyFromUser: (userId: string, sourceUserId: string) =>
    unwrap<any>(api.post(`/admin/risk/user/${userId}/copy-from/${sourceUserId}`)),
  effective: (userId: string) => unwrap<any>(api.get(`/admin/risk/user/${userId}/effective`)),
  usersWithOverrides: () => unwrap<any[]>(api.get("/admin/risk/users-with-overrides")),
};

export const NettingAPI = {
  segments: () => unwrap<any[]>(api.get("/admin/netting/segments")),
  getSegment: (id: string) => unwrap<any>(api.get(`/admin/netting/segments/${id}`)),
  updateSegment: (id: string, patch: any) =>
    unwrap<any>(api.put(`/admin/netting/segments/${id}`, { patch })),
  scripts: (segment?: string) =>
    unwrap<any[]>(api.get("/admin/netting/scripts", { params: segment ? { segment } : {} })),
  createScript: (body: any) => unwrap<any>(api.post("/admin/netting/scripts", body)),
  updateScript: (id: string, patch: any) =>
    unwrap<any>(api.put(`/admin/netting/scripts/${id}`, { patch })),
  deleteScript: (id: string) => unwrap<any>(api.delete(`/admin/netting/scripts/${id}`)),
  userOverrides: (userId: string) => unwrap<any[]>(api.get(`/admin/netting/user/${userId}`)),
  upsertUserOverride: (userId: string, segmentName: string, patch: any, symbol?: string) =>
    unwrap<any>(
      api.put(`/admin/netting/user/${userId}/${segmentName}`, { patch }, { params: symbol ? { symbol } : {} })
    ),
  deleteUserOverride: (userId: string, segmentName: string, symbol?: string) =>
    unwrap<any>(
      api.delete(`/admin/netting/user/${userId}/${segmentName}`, { params: symbol ? { symbol } : {} })
    ),
  copy: (body: { source_user_id: string; target_user_ids: string[]; overwrite?: boolean }) =>
    unwrap<any>(api.post("/admin/netting/copy", body)),
  usersWithOverrides: () => unwrap<any[]>(api.get("/admin/netting/users-with-overrides")),
};

export const TradingAPI = {
  orders: (params?: any) => unwrap<{ items: any[]; meta: any }>(api.get("/admin/orders", { params })),
  forceCancel: (id: string) => unwrap<any>(api.delete(`/admin/orders/${id}`)),
  positions: (params?: any) => unwrap<any[]>(api.get("/admin/positions", { params })),
  orderQuotes: (tokens: string[]) =>
    unwrap<any[]>(api.get("/admin/orders/quotes", { params: { tokens: tokens.join(",") } })),
  squareoff: (id: string) => unwrap<any>(api.post(`/admin/positions/${id}/squareoff`)),
  deletePosition: (id: string) => unwrap<any>(api.delete(`/admin/positions/${id}`)),
  pnlSummary: () => unwrap<any>(api.get("/admin/positions/pnl-summary")),
  emergencySquareoffAll: () => unwrap<any>(api.post("/admin/positions/emergency-squareoff")),
  editPosition: (
    id: string,
    body: Partial<{
      avg_price: number | string;
      quantity: number;
      opened_at: string;
      stop_loss: number | string | null;
      target: number | string | null;
    }>,
  ) => unwrap<any>(api.patch(`/admin/positions/${id}`, body)),
  trades: (params?: any) => unwrap<any[]>(api.get("/admin/trades", { params })),
  holdings: (params?: any) => unwrap<any[]>(api.get("/admin/holdings", { params })),
};

export const PayinOutAPI = {
  deposits: (status?: string) => unwrap<any[]>(api.get("/admin/deposits", { params: { status } })),
  approveDeposit: (id: string, admin_remark?: string) =>
    unwrap<any>(api.post(`/admin/deposits/${id}/approve`, { admin_remark })),
  rejectDeposit: (id: string, admin_remark: string) =>
    unwrap<any>(api.post(`/admin/deposits/${id}/reject`, { admin_remark })),
  withdrawals: (status?: string) => unwrap<any[]>(api.get("/admin/withdrawals", { params: { status } })),
  approveWithdrawal: (id: string, body: any) => unwrap<any>(api.post(`/admin/withdrawals/${id}/approve`, body)),
  rejectWithdrawal: (id: string, rejection_reason: string) =>
    unwrap<any>(api.post(`/admin/withdrawals/${id}/reject`, { rejection_reason })),
  bankAccounts: () => unwrap<any[]>(api.get("/admin/bank-accounts")),
  createBank: (body: any) => unwrap<any>(api.post("/admin/bank-accounts", body)),
  updateBank: (id: string, body: any) => unwrap<any>(api.put(`/admin/bank-accounts/${id}`, body)),
  deleteBank: (id: string) => unwrap<any>(api.delete(`/admin/bank-accounts/${id}`)),
  wdRules: () => unwrap<any[]>(api.get("/admin/wd-rules")),
  updateWdRule: (rule_type: string, body: any) => unwrap<any>(api.put(`/admin/wd-rules/${rule_type}`, body)),
};

export const InstrumentAdminAPI = {
  list: (params?: any) => unwrap<{ items: any[]; meta: any }>(api.get("/admin/instruments", { params })),
  create: (body: any) => unwrap<any>(api.post("/admin/instruments", body)),
  update: (id: string, body: any) => unwrap<any>(api.put(`/admin/instruments/${id}`, body)),
  halt: (id: string, reason?: string) => unwrap<any>(api.post(`/admin/instruments/${id}/halt`, { reason })),
  resume: (id: string) => unwrap<any>(api.post(`/admin/instruments/${id}/resume`)),
  delete: (id: string) => unwrap<any>(api.delete(`/admin/instruments/${id}`)),
  // Deduped underlyings for the script-override typeahead. Each result
  // is just the underlying name (NIFTY, BANKNIFTY, …); the picker
  // appends `FUT` / `CE` / `PE` to form the pattern that the resolver
  // applies to every contract of that underlying.
  underlyings: (params: { exchange: string; contract_type?: "FUT" | "CE" | "PE"; q?: string; limit?: number }) =>
    unwrap<string[]>(api.get("/admin/instruments/underlyings", { params })),
};

export const BrokerageAPI = {
  list: () => unwrap<any[]>(api.get("/admin/brokerage/plans")),
  create: (body: any) => unwrap<any>(api.post("/admin/brokerage/plans", body)),
  update: (id: string, body: any) => unwrap<any>(api.put(`/admin/brokerage/plans/${id}`, body)),
  delete: (id: string) => unwrap<any>(api.delete(`/admin/brokerage/plans/${id}`)),
};

export const KycAPI = {
  list: (status?: string) =>
    unwrap<any[]>(api.get("/admin/kyc", { params: status ? { status } : {} })),
  detail: (id: string) => unwrap<any>(api.get(`/admin/kyc/${id}`)),
  approve: (id: string, admin_remark?: string) =>
    unwrap<any>(api.post(`/admin/kyc/${id}/approve`, { admin_remark })),
  reject: (id: string, rejection_reason: string, admin_remark?: string) =>
    unwrap<any>(api.post(`/admin/kyc/${id}/reject`, { rejection_reason, admin_remark })),
};

export const LedgerAdminAPI = {
  list: (params?: any) => unwrap<{ items: any[]; meta: any }>(api.get("/admin/ledger", { params })),
  manualEntry: (body: any) => unwrap<any>(api.post("/admin/ledger/manual-entry", body)),
};

export const ReportsAdminAPI = {
  users: () => unwrap<any>(api.get("/admin/reports/users")),
  financial: () => unwrap<any>(api.get("/admin/reports/financial")),
  trades: () => unwrap<any>(api.get("/admin/reports/trades")),
  compliance: () => unwrap<any>(api.get("/admin/reports/compliance")),
};

export const ZerodhaAPI = {
  status: () =>
    api.get("/admin/zerodha/status").then((r) => (r.data?.status ?? r.data)),
  settings: () =>
    api.get("/admin/zerodha/settings").then((r) => (r.data?.settings ?? r.data)),
  saveSettings: (body: any) =>
    api.post("/admin/zerodha/settings", body).then((r) => r.data),
  loginUrl: () =>
    api.get("/admin/zerodha/login-url").then((r) => r.data?.loginUrl as string),
  logout: () => api.post("/admin/zerodha/logout").then((r) => r.data),
  connectWs: () => api.post("/admin/zerodha/connect-ws").then((r) => r.data),
  disconnectWs: () => api.post("/admin/zerodha/disconnect-ws").then((r) => r.data),
  searchInstruments: (query: string, segment?: string) =>
    api
      .get("/admin/zerodha/instruments/search", { params: { query, segment } })
      .then((r) => (r.data?.instruments ?? []) as any[]),
  subscribe: (instrument: any) =>
    api.post("/admin/zerodha/instruments/subscribe", { instrument }).then((r) => r.data),
  subscribeBulk: (instruments: any[]) =>
    api.post("/admin/zerodha/instruments/subscribe-bulk", { instruments }).then((r) => r.data),
  unsubscribe: (token: number) =>
    api.delete(`/admin/zerodha/instruments/${token}`).then((r) => r.data),
  syncInstruments: () =>
    api.post("/admin/zerodha/instruments/sync").then((r) => r.data),
  clearInstruments: () =>
    api.post("/admin/zerodha/instruments/clear").then((r) => r.data),
  listForExchange: (exchange: string) =>
    api
      .get(`/admin/zerodha/instruments/exchange/${encodeURIComponent(exchange)}`)
      .then((r) => (r.data?.instruments ?? []) as any[]),
  listSubscribed: () =>
    api
      .get("/admin/zerodha/instruments/subscribed")
      .then((r) => (r.data?.instruments ?? []) as any[]),
  connectWithToken: (request_token: string) =>
    api
      .post("/admin/zerodha/connect-with-token", { request_token })
      .then((r) => r.data),
  debugCsv: (exchange = "NFO") =>
    api
      .get("/admin/zerodha/debug-csv", { params: { exchange } })
      .then((r) => r.data),
  diagnose: () =>
    api
      .get("/admin/zerodha/diagnose")
      .then((r) => r.data?.report ?? r.data),
};

export const BrokerMgmtAPI = {
  // Cap — drives the create/edit form so OFF/VIEW/EDIT radio options
  // above the actor's own level are greyed out.
  maxGrantable: () =>
    unwrap<{ cap: Record<string, "OFF" | "VIEW" | "EDIT"> }>(
      api.get("/admin/management/brokers/max-grantable"),
    ),

  // Broker CRUD (admin/super-admin creates; broker can create sub-broker
  // when broker_permissions.sub_brokers == EDIT)
  list: (params?: { q?: string; status?: string; page?: number; page_size?: number }) =>
    unwrap<{ items: any[]; meta: any }>(api.get("/admin/management/brokers", { params })),
  get: (id: string) => unwrap<any>(api.get(`/admin/management/brokers/${id}`)),
  create: (body: {
    full_name: string;
    email: string;
    mobile: string;
    password: string;
    permissions: Record<string, "OFF" | "VIEW" | "EDIT">;
    pnl_share_pct: number | string;
  }) => unwrap<any>(api.post("/admin/management/brokers", body)),
  update: (id: string, body: { full_name?: string }) =>
    unwrap<any>(api.put(`/admin/management/brokers/${id}`, body)),
  updatePermissions: (id: string, permissions: Record<string, "OFF" | "VIEW" | "EDIT">) =>
    unwrap<{ broker: any; cascaded_changes: any[] }>(
      api.put(`/admin/management/brokers/${id}/permissions`, { permissions }),
    ),
  updatePnlShare: (id: string, pct: number | string) =>
    unwrap<any>(api.put(`/admin/management/brokers/${id}/pnl-share`, { pct })),
  block: (id: string) => unwrap<any>(api.post(`/admin/management/brokers/${id}/block`)),
  unblock: (id: string) => unwrap<any>(api.post(`/admin/management/brokers/${id}/unblock`)),

  // Subtree clients (every CLIENT/DEALER/MASTER under this broker)
  listSubtreeUsers: (id: string, params?: { page?: number; page_size?: number }) =>
    unwrap<{ items: any[]; meta: any }>(
      api.get(`/admin/management/brokers/${id}/users`, { params }),
    ),

  // Reassignment
  assignUser: (userId: string, broker_id: string | null) =>
    unwrap<any>(api.post(`/admin/management/users/${userId}/assign-to-broker`, { broker_id })),
  bulkAssign: (user_ids: string[], broker_id: string | null) =>
    unwrap<any>(api.post("/admin/management/users/bulk-assign-to-broker", { user_ids, broker_id })),

  // Detail-page aggregator
  report: (id: string) =>
    unwrap<any>(api.get(`/admin/management/brokers/${id}/report`)),

  // Login-as — same shape as ManagementAPI.impersonateSubAdmin
  impersonate: (id: string) =>
    api
      .post(`/admin/management/brokers/${id}/impersonate`)
      .then((r) => r.data?.data ?? r.data),

  // Settlements (admin reconciliation surface — broker doesn't see this)
  listSettlements: (week_start?: string) =>
    unwrap<{
      period_start: string;
      period_end: string;
      items: any[];
      totals: { user_count: number; net_house_pnl_inr: string; broker_share_inr: string };
    }>(api.get("/admin/management/broker-settlements", { params: week_start ? { week_start } : {} })),
  historyForBroker: (id: string, params?: { from_date?: string; to_date?: string }) =>
    unwrap<{ broker: any; items: any[] }>(
      api.get(`/admin/management/broker-settlements/broker/${id}`, { params }),
    ),
  recomputeSettlements: (body: { week_start: string; broker_id?: string }) =>
    unwrap<{ items: any[]; frozen_skipped: number }>(
      api.post("/admin/management/broker-settlements/recompute", body),
    ),
  finalizeSettlement: (id: string) =>
    unwrap<any>(api.post(`/admin/management/broker-settlements/${id}/finalize`)),
  markPaid: (id: string, notes?: string) =>
    unwrap<any>(api.post(`/admin/management/broker-settlements/${id}/mark-paid`, { notes })),
};

export const ManagementAPI = {
  // Sub-admins
  listSubAdmins: (params?: { q?: string; status?: string; page?: number; page_size?: number }) =>
    unwrap<{ items: any[]; meta: any }>(api.get("/admin/management/sub-admins", { params })),
  getSubAdmin: (id: string) => unwrap<any>(api.get(`/admin/management/sub-admins/${id}`)),
  createSubAdmin: (body: {
    full_name: string;
    email: string;
    mobile: string;
    password: string;
    permissions: Record<string, boolean>;
    pnl_share_pct: number | string;
  }) => unwrap<any>(api.post("/admin/management/sub-admins", body)),
  updateSubAdmin: (id: string, body: { full_name?: string }) =>
    unwrap<any>(api.put(`/admin/management/sub-admins/${id}`, body)),
  updatePermissions: (id: string, permissions: Record<string, boolean>) =>
    unwrap<any>(api.put(`/admin/management/sub-admins/${id}/permissions`, { permissions })),
  updatePnlShare: (id: string, pct: number | string) =>
    unwrap<any>(api.put(`/admin/management/sub-admins/${id}/pnl-share`, { pct })),
  blockSubAdmin: (id: string) =>
    unwrap<any>(api.post(`/admin/management/sub-admins/${id}/block`)),
  unblockSubAdmin: (id: string) =>
    unwrap<any>(api.post(`/admin/management/sub-admins/${id}/unblock`)),
  listAssignedUsers: (id: string, params?: { page?: number; page_size?: number }) =>
    unwrap<{ items: any[]; meta: any }>(
      api.get(`/admin/management/sub-admins/${id}/users`, { params })
    ),
  // User reassignment
  assignUser: (userId: string, sub_admin_id: string | null) =>
    unwrap<any>(api.post(`/admin/management/users/${userId}/assign`, { sub_admin_id })),
  bulkAssign: (user_ids: string[], sub_admin_id: string | null) =>
    unwrap<any>(api.post("/admin/management/users/bulk-assign", { user_ids, sub_admin_id })),
  // Settlements
  listSettlements: (week_start?: string) =>
    unwrap<{
      period_start: string;
      period_end: string;
      items: any[];
      totals: { user_count: number; net_house_pnl_inr: string; sub_admin_share_inr: string };
    }>(api.get("/admin/management/settlements", { params: week_start ? { week_start } : {} })),
  historyForSubAdmin: (id: string, params?: { from_date?: string; to_date?: string }) =>
    unwrap<{ sub_admin: any; items: any[] }>(
      api.get(`/admin/management/settlements/sub-admin/${id}`, { params })
    ),
  recomputeSettlements: (body: { week_start: string; sub_admin_id?: string }) =>
    unwrap<{ items: any[]; frozen_skipped: number }>(
      api.post("/admin/management/settlements/recompute", body)
    ),
  finalizeSettlement: (id: string) =>
    unwrap<any>(api.post(`/admin/management/settlements/${id}/finalize`)),
  markPaid: (id: string, notes?: string) =>
    unwrap<any>(api.post(`/admin/management/settlements/${id}/mark-paid`, { notes })),
  // Detail-page aggregator: user count, wallet, pnl windows, trade counts,
  // recent trades, weekly deposit/withdrawal flow.
  subAdminReport: (id: string) =>
    unwrap<any>(api.get(`/admin/management/sub-admins/${id}/report`)),
  // Login-as: returns admin-side tokens for the target sub-admin so the
  // frontend can drop them into the auth store and load that sub-admin's
  // dashboard view. Raw call (no unwrap) so we can read admin_app_url
  // alongside the token pair.
  impersonateSubAdmin: (id: string) =>
    api
      .post(`/admin/management/sub-admins/${id}/impersonate`)
      .then((r) => r.data?.data ?? r.data),
};

export const SettingsAPI = {
  platformList: (category?: string) => unwrap<any[]>(api.get("/admin/settings/platform", { params: { category } })),
  updatePlatform: (key: string, setting_value: any) =>
    unwrap<any>(api.put(`/admin/settings/platform/${encodeURIComponent(key)}`, { setting_value })),
  holidays: (year?: number) => unwrap<any[]>(api.get("/admin/holidays", { params: { year } })),
  createHoliday: (body: any) => unwrap<any>(api.post("/admin/holidays", body)),
  deleteHoliday: (id: string) => unwrap<any>(api.delete(`/admin/holidays/${id}`)),
  audit: (params?: any) => unwrap<{ items: any[]; meta: any }>(api.get("/admin/audit/logs", { params })),
  backupList: () => unwrap<any[]>(api.get("/admin/backup/list")),
  runBackup: () => unwrap<any>(api.post("/admin/backup/run")),
  eodReset: () => unwrap<any>(api.post("/admin/backup/eod-reset")),
};
