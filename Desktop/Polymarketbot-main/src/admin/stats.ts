import { setItem, getItem, saveStore } from "../utils/jsonStore";

export interface TradeRecord {
  id: string;
  market: string;
  side: "BUY" | "SELL";
  outcome: string;
  price: number;
  size: number;
  timestamp: number;
  paper: boolean;
  status: "OPEN" | "FILLED" | "CANCELLED";
  pnl?: number;
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
  totalPnl: number;
  paperTrades: number;
  liveTrades: number;
} {
  const trades = getAllTrades();
  const totalPnl = trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  return {
    totalTrades: trades.length,
    openTrades: trades.filter((t) => t.status === "OPEN").length,
    filledTrades: trades.filter((t) => t.status === "FILLED").length,
    totalPnl: Math.round(totalPnl * 100) / 100,
    paperTrades: trades.filter((t) => t.paper).length,
    liveTrades: trades.filter((t) => !t.paper).length,
  };
}

/** Update the status of a trade by its id. */
export function updateTradeStatus(
  id: string,
  status: TradeRecord["status"],
  pnl?: number
): void {
  const trades = getItem<TradeRecord[]>(TRADES_KEY) ?? [];
  const idx = trades.findIndex((t) => t.id === id);
  if (idx !== -1) {
    trades[idx].status = status;
    if (pnl !== undefined) trades[idx].pnl = pnl;
    setItem(TRADES_KEY, trades, true);
  }
}

/** Save current trade history to disk. */
export function flushStats(): void {
  saveStore();
}
