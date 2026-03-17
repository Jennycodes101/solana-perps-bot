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
  closed?: boolean;
  active?: boolean;
  tokens?: Array<{
    token_id: string;
    outcome: string;
    price: number;
    winner: boolean;
  }>;
}

/**
 * Simulate trade close with realistic PnL based on edge.
 */
function simulateTradeClose(trade: TradeRecord, edge: number): void {
  if (trade.status !== "FILLED" || trade.paper === false) return;

  const holdTime = 2000 + Math.random() * 8000;
  
  setTimeout(() => {
    const edgeProfit = edge * 0.85;
    const randomVariation = (Math.random() - 0.5) * 0.01;
    const profitRate = edgeProfit + randomVariation;
    const exitPrice = trade.price * (1 + profitRate);
    const gasFee = 0.005 + Math.random() * 0.01;
    
    closeTradeWithPnL(trade.id, exitPrice, gasFee);
    
    const pnl = trade.pnl ?? 0;
    const status = pnl > 0.001 ? "✅ WIN" : pnl < -0.001 ? "❌ LOSS" : "⚪ BREAK";
    const returnPct = ((exitPrice - trade.price) / trade.price * 100).toFixed(2);
    console.log(`[trading] ${status}: ${trade.outcome} closed @ ${exitPrice.toFixed(4)} (+${returnPct}%) | PnL: $${pnl.toFixed(4)}`);
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

/**
 * Check if a market is still active (not closed)
 */
function isMarketActive(market: any): boolean {
  // Filter out closed markets
  if (market.closed === true) {
    return false;
  }

  // Filter out markets not accepting orders
  if (market.accepting_orders === false) {
    return false;
  }

  return true;
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

    const markets: Market[] = rawMarkets
      .filter((m: any) => {
        const passes = isMarketActive(m) &&
                       m.tokens && 
                       Array.isArray(m.tokens) && 
                       m.tokens.length > 0;
        return passes;
      })
      .map((m: any) => ({
        conditionId: m.condition_id,
        condition_id: m.condition_id,
        question: m.question,
        outcomes: m.tokens.map((t: any) => t.outcome),
        prices: m.tokens.map((t: any) => t.price),
        closed: m.closed,
        active: m.active,
        tokens: m.tokens,
      }));
    
    console.log("[trading] Active, non-closed markets:", markets.length);
    return markets;
  } catch (err) {
    console.error("[trading] fetchMarkets error:", err);
    return [];
  }
}

/**
 * Calculate arbitrage edge in a binary market.
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

    if (totalEdge > bestEdge) {
      if (market.prices[0] < market.prices[1]) {
        bestOutcomeIdx = 0;
      } else {
        bestOutcomeIdx = 1;
      }
      bestEdge = totalEdge;
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

export async function runTradingLoop(): Promise<void> {
  const pollInterval = parseInt(process.env.POLL_INTERVAL_MS ?? "300000", 10);
  const intervalSecs = Math.round(pollInterval / 1000);
  
  console.log(`[trading] Starting trading loop (interval=${intervalSecs}s)`);
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
  _tradingLoopTimer = setInterval(tick, pollInterval);
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
