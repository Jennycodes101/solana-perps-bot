import { TradeRecord } from "./stats";

/** PnL Tracking - Calculate profit/loss per trade and total */
export interface PnLData {
  tradeId: string;
  pnl: number;
  status: "OPEN" | "FILLED" | "CLOSED" | "CANCELLED";
}

export interface Position {
  market: string;
  outcome: string;
  side: "BUY" | "SELL";
  totalSize: number;
  totalCost: number;
  currentValue?: number;
  netExposure?: number;
}

export interface Analytics {
  totalTrades: number;
  closedTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnL: number;
  averagePnLPerTrade: number;
  largestWin: number;
  largestLoss: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number; // total wins / total losses
}

/** Calculate PnL for all trades */
export function calculateAllPnL(trades: TradeRecord[]): PnLData[] {
  return trades.map((trade) => ({
    tradeId: trade.id,
    pnl: trade.pnl ?? 0,
    status: trade.status,
  }));
}

/** Get position summary by market/outcome */
export function getPositionSummary(trades: TradeRecord[]): Position[] {
  const posMap = new Map<string, Position>();

  trades.forEach((trade) => {
    if (trade.status === "CANCELLED" || trade.status === "CLOSED") return; // Skip cancelled and closed trades

    const key = `${trade.market}|${trade.outcome}|${trade.side}`;
    const existing = posMap.get(key);

    if (existing) {
      existing.totalSize += trade.size;
      existing.totalCost += trade.size * trade.price;
    } else {
      posMap.set(key, {
        market: trade.market,
        outcome: trade.outcome,
        side: trade.side,
        totalSize: trade.size,
        totalCost: trade.size * trade.price,
      });
    }
  });

  // Convert to array and calculate net exposure
  return Array.from(posMap.values()).map((pos) => ({
    ...pos,
    netExposure: pos.totalCost,
    currentValue: pos.totalCost, // Will be updated when market data is available
  }));
}

/** Calculate comprehensive trade analytics */
export function calculateAnalytics(trades: TradeRecord[]): Analytics {
  // Only count CLOSED trades (trades that have settled with a PnL)
  const closedTrades = trades.filter((t) => t.status === "CLOSED" && t.pnl !== undefined);

  if (closedTrades.length === 0) {
    return {
      totalTrades: trades.length,
      closedTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      totalPnL: 0,
      averagePnLPerTrade: 0,
      largestWin: 0,
      largestLoss: 0,
      avgWin: 0,
      avgLoss: 0,
      profitFactor: 0,
    };
  }

  const pnls = closedTrades.map((t) => t.pnl!);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const totalPnL = pnls.reduce((sum, p) => sum + p, 0);

  const largestWin = wins.length > 0 ? Math.max(...wins) : 0;
  const largestLoss = losses.length > 0 ? Math.min(...losses) : 0;
  const avgWin = wins.length > 0 ? wins.reduce((sum, w) => sum + w, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((sum, l) => sum + l, 0) / losses.length : 0;

  const profitFactor =
    losses.length === 0
      ? wins.length > 0
        ? Infinity
        : 0
      : Math.abs(
          (wins.reduce((sum, w) => sum + w, 0) || 0) /
            (losses.reduce((sum, l) => sum + l, 0) || 1)
        );

  return {
    totalTrades: trades.length,
    closedTrades: closedTrades.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRate: closedTrades.length > 0 ? wins.length / closedTrades.length : 0,
    totalPnL: Math.round(totalPnL * 100) / 100,
    averagePnLPerTrade: closedTrades.length > 0 ? Math.round((totalPnL / closedTrades.length) * 100) / 100 : 0,
    largestWin: Math.round(largestWin * 100) / 100,
    largestLoss: Math.round(largestLoss * 100) / 100,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    profitFactor: Math.round(profitFactor * 100) / 100,
  };
}
