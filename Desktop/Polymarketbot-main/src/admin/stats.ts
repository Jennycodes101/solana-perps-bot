import { setItem, getItem, saveStore } from "../utils/jsonStore";

export interface TradeRecord {
  id: string;
  marketId: string;  // condition_id for deduplication
  market: string;    // question for display
  side: "BUY" | "SELL";
  outcome: string;
  price: number;
  size: number;
  timestamp: number;
  closedAt?: number;
  paper: boolean;
  status: "OPEN" | "FILLED" | "CLOSED" | "CANCELLED";
  pnl?: number;
  entryPrice?: number;
  exitPrice?: number;
  gasFee?: number;
}

const TRADES_KEY = "trades";

/** Append a trade record to the in-memory store and persist. */
export function recordTrade(trade: TradeRecord): void {
  const trades = getItem<TradeRecord[]>(TRADES_KEY) ?? [];
  trades.push(trade);
  setItem(TRADES_KEY, trades, true);
}

/** Return all recorded trades. */
export function getAllTrades(): TradeRecord[] {
  return getItem<TradeRecord[]>(TRADES_KEY) ?? [];
}

/** Compute aggregate stats from stored trades. */
export function getStats(): {
  totalTrades: number;
  openTrades: number;
  filledTrades: number;
  closedTrades: number;
  totalPnl: number;
  paperTrades: number;
  liveTrades: number;
} {
  const trades = getAllTrades();
  const closedTrades = trades.filter((t) => t.status === "CLOSED");
  const totalPnl = closedTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  
  return {
    totalTrades: trades.length,
    openTrades: trades.filter((t) => t.status === "OPEN").length,
    filledTrades: trades.filter((t) => t.status === "FILLED").length,
    closedTrades: closedTrades.length,
    totalPnl: Math.round(totalPnl * 100) / 100,
    paperTrades: trades.filter((t) => t.paper).length,
    liveTrades: trades.filter((t) => !t.paper).length,
  };
}

/** Update the status of a trade by its id. */
export function updateTradeStatus(
  id: string,
  status: TradeRecord["status"],
  pnl?: number,
  closedAt?: number
): void {
  const trades = getItem<TradeRecord[]>(TRADES_KEY) ?? [];
  const idx = trades.findIndex((t) => t.id === id);
  if (idx !== -1) {
    trades[idx].status = status;
    if (pnl !== undefined) trades[idx].pnl = pnl;
    if (closedAt !== undefined) trades[idx].closedAt = closedAt;
    setItem(TRADES_KEY, trades, true);
  }
}

/** Close a trade with PnL calculation (entry price vs exit price). */
export function closeTradeWithPnL(
  id: string,
  exitPrice: number,
  gasFee: number = 0
): void {
  const trades = getItem<TradeRecord[]>(TRADES_KEY) ?? [];
  const idx = trades.findIndex((t) => t.id === id);
  
  if (idx !== -1) {
    const trade = trades[idx];
    const entryPrice = trade.entryPrice ?? trade.price;
    
    // Calculate PnL: (exitPrice - entryPrice) * size - gasFee
    let pnl = (exitPrice - entryPrice) * trade.size - gasFee;
    
    // If SELL, invert the calculation
    if (trade.side === "SELL") {
      pnl = (entryPrice - exitPrice) * trade.size - gasFee;
    }
    
    trades[idx].status = "CLOSED";
    trades[idx].exitPrice = exitPrice;
    trades[idx].pnl = Math.round(pnl * 100) / 100;
    trades[idx].closedAt = Date.now();
    
    setItem(TRADES_KEY, trades, true);
  }
}

/** Save current trade history to disk. */
export function flushStats(): void {
  saveStore();
}
