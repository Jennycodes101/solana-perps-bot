"""Technical indicator calculations using pandas_ta."""
import pandas as pd
import pandas_ta as ta
from typing import Tuple, Optional
from logger import logger

class IndicatorCalculator:
    def __init__(self, config, risk_config=None):
        from config import risk_config as default_risk_config
        self.config = config
        self.risk_config = risk_config or default_risk_config

    def calculate_all(self, df: pd.DataFrame) -> pd.DataFrame:
        if df.empty:
            return df
        df = df.copy()
        df["ema_fast"] = ta.ema(df["close"], length=self.config.ema_fast)
        df["ema_slow"] = ta.ema(df["close"], length=self.config.ema_slow)
        st = ta.supertrend(df["high"], df["low"], df["close"], length=self.config.supertrend_period, multiplier=self.config.supertrend_multiplier)
        df["supertrend"] = st["SUPERT_10_3.0"]
        df["st_trend"] = st["SUPERTd_10_3.0"]
        macd = ta.macd(df["close"], fast=12, slow=26, signal=9)
        df["macd"] = macd["MACD_12_26_9"]
        df["macd_signal"] = macd["MACDs_12_26_9"]
        df["macd_hist"] = macd["MACDh_12_26_9"]
        df["rsi"] = ta.rsi(df["close"], length=self.config.rsi_period)
        df["atr"] = ta.atr(df["high"], df["low"], df["close"], length=self.config.atr_period)
        return df

    def get_ema_signal(self, df: pd.DataFrame) -> str:
        if df.empty or len(df) < 2:
            return "NEUTRAL"
        if pd.isna(df["ema_fast"].iloc[-1]) or pd.isna(df["ema_slow"].iloc[-1]):
            return "NEUTRAL"
        if df["ema_fast"].iloc[-2] <= df["ema_slow"].iloc[-2] and df["ema_fast"].iloc[-1] > df["ema_slow"].iloc[-1]:
            return "LONG"
        elif df["ema_fast"].iloc[-2] >= df["ema_slow"].iloc[-2] and df["ema_fast"].iloc[-1] < df["ema_slow"].iloc[-1]:
            return "SHORT"
        return "NEUTRAL"

    def get_supertrend_signal(self, df: pd.DataFrame) -> str:
        if df.empty or pd.isna(df["st_trend"].iloc[-1]):
            return "NEUTRAL"
        return "LONG" if df["st_trend"].iloc[-1] == 1 else "SHORT"

    def get_macd_signal(self, df: pd.DataFrame) -> str:
        if df.empty or len(df) < 2 or pd.isna(df["macd"].iloc[-1]):
            return "NEUTRAL"
        if df["macd"].iloc[-2] <= df["macd_signal"].iloc[-2] and df["macd"].iloc[-1] > df["macd_signal"].iloc[-1]:
            return "LONG"
        elif df["macd"].iloc[-2] >= df["macd_signal"].iloc[-2] and df["macd"].iloc[-1] < df["macd_signal"].iloc[-1]:
            return "SHORT"
        return "NEUTRAL"

    def get_rsi_signal(self, df: pd.DataFrame) -> str:
        if df.empty or pd.isna(df["rsi"].iloc[-1]):
            return "OK"
        rsi = df["rsi"].iloc[-1]
        return "OVERBOUGHT" if rsi > 70 else "OVERSOLD" if rsi < 30 else "OK"

    def calculate_atr_stops(self, df: pd.DataFrame, entry_price: float, direction: str) -> Tuple[float, float]:
        if df.empty or pd.isna(df["atr"].iloc[-1]):
            sl = entry_price * 0.98 if direction == "LONG" else entry_price * 1.02
            tp = entry_price * 1.06 if direction == "LONG" else entry_price * 0.94
            return (sl, tp)
        atr = df["atr"].iloc[-1]
        if direction == "LONG":
            return (entry_price - (atr * self.risk_config.atr_stop_multiplier), entry_price + (atr * self.risk_config.atr_tp_multiplier))
        else:
            return (entry_price + (atr * self.risk_config.atr_stop_multiplier), entry_price - (atr * self.risk_config.atr_tp_multiplier))

    def calculate_confidence_score(self, df: pd.DataFrame, direction: str) -> float:
        if df.empty:
            return 0.0
        score = 0
        if (direction == "LONG" and self.get_ema_signal(df) == "LONG") or (direction == "SHORT" and self.get_ema_signal(df) == "SHORT"):
            score += 25
        if (direction == "LONG" and self.get_supertrend_signal(df) == "LONG") or (direction == "SHORT" and self.get_supertrend_signal(df) == "SHORT"):
            score += 25
        if (direction == "LONG" and self.get_macd_signal(df) == "LONG") or (direction == "SHORT" and self.get_macd_signal(df) == "SHORT"):
            score += 25
        rsi_sig = self.get_rsi_signal(df)
        if (direction == "LONG" and rsi_sig != "OVERBOUGHT") or (direction == "SHORT" and rsi_sig != "OVERSOLD"):
            score += 25
        return min(score, 100.0)
    def get_rsi_filter(self, df: pd.DataFrame) -> bool:
        """RSI filter - return True if RSI is not in extreme territory."""
        if df.empty or pd.isna(df["rsi"].iloc[-1]):
            return True
        rsi = df["rsi"].iloc[-1]
        return 30 <= rsi <= 70
