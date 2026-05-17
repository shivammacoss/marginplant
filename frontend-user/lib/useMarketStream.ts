"use client";

import { useEffect, useRef, useState } from "react";
import { WS_URL } from "@/lib/constants";

export type MarketQuote = {
  token: string;
  ltp?: number;
  bid?: number;
  ask?: number;
  change?: number;
  change_pct?: number;
  [key: string]: any;
};

/**
 * Live market-data stream. Opens a single WebSocket to `/ws/marketdata`,
 * subscribes to the given tokens, and returns a `{token → quote}` map that
 * updates as ticks arrive. Auto-reconnects with exponential backoff.
 *
 * Why a hook instead of `useQuery` polling: the order panel quotes at 1 s,
 * positions used to quote at 2 s, and the WS pump now runs at 250 ms. By
 * subscribing here we get sub-second tick updates on every consumer of
 * `position.ltp` (CURRENT column, P/L, totals) without paying for repeat
 * REST round-trips.
 */
export function useMarketStream(tokens: string[]): Map<string, MarketQuote> {
  const [quotes, setQuotes] = useState<Map<string, MarketQuote>>(new Map());
  const wsRef = useRef<WebSocket | null>(null);
  const subscribedRef = useRef<Set<string>>(new Set());
  const tokensKey = tokens.join(",");

  // One-shot WS lifecycle — open on mount, close on unmount, reconnect on close.
  useEffect(() => {
    let stopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    function applyTicks(snaps: any[]) {
      setQuotes((prev) => {
        const next = new Map(prev);
        for (const q of snaps) {
          const tok = String(q?.token ?? "");
          if (!tok) continue;
          next.set(tok, q as MarketQuote);
        }
        return next;
      });
    }

    function connect() {
      if (stopped) return;
      const url = `${WS_URL.replace(/\/$/, "")}/ws/marketdata`;
      // Production-debugging breadcrumb: log the resolved WS origin once per
      // connect attempt. If the panel shows "—" everywhere in prod, this is
      // the first thing to check in DevTools console — if it prints
      // `ws://localhost:8000` from marginplant.com, NEXT_PUBLIC_WS_URL wasn't set
      // at build time (or the build wasn't redeployed after fixing the env).
      // eslint-disable-next-line no-console
      console.info("[market-ws] connecting", url);
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        // eslint-disable-next-line no-console
        console.info("[market-ws] open", url);
        // Re-send subscriptions for whatever tokens the consumer last asked
        // about. The cleanup effect below mirrors `subscribedRef` to the
        // outside world; on reconnect we re-establish that exact set.
        const list = [...subscribedRef.current];
        if (list.length > 0) {
          ws.send(JSON.stringify({ type: "subscribe", tokens: list }));
        }
      };

      ws.onmessage = (ev) => {
        let msg: any;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if ((msg?.type === "tick" || msg?.type === "snapshot") && Array.isArray(msg.payload)) {
          applyTicks(msg.payload);
        }
      };

      ws.onclose = (ev) => {
        if (stopped) return;
        attempt += 1;
        const delay = Math.min(15_000, 1_000 * 2 ** Math.min(attempt, 4));
        // eslint-disable-next-line no-console
        console.warn("[market-ws] closed", { code: ev.code, reason: ev.reason, retryInMs: delay });
        reconnectTimer = setTimeout(connect, delay);
      };

      ws.onerror = (ev) => {
        // eslint-disable-next-line no-console
        console.error("[market-ws] error", ev);
        ws.close();
      };
    }
    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
    // intentionally empty deps — the WS stays open for the lifetime of the
    // component; the subscribe-set sync effect below handles token changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Diff the subscription set whenever the consumer's `tokens` change.
  // Sends `subscribe` for new tokens and `unsubscribe` for removed ones,
  // so the server can free per-token state and we don't get tick spam
  // for symbols we no longer care about.
  useEffect(() => {
    const ws = wsRef.current;
    const next = new Set(tokens.filter(Boolean));
    const prev = subscribedRef.current;
    const toAdd = [...next].filter((t) => !prev.has(t));
    const toRemove = [...prev].filter((t) => !next.has(t));
    subscribedRef.current = next;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (toAdd.length > 0) ws.send(JSON.stringify({ type: "subscribe", tokens: toAdd }));
    if (toRemove.length > 0) ws.send(JSON.stringify({ type: "unsubscribe", tokens: toRemove }));
  }, [tokensKey]);

  return quotes;
}
