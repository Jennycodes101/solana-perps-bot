"""
Centralized configuration for Jupiter Perps backtester & signal generator.
All strategy parameters, risk limits, and trading symbols defined here.
"""

from dataclasses import dataclass
from typing import List
from dotenv import load_dotenv
import os

load_dotenv()


@dataclass
class IndicatorConfig:
    """Technical indicator parameters."""
    ema_fast: int = int(os.getenv("EMA_FAST", "9"))
    ema_slow: int = int(os.getenv("EMA_SLOW", "21"))
    supertrend_period: int = int(os.getenv("SUPERTREND_PERIOD", "10"))
    supertrend_multiplier: float = float(os.getenv("SUPERTREND_MULTIPLIER", "3.0"))
    macd_fast: int = int(os.getenv("MACD_FAST", "12"))
    macd_slow: int = int(os.getenv("MACD_SLOW", "26"))
    macd_signal: int = int(os.getenv("MACD_SIGNAL", "9"))
    rsi_period: int = int(os.getenv("RSI_PERIOD", "14"))
    atr_period: int = int(os.getenv("ATR_PERIOD", "14"))
    min_confidence_score: float = float(os.getenv("MIN_CONFIDENCE_SCORE", "65.0"))


@dataclass
class RiskConfig:
    """Risk management parameters."""
    max_account_risk_pct: float = float(os.getenv("MAX_ACCOUNT_RISK_PCT", "1.0"))
    max_total_exposure_pct: float = float(os.getenv("MAX_TOTAL_EXPOSURE_PCT", "5.0"))
    daily_loss_limit_pct: float = float(os.getenv("DAILY_LOSS_LIMIT_PCT", "-3.0"))
    max_concurrent_positions: int = int(os.getenv("MAX_CONCURRENT_POSITIONS", "3"))
    kelly_fraction: float = float(os.getenv("KELLY_FRACTION", "0.25"))
    atr_stop_multiplier: float = float(os.getenv("ATR_STOP_MULTIPLIER", "1.5"))
    atr_tp_multiplier: float = float(os.getenv("ATR_TP_MULTIPLIER", "3.0"))


@dataclass
class TradingConfig:
    """Trading execution parameters."""
    symbols: List[str] = None
    timeframes: List[str] = None
    backtest_mode: bool = False
    paper_trading_mode: bool = True

    def __post_init__(self):
        if self.symbols is None:
            self.symbols = os.getenv("SYMBOLS", "SOL,ETH,WBTC").split(",")
        if self.timeframes is None:
            self.timeframes = os.getenv("TIMEFRAMES", "5m,1m").split(",")
        self.backtest_mode = os.getenv("BACKTEST_MODE", "false").lower() == "true"
        self.paper_trading_mode = os.getenv("PAPER_TRADING_MODE", "true").lower() == "true"


# Global instances
indicators_config = IndicatorConfig()
risk_config = RiskConfig()
trading_config = TradingConfig()

# Validation
assert indicators_config.ema_fast < indicators_config.ema_slow, "EMA_FAST must be < EMA_SLOW"
assert risk_config.max_account_risk_pct > 0, "MAX_ACCOUNT_RISK_PCT must be positive"
assert risk_config.max_concurrent_positions > 0, "MAX_CONCURRENT_POSITIONS must be positive"

if __name__ == "__main__":
    print("Indicator Config:", indicators_config)
    print("Risk Config:", risk_config)
    print("Trading Config:", trading_config)
