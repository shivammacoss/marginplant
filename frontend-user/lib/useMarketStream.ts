"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { WS_URL } from "@/lib/constants";

/**
 * Per-WS-connection cap on live token subscriptions. Mirrors the backend
 * `WS_MAX_SUBSCRIPTIONS_PER_CONN` (app/core/config.py). When the caller
 * passes more than this many tokens we trim to the first N, toast the
 * user, and never put the over-flow on the wire — the server would
 * reject the whole batch anyway and the user wouldn't see any quote
 * stream until they manually trimmed. The pre-trim keeps the first 70
 * streaming so the panel is usable while the user prunes the watchlist.
 */
const MAX_SUBSCRIPTIONS = 70;

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
 * Throttling — display refresh is coalesced to ~500 ms (matches Zerodha
 * Kite / Dhan; Groww + Upstox sit at ~1 s). The WS itself still receives
 * every upstream tick at full rate so data freshness is preserved; we just
 * apply the LATEST per-token snapshot to React state at most twice per
 * second so the PnL number doesn't flicker 4-10× per second. User-reported
 * symptom before this change: "PnL bahut jada fast move ho raha hai, glitch
 * jaisa lag raha". Setting this to 0 would restore the old behaviour
 * (every tick → re-render).
 */
const DISPLAY_THROTTLE_MS = 500;

export function useMarketStream(tokens: string[]): Map<string, MarketQuote> {
  const [quotes, setQuotes] = useState<Map<string, MarketQuote>>(new Map());
  const wsRef = useRef<WebSocket | null>(null);
  const subscribedRef = useRef<Set<string>>(new Set());
  // Last requested-list length we saw, so we only toast on the EDGE —
  // re-renders that pass the same over-limit list don't spam the user.
  const lastRequestedLenRef = useRef(0);
  const tokensKey = tokens.join(",");

  // One-shot WS lifecycle — open on mount, close on unmount, reconnect on close.
  useEffect(() => {
    let stopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    // Per-token sticky cache. Every incoming tick is merged INTO the
    // previous cached entry instead of replacing it wholesale, with one
    // crucial rule: if a numeric quote field (bid / ask / ltp) arrives
    // as 0 / null / undefined / NaN, KEEP the previous non-zero value
    // for that field. Upstream Zerodha / Infoway ticks legitimately
    // skip bid or ask on illiquid options + the millisecond between a
    // depth refresh and a trade — without the sticky merge, the
    // position page's `(isLong ? bid : ask) || liveLtp` chain falls
    // through to LTP for that single tick, and on a wide-spread
    // instrument the PnL jumps several hundred / thousand rupees only
    // to snap back on the next tick. User-reported symptom: "bid/ask
    // ek millisecond ke liye band hoti hai, position LTP par shift ho
    // jata hai, PnL 2000 se 5000 ho jata hai". Sticky preservation
    // makes the display continuous — the LAST KNOWN good bid/ask
    // stays until a new non-zero value arrives.
    const sticky = new Map<string, MarketQuote>();
    const dirty = new Set<string>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    function isPositive(x: any): boolean {
      const n = Number(x);
      return Number.isFinite(n) && n > 0;
    }

    function mergeSticky(prev: MarketQuote | undefined, next: MarketQuote): MarketQuote {
      // Start from the previous quote so unrelated fields (volume, OHLC,
      // change_pct, etc.) are preserved when the new tick only carries
      // a subset of fields.
      const merged: MarketQuote = { ...(prev ?? {}), ...next };
      // Sticky overrides — keep prior value when the incoming field is
      // missing or non-positive. Zero is treated as "no data" for
      // bid / ask / ltp because exchanges never quote them as 0 for a
      // live tradable instrument.
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
        const next = new Map(prevState);
        for (const tok of drainedTokens) {
          const q = sticky.get(tok);
          if (q) next.set(tok, q);
        }
        return next;
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
        } else if (msg?.type === "error" && msg?.code === "subscription_limit") {
          // Safety net — the pre-trim below should keep us off this
          // path, but if a race ever sends an over-limit batch (e.g.
          // tokens prop grew mid-flight) the server rejects and we
          // surface the same toast as the client-side cap.
          toast.error(
            msg.message ||
              `Subscription limit reached (${MAX_SUBSCRIPTIONS}). Unsubscribe some symbols before adding new ones.`,
            { duration: 5000 },
          );
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
      if (flushTimer) clearTimeout(flushTimer);
      sticky.clear();
      dirty.clear();
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
    const requested = tokens.filter(Boolean);
    // Pre-trim to the per-WS cap. We keep the FIRST N tokens (callers
    // pass watchlist order so the user's most-recently-arranged items
    // win) and drop the rest. The dropped tokens never hit the wire —
    // the backend would reject the whole batch otherwise.
    const trimmed = requested.slice(0, MAX_SUBSCRIPTIONS);
    const droppedCount = requested.length - trimmed.length;
    if (droppedCount > 0 && requested.length > lastRequestedLenRef.current) {
      // Only toast when the requested list GREW past the cap, so a
      // steady-state over-limit watchlist toasts once on initial mount
      // and once per additional add — not on every unrelated re-render.
      toast.error(
        `Subscription limit reached (${MAX_SUBSCRIPTIONS}). ${droppedCount} symbol${droppedCount > 1 ? "s" : ""} will not stream — remove some from your watchlist to add new ones.`,
        { duration: 5000 },
      );
    }
    lastRequestedLenRef.current = requested.length;

    const next = new Set(trimmed);
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
