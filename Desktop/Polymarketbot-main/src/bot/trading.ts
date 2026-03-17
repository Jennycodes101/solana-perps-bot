import axios from "axios";
import { getWallet, getTokenBalance } from "../utils/wallet";
import { recordTrade, getAllTrades, updateTradeStatus, closeTradeWithPnL } from "../admin/stats";
import { getItem, setItem } from "../utils/jsonStore";
import { isPaperMode } from "../admin/tradingMode";
import { getMaxConcurrentTrades, getMaxPositionSize } from "../admin/tradingLimits";
import type { TradeRecord } from "../admin/stats";

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

/** Track open positions to prevent duplicates */
interface Position {
  market: string;
  outcome: string;
  size: number;
  entryPrice: number;
  timestamp: number;
}

const POSITIONS_KEY = "positions";

function getPositions(): Position[] {
  return getItem<Position[]>(POSITIONS_KEY) ?? [];
}

function addPosition(pos: Position): void {
  const positions = getPositions();
  positions.push(pos);
  setItem(POSITIONS_KEY, positions, true);
}

function hasExistingPosition(market: string, outcome: string): boolean {
  return getPositions().some((p) => p.market === market && p.outcome === outcome);
}

/** Count currently open trades from the last 5 minutes */
function getOpenTradeCount(): number {
  const trades = getAllTrades();
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
  return trades.filter((t) => t.timestamp > fiveMinutesAgo && t.status === "FILLED").length;
}

/** Simulate trade close with random outcome (for paper trading) */
function simulateTradeClose(trade: TradeRecord): void {
  if (trade.status !== "FILLED" || trade.paper === false) return;

  // Simulate holding for 10-60 seconds before closing
  const holdTime = 10000 + Math.random() * 50000;
  
  setTimeout(() => {
    // Random exit price within ±5% of entry
    const variation = (Math.random() - 0.5) * 0.1; // ±5%
    const exitPrice = trade.price * (1 + variation);
    
    // Simulate small gas fee (0.10-0.25 USDC)
    const gasFee = 0.10 + Math.random() * 0.15;
    
    // Close the trade with PnL calculation
    closeTradeWithPnL(trade.id, exitPrice, gasFee);
    
    console.log(`[trading] CLOSED: ${trade.outcome} @ ${exitPrice.toFixed(4)} (PnL: ${(trade.pnl ?? 0).toFixed(2)} USDC)`);
  }, holdTime);
}

/** Fetch active markets accepting orders from the Polymarket CLOB API. */
export async function fetchMarkets(): Promise<Market[]> {
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
 * Evaluate a market and return a trade signal if edge exceeds MIN_EDGE.
 * Respects MAX_CONCURRENT_TRADES and MAX_POSITION_SIZE limits.
 */
export async function evaluateAndTrade(market: Market): Promise<void> {
  const minEdge = parseFloat(process.env.MIN_EDGE ?? "0.05");
  const maxConcurrent = getMaxConcurrentTrades();
  const maxSize = getMaxPositionSize();
  const isPaper = isPaperMode();
  
  const openTrades = getOpenTradeCount();
  
  // Check concurrent trades limit
  if (openTrades >= maxConcurrent) {
    console.log(
      `[trading] Skipping market: ${openTrades}/${maxConcurrent} concurrent trades reached`
    );
    return;
  }
        
  if (!market.outcomes || !Array.isArray(market.outcomes) || !market.prices || !Array.isArray(market.prices)) {
    return;
  }

  const hasExtremePrice = market.prices.some((p: number) => p === 0 || p === 1);
  if (hasExtremePrice) {
    return;
  }

  for (let i = 0; i < market.outcomes.length; i++) {
    const price = market.prices[i];
    if (price === undefined) continue;

    const outcome = market.outcomes[i];

    if (hasExistingPosition(market.conditionId, outcome)) {
      console.log(`[trading] Skipping duplicate position: ${market.conditionId} / ${outcome}`);
      continue;
    }

    const edge = 1 - price - minEdge;

    console.log(`[trading] Market: ${market.question?.substring(0, 60)}`);
    console.log(`[trading]   ${outcome}: price=${price}, edge=${edge.toFixed(4)}, minEdge=${minEdge}`);

    if (edge < 0) {
      console.log(`[trading]   → SKIP (edge too low)`);
      continue;
    }

    const size = Math.min(maxSize, Math.round(edge * maxSize * 100) / 100);

    console.log(`[trading] BUY ${size} USDC of "${outcome}" @ ${price}`);

    const trade: TradeRecord = {
      id: newId(),
      timestamp: Date.now(),
      market: market.question,
      outcome,
      side: "BUY",
      size,
      price,
      entryPrice: price,
      paper: isPaper,
      status: "FILLED",
    };

    recordTrade(trade);

    // For paper trading, simulate closing the trade after a random delay
    if (isPaper) {
      simulateTradeClose(trade);
    }
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
      market: trade.market,
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
  return getOpenTradeCount();
}
