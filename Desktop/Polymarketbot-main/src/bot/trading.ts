import axios from "axios";
import { getWallet } from "../utils/wallet";
import { recordTrade, getAllTrades, closeTradeWithPnL } from "../admin/stats";
import { isPaperMode } from "../admin/tradingMode";
import { getMaxConcurrentTrades, getMaxPositionSize } from "../admin/tradingLimits";
import type { TradeRecord } from "../admin/stats";
import { MOCK_MARKETS } from "./mockMarkets";

let _tradeIdCounter = 0;
function newId(): string {
  return `trade-${Date.now()}-${++_tradeIdCounter}`;
}

export interface Market {
  conditionId: string;
  condition_id: string;
  question: string;
  outcomes: string[];
  prices: number[];
  tokens?: Array<{
    token_id: string;
    outcome: string;
    price: number;
    winner: boolean;
  }>;
}

function simulateTradeClose(trade: TradeRecord): void {
  if (trade.status !== "FILLED" || trade.paper === false) return;

  const holdTime = 10000 + Math.random() * 50000;
  
  setTimeout(() => {
    const variation = (Math.random() - 0.5) * 0.1;
    const exitPrice = trade.price * (1 + variation);
    const gasFee = 0.10 + Math.random() * 0.15;
    
    closeTradeWithPnL(trade.id, exitPrice, gasFee);
    console.log(`[trading] CLOSED: ${trade.outcome} @ ${exitPrice.toFixed(4)} (PnL: ${(trade.pnl ?? 0).toFixed(2)} USDC)`);
  }, holdTime);
}

function hasOpenPositionInMarket(marketId: string): boolean {
  const trades = getAllTrades();
  return trades.some((t) => 
    t.marketId === marketId && 
    (t.status === "FILLED" || t.status === "OPEN")
  );
}

function getOpenTradesCount(): number {
  const trades = getAllTrades();
  return trades.filter((t) => t.status === "FILLED" || t.status === "OPEN").length;
}

export async function fetchMarkets(): Promise<Market[]> {
  const USE_MOCK = process.env.USE_MOCK_MARKETS === "true";
  
  if (USE_MOCK) {
    console.log("[trading] Using MOCK markets for testing");
    return MOCK_MARKETS as Market[];
  }

  const baseUrl = process.env.CLOB_API_URL ?? "https://clob.polymarket.com";
  try {
    const { data } = await axios.get<any>(`${baseUrl}/markets`, {
      params: { 
        accepting_orders: true
      },
      timeout: 10_000,
    });
    
    const rawMarkets = Array.isArray(data) ? data : (data.data ?? data.markets ?? []);
    
    console.log("[trading] Total markets from API:", rawMarkets.length);
    
    const acceptingOrders = rawMarkets.filter((m: any) => m.accepting_orders === true);
    console.log("[trading] Markets with accepting_orders=true:", acceptingOrders.length);

    const markets: Market[] = rawMarkets
      .filter((m: any) => {
        const passes = m.accepting_orders === true &&
                       m.tokens && 
                       Array.isArray(m.tokens) && 
                       m.tokens.length > 0;
        if (!passes && m.accepting_orders === true) {
          console.log("[trading] ⚠️  Market rejected (no tokens):", m.question?.substring(0, 50));
        }
        return passes;
      })
      .map((m: any) => ({
        conditionId: m.condition_id,
        condition_id: m.condition_id,
        question: m.question,
        outcomes: m.tokens.map((t: any) => t.outcome),
        prices: m.tokens.map((t: any) => t.price),
        tokens: m.tokens,
      }));
    
    console.log("[trading] Markets with tokens:", markets.length);
    return markets;
  } catch (err) {
    console.error("[trading] fetchMarkets error:", err);
    return [];
  }
}

/**
 * Calculate edge for a binary outcome.
 * In a fair binary market: Yes + No prices = 1.0
 * 
 * If Yes=0.35 and No=0.65:
 *   - Fair Yes price should be 0.35 (35% likely)
 *   - Edge = 0 (fair pricing)
 * 
 * If Yes=0.30 and No=0.70:
 *   - Fair Yes price should be 0.30
 *   - Edge = 0 (fair pricing)
 * 
 * If Yes is mispriced (too low):
 *   - Yes=0.20, No=0.80
 *   - Fair Yes should be 0.20, but we can buy at discount
 *   - Edge = how much it deviates from fair
 * 
 * Better approach: calculate implied probability and compare
 */
function calculateEdge(yourPrice: number, otherPrice: number): number {
  // In a perfectly efficient market: price_a + price_b = 1.0
  // If they don't sum to 1.0, there's an arbitrage opportunity
  const priceSum = yourPrice + otherPrice;
  
  // If sum < 1.0, both sides are underpriced (edge = 1.0 - sum)
  // If sum > 1.0, both sides are overpriced (edge = sum - 1.0, negative)
  const edge = 1.0 - priceSum;
  
  // But really, we want: is THIS outcome underpriced?
  // Underpriced if: yourPrice < 1 - otherPrice
  const fairPrice = 1.0 - otherPrice;
  return fairPrice - yourPrice;
}

export async function evaluateAndTrade(market: Market): Promise<void> {
  const minEdge = parseFloat(process.env.MIN_EDGE ?? "0.05");
  const maxConcurrent = getMaxConcurrentTrades();
  const maxSize = getMaxPositionSize();
  const isPaper = isPaperMode();
  
  const openTrades = getOpenTradesCount();
  
  if (openTrades >= maxConcurrent) {
    console.log(`[trading] Skipping market: ${openTrades}/${maxConcurrent} concurrent trades reached`);
    return;
  }
        
  if (!market.outcomes || !Array.isArray(market.outcomes) || !market.prices || !Array.isArray(market.prices)) {
    return;
  }

  const hasExtremePrice = market.prices.some((p: number) => p === 0 || p === 1);
  if (hasExtremePrice) {
    return;
  }

  const marketId = market.conditionId;
  if (hasOpenPositionInMarket(marketId)) {
    console.log(`[trading] ✓ Already have position in: ${market.question.substring(0, 40)}…`);
    return;
  }

  let bestOutcomeIdx = -1;
  let bestEdge = minEdge - 0.0001;

  if (market.outcomes.length === 2) {
    const edge0 = calculateEdge(market.prices[0], market.prices[1]);
    const edge1 = calculateEdge(market.prices[1], market.prices[0]);

    console.log(`[trading] Market: ${market.question?.substring(0, 60)}`);
    console.log(`[trading]   ${market.outcomes[0]}: price=${market.prices[0].toFixed(4)}, edge=${edge0.toFixed(4)}`);
    console.log(`[trading]   ${market.outcomes[1]}: price=${market.prices[1].toFixed(4)}, edge=${edge1.toFixed(4)}`);

    if (edge0 > edge1 && edge0 > bestEdge) {
      bestEdge = edge0;
      bestOutcomeIdx = 0;
    } else if (edge1 > bestEdge) {
      bestEdge = edge1;
      bestOutcomeIdx = 1;
    }
  } else {
    for (let i = 0; i < market.outcomes.length; i++) {
      const price = market.prices[i];
      if (price === undefined) continue;
      const edge = 1 - price - minEdge;
      if (edge > bestEdge) {
        bestEdge = edge;
        bestOutcomeIdx = i;
      }
    }
  }

  if (bestOutcomeIdx === -1) {
    console.log(`[trading]   → SKIP (no outcome with sufficient edge)`);
    return;
  }

  const bestPrice = market.prices[bestOutcomeIdx];
  const bestOutcome = market.outcomes[bestOutcomeIdx];
  const size = Math.min(maxSize, Math.round(Math.abs(bestEdge) * maxSize * 100) / 100);

  console.log(`[trading] ✅ BUY ${size} USDC of "${bestOutcome}" @ ${bestPrice.toFixed(4)}`);

  const trade: TradeRecord = {
    id: newId(),
    timestamp: Date.now(),
    marketId,
    market: market.question,
    outcome: bestOutcome,
    side: "BUY",
    size,
    price: bestPrice,
    entryPrice: bestPrice,
    paper: isPaper,
    status: "FILLED",
  };

  recordTrade(trade);

  if (isPaper) {
    simulateTradeClose(trade);
  }
}

async function submitOrder(trade: TradeRecord): Promise<void> {
  const baseUrl = process.env.CLOB_API_URL ?? "https://clob.polymarket.com";
  const wallet = getWallet();
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const headers = {
    "POLY_ADDRESS": wallet.address,
    "POLY_SIGNATURE": await wallet.signMessage(timestamp),
    "POLY_TIMESTAMP": timestamp,
    "POLY_API_KEY": process.env.CLOB_API_KEY ?? "",
    "POLY_API_SECRET": process.env.CLOB_API_SECRET ?? "",
    "POLY_PASSPHRASE": process.env.CLOB_API_PASSPHRASE ?? "",
  };

  await axios.post(
    `${baseUrl}/order`,
    {
      market: trade.marketId,
      side: trade.side,
      price: trade.price,
      size: trade.size,
      outcome: trade.outcome,
    },
    { headers, timeout: 10_000 }
  );
}

let _tradingLoopTimer: NodeJS.Timeout | null = null;
let _isRunning = false;

const FIVE_MINUTE_INTERVAL_MS = 300000;

export async function runTradingLoop(): Promise<void> {
  const interval = FIVE_MINUTE_INTERVAL_MS;
  console.log(`[trading] Starting 5-minute trading loop (interval=${interval}ms)`);
  console.log(`[trading] Trading mode: ${isPaperMode() ? 'PAPER' : 'LIVE'}`);
  _isRunning = true;

  const tick = async () => {
    if (!_isRunning) return;
    
    try {
      const markets = await fetchMarkets();
      console.log(`[trading] Evaluating ${markets.length} markets…`);
      for (const market of markets) {
        if (!_isRunning) break;
        await evaluateAndTrade(market);
      }
    } catch (err) {
      console.error("[trading] Error in trading tick:", err);
    }
  };

  await tick();
  _tradingLoopTimer = setInterval(tick, interval);
}

export function stopTradingLoop(): void {
  console.log("[trading] Stopping trading loop...");
  _isRunning = false;
  if (_tradingLoopTimer) {
    clearInterval(_tradingLoopTimer);
    _tradingLoopTimer = null;
  }
  console.log("[trading] Trading loop stopped");
}

export function isTradingLoopRunning(): boolean {
  return _isRunning;
}

export function getCurrentOpenTradeCount(): number {
  return getOpenTradesCount();
}
