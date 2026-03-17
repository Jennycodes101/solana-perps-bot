/**
 * speedTrade.ts — Speed-Trading Strategy for Polymarket 5-Minute Markets
 *
 * This module implements a trading strategy targeting 5-minute prediction markets
 * on Polymarket. It exploits last-second price lag opportunities when prices
 * become unsynced between sources.
 *
 * Key Features:
 * - WebSocket-based low-latency price streaming
 * - Last-second lag detection and exploitation
 * - Automated trading with configurable throttling
 * - Paper trading mode for testing
 * - Wallet balance management
 */

import WebSocket from "ws";
import { getWallet, getTokenBalance, hasEnoughBalance } from "../utils/wallet";
import { recordTrade, getAllTrades, type TradeRecord } from "../admin/stats";
import { getItem, setItem, saveStore } from "../utils/jsonStore";
import { isPaperMode } from "../admin/tradingMode";
import * as fs from "fs";
import * as path from "path";

// ── Types ──────────────────────────────────────────────────────────────────

export interface MarketPriceData {
  symbol: string;
  marketId: string;
  yesTokenId: string;
  noTokenId: string;
  midPrice: number;
  bestBid: number;
  bestAsk: number;
  spread: number;
  timestamp: number;
  externalPrice?: number; // Reference price from external source
  priceHistory: number[]; // Recent price history for lag detection
}

export interface SpeedTradeConfig {
  /** Enable paper trading mode (no real orders) */
  paperMode: boolean;
  /** Minimum USDC balance required to trade */
  minBalanceUSDC: number;
  /** Maximum position size per trade in USDC */
  maxPositionSizeUSDC: number;
  /** Minimum price lag threshold to trigger trade (e.g., 0.02 = 2%) */
  lagThreshold: number;
  /** Minimum spread threshold (avoid high-spread markets) */
  maxSpread: number;
  /** Throttle: minimum milliseconds between trades per market */
  throttleMs: number;
  /** Number of price samples to track for lag detection */
  priceHistorySize: number;
  /** Time window for 5-min market resolution (ms before close) */
  lastSecondWindowMs: number;
  /** Market close detection window (ms before anticipated close) */
  closeDetectionWindowMs: number;
}

export interface SpeedTradeState {
  isRunning: boolean;
  totalTrades: number;
  successfulTrades: number;
  totalPnl: number;
  lastTradeTimestamp: number;
  lastThrottleCheck: Record<string, number>;
  currentPositions: Map<string, SpeedPosition>;
}

export interface SpeedPosition {
  marketId: string;
  symbol: string;
  side: "YES" | "NO";
  entryPrice: number;
  size: number;
  entryTimestamp: number;
}

export interface SpeedTradeResult {
  id: string;
  marketId: string;
  symbol: string;
  side: "BUY" | "SELL";
  outcome: "Yes" | "No";
  price: number;
  size: number;
  timestamp: number;
  paper: boolean;
  status: "OPEN" | "FILLED" | "CANCELLED";
  lagAmount?: number;
  expectedClose?: number;
  pnl?: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

const CLOB_WS_URL = process.env.CLOB_WS_URL ?? "wss://clob.polymarket.com/ws";
const RECONNECT_DELAY_MS = 3000;
const PRICE_HISTORY_FILE = "paper-trade-history.json";
const SPEED_TRADES_KEY = "speedTrades";

// Price calculation constants
const RECENT_PRICE_WINDOW = 5; // Number of recent prices to average for lag detection
const DEFAULT_BID_SPREAD = 0.99; // Default bid = midPrice * 0.99 (1% below)
const DEFAULT_ASK_SPREAD = 1.01; // Default ask = midPrice * 1.01 (1% above)

// Paper trading simulation constants
const PAPER_WIN_PROBABILITY = 0.6; // 60% chance of winning paper trades
const PAPER_LOSS_FACTOR = 0.5; // Losing paper trades lose 50% of potential gain

// Polymarket 5-minute market condition IDs (configurable via environment)
// These can be updated with actual Polymarket condition IDs for target markets
const MARKETS: Record<string, { conditionId: string; yesTokenId: string; noTokenId: string }> = {
  DEFAULT: {
    conditionId: process.env.MARKET_5MIN_CONDITION_ID ?? "market-5min",
    yesTokenId: process.env.MARKET_5MIN_YES_TOKEN ?? "market-5min-yes",
    noTokenId: process.env.MARKET_5MIN_NO_TOKEN ?? "market-5min-no",
  },
};

// ── Trading Mode ────────────────────────────────────────────────────────────
// Trading mode is dynamically controlled via the dashboard.
// Use isPaperMode() to check current mode at trade execution time.

// Default configuration
// Note: paperMode in this config is only used as a fallback.
// Actual mode is determined by isPaperMode() at trade execution time.
const DEFAULT_CONFIG: SpeedTradeConfig = {
  paperMode: true, // Default fallback; actual mode determined by isPaperMode()
  minBalanceUSDC: parseFloat(process.env.MIN_BALANCE_USDC ?? "10"),
  maxPositionSizeUSDC: parseFloat(process.env.MAX_POSITION_SIZE_USDC ?? "50"),
  lagThreshold: parseFloat(process.env.LAG_THRESHOLD ?? "0.02"),
  maxSpread: parseFloat(process.env.MAX_SPREAD ?? "0.05"),
  throttleMs: parseInt(process.env.THROTTLE_MS ?? "5000", 10),
  priceHistorySize: parseInt(process.env.PRICE_HISTORY_SIZE ?? "20", 10),
  lastSecondWindowMs: parseInt(process.env.LAST_SECOND_WINDOW_MS ?? "10000", 10),
  closeDetectionWindowMs: parseInt(process.env.CLOSE_DETECTION_WINDOW_MS ?? "60000", 10),
};

// ── State ──────────────────────────────────────────────────────────────────

let ws: WebSocket | null = null;
let isConnecting = false;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let priceData: Map<string, MarketPriceData> = new Map();
let config: SpeedTradeConfig = { ...DEFAULT_CONFIG };
let _tradeIdCounter = 0;

const state: SpeedTradeState = {
  isRunning: false,
  totalTrades: 0,
  successfulTrades: 0,
  totalPnl: 0,
  lastTradeTimestamp: 0,
  lastThrottleCheck: {},
  currentPositions: new Map(),
};

// ── Utility Functions ──────────────────────────────────────────────────────

function newTradeId(): string {
  return `speed-${Date.now()}-${++_tradeIdCounter}`;
}

function log(message: string, level: "info" | "warn" | "error" = "info"): void {
  const timestamp = new Date().toISOString();
  const prefix = `[speedTrade][${level.toUpperCase()}]`;
  if (level === "error") {
    console.error(`${prefix} ${timestamp} ${message}`);
  } else if (level === "warn") {
    console.warn(`${prefix} ${timestamp} ${message}`);
  } else {
    console.log(`${prefix} ${timestamp} ${message}`);
  }
}

/** Calculate the next 5-minute market close time. */
function getNextMarketClose(): number {
  const now = Date.now();
  const FIVE_MINUTES_MS = 5 * 60 * 1000;
  return Math.ceil(now / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
}

/** Check if we are in the last-second window before market close. */
function isInLastSecondWindow(): boolean {
  const nextClose = getNextMarketClose();
  const timeToClose = nextClose - Date.now();
  return timeToClose <= config.lastSecondWindowMs && timeToClose > 0;
}

/** Calculate price lag between current price and historical average. */
function calculatePriceLag(data: MarketPriceData): number {
  if (data.priceHistory.length < 3) return 0;
  
  const windowSize = Math.min(RECENT_PRICE_WINDOW, data.priceHistory.length);
  const recentAvg = data.priceHistory.slice(-RECENT_PRICE_WINDOW).reduce((a, b) => a + b, 0) / windowSize;
  return Math.abs(data.midPrice - recentAvg);
}

/** Detect if price is lagging (unsynced) compared to recent history. */
function detectPriceLag(data: MarketPriceData): { isLagging: boolean; lagAmount: number; direction: "up" | "down" } {
  const lagAmount = calculatePriceLag(data);
  const isLagging = lagAmount >= config.lagThreshold;
  
  const windowSize = Math.min(RECENT_PRICE_WINDOW, data.priceHistory.length);
  const recentAvg = data.priceHistory.slice(-RECENT_PRICE_WINDOW).reduce((a, b) => a + b, 0) / windowSize;
  const direction = data.midPrice < recentAvg ? "down" : "up";
  
  return { isLagging, lagAmount, direction };
}

/** Check if throttle period has passed for a market. */
function isThrottled(marketId: string): boolean {
  const lastTrade = state.lastThrottleCheck[marketId] ?? 0;
  return Date.now() - lastTrade < config.throttleMs;
}

/** Update throttle timestamp for a market. */
function updateThrottle(marketId: string): void {
  state.lastThrottleCheck[marketId] = Date.now();
}

// ── WebSocket Connection ───────────────────────────────────────────────────

/** Connect to Polymarket CLOB WebSocket for low-latency prices. */
export function connectWebSocket(): void {
  if (ws !== null || isConnecting) {
    return;
  }

  isConnecting = true;
  log(`Connecting to ${CLOB_WS_URL}...`);

  ws = new WebSocket(CLOB_WS_URL);

  ws.on("open", () => {
    isConnecting = false;
    log("Connected to Polymarket WebSocket");
    subscribeToMarkets();
  });

  ws.on("message", (raw: WebSocket.RawData) => {
    try {
      const data = JSON.parse(raw.toString());
      handlePriceMessage(data);
    } catch (err) {
      log(`Failed to parse WebSocket message: ${err}`, "error");
    }
  });

  ws.on("error", (err: Error) => {
    log(`WebSocket error: ${err.message}`, "error");
  });

  ws.on("close", (code: number, reason: Buffer) => {
    log(`Disconnected (code=${code}, reason=${reason.toString()})`, "warn");
    ws = null;
    isConnecting = false;
    scheduleReconnect();
  });
}

/** Disconnect from WebSocket. */
export function disconnectWebSocket(): void {
  if (reconnectTimeout !== null) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  if (ws !== null) {
    ws.close();
    ws = null;
  }

  isConnecting = false;
  log("Disconnected from WebSocket");
}

/** Schedule reconnection attempt. */
function scheduleReconnect(): void {
  if (reconnectTimeout !== null || !state.isRunning) {
    return;
  }

  log(`Reconnecting in ${RECONNECT_DELAY_MS}ms...`);
  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    if (state.isRunning) {
      connectWebSocket();
    }
  }, RECONNECT_DELAY_MS);
}

/** Subscribe to market price feeds. */
function subscribeToMarkets(): void {
  if (ws === null || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  const markets = Object.values(MARKETS).map((m) => m.conditionId);
  log(`Subscribing to ${markets.length} markets: ${markets.join(", ")}`);
  
  ws.send(JSON.stringify({
    action: "subscribe",
    markets,
  }));
}

/** Handle incoming price messages. */
function handlePriceMessage(data: unknown): void {
  if (typeof data !== "object" || data === null) {
    return;
  }

  const msg = data as Record<string, unknown>;

  // Handle price update messages
  if ("midPrice" in msg && typeof msg.midPrice === "number") {
    const marketId = (msg.market ?? msg.marketId ?? msg.conditionId) as string | undefined;
    if (!marketId) return;

    // Find the symbol for this market
    const symbol = Object.entries(MARKETS).find(
      ([, m]) => m.conditionId === marketId
    )?.[0] as string | undefined;

    if (!symbol) return;

    const marketConfig = MARKETS[symbol];
    const existing = priceData.get(marketId);
    const priceHistory = existing?.priceHistory ?? [];
    
    // Update price history (keep last N samples)
    priceHistory.push(msg.midPrice);
    if (priceHistory.length > config.priceHistorySize) {
      priceHistory.shift();
    }

    const bestBid = typeof msg.bestBid === "number" ? msg.bestBid : msg.midPrice * DEFAULT_BID_SPREAD;
    const bestAsk = typeof msg.bestAsk === "number" ? msg.bestAsk : msg.midPrice * DEFAULT_ASK_SPREAD;

    const updatedData: MarketPriceData = {
      symbol,
      marketId,
      yesTokenId: marketConfig.yesTokenId,
      noTokenId: marketConfig.noTokenId,
      midPrice: msg.midPrice,
      bestBid,
      bestAsk,
      spread: bestAsk - bestBid,
      timestamp: Date.now(),
      priceHistory,
    };

    priceData.set(marketId, updatedData);
    
    // Evaluate trade opportunity
    if (state.isRunning) {
      evaluateTradeOpportunity(updatedData);
    }
  }
}

// ── Trading Logic ──────────────────────────────────────────────────────────

/** Evaluate if there's a trade opportunity based on price lag. */
async function evaluateTradeOpportunity(data: MarketPriceData): Promise<void> {
  // Check throttle
  if (isThrottled(data.marketId)) {
    return;
  }

  // Check spread (avoid high-spread markets)
  if (data.spread > config.maxSpread) {
    log(`Skipping ${data.symbol}: spread ${data.spread.toFixed(4)} exceeds max ${config.maxSpread}`, "warn");
    return;
  }

  // Detect price lag
  const { isLagging, lagAmount, direction } = detectPriceLag(data);
  
  if (!isLagging) {
    return;
  }

  // Check if we're in last-second window (for extra edge)
  const inLastSecondWindow = isInLastSecondWindow();
  const nextClose = getNextMarketClose();
  
  log(`Lag detected for ${data.symbol}: ${lagAmount.toFixed(4)} (${direction}), lastSecond=${inLastSecondWindow}`);

  // Determine trade side based on lag direction
  // If price is lagging DOWN (below average), it might bounce back - buy YES
  // If price is lagging UP (above average), it might drop - buy NO
  const outcome: "Yes" | "No" = direction === "down" ? "Yes" : "No";
  const tokenId = outcome === "Yes" ? data.yesTokenId : data.noTokenId;
  const price = outcome === "Yes" ? data.midPrice : (1 - data.midPrice);

  // Calculate position size based on lag amount (higher lag = more confident)
  const confidenceFactor = Math.min(lagAmount / config.lagThreshold, 2);
  const baseSize = config.maxPositionSizeUSDC * 0.5;
  const size = Math.min(baseSize * confidenceFactor, config.maxPositionSizeUSDC);

  // Check balance (for live trades)
  if (!isPaperMode()) {
    const hasBalance = await hasEnoughBalance("USDC", Math.max(size, config.minBalanceUSDC));
    if (!hasBalance) {
      log(`Insufficient USDC balance for trade`, "warn");
      return;
    }
  }

  // Execute trade
  await executeTrade({
    marketId: data.marketId,
    symbol: data.symbol,
    tokenId,
    outcome,
    price,
    size,
    lagAmount,
    expectedClose: nextClose,
    inLastSecondWindow,
  });
}

interface ExecuteTradeParams {
  marketId: string;
  symbol: string;
  tokenId: string;
  outcome: "Yes" | "No";
  price: number;
  size: number;
  lagAmount: number;
  expectedClose: number;
  inLastSecondWindow: boolean;
}

/** Execute a trade (paper or live). */
async function executeTrade(params: ExecuteTradeParams): Promise<void> {
  const { marketId, symbol, tokenId, outcome, price, size, lagAmount, expectedClose, inLastSecondWindow } = params;

  // Use dynamic trading mode
  const paperMode = isPaperMode();

  const trade: SpeedTradeResult = {
    id: newTradeId(),
    marketId,
    symbol,
    side: "BUY",
    outcome,
    price,
    size,
    timestamp: Date.now(),
    paper: paperMode,
    status: "OPEN",
    lagAmount,
    expectedClose,
    pnl: 0,
  };

  try {
    if (paperMode) {
      // Paper trade - simulate execution
      log(`[PAPER] BUY ${size.toFixed(2)} USDC of ${symbol} ${outcome} @ ${price.toFixed(4)} (lag=${lagAmount.toFixed(4)}, lastSec=${inLastSecondWindow})`);
      trade.status = "FILLED";
      
      // Simulate PnL for paper trades based on configurable win probability
      const isWinningTrade = Math.random() < PAPER_WIN_PROBABILITY;
      const simulatedPnl = size * lagAmount * (isWinningTrade ? 1 : -PAPER_LOSS_FACTOR);
      trade.pnl = Math.round(simulatedPnl * 100) / 100;
    } else {
      // Live trade - submit to CLOB
      log(`[LIVE] BUY ${size.toFixed(2)} USDC of ${symbol} ${outcome} @ ${price.toFixed(4)}`);
      
      // Import and use orders module for live trades
      const { placeOrder } = await import("./orders");
      await placeOrder(tokenId, price, size, "buy");
      trade.status = "FILLED";
    }

    // Update state
    state.totalTrades++;
    state.lastTradeTimestamp = Date.now();
    updateThrottle(marketId);

    if (trade.status === "FILLED") {
      state.successfulTrades++;
      state.totalPnl += trade.pnl ?? 0;
      
      // Track position
      state.currentPositions.set(marketId, {
        marketId,
        symbol,
        side: outcome === "Yes" ? "YES" : "NO",
        entryPrice: price,
        size,
        entryTimestamp: Date.now(),
      });
    }

    // Record trade to stats
    const tradeRecord: TradeRecord = {
      id: trade.id,
      market: marketId,
      side: trade.side,
      outcome: trade.outcome,
      price: trade.price,
      size: trade.size,
      timestamp: trade.timestamp,
      paper: trade.paper,
      status: trade.status,
      pnl: trade.pnl,
    };
    recordTrade(tradeRecord);

    // Append to paper trade history file
    appendToPaperHistory(trade);

  } catch (err) {
    log(`Trade execution failed: ${err}`, "error");
    trade.status = "CANCELLED";
  }
}

/** Append trade to paper-trade-history.json. */
function appendToPaperHistory(trade: SpeedTradeResult): void {
  const historyPath = path.join(process.cwd(), PRICE_HISTORY_FILE);
  
  let history: SpeedTradeResult[] = [];
  try {
    if (fs.existsSync(historyPath)) {
      const raw = fs.readFileSync(historyPath, "utf-8");
      history = JSON.parse(raw);
    }
  } catch {
    history = [];
  }

  history.push(trade);

  try {
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), "utf-8");
    log(`Trade recorded to ${PRICE_HISTORY_FILE}`);
  } catch (err) {
    log(`Failed to write paper history: ${err}`, "error");
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Start the speed trading loop. Supports both paper and live trading modes. */
export async function startSpeedTrading(customConfig?: Partial<SpeedTradeConfig>): Promise<void> {
  if (state.isRunning) {
    log("Speed trading already running", "warn");
    return;
  }

  // Use dynamic trading mode from dashboard
  const paperMode = isPaperMode();
  
  // Merge custom config with dynamic paper mode
  config = { ...DEFAULT_CONFIG, ...customConfig, paperMode };
  
  log(`Starting speed trading (mode=${paperMode ? 'PAPER' : 'LIVE'}, throttle=${config.throttleMs}ms, lagThreshold=${config.lagThreshold})`);
  
  // Check balance for live trading
  if (!paperMode) {
    const hasBalance = await hasEnoughBalance("USDC", config.minBalanceUSDC);
    if (!hasBalance) {
      throw new Error(`Insufficient USDC balance. Minimum required: ${config.minBalanceUSDC} USDC`);
    }
    log("Live trading enabled - balance check passed");
  }

  state.isRunning = true;
  state.totalTrades = 0;
  state.successfulTrades = 0;
  state.totalPnl = 0;
  state.lastTradeTimestamp = 0;
  state.lastThrottleCheck = {};
  state.currentPositions.clear();

  // Connect to WebSocket for low-latency prices
  connectWebSocket();

  log("Speed trading started - 24/7 monitoring active");
}

/** Stop the speed trading loop. */
export function stopSpeedTrading(): void {
  if (!state.isRunning) {
    return;
  }

  log("Stopping speed trading...");
  state.isRunning = false;
  
  disconnectWebSocket();
  
  // Persist state
  saveStore();
  
  log(`Speed trading stopped. Total trades: ${state.totalTrades}, PnL: $${state.totalPnl.toFixed(2)}`);
}

/** Get current speed trading state. */
export function getSpeedTradeState(): SpeedTradeState & { prices: MarketPriceData[] } {
  return {
    ...state,
    currentPositions: new Map(state.currentPositions),
    prices: Array.from(priceData.values()),
  };
}

/** Get current configuration. */
export function getSpeedTradeConfig(): SpeedTradeConfig {
  return { ...config };
}

/** Update configuration (can be done while running). */
export function updateSpeedTradeConfig(updates: Partial<SpeedTradeConfig>): void {
  config = { ...config, ...updates };
  log(`Config updated: ${JSON.stringify(updates)}`);
}

/** Check if speed trading is running. */
export function isSpeedTradingRunning(): boolean {
  return state.isRunning;
}

/** Get all speed trades from history. */
export function getSpeedTradeHistory(): SpeedTradeResult[] {
  const historyPath = path.join(process.cwd(), PRICE_HISTORY_FILE);
  
  try {
    if (fs.existsSync(historyPath)) {
      const raw = fs.readFileSync(historyPath, "utf-8");
      return JSON.parse(raw);
    }
  } catch {
    // Fall through
  }
  
  return [];
}

/** Get price data for a specific market symbol. */
export function getMarketPriceData(symbol: string): MarketPriceData | undefined {
  const marketConfig = MARKETS[symbol];
  if (!marketConfig) return undefined;
  return priceData.get(marketConfig.conditionId);
}

/** Manually trigger a trade opportunity check (for testing). */
export async function triggerTradeCheck(symbol: string): Promise<void> {
  const data = getMarketPriceData(symbol);
  if (data) {
    await evaluateTradeOpportunity(data);
  }
}
