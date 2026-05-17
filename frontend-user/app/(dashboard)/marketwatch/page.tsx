"use client";

import { useState } from "react";
import { MobileInstrumentsBar } from "@/components/trading/MobileInstrumentsBar";
import { TradeDetailSheet } from "@/components/trading/TradeDetailSheet";

/**
 * Markets page — browse + search every tradable instrument, star favorites,
 * tap a row to open the slide-up trade card with all order-placement
 * controls (no route change, so the user returns to the same scroll
 * position when the card closes).
 */
export default function MarketsPage() {
  const [tradeToken, setTradeToken] = useState<string | null>(null);

  return (
    <div className="flex h-[calc(100vh-9rem)] min-h-[480px] flex-col md:h-[calc(100vh-7rem)]">
      <MobileInstrumentsBar
        activeToken={tradeToken}
        onSelect={(token) => setTradeToken(token)}
      />
      <TradeDetailSheet
        token={tradeToken}
        open={!!tradeToken}
        onClose={() => setTradeToken(null)}
      />
    </div>
  );
}
