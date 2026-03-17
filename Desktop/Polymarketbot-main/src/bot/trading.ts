import axios from "axios";
import { ClobClient, Chain } from "@polymarket/clob-client";
import { getWallet, getTokenBalance } from "../utils/wallet";
import { recordTrade, getAllTrades } from "../admin/stats";
import { getItem, setItem } from "../utils/jsonStore";
import { isPaperMode } from "../admin/tradingMode";
import { 
  recordTradeAnalytics, 
  checkRiskLimits, 
  shouldRebalanceToTarget,
  getDailySummary,
  getProfitabilityByType,
  pauseTradingDueToRiskLimit,
  lockInWinners,
  resetDailyCounters
} from "./analytics";
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
const TRADING_PAUSED_KEY = "trading_paused";
const STARTING_BALANCE = 1000; // Reference balance for risk limits

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

function isTradingPaused(): boolean {
  return getItem<boolean>(TRADING_PAUSED_KEY) ?? false;
}

function setPausedStatus(paused: boolean): void {
  setItem(TRADING_PAUSED_KEY, paused, true);
}

/** Cursor value returned by the CLOB API when there are no more pages. */
const END_OF_RESULTS_CURSOR = "LTE=";

/** Market cache for reducing API calls */
let _marketCache: Market[] = [];
let _lastFetchTime = 0;
const CACHE_TTL_MS = 4 * 60 * 1000; // 4 minutes

/** Return a read-only ClobClient for public market data (no credentials required). */
function getClobClient(): ClobClient {
  const host = process.env.CLOB_API_URL ?? "https://clob.polymarket.com";
  const chainId = parseInt(process.env.CHAIN_ID ?? "137", 10) as Chain;
  return new ClobClient(host, chainId);
}

/** Classify market type based on slug patterns */
function getMarketType(slug: string): string {
  if (!slug) return "other";
  const lower = slug.toLowerCase();
  
  if (/^(nba|nfl|nhl|ncaab|mlb|mls|soccer|football|cricket|rugby|tennis|golf|boxing|mma|ufc)-/.test(lower) ||
      lower.includes("super-bowl") ||
      lower.includes("world-cup") ||
      lower.includes("championship")) {
    return "sports";
  }
  
  if (/crypto|bitcoin|ethereum|eth-|btc-|token|defi|nft|web3|blockchain|opensea|blur/.test(lower)) {
    return "crypto";
  }
  
  if (/2024|2025|2026|election|president|senate|congress|parliament|impeach|brexit/.test(lower) ||
      lower.includes("will-")) {
    return "politics";
  }
  
  if (/oscar|grammy|emmy|golden-globe|bafta|cannes|tribeca/.test(lower) ||
      lower.includes("celebrity") ||
      lower.includes("actor")) {
    return "entertainment";
  }
  
  return "other";
}

/** Check if market should be included based on filters */
function shouldIncludeMarket(market: any, counts: Record<string, number>): boolean {
  const marketTypes = process.env.MARKET_TYPES?.split(",").map(t => t.trim()) || ["sports", "crypto"];
  const maxPerType = parseInt(process.env.MAX_MARKETS_PER_TYPE || "200", 10);
  
  const type = getMarketType(market.market_slug);
  
  if (!marketTypes.includes(type)) return false;
  if ((counts[type] || 0) >= maxPerType) return false;
  
  return true;
}

/** Calculate liquidity score (0-1) based on order book spread and volume indicators */
function calculateLiquidityScore(market: Market): number {
  if (!market.prices || market.prices.length === 0) return 0;
  
  const hasExtremePrice = market.prices.some((p: number) => p === 0 || p === 1);
  if (hasExtremePrice) return 0;
  
  const priceBalance = market.prices.map(p => Math.abs(p - 0.5)).reduce((a, b) => a + b, 0) / market.prices.length;
  const balanceScore = 1 - priceBalance;
  
  return balanceScore;
}

/** Calculate edge accounting for transaction costs and slippage */
function calculateAdjustedEdge(impliedPrice: number, minEdge: number = 0.05): number {
  const txCost = 0.005;
  const rawEdge = 1 - impliedPrice - minEdge;
  return Math.max(0, rawEdge - txCost);
}

/** Calculate bet size based on edge and confidence */
function calculateBetSize(edge: number, liquidity: number, maxSize: number): number {
  const edgeRatio = Math.min(edge / 0.2, 1);
  const liquidityRatio = liquidity;
  const confidence = edgeRatio * liquidityRatio;
  const sizeMultiplier = 0.2 + (confidence * 0.8);
  return Math.round(maxSize * sizeMultiplier * 100) / 100;
}

/** Fetch active markets accepting orders from the Polymarket CLOB API with filtering. */
export async function fetchMarkets(): Promise<Market[]> {
  const now = Date.now();
  
  if (_marketCache.length > 0 && (now - _lastFetchTime) < CACHE_TTL_MS) {
    console.log(`[trading] Using cached markets (${_marketCache.length} markets, age: ${Math.round((now - _lastFetchTime) / 1000)}s)`);
    return _marketCache;
  }
  
  console.log(`[trading] Fetching fresh markets (cache expired or empty)`);
  
  const client = getClobClient();
  const markets: Market[] = [];
  const typeCounts: Record<string, number> = {};
  const maxPerType = parseInt(process.env.MAX_MARKETS_PER_TYPE || "200", 10);
  const marketTypes = process.env.MARKET_TYPES?.split(",").map(t => t.trim()) || ["sports", "crypto"];
  let cursor: string | undefined = undefined;

  console.log(`[trading] Filtering markets by types: ${marketTypes.join(", ")}, max ${maxPerType} per type`);

  try {
    do {
      const response = await client.getMarkets(cursor);
      const rawMarkets: any[] = response.data ?? [];

      console.log(`[trading] Fetched ${rawMarkets.length} markets (cursor: ${cursor ?? "initial"}), current counts: ${JSON.stringify(typeCounts)}`);

      for (const m of rawMarkets) {
        if (
          m.accepting_orders === true &&
          m.tokens &&
          Array.isArray(m.tokens) &&
          m.tokens.length > 0 &&
          shouldIncludeMarket(m, typeCounts)
        ) {
          const type = getMarketType(m.market_slug);
          typeCounts[type] = (typeCounts[type] || 0) + 1;
          
          markets.push({
            conditionId: m.condition_id,
            condition_id: m.condition_id,
            question: m.question,
            outcomes: m.tokens.map((t: any) => t.outcome),
            prices: m.tokens.map((t: any) => t.price),
            tokens: m.tokens,
          });
        }
      }

      const hasEnough = marketTypes.every(type => (typeCounts[type] || 0) >= maxPerType);
      if (hasEnough) {
        console.log(`[trading] ✓ Reached target market counts!`);
        break;
      }

      cursor = response.next_cursor;
    } while (cursor && cursor !== END_OF_RESULTS_CURSOR);

    _marketCache = markets;
    _lastFetchTime = now;

    console.log(`[trading] ✓ Total markets collected: ${markets.length}`);
    console.log(`[trading] ✓ Markets by type: ${JSON.stringify(typeCounts)}`);
    return markets;
  } catch (err) {
    console.error("[trading] fetchMarkets error:", err);
    return _marketCache;
  }
}

/**
 * Evaluate a market and return a trade signal if edge exceeds MIN_EDGE.
 * Includes position tracking, liquidity filtering, and confidence-based sizing.
 */
export async function evaluateAndTrade(market: Market): Promise<void> {
  if (isTradingPaused()) {
    return; // Skip evaluation if trading is paused
  }

  const minEdge = parseFloat(process.env.MIN_EDGE ?? "0.05");
  const maxSize = parseFloat(process.env.MAX_POSITION_SIZE_USDC ?? "100");
  const minLiquidity = parseFloat(process.env.MIN_LIQUIDITY ?? "0.3");
  const isPaper = isPaperMode();
        
  if (!market.outcomes || !Array.isArray(market.outcomes) || !market.prices || !Array.isArray(market.prices)) {
    return;
  }

  const liquidityScore = calculateLiquidityScore(market);
  if (liquidityScore < minLiquidity) {
    return;
  }

  for (let i = 0; i < market.outcomes.length; i++) {
    const price = market.prices[i];
    if (price === undefined) continue;

    const outcome = market.outcomes[i];

    if (hasExistingPosition(market.conditionId, outcome)) {
      continue;
    }

    const adjustedEdge = calculateAdjustedEdge(price, minEdge);

    if (adjustedEdge <= 0) {
      continue;
    }

    const betSize = calculateBetSize(adjustedEdge, liquidityScore, maxSize);

    console.log(`[trading] Market: ${market.question?.substring(0, 60)}`);
    console.log(`[trading]   ${outcome}: price=${price.toFixed(3)}, adjusted_edge=${adjustedEdge.toFixed(4)}, liquidity=${liquidityScore.toFixed(2)}, bet=${betSize}USDC`);

    console.log(`[paper-trade] BUY ${betSize} USDC of "${outcome}" @ ${price}`);

    recordTrade({
      id: newId(),
      marketId: market.condition_id,
      market: market.question,
      outcome,
      side: "BUY",
      size: betSize,
      price,
      paper: isPaper,
      status: "FILLED",
      timestamp: Date.now(),
    });
  }
}

/**
 * Submit a real order to the Polymarket CLOB API.
 */
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

const FIVE_MINUTE_INTERVAL_MS = 300000; // 5 minutes

/** Main trading loop — polls markets and evaluates trade signals. */
export async function runTradingLoop(): Promise<void> {
  const interval = FIVE_MINUTE_INTERVAL_MS;
  console.log(`[trading] Starting 5-minute trading loop (interval=${interval}ms)`);
  console.log(`[trading] Trading mode: ${isPaperMode() ? 'PAPER' : 'LIVE'}`);
  _isRunning = true;

  const tick = async () => {
    if (!_isRunning) return;
    
    try {
      // Check risk limits before trading
      const riskCheck = checkRiskLimits(STARTING_BALANCE);
      if (riskCheck.breached) {
        if (!isTradingPaused()) {
          pauseTradingDueToRiskLimit();
          setPausedStatus(true);
        }
        return;
      }

      // Check if profit target reached
      const rebalanceCheck = shouldRebalanceToTarget();
      if (rebalanceCheck.shouldRebalance) {
        lockInWinners();
        resetDailyCounters();
      }

      // Normal trading logic
      const markets = await fetchMarkets();
      console.log(`[trading] Evaluating ${markets.length} markets…`);
      for (const market of markets) {
        if (!_isRunning) break;
        await evaluateAndTrade(market);
      }

      // Log daily summary
      const summary = getDailySummary();
      console.log(`[analytics] Daily Summary: P&L=$${summary.dailyPnL.toFixed(2)}, Win Rate=${(summary.winRate * 100).toFixed(1)}%`);
      
      const profitsByType = getProfitabilityByType();
      for (const [type, data] of Object.entries(profitsByType)) {
        console.log(`  ${type}: $${data.pnl.toFixed(2)} (${(data.winRate * 100).toFixed(1)}% WR, ${data.trades} trades)`);
      }

      // Resume trading if conditions improve
      if (riskCheck.breached === false && isTradingPaused()) {
        setPausedStatus(false);
        console.log(`[trading] ✓ Risk conditions cleared - resuming trading`);
      }

    } catch (err) {
      console.error("[trading] Error in trading tick:", err);
    }
  };

  await tick();
  _tradingLoopTimer = setInterval(tick, interval);
}

/** Stop the trading loop gracefully. */
export function stopTradingLoop(): void {
  console.log("[trading] Stopping trading loop...");
  _isRunning = false;
  if (_tradingLoopTimer) {
    clearInterval(_tradingLoopTimer);
    _tradingLoopTimer = null;
  }
  console.log("[trading] Trading loop stopped");
}

/** Check if the trading loop is currently running. */
export function isTradingLoopRunning(): boolean {
  return _isRunning;
}
