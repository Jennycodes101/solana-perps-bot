"""
Real-time signal generator using technical indicators.
Generates trading signals based on EMA, Supertrend, MACD, and RSI.
"""

import pandas as pd
import asyncio
from indicators import IndicatorCalculator
from config import indicators_config, risk_config
from data_loader import DataLoader
from risk_manager import RiskManager
from logger import logger
from rich.console import Console
from rich.table import Table

console = Console()


class SignalGenerator:
    def __init__(self, symbols: list = None, timeframe: str = "5m"):
        self.symbols = symbols or ["SOL", "ETH", "WBTC"]
        self.timeframe = timeframe
        self.data_loader = DataLoader()
        self.risk_mgr = RiskManager(risk_config)

    def generate_signal(self, symbol: str, df: pd.DataFrame, funding_rate: float = 0.0):
        """Generate a trading signal for the given symbol."""
        if df is None or df.empty or len(df) < 30:
            logger.warning(f"generate_signal: {symbol} - df is None/empty or len < 30")
            return {"signal": "NEUTRAL", "confidence": 0.0}

        try:
            calc = IndicatorCalculator(indicators_config)
            df = calc.calculate_all(df)

            ema_sig = calc.get_ema_signal(df)
            st_sig = calc.get_supertrend_signal(df)
            macd_sig = calc.get_macd_signal(df)
            rsi_filt = calc.get_rsi_filter(df)

            signal = "NEUTRAL"
            if ema_sig == "LONG" or st_sig == "LONG":
                signal = "LONG"
            elif ema_sig == "SHORT" or st_sig == "SHORT":
                signal = "SHORT"

            confidence = calc.calculate_confidence_score(df, signal)
            funding_ok = self.risk_mgr.funding_rate_filter(funding_rate, signal) if signal != "NEUTRAL" else True

            current_price = df["close"].iloc[-1]
            prev_price = df["close"].iloc[-2] if len(df) > 1 else current_price
            sl, tp = calc.calculate_atr_stops(df, current_price, signal)
            price_change_pct = ((current_price - prev_price) / prev_price) * 100 if prev_price != 0 else 0.0

            result = {
                "symbol": symbol,
                "signal": signal,
                "confidence": confidence,
                "price": current_price,
                "price_change_pct": price_change_pct,
                "rsi": df["rsi"].iloc[-1] if not pd.isna(df["rsi"].iloc[-1]) else 0.0,
                "funding_rate": funding_rate,
                "funding_ok": funding_ok,
                "stop_loss": sl,
                "take_profit": tp,
                "ema_signal": ema_sig,
                "st_signal": st_sig,
                "macd_signal": macd_sig,
            }
            logger.info(f"generate_signal: {symbol} - Signal: {signal}, Price: ${current_price:.2f}")
            return result
        except Exception as e:
            logger.error(f"Error in generate_signal for {symbol}: {e}", exc_info=True)
            return {"signal": "NEUTRAL", "confidence": 0.0}

    async def run(self, update_interval: int = 60, duration_seconds: int = None):
        """Run real-time signal generator (async)."""
        logger.info(f"Starting signal generator for {self.symbols} on {self.timeframe}")
        console.print("\n[bold cyan]Jupiter Perps Signal Generator[/bold cyan]")
        console.print(f"Symbols: {', '.join(self.symbols)}")
        console.print(f"Timeframe: {self.timeframe}")
        console.print(f"Update interval: {update_interval}s\n")

        start_time = asyncio.get_event_loop().time() if duration_seconds else None

        while True:
            try:
                if duration_seconds and start_time:
                    elapsed = asyncio.get_event_loop().time() - start_time
                    if elapsed > duration_seconds:
                        logger.info(f"Signal generator completed ({duration_seconds}s duration)")
                        break

                signals = []
                for symbol in self.symbols:
                    # Try to fetch live data from CoinGecko API
                    logger.info(f"Fetching live data for {symbol}...")
                    df = await self.data_loader.fetch_coingecko_ohlcv(symbol, self.timeframe, days=180)
                    
                    if df is None or df.empty:
                        logger.warning(f"Live data fetch failed for {symbol}, trying cache...")
                        df = self.data_loader.load_cached_data(symbol, self.timeframe)
                    else:
                        # Save the fresh data to cache
                        self.data_loader.save_cached_data(df, symbol, self.timeframe)
                    
                    logger.info(f"Loaded data for {symbol}: {df.shape if df is not None and not df.empty else 'None/Empty'}")
                    if df is not None and not df.empty:
                        funding_rate = 0.0
                        sig = self.generate_signal(symbol, df, funding_rate)
                        signals.append(sig)
                    else:
                        logger.warning(f"No data for {symbol}")

                logger.info(f"Total signals generated: {len(signals)}")
                self._display_signals(signals)
                await asyncio.sleep(update_interval)

            except Exception as e:
                logger.error(f"Error in signal generation: {e}", exc_info=True)
                await asyncio.sleep(update_interval)

    def _display_signals(self, signals):
        """Display signals in a formatted table."""
        table = Table(title="Real-Time Signals", show_header=True, header_style="bold magenta")
        table.add_column("Symbol", style="cyan")
        table.add_column("Signal", style="magenta")
        table.add_column("Confidence", style="green")
        table.add_column("Price", style="yellow")
        table.add_column("Change %", style="blue")
        table.add_column("RSI", style="white")
        table.add_column("Funding", style="white")
        table.add_column("Funding OK", style="white")

        for sig in signals:
            color = "green" if sig["signal"] == "LONG" else "red" if sig["signal"] == "SHORT" else "yellow"
            sig_str = f"[bold {color}]{sig['signal']}[/bold {color}]"
            funding_ok_str = "✓" if sig["funding_ok"] else "✗"
            table.add_row(
                sig["symbol"],
                sig_str,
                f"{sig['confidence']:.1f}%",
                f"${sig['price']:.2f}",
                f"{sig['price_change_pct']:+.2f}%",
                f"{sig['rsi']:.1f}",
                f"{sig['funding_rate']:.5f}",
                funding_ok_str,
            )
        console.print(table)
