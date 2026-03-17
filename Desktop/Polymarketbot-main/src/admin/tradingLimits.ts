/**
 * tradingLimits.ts — Trading Limits Management
 *
 * Manages:
 * - Maximum concurrent open trades (1-10)
 * - Maximum position size per trade
 */

import { getItem, setItem } from "../utils/jsonStore";

export interface TradingLimitsConfig {
  maxConcurrentTrades: number;
  maxPositionSizeUSDC: number;
  updatedAt: number;
  updatedBy: string;
}

const TRADING_LIMITS_KEY = "tradingLimits";

const DEFAULT_CONFIG: TradingLimitsConfig = {
  maxConcurrentTrades: 10,
  maxPositionSizeUSDC: 20,
  updatedAt: Date.now(),
  updatedBy: "system",
};

let currentConfig: TradingLimitsConfig | null = null;

export function initTradingLimits(): void {
  const stored = getItem<TradingLimitsConfig>(TRADING_LIMITS_KEY);
  if (stored) {
    currentConfig = stored;
    console.log(`[tradingLimits] Loaded: ${currentConfig.maxConcurrentTrades} concurrent trades, $${currentConfig.maxPositionSizeUSDC}/trade`);
  } else {
    currentConfig = { ...DEFAULT_CONFIG };
    setItem(TRADING_LIMITS_KEY, currentConfig, true);
    console.log(`[tradingLimits] Initialized defaults`);
  }
}

export function getTradingLimits(): TradingLimitsConfig {
  if (!currentConfig) {
    initTradingLimits();
  }
  return currentConfig ? { ...currentConfig } : { ...DEFAULT_CONFIG };
}

export function getMaxConcurrentTrades(): number {
  const config = getTradingLimits();
  return Math.max(1, Math.min(10, config.maxConcurrentTrades));
}

export function getMaxPositionSize(): number {
  const config = getTradingLimits();
  return Math.max(1, config.maxPositionSizeUSDC);
}

export function updateTradingLimits(
  updates: Partial<TradingLimitsConfig>,
  changedBy = "api"
): TradingLimitsConfig {
  if (!currentConfig) {
    initTradingLimits();
  }

  if (updates.maxConcurrentTrades !== undefined) {
    const val = updates.maxConcurrentTrades;
    if (!Number.isInteger(val) || val < 1 || val > 10) {
      throw new Error("maxConcurrentTrades must be integer 1-10");
    }
  }

  if (updates.maxPositionSizeUSDC !== undefined) {
    const val = updates.maxPositionSizeUSDC;
    if (val <= 0 || val > 10000) {
      throw new Error("maxPositionSizeUSDC must be 1-10000");
    }
  }

  currentConfig = {
    ...currentConfig!,
    ...updates,
    updatedAt: Date.now(),
    updatedBy: changedBy,
  };

  setItem(TRADING_LIMITS_KEY, currentConfig, true);

  console.log(
    `[tradingLimits] Updated: ${currentConfig.maxConcurrentTrades} concurrent, ` +
    `$${currentConfig.maxPositionSizeUSDC}/trade (by ${changedBy})`
  );

  return { ...currentConfig };
}

export function resetTradingLimits(): TradingLimitsConfig {
  currentConfig = { ...DEFAULT_CONFIG };
  setItem(TRADING_LIMITS_KEY, currentConfig, true);
  console.log("[tradingLimits] Reset to defaults");
  return { ...currentConfig };
}
