"""
Educational backtester for Jupiter Perps strategies.
Simulates trading using historical OHLCV data, indicators, and risk management.
"""

import pandas as pd
import numpy as np
from datetime import datetime
from typing import List, Dict, Tuple, Optional
import matplotlib.pyplot as plt
import seaborn as sns
from pathlib import Path

from config import indicators_config, risk_config, trading_config
from indicators import IndicatorCalculator
from risk_manager import RiskManager
from data_loader import DataLoader
from logger import logger

sns.set_style("darkgrid")
plt.rcParams["figure.figsize"] = (14, 8)


class BacktestTrade:
    """Represents a single simulated trade."""

    def __init__(
        self,
        trade_id: int,
        symbol: str,
        entry_time: pd.Timestamp,
        entry_price: float,
        direction: str,
        position_size: float,
        leverage: float,
        stop_loss: float,
        take_profit: float,
        confidence: float,
        funding_rate: float,
    ):
        self.trade_id = trade_id
        self.symbol = symbol
        self.entry_time = entry_time
        self.entry_price = entry_price
        self.direction = direction
        self.position_size = position_size
        self.leverage = leverage
        self.stop_loss = stop_loss
        self.take_profit = take_profit
        self.confidence = confidence
        self.funding_rate = funding_rate

        self.exit_time: Optional[pd.Timestamp] = None
        self.exit_price: float = 0.0
        self.exit_reason: str = ""

        self.pnl: float = 0.0
        self.pnl_pct: float = 0.0

    def close(
        self,
        exit_price: float,
        exit_time: pd.Timestamp,
        exit_reason: str = "Manual",
    ) -> None:
        """Close the trade and calculate P&L."""
        self.exit_price = exit_price
        self.exit_time = exit_time
        self.exit_reason = exit_reason

        if self.direction == "LONG":
            self.pnl = (exit_price - self.entry_price) * self.position_size * self.leverage
            self.pnl_pct = ((exit_price - self.entry_price) / self.entry_price) * 100 * self.leverage
        else:
            self.pnl = (self.entry_price - exit_price) * self.position_size * self.leverage
            self.pnl_pct = ((self.entry_price - exit_price) / self.entry_price) * 100 * self.leverage

    def to_dict(self) -> Dict:
        """Convert trade to dictionary for logging."""
        return {
            "trade_id": self.trade_id,
            "symbol": self.symbol,
            "entry_time": self.entry_time,
            "entry_price": self.entry_price,
            "direction": self.direction,
            "position_size": self.position_size,
            "leverage": self.leverage,
            "stop_loss": self.stop_loss,
            "take_profit": self.take_profit,
            "confidence": self.confidence,
            "funding_rate": self.funding_rate,
            "exit_time": self.exit_time,
            "exit_price": self.exit_price,
            "exit_reason": self.exit_reason,
            "pnl": self.pnl,
            "pnl_pct": self.pnl_pct,
            "duration_minutes": (self.exit_time - self.entry_time).total_seconds() / 60 if self.exit_time else 0,
        }


class SimpleBacktester:
    """Educational backtester for Jupiter Perps."""

    def __init__(
        self,
        initial_balance: float = 10000.0,
        indicators_cfg=None,
        risk_cfg=None,
    ):
        self.initial_balance = initial_balance
        self.balance = initial_balance
        self.indicators_cfg = indicators_cfg or indicators_config
        self.risk_cfg = risk_cfg or risk_config

        self.trades: List[BacktestTrade] = []
        self.equity_curve: List[Tuple[pd.Timestamp, float]] = []
        self.open_positions: Dict[str, BacktestTrade] = {}

        self.trade_id_counter = 0

    def run_backtest(
        self,
        df: pd.DataFrame,
        symbol: str = "SOL",
        funding_rates: Optional[pd.Series] = None,
    ) -> pd.DataFrame:
        """Run full backtest on historical data."""
        logger.info(f"Starting backtest for {symbol} | Data: {len(df)} candles | Start: {df.index[0]} | End: {df.index[-1]}")

        calc = IndicatorCalculator(self.indicators_cfg)
        df = calc.calculate_all(df)

        if funding_rates is None:
            funding_rates = pd.Series(
                np.random.uniform(-0.0005, 0.0005, len(df)),
                index=df.index,
            )

        for i in range(len(df)):
            candle = df.iloc[i]
            timestamp = df.index[i]

            if symbol in self.open_positions:
                trade = self.open_positions[symbol]
                self._check_exit(trade, candle, timestamp)

            if i < self.indicators_cfg.ema_slow + 10:
                continue

            price = candle["close"]
            signal = self._generate_signal(df.iloc[:i+1], symbol, funding_rates.iloc[i])

            if signal == "LONG" and symbol not in self.open_positions:
                self._open_position(symbol, "LONG", price, timestamp, df.iloc[:i+1], funding_rates.iloc[i])

            elif signal == "SHORT" and symbol not in self.open_positions:
                self._open_position(symbol, "SHORT", price, timestamp, df.iloc[:i+1], funding_rates.iloc[i])

            current_equity = self._calculate_equity()
            self.equity_curve.append((timestamp, current_equity))

        if symbol in self.open_positions:
            trade = self.open_positions[symbol]
            last_price = df["close"].iloc[-1]
            trade.close(last_price, df.index[-1], "Expired")
            self.trades.append(trade)
            del self.open_positions[symbol]

        logger.info(f"Backtest complete | Trades: {len(self.trades)} | Final Balance: ${self.balance:.2f}")

        return self._trades_to_dataframe()

    def _generate_signal(
        self,
        df: pd.DataFrame,
        symbol: str,
        funding_rate: float,
    ) -> str:
        """Generate trading signal based on indicators and filters."""
        calc = IndicatorCalculator(self.indicators_cfg)

        ema_signal = calc.get_ema_signal(df)
        st_signal = calc.get_supertrend_signal(df)
        macd_signal = calc.get_macd_signal(df)
        rsi_filter = calc.get_rsi_filter(df)

        confidence = calc.calculate_confidence_score(df, ema_signal)

        if ema_signal == "LONG" and st_signal == "LONG" and confidence > self.indicators_cfg.min_confidence_score:
            risk_mgr = RiskManager(self.risk_cfg)
            if risk_mgr.funding_rate_filter(funding_rate, "LONG"):
                return "LONG"

        elif ema_signal == "SHORT" and st_signal == "SHORT" and confidence > self.indicators_cfg.min_confidence_score:
            risk_mgr = RiskManager(self.risk_cfg)
            if risk_mgr.funding_rate_filter(funding_rate, "SHORT"):
                return "SHORT"

        return "NEUTRAL"

    def _open_position(
        self,
        symbol: str,
        direction: str,
        entry_price: float,
        entry_time: pd.Timestamp,
        df: pd.DataFrame,
        funding_rate: float,
    ) -> None:
        """Open a new position."""
        calc = IndicatorCalculator(self.indicators_cfg)
        confidence = calc.calculate_confidence_score(df, direction)

        stop_loss, take_profit = calc.calculate_atr_stops(df, entry_price, direction)

        risk_mgr = RiskManager(self.risk_cfg)
        position_size, leverage = risk_mgr.calculate_position_size(
            self.balance,
            entry_price,
            stop_loss,
            confidence,
        )

        if not risk_mgr.check_portfolio_limits(0.0, len(self.open_positions)):
            logger.warning(f"Portfolio limits prevented opening {direction} position")
            return

        self.trade_id_counter += 1
        trade = BacktestTrade(
            trade_id=self.trade_id_counter,
            symbol=symbol,
            entry_time=entry_time,
            entry_price=entry_price,
            direction=direction,
            position_size=position_size,
            leverage=leverage,
            stop_loss=stop_loss,
            take_profit=take_profit,
            confidence=confidence,
            funding_rate=funding_rate,
        )

        self.open_positions[symbol] = trade
        logger.info(
            f"[TRADE #{trade.trade_id}] {direction} {symbol} @ ${entry_price:.2f} | "
            f"Size: ${position_size:.2f} | Leverage: {leverage:.1f}x | SL: ${stop_loss:.2f} | TP: ${take_profit:.2f}"
        )

    def _check_exit(self, trade: BacktestTrade, candle: pd.Series, timestamp: pd.Timestamp) -> None:
        """Check if an open position should be closed (SL/TP hit)."""
        high = candle["high"]
        low = candle["low"]

        if trade.direction == "LONG":
            if low <= trade.stop_loss:
                trade.close(trade.stop_loss, timestamp, "SL")
                self.trades.append(trade)
                del self.open_positions[trade.symbol]
                logger.info(f"[TRADE #{trade.trade_id}] CLOSED (SL) | P&L: ${trade.pnl:.2f} ({trade.pnl_pct:.2f}%)")

            elif high >= trade.take_profit:
                trade.close(trade.take_profit, timestamp, "TP")
                self.trades.append(trade)
                del self.open_positions[trade.symbol]
                logger.info(f"[TRADE #{trade.trade_id}] CLOSED (TP) | P&L: ${trade.pnl:.2f} ({trade.pnl_pct:.2f}%)")

        else:
            if high >= trade.stop_loss:
                trade.close(trade.stop_loss, timestamp, "SL")
                self.trades.append(trade)
                del self.open_positions[trade.symbol]
                logger.info(f"[TRADE #{trade.trade_id}] CLOSED (SL) | P&L: ${trade.pnl:.2f} ({trade.pnl_pct:.2f}%)")

            elif low <= trade.take_profit:
                trade.close(trade.take_profit, timestamp, "TP")
                self.trades.append(trade)
                del self.open_positions[trade.symbol]
                logger.info(f"[TRADE #{trade.trade_id}] CLOSED (TP) | P&L: ${trade.pnl:.2f} ({trade.pnl_pct:.2f}%)")

    def _calculate_equity(self) -> float:
        """Calculate current account equity."""
        closed_pnl = sum(t.pnl for t in self.trades)
        return self.initial_balance + closed_pnl

    def _trades_to_dataframe(self) -> pd.DataFrame:
        """Convert trades list to DataFrame."""
        return pd.DataFrame([t.to_dict() for t in self.trades])

    def calculate_metrics(self) -> Dict:
        """Calculate backtest performance metrics."""
        if len(self.trades) == 0:
            logger.warning("No trades completed, cannot calculate metrics")
            return {}

        trades_df = pd.DataFrame([t.to_dict() for t in self.trades])

        winning_trades = trades_df[trades_df["pnl"] > 0]
        losing_trades = trades_df[trades_df["pnl"] < 0]

        win_rate = len(winning_trades) / len(trades_df) * 100 if len(trades_df) > 0 else 0
        gross_profit = winning_trades["pnl"].sum()
        gross_loss = abs(losing_trades["pnl"].sum())
        profit_factor = gross_profit / (gross_loss + 1e-8)

        equity_values = [e[1] for e in self.equity_curve]
        equity_returns = pd.Series(equity_values).pct_change().dropna()

        sharpe_ratio = (equity_returns.mean() / (equity_returns.std() + 1e-8)) * np.sqrt(252 * 24 * 12)

        cumulative_returns = (1 + equity_returns).cumprod()
        running_max = cumulative_returns.expanding().max()
        drawdown = (cumulative_returns - running_max) / running_max
        max_drawdown = drawdown.min() * 100

        annual_return = ((equity_values[-1] / equity_values[0]) ** (252 / len(self.trades)) - 1) * 100 if len(self.trades) > 0 else 0
        calmar_ratio = annual_return / (abs(max_drawdown) + 1e-8)

        metrics = {
            "total_trades": len(trades_df),
            "winning_trades": len(winning_trades),
            "losing_trades": len(losing_trades),
            "win_rate": win_rate,
            "gross_profit": gross_profit,
            "gross_loss": gross_loss,
            "profit_factor": profit_factor,
            "avg_win": winning_trades["pnl"].mean() if len(winning_trades) > 0 else 0,
            "avg_loss": losing_trades["pnl"].mean() if len(losing_trades) > 0 else 0,
            "sharpe_ratio": sharpe_ratio,
            "max_drawdown_pct": max_drawdown,
            "calmar_ratio": calmar_ratio,
            "total_pnl": self.balance - self.initial_balance,
            "total_return_pct": ((self.balance - self.initial_balance) / self.initial_balance) * 100,
        }

        return metrics

    def plot_results(self, save_path: str = "backtest_results.png") -> None:
        """Plot backtesting results."""
        fig, axes = plt.subplots(3, 1, figsize=(16, 12))

        if self.equity_curve:
            times = [e[0] for e in self.equity_curve]
            equity = [e[1] for e in self.equity_curve]
            axes[0].plot(times, equity, linewidth=2, label="Equity", color="green")
            axes[0].axhline(self.initial_balance, linestyle="--", color="red", label="Initial Balance")
            axes[0].set_ylabel("Equity ($)")
            axes[0].set_title("Equity Curve")
            axes[0].legend()
            axes[0].grid(True)

        if self.equity_curve:
            equity_values = np.array([e[1] for e in self.equity_curve])
            running_max = np.maximum.accumulate(equity_values)
            drawdown = (equity_values - running_max) / (running_max + 1e-8) * 100
            times = [e[0] for e in self.equity_curve]
            axes[1].fill_between(times, drawdown, 0, alpha=0.3, color="red", label="Drawdown")
            axes[1].set_ylabel("Drawdown (%)")
            axes[1].set_title("Underwater Plot")
            axes[1].legend()
            axes[1].grid(True)

        if self.trades:
            trades_df = pd.DataFrame([t.to_dict() for t in self.trades])
            entry_times = trades_df["entry_time"]
            entry_prices = trades_df["entry_price"]
            colors = ["green" if pnl > 0 else "red" for pnl in trades_df["pnl"]]
            axes[2].scatter(entry_times, entry_prices, c=colors, alpha=0.6, s=100)
            axes[2].set_ylabel("Price ($)")
            axes[2].set_title("Trade Entry Points (Green=Win, Red=Loss)")
            axes[2].grid(True)

        plt.tight_layout()
        plt.savefig(save_path, dpi=150)
        logger.info(f"Saved backtest chart to {save_path}")
