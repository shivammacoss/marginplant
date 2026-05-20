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
 * arrive. Auto-reconnects with exponential backoff.
 *
 * Two display-quality fixes ported from the user-side hook
 * (frontend-user/lib/useMarketStream.ts):
 *
 *   • **500 ms display throttle** — the backend tick pump runs at
 *     ~250 ms and upstream Kite ticks can land every 50-200 ms. Without
 *     throttling each tick triggers a React re-render, so the admin
 *     PnL number flickers 4-10× per second. Coalesce to ~2 fps so the
 *     value is readable AND admin updates feel as snappy as the user
 *     app screen the operator is comparing it to.
 *   • **Sticky bid / ask / ltp** — exchanges occasionally publish a 0
 *     for one of these fields (depth refresh gap, illiquid moment).
 *     A 0 isn't a real price; preserve the last positive value so the
 *     downstream P&L calc doesn't get yanked to LTP for one frame and
 *     spike by hundreds of rupees only to snap back.
 *
 * Used by the admin positions page and the per-user Live Trade Stats
 * dialog so admins see floating P&L in real time, not behind a 5 s
 * REST poll.
 */
const DISPLAY_THROTTLE_MS = 500;

export function useMarketStream(tokens: string[]): Map<string, MarketQuote> {
  const [quotes, setQuotes] = useState<Map<string, MarketQuote>>(new Map());
  const wsRef = useRef<WebSocket | null>(null);
  const subscribedRef = useRef<Set<string>>(new Set());
  const tokensKey = tokens.filter(Boolean).join(",");

  useEffect(() => {
    let stopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    // Sticky per-token cache + dirty set. See user-side hook for the
    // full rationale; in short: every incoming tick is merged INTO
    // the cached entry (zero/null fields preserve the prior positive
    // value), and a single setTimeout flushes the dirty tokens into
    // React state at most every DISPLAY_THROTTLE_MS.
    const sticky = new Map<string, MarketQuote>();
    const dirty = new Set<string>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    function isPositive(x: any): boolean {
      const n = Number(x);
      return Number.isFinite(n) && n > 0;
    }

    function mergeSticky(prev: MarketQuote | undefined, next: MarketQuote): MarketQuote {
      const merged: MarketQuote = { ...(prev ?? {}), ...next };
      if (!isPositive(next.bid) && isPositive(prev?.bid)) merged.bid = prev!.bid;
      if (!isPositive(next.ask) && isPositive(prev?.ask)) merged.ask = prev!.ask;
      if (!isPositive(next.ltp) && isPositive(prev?.ltp)) merged.ltp = prev!.ltp;
      return merged;
    }

    function flushPending() {
      flushTimer = null;
      if (dirty.size === 0) return;
      const drainedTokens = [...dirty];
      dirty.clear();
      setQuotes((prevState) => {
        const nextState = new Map(prevState);
        for (const tok of drainedTokens) {
          const q = sticky.get(tok);
          if (q) nextState.set(tok, q);
        }
        return nextState;
      });
    }

    function applyTicks(snaps: any[]) {
      for (const q of snaps) {
        const tok = String(q?.token ?? "");
        if (!tok) continue;
        const prev = sticky.get(tok);
        sticky.set(tok, mergeSticky(prev, q as MarketQuote));
        dirty.add(tok);
      }
      if (flushTimer === null) {
        flushTimer = setTimeout(flushPending, DISPLAY_THROTTLE_MS);
      }
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
      if (flushTimer) clearTimeout(flushTimer);
      sticky.clear();
      dirty.clear();
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
