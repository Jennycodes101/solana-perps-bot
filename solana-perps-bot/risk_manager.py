"""
Risk management: position sizing, Kelly criterion, portfolio limits.
"""

import pandas as pd
from typing import Tuple
from config import risk_config
from logger import logger


class RiskManager:
    """Manage position sizing, stops, and portfolio constraints."""

    def __init__(self, config):
        """
        Args:
            config: RiskConfig instance.
        """
        self.config = config
        self.daily_pnl = 0.0
        self.current_exposure_pct = 0.0
        self.open_positions = []

    def calculate_position_size(
        self,
        account_balance: float,
        entry_price: float,
        stop_loss: float,
        confidence_score: float,
    ) -> Tuple[float, float]:
        """Calculate position size using Kelly Criterion (lite) and risk per trade."""
        max_risk_usd = account_balance * (self.config.max_account_risk_pct / 100.0)
        
        risk_per_unit = abs(entry_price - stop_loss)
        if risk_per_unit < 1e-8:
            logger.warning("Risk per unit too small, using default 2%")
            risk_per_unit = entry_price * 0.02
        
        position_size_usd = max_risk_usd / risk_per_unit
        
        kelly_adjusted_confidence = min(100, max(0, confidence_score))
        leverage = 3.0 + (kelly_adjusted_confidence / 100.0) * 7.0
        leverage = min(10.0, leverage)
        
        position_size_usd = position_size_usd * self.config.kelly_fraction
        
        logger.debug(
            f"Position size: ${position_size_usd:.2f} | "
            f"Leverage: {leverage:.1f}x | Risk: ${max_risk_usd:.2f} | "
            f"Confidence: {kelly_adjusted_confidence:.1f}%"
        )
        
        return (position_size_usd, leverage)

    def check_portfolio_limits(
        self,
        current_exposure_pct: float,
        num_open_positions: int,
    ) -> bool:
        """Validate portfolio constraints."""
        violations = []
        
        if current_exposure_pct > self.config.max_total_exposure_pct:
            violations.append(
                f"Exposure {current_exposure_pct:.1f}% > max {self.config.max_total_exposure_pct:.1f}%"
            )
        
        if num_open_positions >= self.config.max_concurrent_positions:
            violations.append(
                f"Open positions {num_open_positions} >= max {self.config.max_concurrent_positions}"
            )
        
        if violations:
            logger.warning(f"Portfolio limits violated: {' | '.join(violations)}")
            return False
        
        return True

    def check_daily_loss_limit(self, daily_pnl: float) -> bool:
        """Check if daily loss limit has been hit."""
        if daily_pnl < 0 and abs(daily_pnl) > abs(self.config.daily_loss_limit_pct):
            logger.error(
                f"Daily loss limit hit: {daily_pnl:.2f}% < {self.config.daily_loss_limit_pct:.2f}%"
            )
            return False
        return True

    def funding_rate_filter(self, funding_rate: float, direction: str) -> bool:
        """Filter trades based on funding rate favorability."""
        if direction == "LONG":
            favorable = funding_rate < 0.0
        else:
            favorable = funding_rate > 0.0
        
        if not favorable:
            logger.info(f"Funding rate {funding_rate:.4f} unfavorable for {direction}")
        
        return favorable
