"""
Main orchestrator: Run backtest or signal generator.
"""

import asyncio
import argparse
from pathlib import Path
from logger import logger
from config import trading_config, indicators_config, risk_config
from backtest import SimpleBacktester
from data_loader import DataLoader
from signal_generator import SignalGenerator


def run_backtest(symbol: str = "SOL", days: int = 180):
    """Run historical backtest."""
    logger.info(f"Starting backtest for {symbol} ({days} days)")

    df = DataLoader.load_cached_data(symbol, "5m", max_age_days=1)
    if df is None:
        logger.info(f"Generating synthetic data for {symbol}...")
        df = DataLoader.generate_synthetic_ohlcv(symbol, "5m", days=days, start_price=140.0)
        DataLoader.save_cached_data(df, symbol, "5m")

    bt = SimpleBacktester(initial_balance=10000.0)
    trades_df = bt.run_backtest(df, symbol=symbol)

    metrics = bt.calculate_metrics()

    print("\n" + "="*70)
    print(f"BACKTEST RESULTS: {symbol}")
    print("="*70)
    for key, value in metrics.items():
        if isinstance(value, float):
            print(f"{key:.<50} {value:.2f}")
        else:
            print(f"{key:.<50} {value}")
    print("="*70)

    trades_df.to_csv(f"trades_{symbol}.csv", index=False)
    bt.plot_results(f"backtest_{symbol}.png")

    logger.info(f"Backtest complete | Trades: {trades_df.shape[0]} | Output: trades_{symbol}.csv, backtest_{symbol}.png")


async def run_signal_generator(symbols: list = None, duration: int = None):
    """Run real-time signal generator."""
    logger.info("Starting signal generator...")

    symbols = symbols or trading_config.symbols
    sg = SignalGenerator(symbols=symbols, timeframe="5m")
    await sg.run(update_interval=60, duration_seconds=duration)


def main():
    parser = argparse.ArgumentParser(
        description="Jupiter Perps Educational Bot: Backtest & Signal Generator",
    )
    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    backtest_parser = subparsers.add_parser("backtest", help="Run backtest")
    backtest_parser.add_argument("--symbol", default="SOL", help="Symbol to backtest (default: SOL)")
    backtest_parser.add_argument("--days", type=int, default=180, help="Number of days (default: 180)")

    signal_parser = subparsers.add_parser("signals", help="Run signal generator")
    signal_parser.add_argument("--symbols", nargs="+", default=None, help="Symbols to track (default: SOL ETH WBTC)")
    signal_parser.add_argument("--duration", type=int, default=None, help="Run duration in seconds (default: indefinite)")

    args = parser.parse_args()

    if args.command == "backtest":
        run_backtest(symbol=args.symbol, days=args.days)
    elif args.command == "signals":
        asyncio.run(run_signal_generator(symbols=args.symbols, duration=args.duration))
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
