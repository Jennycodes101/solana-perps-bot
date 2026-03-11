"""
Multi-timeframe technical analysis.
Analyzes 1m, 5m, 15m, 1H, 4H timeframes and correlates signals.
"""

import pandas as pd
import numpy as np
from indicators import IndicatorCalculator
from data_loader import DataLoader
from logger import logger
from config import indicators_config


class MultiTimeframeAnalyzer:
    def __init__(self):
        self.data_loader = DataLoader()
        self.calc = IndicatorCalculator(indicators_config)
        self.timeframes = ['1m', '5m', '15m', '1h', '4h']
        
    async def analyze_symbol(self, symbol: str):
        """
        Analyze a symbol across multiple timeframes.
        Returns correlation and alignment of signals.
        """
        analysis = {
            'symbol': symbol,
            'timestamp': pd.Timestamp.now().isoformat(),
            'timeframes': {},
            'alignment': {},
            'correlation': 0.0,
            'bias': 'NEUTRAL'
        }
        
        try:
            # Fetch data for each timeframe
            timeframe_signals = {}
            for tf in self.timeframes:
                logger.info(f"Fetching {tf} data for {symbol}...")
                df = await self.data_loader.fetch_coingecko_ohlcv(symbol, tf, days=90)
                
                if df is None or df.empty or len(df) < 30:
                    logger.warning(f"Insufficient data for {symbol} on {tf}")
                    timeframe_signals[tf] = {
                        'signal': 'NEUTRAL',
                        'confidence': 0.0,
                        'rsi': 50.0,
                        'ema_short': 0.0,
                        'ema_long': 0.0,
                        'price': 0.0,
                        'trend': 'NEUTRAL'
                    }
                    continue
                
                # Calculate indicators
                df = self.calc.calculate_all(df)
                
                # Get signal
                ema_sig = self.calc.get_ema_signal(df)
                st_sig = self.calc.get_supertrend_signal(df)
                signal = ema_sig if ema_sig == st_sig else 'NEUTRAL'
                
                rsi = df['rsi'].iloc[-1] if not pd.isna(df['rsi'].iloc[-1]) else 50
                confidence = self.calc.calculate_confidence_score(df, signal)
                
                # Determine trend
                if ema_sig == 'LONG' and st_sig == 'LONG':
                    trend = 'STRONG_UP'
                elif ema_sig == 'LONG' or st_sig == 'LONG':
                    trend = 'UP'
                elif ema_sig == 'SHORT' and st_sig == 'SHORT':
                    trend = 'STRONG_DOWN'
                elif ema_sig == 'SHORT' or st_sig == 'SHORT':
                    trend = 'DOWN'
                else:
                    trend = 'NEUTRAL'
                
                current_price = df['close'].iloc[-1]
                
                timeframe_signals[tf] = {
                    'signal': signal,
                    'confidence': confidence,
                    'rsi': rsi,
                    'ema_short': df['ema_short'].iloc[-1],
                    'ema_long': df['ema_long'].iloc[-1],
                    'price': current_price,
                    'trend': trend,
                    'data_points': len(df)
                }
                
                logger.info(f"✓ {symbol} {tf}: {signal} (Conf: {confidence:.1f}%) - Trend: {trend}")
            
            analysis['timeframes'] = timeframe_signals
            
            # Calculate alignment
            alignment = self._calculate_alignment(timeframe_signals)
            analysis['alignment'] = alignment
            
            # Calculate correlation
            correlation = self._calculate_correlation(timeframe_signals)
            analysis['correlation'] = correlation
            
            # Determine overall bias
            analysis['bias'] = self._determine_bias(timeframe_signals, alignment)
            
            logger.info(f"🎯 {symbol} Overall Bias: {analysis['bias']} (Alignment: {alignment['score']:.1f}%)")
            
            return analysis
            
        except Exception as e:
            logger.error(f"Error in multi-timeframe analysis for {symbol}: {e}", exc_info=True)
            return analysis
    
    def _calculate_alignment(self, timeframe_signals):
        """Calculate how well signals align across timeframes."""
        alignment = {
            'score': 0.0,
            '1m_aligned': False,
            '5m_aligned': False,
            '15m_aligned': False,
            '1h_aligned': False,
            '4h_aligned': False,
            'strong_alignment': False,
            'details': {}
        }
        
        try:
            # Get higher timeframe bias (4H and 1H as base)
            higher_tf_signals = []
            for tf in ['4h', '1h']:
                sig = timeframe_signals.get(tf, {}).get('trend', 'NEUTRAL')
                if sig != 'NEUTRAL':
                    higher_tf_signals.append(sig)
            
            if not higher_tf_signals:
                higher_bias = 'NEUTRAL'
            else:
                higher_bias = higher_tf_signals[0]
            
            # Check alignment for each timeframe
            aligned_count = 0
            total_count = 0
            
            for tf in self.timeframes:
                tf_trend = timeframe_signals.get(tf, {}).get('trend', 'NEUTRAL')
                
                is_aligned = (tf_trend != 'NEUTRAL' and higher_bias != 'NEUTRAL' and 
                             tf_trend.startswith(higher_bias.split('_')[0]))
                
                alignment[f'{tf}_aligned'] = is_aligned
                alignment['details'][tf] = {
                    'trend': tf_trend,
                    'aligned_with_higher_tf': is_aligned
                }
                
                if tf not in ['4h', '1h']:  # Don't count higher TFs against themselves
                    total_count += 1
                    if is_aligned:
                        aligned_count += 1
            
            if total_count > 0:
                alignment['score'] = (aligned_count / total_count) * 100
            
            # Strong alignment if all lower TFs align with higher TFs
            alignment['strong_alignment'] = alignment['score'] >= 80
            
        except Exception as e:
            logger.error(f"Error calculating alignment: {e}")
        
        return alignment
    
    def _calculate_correlation(self, timeframe_signals):
        """Calculate correlation between timeframe signals."""
        try:
            # Extract signals
            signals_list = []
            for tf in self.timeframes:
                sig = timeframe_signals.get(tf, {}).get('signal')
                if sig == 'LONG':
                    signals_list.append(1)
                elif sig == 'SHORT':
                    signals_list.append(-1)
                else:
                    signals_list.append(0)
            
            # Calculate correlation (simple: how many agree)
            if len(signals_list) == 0:
                return 0.0
            
            non_neutral = [s for s in signals_list if s != 0]
            if not non_neutral:
                return 0.0
            
            long_count = sum(1 for s in non_neutral if s == 1)
            short_count = sum(1 for s in non_neutral if s == -1)
            
            agreement = max(long_count, short_count) / len(non_neutral)
            return agreement * 100
            
        except Exception as e:
            logger.error(f"Error calculating correlation: {e}")
            return 0.0
    
    def _determine_bias(self, timeframe_signals, alignment):
        """Determine overall market bias based on multi-timeframe analysis."""
        try:
            # Higher timeframes have more weight
            weights = {
                '4h': 4,
                '1h': 3,
                '15m': 2,
                '5m': 1.5,
                '1m': 1
            }
            
            weighted_score = 0
            total_weight = 0
            
            for tf, weight in weights.items():
                trend = timeframe_signals.get(tf, {}).get('trend', 'NEUTRAL')
                
                if 'UP' in trend:
                    weighted_score += weight
                elif 'DOWN' in trend:
                    weighted_score -= weight
                
                total_weight += weight
            
            if total_weight == 0:
                return 'NEUTRAL'
            
            avg_score = weighted_score / total_weight
            
            # Strong bias if alignment is good
            if alignment['score'] >= 80:
                if avg_score > 0.5:
                    return 'STRONG_LONG'
                elif avg_score < -0.5:
                    return 'STRONG_SHORT'
            
            # Regular bias
            if avg_score > 0.3:
                return 'LONG'
            elif avg_score < -0.3:
                return 'SHORT'
            else:
                return 'NEUTRAL'
                
        except Exception as e:
            logger.error(f"Error determining bias: {e}")
            return 'NEUTRAL'
    
    async def get_scalping_setup(self, symbol: str, analysis: dict):
        """
        Get high-probability scalping setup based on multi-timeframe analysis.
        """
        setup = {
            'symbol': symbol,
            'validity': False,
            'entry_signal': None,
            'entry_price': None,
            'stop_loss': None,
            'take_profit': None,
            'time_window': None,
            'confidence': 0.0,
            'bias': analysis.get('bias', 'NEUTRAL'),
            'alignment_score': analysis.get('alignment', {}).get('score', 0),
            'reasoning': ''
        }
        
        try:
            # Scalping setup is valid only if:
            # 1. Higher timeframes show clear direction (4H and 1H aligned)
            # 2. Lower timeframes show reversal/breakout setup (5m and 1m)
            # 3. Alignment score is > 70%
            
            alignment = analysis.get('alignment', {})
            
            if alignment.get('score', 0) < 70:
                setup['reasoning'] = 'Low alignment across timeframes - too risky for scalping'
                return setup
            
            # Get 1M data for entry setup
            df_1m = await self.data_loader.fetch_coingecko_ohlcv(symbol, '1m', days=1)
            
            if df_1m is None or df_1m.empty or len(df_1m) < 20:
                setup['reasoning'] = 'Insufficient 1M data for scalping setup'
                return setup
            
            df_1m = self.calc.calculate_all(df_1m)
            
            current_price = df_1m['close'].iloc[-1]
            rsi_1m = df_1m['rsi'].iloc[-1] if not pd.isna(df_1m['rsi'].iloc[-1]) else 50
            
            # Determine entry signal based on bias
            bias = analysis.get('bias', 'NEUTRAL')
            
            if bias in ['LONG', 'STRONG_LONG']:
                # Look for oversold entry on 1M
                if rsi_1m < 40:
                    setup['entry_signal'] = 'BUY'
                    setup['entry_price'] = current_price
                    setup['stop_loss'] = current_price - (df_1m['atr'].iloc[-1] * 1.5)
                    setup['take_profit'] = current_price + (df_1m['atr'].iloc[-1] * 3)
                    setup['confidence'] = alignment.get('score', 0)
                    setup['validity'] = True
                    setup['time_window'] = '5-15 minutes'
                    setup['reasoning'] = f'Higher TFs bullish (Bias: {bias}), 1M oversold (RSI: {rsi_1m:.1f})'
            
            elif bias in ['SHORT', 'STRONG_SHORT']:
                # Look for overbought entry on 1M
                if rsi_1m > 60:
                    setup['entry_signal'] = 'SELL'
                    setup['entry_price'] = current_price
                    setup['stop_loss'] = current_price + (df_1m['atr'].iloc[-1] * 1.5)
                    setup['take_profit'] = current_price - (df_1m['atr'].iloc[-1] * 3)
                    setup['confidence'] = alignment.get('score', 0)
                    setup['validity'] = True
                    setup['time_window'] = '5-15 minutes'
                    setup['reasoning'] = f'Higher TFs bearish (Bias: {bias}), 1M overbought (RSI: {rsi_1m:.1f})'
            
            else:
                setup['reasoning'] = 'Neutral bias - waiting for clearer direction'
            
        except Exception as e:
            logger.error(f"Error generating scalping setup: {e}")
            setup['reasoning'] = f'Error: {str(e)}'
        
        return setup
