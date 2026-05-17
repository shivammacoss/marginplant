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
  fx_rate?: number;
  [key: string]: any;
};

/**
 * Admin-side mirror of the user app's market-data WS hook.
 *
 * Opens a single WebSocket to `/ws/marketdata`, subscribes to the given
 * tokens, and returns a `{token → quote}` map that updates as ticks
 * arrive. Auto-reconnects with exponential backoff. Diffs the
 * subscription set whenever the input array changes so we only
 * subscribe to new tokens and unsubscribe to removed ones.
 *
 * Used by the Live Trade Stats dialog to compute floating P&L per
 * tick (≈250 ms server pump) instead of polling REST.
 */
export function useMarketStream(tokens: string[]): Map<string, MarketQuote> {
  const [quotes, setQuotes] = useState<Map<string, MarketQuote>>(new Map());
  const wsRef = useRef<WebSocket | null>(null);
  const subscribedRef = useRef<Set<string>>(new Set());
  const tokensKey = tokens.filter(Boolean).join(",");

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
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
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
        if (
          (msg?.type === "tick" || msg?.type === "snapshot") &&
          Array.isArray(msg.payload)
        ) {
          applyTicks(msg.payload);
        }
      };

      ws.onclose = () => {
        if (stopped) return;
        attempt += 1;
        const delay = Math.min(15_000, 1_000 * 2 ** Math.min(attempt, 4));
        reconnectTimer = setTimeout(connect, delay);
      };

      ws.onerror = () => ws.close();
    }
    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
    // intentional: WS stays open for component lifetime; the
    // subscribe-diff effect below handles token changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const ws = wsRef.current;
    const next = new Set(tokens.filter(Boolean));
    const prev = subscribedRef.current;
    const toAdd = [...next].filter((t) => !prev.has(t));
    const toRemove = [...prev].filter((t) => !next.has(t));
    subscribedRef.current = next;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (toAdd.length > 0) {
      ws.send(JSON.stringify({ type: "subscribe", tokens: toAdd }));
    }
    if (toRemove.length > 0) {
      ws.send(JSON.stringify({ type: "unsubscribe", tokens: toRemove }));
    }
  }, [tokensKey]);

  return quotes;
}
