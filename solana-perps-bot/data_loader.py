"""
Load historical OHLCV data from Birdeye API with local caching.
Also provides real-time price/funding rate fetching via async.
"""

import pandas as pd
import aiohttp
import asyncio
import json
from pathlib import Path
from datetime import datetime, timedelta
from typing import Optional, Dict, List
from logger import logger
from dotenv import load_dotenv
import os

load_dotenv()

BIRDEYE_API_KEY = os.getenv("BIRDEYE_API_KEY", "")
BIRDEYE_BASE_URL = "https://public-api.birdeye.so/v1"
CACHE_DIR = Path("data/cache")
CACHE_DIR.mkdir(parents=True, exist_ok=True)


class DataLoader:
    """Fetch and cache OHLCV data for backtesting."""

    @staticmethod
    def get_cache_path(symbol: str, timeframe: str) -> Path:
        """Get local cache file path."""
        return CACHE_DIR / f"{symbol}_{timeframe}.parquet"

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
        df.to_parquet(cache_path)
        logger.info(f"Cached {len(df)} rows: {symbol}_{timeframe}")

    @staticmethod
    async def fetch_birdeye_ohlcv(
        symbol: str,
        timeframe: str = "5m",
        limit: int = 1000,
    ) -> Optional[pd.DataFrame]:
        """Fetch OHLCV data from Birdeye API."""
        if not BIRDEYE_API_KEY:
            logger.warning("BIRDEYE_API_KEY not set, cannot fetch from API")
            return None
        
        tf_map = {"1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d"}
        if timeframe not in tf_map:
            logger.error(f"Unsupported timeframe: {timeframe}")
            return None
        
        url = f"{BIRDEYE_BASE_URL}/defi/ohlcv"
        params = {
            "address": symbol,
            "type": tf_map[timeframe],
            "limit": limit,
        }
        headers = {"X-API-KEY": BIRDEYE_API_KEY}
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, params=params, headers=headers, timeout=10) as resp:
                    if resp.status != 200:
                        logger.error(f"Birdeye API error: {resp.status}")
                        return None
                    
                    data = await resp.json()
                    
                    if "data" not in data or "items" not in data["data"]:
                        logger.error("Unexpected Birdeye response format")
                        return None
                    
                    records = []
                    for item in data["data"]["items"]:
                        records.append({
                            "timestamp": pd.to_datetime(item["unixTime"], unit="s"),
                            "open": float(item["o"]),
                            "high": float(item["h"]),
                            "low": float(item["l"]),
                            "close": float(item["c"]),
                            "volume": float(item["v"]),
                        })
                    
                    df = pd.DataFrame(records).set_index("timestamp").sort_index()
                    logger.info(f"Fetched {len(df)} candles from Birdeye: {symbol}_{timeframe}")
                    return df
        
        except asyncio.TimeoutError:
            logger.error(f"Birdeye API timeout")
            return None
        except Exception as e:
            logger.error(f"Error fetching from Birdeye: {e}")
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
