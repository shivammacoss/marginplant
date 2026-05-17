/**
 * Frontend market-hours guard — used so the UI doesn't fire close / new
 * orders when the backend will obviously reject them with MARKET_CLOSED.
 *
 * Why: previously, clicking "Close" on a position outside market hours
 * triggered the same optimistic-remove pipeline as any other close — the
 * row disappeared for ~1 s, then the backend rejected and the row came
 * back with a tiny error toast. Traders kept thinking the close worked
 * for a moment and then "got reversed." Pre-checking here means we show
 * one clear "Market is closed" message and the position stays put.
 *
 * Segment hours mirror the backend's `app/utils/time_utils.py` schedule.
 * If the backend ever queues after-hours closes as AMO orders, flip the
 * relevant branch to `true` here.
 */

/** Minutes since IST midnight for the given JS Date (no tz library needed). */
function _istMinutes(date: Date): number {
  // toLocaleString → "Asia/Kolkata" gives us H:M without DST headaches.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return h * 60 + m;
}

/** IST day-of-week (0 = Sun, 6 = Sat). */
function _istDay(date: Date): number {
  // `getDay()` on a UTC date returns UTC weekday — for IST we shift the
  // epoch forward by 5h30m, then read it back as a UTC weekday. Avoids
  // tz-aware Date construction.
  const ist = new Date(date.getTime() + (5 * 60 + 30) * 60_000);
  return ist.getUTCDay();
}

/**
 * Returns true when the segment's exchange is currently accepting trades.
 *
 * `segment_type` is the canonical Position.segment_type value the backend
 * sends; `exchange` is a fallback when segment_type is empty (legacy
 * positions). Both are uppercased before matching.
 */
export function isInstrumentMarketOpen(
  segmentType?: string | null,
  exchange?: string | null,
  now: Date = new Date(),
): boolean {
  const seg = (segmentType || "").toUpperCase();
  const exch = (exchange || "").toUpperCase();
  const min = _istMinutes(now);
  const day = _istDay(now);
  const weekday = day !== 0 && day !== 6;

  // Crypto trades 24/7. AllTick/Infoway feed never closes, the matching
  // engine accepts orders at any time.
  if (seg.includes("CRYPTO") || exch === "CRYPTO" || exch === "BINANCE") return true;

  // International equities / indices / metals / energy / forex — all
  // Infoway-mirrored, 24/5. Closed only on Sat the whole day and Sun
  // until ~17:00 EST (≈03:30 IST Mon). Approximate as Mon-Fri all hours
  // + Sun 21:00 IST onwards (typical FX market open) — matches what
  // traders see on TradingView for these symbols.
  if (
    seg === "FOREX" ||
    seg === "STOCKS" ||
    seg === "INDICES" ||
    seg === "COMMODITIES" ||
    seg.includes("FOREX") ||
    seg.includes("FX") ||
    exch === "CDS"
  ) {
    if (day === 6) return false; // Saturday closed
    if (day === 0 && min < 21 * 60) return false; // Sun before 21:00 IST
    return true;
  }

  // MCX commodities: Mon-Fri 09:00-23:30 IST (evening session merged).
  if (seg.startsWith("MCX") || exch === "MCX") {
    if (!weekday) return false;
    return min >= 9 * 60 && min <= 23 * 60 + 30;
  }

  // NSE / BSE equity, F&O — Mon-Fri 09:15-15:30 IST.
  // Catch-all: anything we couldn't classify falls into this bucket,
  // which is safer than defaulting to "open" because Indian equity is
  // the dominant segment and a wrong "closed" is better than a wrong
  // "open" (the backend rejects either way; we just avoid the flicker).
  if (!weekday) return false;
  return min >= 9 * 60 + 15 && min <= 15 * 60 + 30;
}

/** Friendly label used in the "Market is closed" toast. */
export function marketLabel(segmentType?: string | null, exchange?: string | null): string {
  const seg = (segmentType || "").toUpperCase();
  const exch = (exchange || "").toUpperCase();
  if (seg.includes("CRYPTO") || exch === "CRYPTO") return "Crypto";
  if (seg === "FOREX" || seg.includes("FOREX") || seg.includes("FX") || exch === "CDS") return "Forex";
  if (seg === "COMMODITIES") return "Commodities";
  if (seg === "STOCKS") return "Global stocks";
  if (seg === "INDICES") return "Global indices";
  if (seg.startsWith("MCX") || exch === "MCX") return "MCX";
  if (seg.startsWith("BSE") || exch === "BSE") return "BSE";
  return "NSE";
}
