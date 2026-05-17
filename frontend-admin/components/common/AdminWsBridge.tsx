"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAdminAuthStore } from "@/stores/authStore";
import { ADMIN_API_KEY, STORAGE_KEYS, WS_URL } from "@/lib/constants";

/**
 * Live admin-side updates from the backend's `admin:events` pub/sub channel.
 *
 * Opens a single WebSocket to `/ws/admin?token=…&key=…` (browsers can't
 * send custom headers on a WS handshake, so the X-Admin-Api-Key check is
 * mirrored as a query param). Whenever the backend publishes one of the
 * known event types (`position_update`, `order_update`, `wallet_update`,
 * `deposit_update`, `withdrawal_update`, `kyc_update`) we invalidate the
 * matching React Query keys so every open admin tab — Positions / Orders /
 * Payments / KYC / Dashboard — refreshes within the same event-loop tick
 * the user takes the action on the trader side. No more F5.
 *
 * Mounted once near the top of the admin layout; renders nothing.
 *
 * Reconnects with exponential backoff (max 15 s) on close / error. The
 * existing `refetchInterval` polls on each page are still in place as a
 * safety net — they just become rarely-triggered when the WS is healthy.
 */
export function AdminWsBridge() {
  const qc = useQueryClient();
  const admin = useAdminAuthStore((s) => s.admin);

  useEffect(() => {
    if (!admin) return;
    const access =
      typeof window !== "undefined"
        ? window.localStorage.getItem(STORAGE_KEYS.accessToken)
        : null;
    if (!access || !ADMIN_API_KEY) return;

    let stopped = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    function connect() {
      if (stopped) return;
      const url =
        `${WS_URL.replace(/\/$/, "")}/ws/admin` +
        `?token=${encodeURIComponent(access ?? "")}` +
        `&key=${encodeURIComponent(ADMIN_API_KEY)}`;
      ws = new WebSocket(url);

      ws.onopen = () => {
        attempt = 0;
        // eslint-disable-next-line no-console
        console.info("[admin-ws] open");
      };

      ws.onmessage = (ev) => {
        let msg: any;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        // The publisher's `type` tells us which slice of admin queries to
        // refresh. Keys mirror the queryKey prefixes the admin pages use
        // (`["admin", "positions", ...]`, `["admin", "orders"]`, etc.).
        switch (msg?.type) {
          case "position_update":
            qc.invalidateQueries({ queryKey: ["admin", "positions"] });
            qc.invalidateQueries({ queryKey: ["admin", "dashboard"] });
            break;
          case "order_update":
            qc.invalidateQueries({ queryKey: ["admin", "orders"] });
            qc.invalidateQueries({ queryKey: ["admin", "trades"] });
            qc.invalidateQueries({ queryKey: ["admin", "positions"] });
            qc.invalidateQueries({ queryKey: ["admin", "dashboard"] });
            break;
          case "wallet_update":
            // Admin wallet / margin tiles + per-user wallet drill-downs.
            qc.invalidateQueries({ queryKey: ["admin", "wallets"] });
            qc.invalidateQueries({ queryKey: ["admin", "ledger"] });
            qc.invalidateQueries({ queryKey: ["admin", "dashboard"] });
            qc.invalidateQueries({ queryKey: ["admin", "users"] });
            break;
          case "deposit_update":
            qc.invalidateQueries({ queryKey: ["admin", "deposits"] });
            qc.invalidateQueries({ queryKey: ["admin", "payments"] });
            qc.invalidateQueries({ queryKey: ["admin", "dashboard"] });
            break;
          case "withdrawal_update":
            qc.invalidateQueries({ queryKey: ["admin", "withdrawals"] });
            qc.invalidateQueries({ queryKey: ["admin", "payments"] });
            qc.invalidateQueries({ queryKey: ["admin", "dashboard"] });
            break;
          case "kyc_update":
            qc.invalidateQueries({ queryKey: ["admin", "kyc"] });
            qc.invalidateQueries({ queryKey: ["admin", "users"] });
            qc.invalidateQueries({ queryKey: ["admin", "dashboard"] });
            break;
          // hello / heartbeat — ignore
        }
      };

      ws.onclose = (ev) => {
        if (stopped) return;
        attempt += 1;
        const delay = Math.min(15_000, 1_000 * 2 ** Math.min(attempt, 4));
        // eslint-disable-next-line no-console
        console.warn("[admin-ws] closed", {
          code: ev.code,
          reason: ev.reason,
          retryInMs: delay,
        });
        reconnectTimer = setTimeout(connect, delay);
      };

      ws.onerror = (ev) => {
        // eslint-disable-next-line no-console
        console.error("[admin-ws] error", ev);
        ws?.close();
      };
    }

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [qc, admin?.id]);

  return null;
}
