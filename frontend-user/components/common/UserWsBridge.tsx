"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/stores/authStore";
import { STORAGE_KEYS, WS_URL } from "@/lib/constants";

/**
 * Live updates from the backend's per-user pub/sub channels.
 *
 * Opens a single WebSocket to `/ws/user?token=…` (auth via JWT in query
 * because browsers don't allow custom headers on WS handshakes). Whenever
 * the server pushes a `position_update`, `order_update`, `trade_update` or
 * `wallet_update`, we invalidate the matching React Query keys so the
 * affected pages re-render without a manual refresh.
 *
 * Drop this component once near the top of the dashboard tree (e.g. in
 * `app/(dashboard)/layout.tsx`); it renders nothing.
 */
export function UserWsBridge() {
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);

  useEffect(() => {
    if (!user) return;
    const access =
      typeof window !== "undefined"
        ? window.localStorage.getItem(STORAGE_KEYS.accessToken)
        : null;
    if (!access) return;

    let stopped = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    function connect() {
      if (stopped) return;
      const url = `${WS_URL.replace(/\/$/, "")}/ws/user?token=${encodeURIComponent(access ?? "")}`;
      ws = new WebSocket(url);

      ws.onopen = () => {
        attempt = 0;
      };

      ws.onmessage = (ev) => {
        let msg: any;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        switch (msg?.type) {
          case "position_update":
            qc.invalidateQueries({ queryKey: ["positions"] });
            qc.invalidateQueries({ queryKey: ["positions", "open"] });
            qc.invalidateQueries({ queryKey: ["wallet"] });
            break;
          case "order_update":
            qc.invalidateQueries({ queryKey: ["orders"] });
            qc.invalidateQueries({ queryKey: ["orders", "recent"] });
            break;
          case "trade_update":
            qc.invalidateQueries({ queryKey: ["trades"] });
            break;
          case "wallet_update":
            qc.invalidateQueries({ queryKey: ["wallet"] });
            break;
          case "kyc_update":
            qc.invalidateQueries({ queryKey: ["kyc"] });
            qc.invalidateQueries({ queryKey: ["profile", "me"] });
            break;
          // hello / heartbeat — ignore
        }
      };

      ws.onclose = () => {
        if (stopped) return;
        attempt += 1;
        const delay = Math.min(15_000, 1_000 * 2 ** Math.min(attempt, 4));
        reconnectTimer = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // Let onclose handle reconnect cadence.
        ws?.close();
      };
    }

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [qc, user?.id]);

  return null;
}
