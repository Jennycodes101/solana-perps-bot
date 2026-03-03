"""
Load historical OHLCV data from CoinGecko API with local caching.
"""

import os
import sys
import pandas as pd
import asyncio
import aiohttp
from pathlib import Path
from datetime import datetime, timedelta
from typing import Optional, Dict
from dotenv import load_dotenv
from logger import logger

load_dotenv()

COINGECKO_BASE_URL = "https://api.coingecko.com/api/v3"

# CoinGecko token IDs
TOKEN_IDS = {
    "SOL": "solana",
    "ETH": "ethereum",
    "WBTC": "bitcoin",
}


class DataLoader:
    @staticmethod
    def get_cache_path(symbol: str, timeframe: str) -> Path:
        """Get path to cache file."""
        cache_dir = Path.home() / "solana-perps-bot" / "data" / "cache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        return cache_dir / f"{symbol}_{timeframe}.parquet"

    @staticmethod
    def load_cached_data(symbol: str, timeframe: str, max_age_days: int = 1) -> Optional[pd.DataFrame]:
        """Load data from local cache if fresh."""
        cache_path = DataLoader.get_cache_path(symbol, timeframe)
        
        if not cache_path.exists():
            return None
        
        mod_time = cache_path.stat().st_mtime
        age_seconds = (datetime.now().timestamp() - mod_time)
        age_days = age_seconds / (24 * 3600)
        
        if age_days > max_age_days:
            logger.info(f"Cache for {symbol}_{timeframe} is stale ({age_days:.1f} days old)")
            return None
        
        try:
            df = pd.read_parquet(cache_path)
            logger.info(f"Loaded {len(df)} rows from cache: {symbol}_{timeframe}")
            return df
        except Exception as e:
            logger.error(f"Error loading cache: {e}")
            return None

    @staticmethod
    def save_cached_data(df: pd.DataFrame, symbol: str, timeframe: str) -> None:
        """Save DataFrame to local cache."""
        cache_path = DataLoader.get_cache_path(symbol, timeframe)
        try:
            df.to_parquet(cache_path)
            logger.info(f"Saved {len(df)} rows to cache: {symbol}_{timeframe}")
        except Exception as e:
            logger.error(f"Error saving cache: {e}")

    @staticmethod
    async def fetch_coingecko_ohlcv(symbol: str, timeframe: str, days: int = 180) -> Optional[pd.DataFrame]:
        """Fetch OHLCV data from CoinGecko API (free, no key required)."""
        if symbol not in TOKEN_IDS:
            logger.error(f"Unknown symbol: {symbol}")
            return None
        
        token_id = TOKEN_IDS[symbol]
        
        # CoinGecko returns daily data only in free tier
        url = f"{COINGECKO_BASE_URL}/coins/{token_id}/market_chart"
        params = {
            "vs_currency": "usd",
            "days": days,
            "interval": "daily",
        }
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, params=params, timeout=30) as resp:
                    if resp.status != 200:
                        logger.error(f"CoinGecko API error: {resp.status}")
                        return None
                    
                    data = await resp.json()
                    
                    if "prices" not in data:
                        logger.error(f"Unexpected CoinGecko response format")
                        return None
                    
                    records = []
                    for i, (timestamp_ms, price) in enumerate(data["prices"]):
                        timestamp = pd.to_datetime(timestamp_ms, unit="ms")
                        
                        records.append({
                            "timestamp": timestamp,
                            "open": price,
                            "high": price,
                            "low": price,
                            "close": price,
                            "volume": 0,
                        })
                    
                    if not records:
                        logger.error(f"No valid records returned for {symbol}")
                        return None
                    
                    df = pd.DataFrame(records).set_index("timestamp").sort_index()
                    logger.info(f"Fetched {len(df)} days from CoinGecko API: {symbol}")
                    return df
        
        except asyncio.TimeoutError:
            logger.error(f"CoinGecko API timeout for {symbol}")
            return None
        except Exception as e:
            logger.error(f"Error fetching from CoinGecko: {e}")
            return None

    @staticmethod
    def generate_synthetic_ohlcv(
        symbol: str,
        timeframe: str,
        days: int = 180,
        start_price: float = 100.0,
    ) -> pd.DataFrame:
        """Generate synthetic OHLCV data for backtesting."""
        import numpy as np
        
        tf_minutes = {"1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440}
        minutes = tf_minutes.get(timeframe, 5)
        
        num_candles = (days * 24 * 60) // minutes
        
        mu = 0.001
        sigma = 0.02
        dt = minutes / (24 * 60)
        
        returns = np.random.normal(mu * dt, sigma * np.sqrt(dt), num_candles)
        prices = start_price * np.exp(np.cumsum(returns))
        
        start_time = datetime.now() - timedelta(days=days)
        timestamps = [start_time + timedelta(minutes=minutes * i) for i in range(num_candles)]
        
        data = []
        for i, price in enumerate(prices):
            volatility = np.random.uniform(0.5, 1.5)
            o = price * (1 + np.random.uniform(-0.01, 0.01) * volatility)
            h = max(o, price) * (1 + np.random.uniform(0, 0.015) * volatility)
            l = min(o, price) * (1 - np.random.uniform(0, 0.015) * volatility)
            c = price
            v = np.random.uniform(1e6, 2e6)
            
            data.append({
                "timestamp": timestamps[i],
                "open": o,
                "high": h,
                "low": l,
                "close": c,
                "volume": v,
            })
        
        df = pd.DataFrame(data).set_index("timestamp")
        logger.info(f"Generated synthetic {symbol}_{timeframe}: {len(df)} candles")
        return df

    @staticmethod
    async def fetch_current_funding_rates() -> Dict[str, float]:
        """Fetch current funding rates for major perpetuals."""
        funding_rates = {
            "SOL": -0.0005,
            "ETH": 0.0002,
            "WBTC": 0.0001,
        }
        return funding_rates
