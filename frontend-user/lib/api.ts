"use client";

import axios, { AxiosError, AxiosRequestConfig, InternalAxiosRequestConfig } from "axios";
import { API_URL, STORAGE_KEYS } from "./constants";
import type { ApiErrorResponse, ApiResponse, TokenPair } from "@/types";

export const api = axios.create({
  baseURL: `${API_URL}/api/v1`,
  withCredentials: false,
  timeout: 30_000,
});

let refreshPromise: Promise<string | null> | null = null;

function getAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(STORAGE_KEYS.accessToken);
}
function getRefreshToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(STORAGE_KEYS.refreshToken);
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
  // ALSO drop the zustand-persist auth blob (nb.auth). Without this
  // the store still rehydrates `user` from localStorage on the next
  // navigation, the dashboard guard sees a "logged in" state, fires
  // an API call, gets 401 (tokens are gone), refresh fails, we land
  // back here, redirect to /login — and /login's "if user, go to
  // /dashboard" effect bounces us back. The screen alternates
  // dashboard ↔ login forever on phones with flaky networks where a
  // single refresh failure trips the chain. User report: "kisi phone
  // me sahi chal raha, kisi me band-chalu jaisa feel a raha".
  // Wiping nb.auth here makes the store's `user` null on next read,
  // so the guards correctly send the user to the login form one
  // time, not in a loop.
  window.localStorage.removeItem("nb.auth");
}

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = getAccessToken();
  if (token && config.headers) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/**
 * Try to mint a fresh access token from the stored refresh token.
 *
 * Return semantics — three states matter, not two:
 *   - "ok":          got a new access; tokens updated in localStorage.
 *   - "auth_failed": backend explicitly rejected the refresh (401 / 403).
 *                    Tokens MUST be cleared and the user redirected.
 *   - "transient":   network glitch, 5xx, timeout, CORS, anything else.
 *                    DO NOT clear tokens — the refresh token may still be
 *                    valid, the user just temporarily can't reach the
 *                    server. PWA users on flaky mobile networks hit this
 *                    every time the app resumes from background; the old
 *                    code force-cleared tokens here and bounced them to
 *                    /login, which is the "PWA bar bar logout" the user
 *                    reported even with a 30-day refresh TTL.
 */
async function refreshAccessToken(): Promise<
  { kind: "ok"; access: string } | { kind: "auth_failed" | "transient" }
> {
  const refresh = getRefreshToken();
  if (!refresh) return { kind: "auth_failed" };
  try {
    const res = await axios.post<ApiResponse<TokenPair>>(
      `${API_URL}/api/v1/user/auth/refresh`,
      { refresh_token: refresh },
      { timeout: 15_000 }
    );
    const pair = res.data.data;
    if (!pair) return { kind: "transient" };
    setTokens(pair.access_token, pair.refresh_token);
    return { kind: "ok", access: pair.access_token };
  } catch (err) {
    const ax = err as AxiosError;
    const status = ax.response?.status;
    // Only treat an explicit auth rejection as a sign-out signal.
    // 401 + 403 from /refresh itself = the refresh token is no longer
    // valid (revoked, rotated by another tab, expired, etc.) → clear
    // and log the user out. Anything else (network down, server 5xx,
    // gateway timeout, CORS preflight failure) is transient — keep the
    // tokens and let the next request retry.
    if (status === 401 || status === 403) {
      clearTokens();
      return { kind: "auth_failed" };
    }
    return { kind: "transient" };
  }
}

api.interceptors.response.use(
  (resp) => resp,
  async (error: AxiosError<ApiErrorResponse>) => {
    const original = error.config as (AxiosRequestConfig & { _retry?: boolean }) | undefined;
    const status = error.response?.status;
    if (status === 401 && original && !original._retry) {
      original._retry = true;
      refreshPromise ||= (async () => {
        const r = await refreshAccessToken();
        return r.kind === "ok" ? r.access : null;
      })().finally(() => {
        refreshPromise = null;
      });
      const newToken = await refreshPromise;
      if (newToken) {
        original.headers = { ...(original.headers || {}), Authorization: `Bearer ${newToken}` };
        return api.request(original);
      }
      // Only redirect to /login when we KNOW the refresh was rejected
      // (auth_failed → tokens already cleared inside refreshAccessToken).
      // For transient failures the tokens are still around — let the next
      // call retry naturally; the user keeps their session.
      const stillHaveRefresh = typeof window !== "undefined" && !!getRefreshToken();
      if (
        !stillHaveRefresh &&
        typeof window !== "undefined" &&
        !window.location.pathname.startsWith("/login")
      ) {
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
    const ax = err as AxiosError<ApiErrorResponse>;
    const e = ax.response?.data?.error;
    throw new ApiError(e?.message || ax.message || "Network error", e?.code || "NETWORK", e?.details);
  }
}

// ── Auth ─────────────────────────────────────────────────────────────
export const AuthAPI = {
  login: (body: { identifier: string; password: string; two_fa_code?: string }) =>
    unwrap<TokenPair>(api.post("/user/auth/login", body)),
  register: (body: { email: string; mobile: string; password: string; full_name: string; pan?: string }) =>
    unwrap(api.post("/user/auth/register", body)),
  logout: (refresh_token?: string) => unwrap(api.post("/user/auth/logout", { refresh_token })),
  refresh: (refresh_token: string) => unwrap<TokenPair>(api.post("/user/auth/refresh", { refresh_token })),
  forgotPassword: (identifier: string) => unwrap(api.post("/user/auth/forgot-password", { identifier })),
  resetPassword: (body: { identifier: string; otp: string; new_password: string }) =>
    unwrap(api.post("/user/auth/reset-password", body)),
  changePassword: (body: { current_password: string; new_password: string }) =>
    unwrap(api.post("/user/auth/change-password", body)),
  twoFASetup: () => unwrap<{ secret: string; provisioning_uri: string }>(api.post("/user/auth/2fa/setup")),
  twoFAEnable: (code: string) => unwrap(api.post("/user/auth/2fa/enable", { code })),
  twoFADisable: (password: string, code: string) => unwrap(api.post("/user/auth/2fa/disable", { password, code })),
};

export const ProfileAPI = {
  me: () => unwrap<any>(api.get("/user/users/me")),
  update: (body: Record<string, unknown>) => unwrap<any>(api.put("/user/users/me", body)),
};

export const KycAPI = {
  status: () => unwrap<any>(api.get("/user/kyc")),
  submit: (body: {
    id_proof_type: string;
    id_proof_number?: string;
    id_proof_url: string;
    address_proof_type: string;
    address_proof_url: string;
    address_text: string;
  }) => unwrap<any>(api.post("/user/kyc/submit", body)),
  uploadProof: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return unwrap<{ url: string; size: number }>(
      api.post("/user/kyc/upload", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      })
    );
  },
};

export const WalletAPI = {
  summary: () => unwrap<any>(api.get("/user/wallet/summary")),
  transactions: (limit = 100, skip = 0) =>
    unwrap<any[]>(api.get("/user/wallet/transactions", { params: { limit, skip } })),
  companyBanks: () => unwrap<any[]>(api.get("/user/wallet/company-banks")),
  createDeposit: (body: any) => unwrap<any>(api.post("/user/wallet/deposits", body)),
  myDeposits: () => unwrap<any[]>(api.get("/user/wallet/deposits")),
  createWithdrawal: (body: any) => unwrap<any>(api.post("/user/wallet/withdrawals", body)),
  myWithdrawals: () => unwrap<any[]>(api.get("/user/wallet/withdrawals")),
  myBankAccounts: () => unwrap<any[]>(api.get("/user/wallet/bank-accounts")),
  addBankAccount: (body: any) => unwrap<any>(api.post("/user/wallet/bank-accounts", body)),
  uploadScreenshot: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return unwrap<{ url: string; size: number }>(
      api.post("/user/wallet/upload-screenshot", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      })
    );
  },
};

export const MarketwatchAPI = {
  list: () => unwrap<any[]>(api.get("/user/marketwatch")),
  create: (name: string) => unwrap<any>(api.post("/user/marketwatch", { name })),
  delete: (id: string) => unwrap<any>(api.delete(`/user/marketwatch/${id}`)),
  addItem: (watchlistId: string, token: string) =>
    unwrap<any>(api.post(`/user/marketwatch/${watchlistId}/items`, { token })),
  removeItem: (watchlistId: string, itemId: string) =>
    unwrap<any>(api.delete(`/user/marketwatch/${watchlistId}/items/${itemId}`)),
  quotes: (watchlistId: string) => unwrap<any[]>(api.get(`/user/marketwatch/${watchlistId}/quotes`)),
  // Per-segment managed instrument lists (Indian segments only — NSE_EQ,
  // NSE_FUT, NSE_OPT, BSE_*, MCX_*). User explicitly adds/removes items
  // here; the panel only shows what they've added. Forex / Crypto /
  // Stocks / Indices / Commodities continue to render from the Infoway
  // feed directly without a per-user list.
  segmentItems: (segmentName: string) =>
    unwrap<any[]>(api.get(`/user/marketwatch/segment/${segmentName}/items`)),
  addSegmentItem: (segmentName: string, token: string) =>
    unwrap<any>(
      api.post(`/user/marketwatch/segment/${segmentName}/items`, { token }),
    ),
  removeSegmentItem: (segmentName: string, token: string) =>
    unwrap<any>(api.delete(`/user/marketwatch/segment/${segmentName}/items/${token}`)),
};

export const InstrumentAPI = {
  search: (
    q?: string,
    exchange?: string,
    segment?: string,
    limit = 30,
    instrumentType?: string,
  ) =>
    unwrap<any[]>(
      api.get("/user/instruments/search", {
        params: { q, exchange, segment, instrument_type: instrumentType, limit },
      }),
    ),
  detail: (token: string) => unwrap<any>(api.get(`/user/instruments/${token}`)),
  quote: (token: string) => unwrap<any>(api.get(`/user/instruments/${token}/quote`)),
  quotesBatch: (tokens: string[]) =>
    unwrap<any[]>(api.get("/user/instruments/quotes/batch", { params: { tokens: tokens.join(",") } })),
  history: (token: string, interval = "5minute", days = 5) =>
    unwrap<any[]>(api.get(`/user/instruments/${token}/history`, { params: { interval, days } })),
};

export const SegmentSettingsAPI = {
  effective: (token: string, action: "BUY" | "SELL" = "BUY", product_type: "MIS" | "NRML" | "CNC" = "MIS") =>
    unwrap<any>(
      api.get("/user/segment-settings/effective", {
        params: { token, action, product_type },
      })
    ),
  // Names of admin matrix rows currently flagged isActive=false. The
  // InstrumentsPanel uses this list to hide buckets whose underlying
  // segments are turned off — chip + dropdown entry both disappear.
  inactive: () => unwrap<string[]>(api.get("/user/segment-settings/inactive")),
};

export const OrderAPI = {
  list: (status?: string) => unwrap<any[]>(api.get("/user/orders", { params: { status } })),
  detail: (id: string) => unwrap<any>(api.get(`/user/orders/${id}`)),
  place: (body: any) => unwrap<any>(api.post("/user/orders", body)),
  modify: (id: string, body: any) => unwrap<any>(api.put(`/user/orders/${id}`, body)),
  cancel: (id: string) => unwrap<any>(api.delete(`/user/orders/${id}`)),
};

export const PositionAPI = {
  open: () => unwrap<any[]>(api.get("/user/positions/open")),
  closed: () => unwrap<any[]>(api.get("/user/positions/closed")),
  squareoff: (id: string, lots?: number) =>
    unwrap<any>(api.post(`/user/positions/${id}/squareoff`, undefined, { params: lots ? { lots } : {} })),
  squareoffAll: () => unwrap<any>(api.post("/user/positions/squareoff-all")),
  updateSlTp: (id: string, body: { stop_loss?: number | null; target?: number | null }) =>
    unwrap<any>(api.put(`/user/positions/${id}/sl-tp`, body)),
  pnlSummary: () => unwrap<any>(api.get("/user/positions/pnl-summary")),
  activeTrades: () => unwrap<any[]>(api.get("/user/positions/active-trades")),
  closeActiveTrade: (tradeId: string) =>
    unwrap<any>(api.post(`/user/positions/active-trades/${tradeId}/close`)),
  updateActiveTradeSlTp: (tradeId: string, body: { stop_loss?: number | null; target?: number | null }) =>
    unwrap<any>(api.put(`/user/positions/active-trades/${tradeId}/sl-tp`, body)),
};

export const DashboardAPI = {
  summary: () => unwrap<any>(api.get("/user/dashboard/summary")),
};

export const LedgerAPI = {
  list: (params?: { from_date?: string; to_date?: string; limit?: number }) =>
    unwrap<any>(api.get("/user/ledger", { params })),
};

export const ReportsAPI = {
  pnl: (params?: any) => unwrap<any>(api.get("/user/reports/pnl", { params })),
  tradebook: (params?: any) => unwrap<any[]>(api.get("/user/reports/tradebook", { params })),
  brokerage: (params?: any) => unwrap<any>(api.get("/user/reports/brokerage", { params })),
  tax: () => unwrap<any>(api.get("/user/reports/tax")),
  margin: () => unwrap<any>(api.get("/user/reports/margin")),
};

export const AlertsAPI = {
  list: () => unwrap<any[]>(api.get("/user/alerts")),
  create: (body: any) => unwrap<any>(api.post("/user/alerts", body)),
  delete: (id: string) => unwrap<any>(api.delete(`/user/alerts/${id}`)),
};

export const OptionChainAPI = {
  fetch: (underlying: string, expiry?: string) =>
    unwrap<any>(api.get("/user/option-chain", { params: { underlying, expiry } })),
  config: () => unwrap<any>(api.get("/user/option-chain/config")),
};

export const NotificationsAPI = {
  list: (only_unread = false, limit = 100) =>
    unwrap<any[]>(api.get("/user/notifications", { params: { only_unread, limit } })),
  markRead: (id: string) => unwrap<any>(api.post(`/user/notifications/${id}/read`)),
  markAllRead: () => unwrap<any>(api.post("/user/notifications/mark-all-read")),
  unreadCount: () => unwrap<{ count: number }>(api.get("/user/notifications/unread-count")),
};

export { getAccessToken, getRefreshToken };
