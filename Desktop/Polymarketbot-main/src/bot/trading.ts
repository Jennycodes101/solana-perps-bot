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

/**
 * Simulate trade close with realistic PnL based on edge.
 * Better trades (higher edge) should be more likely to win.
 */
function simulateTradeClose(trade: TradeRecord, edge: number): void {
  if (trade.status !== "FILLED" || trade.paper === false) return;

  // Shorter hold time for tighter simulation (5-30 seconds)
  const holdTime = 5000 + Math.random() * 25000;
  
  setTimeout(() => {
    // Use edge to determine exit price
    // Higher edge = more likely to exit at profit
    // Edge of 0.05 (5%) means we bought 5% below fair value
    
    // Exit price variation based on edge:
    // If edge is 0.05, we expect ~2-3% profit on average
    // Add some randomness: ±2% around the edge-adjusted price
    const expectedProfit = edge * 0.6; // Convert edge to expected profit (60% of edge)
    const randomVariation = (Math.random() - 0.5) * 0.04; // ±2% randomness
    const exitMultiplier = 1 + expectedProfit + randomVariation;
    
    const exitPrice = trade.price * exitMultiplier;
    
    // Lower gas fee (0.05-0.10 USDC for smaller trades)
    const gasFee = 0.05 + Math.random() * 0.05;
    
    closeTradeWithPnL(trade.id, exitPrice, gasFee);
    
    const pnl = trade.pnl ?? 0;
    const status = pnl > 0 ? "✅ WIN" : pnl < 0 ? "❌ LOSS" : "⚪ BREAKEVEN";
    console.log(`[trading] ${status}: ${trade.outcome} closed @ ${exitPrice.toFixed(4)} | PnL: ${pnl.toFixed(2)} USDC`);
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
 * Calculate arbitrage edge in a binary market.
 * Edge exists when prices sum to < 1.0
 */
function calculateEdge(price1: number, price2: number): number {
  const priceSum = price1 + price2;
  const edge = Math.max(0, 1.0 - priceSum);
  return edge;
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
    const totalEdge = calculateEdge(market.prices[0], market.prices[1]);

    console.log(`[trading] Market: ${market.question?.substring(0, 60)}`);
    console.log(`[trading]   ${market.outcomes[0]}: price=${market.prices[0].toFixed(4)}`);
    console.log(`[trading]   ${market.outcomes[1]}: price=${market.prices[1].toFixed(4)}`);
    console.log(`[trading]   Total edge: ${totalEdge.toFixed(4)}`);

    // Buy the cheaper outcome to capture the edge
    if (totalEdge > bestEdge) {
      if (market.prices[0] < market.prices[1]) {
        bestOutcomeIdx = 0;
      } else {
        bestOutcomeIdx = 1;
      }
      bestEdge = totalEdge;
    }
  } else {
    // For multi-outcome markets, use simpler logic
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
    console.log(`[trading]   → SKIP (edge ${bestEdge.toFixed(4)} < minimum ${minEdge})`);
    return;
  }

  const bestPrice = market.prices[bestOutcomeIdx];
  const bestOutcome = market.outcomes[bestOutcomeIdx];
  const size = Math.min(maxSize, Math.round(bestEdge * maxSize * 100) / 100);

  console.log(`[trading] ✅ BUY ${size} USDC of "${bestOutcome}" @ ${bestPrice.toFixed(4)} (edge: ${bestEdge.toFixed(4)})`);

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
    simulateTradeClose(trade, bestEdge);
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
