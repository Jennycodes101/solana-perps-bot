import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import './MultiTimeframePanel.css';

const MultiTimeframePanel = ({ symbol }) => {
  const [analysis, setAnalysis] = useState(null);
  const [setup, setSetup] = useState(null);
  const API_URL = 'http://localhost:8000';

  const fetchMultiTimeframe = useCallback(async () => {
    try {
      const [analysisRes, setupRes] = await Promise.all([
        axios.get(`${API_URL}/api/multi-timeframe/${symbol}`).catch(() => ({ data: null })),
        axios.get(`${API_URL}/api/scalping-setup/${symbol}`).catch(() => ({ data: null })),
      ]);
      setAnalysis(analysisRes.data);
      setSetup(setupRes.data);
    } catch (error) {
      console.error('Error fetching multi-timeframe data:', error);
    }
  }, [symbol]);

  useEffect(() => {
    if (symbol) {
      fetchMultiTimeframe();
    }
  }, [symbol, fetchMultiTimeframe]);

  if (!analysis) return <div className="mtf-loading">Loading analysis...</div>;

  const getBiasColor = (bias) => {
    if (bias.includes('LONG')) return '#00ff00';
    if (bias.includes('SHORT')) return '#ff0000';
    return '#ffff00';
  };

  const getTrendIcon = (trend) => {
    if (trend.includes('UP')) return '↑';
    if (trend.includes('DOWN')) return '↓';
    return '→';
  };

  return (
    <div className="mtf-panel">
      {/* Overall Bias */}
      <div className="mtf-summary">
        <div className="bias-indicator" style={{ color: getBiasColor(analysis.bias) }}>
          <span className="bias-label">OVERALL BIAS:</span>
          <span className="bias-value">[{analysis.bias}]</span>
        </div>
        <div className="alignment-score">
          <span className="label">ALIGNMENT:</span>
          <span className="value">{analysis.alignment.score.toFixed(1)}%</span>
        </div>
        <div className="correlation-score">
          <span className="label">CORRELATION:</span>
          <span className="value">{analysis.correlation.toFixed(1)}%</span>
        </div>
      </div>

      {/* Timeframe Grid */}
      <div className="timeframes-grid">
        {['1m', '5m', '15m', '1h', '4h'].map(tf => {
          const tfData = analysis.timeframes[tf];
          if (!tfData) return null;

          return (
            <div key={tf} className="timeframe-card">
              <div className="tf-header">
                <span className="tf-name">{tf.toUpperCase()}</span>
                <span className="tf-trend" style={{ color: getBiasColor(tfData.trend) }}>
                  {getTrendIcon(tfData.trend)} {tfData.trend}
                </span>
              </div>

              <div className="tf-data">
                <div className="data-item">
                  <span className="label">Signal:</span>
                  <span className="value" style={{ color: tfData.signal === 'LONG' ? '#00ff00' : tfData.signal === 'SHORT' ? '#ff0000' : '#ffff00' }}>
                    {tfData.signal}
                  </span>
                </div>
                <div className="data-item">
                  <span className="label">Conf:</span>
                  <span className="value">{tfData.confidence.toFixed(1)}%</span>
                </div>
                <div className="data-item">
                  <span className="label">RSI:</span>
                  <span className="value">{tfData.rsi.toFixed(1)}</span>
                </div>
                <div className="data-item">
                  <span className="label">Price:</span>
                  <span className="value">${tfData.price.toFixed(2)}</span>
                </div>
              </div>

              {analysis.alignment.details[tf] && (
                <div className="alignment-check">
                  {analysis.alignment.details[tf].aligned_with_higher_tf ? (
                    <span className="aligned">✓ ALIGNED</span>
                  ) : (
                    <span className="not-aligned">✗ DIVERGE</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Scalping Setup */}
      {setup && (
        <div className="scalping-setup">
          <div className="setup-header">
            <span className="setup-title">SCALPING SETUP</span>
            <span className={`setup-validity ${setup.validity ? 'valid' : 'invalid'}`}>
              {setup.validity ? '✓ VALID' : '✗ INVALID'}
            </span>
          </div>

          {setup.validity ? (
            <div className="setup-details">
              <div className="setup-signal" style={{ color: setup.entry_signal === 'BUY' ? '#00ff00' : '#ff0000' }}>
                <span className="signal-type">[{setup.entry_signal}]</span>
                <span className="signal-price">${setup.entry_price?.toFixed(2)}</span>
              </div>

              <div className="setup-levels">
                <div className="level tp">
                  <span className="label">TP:</span>
                  <span className="value">${setup.take_profit?.toFixed(2)}</span>
                </div>
                <div className="level sl">
                  <span className="label">SL:</span>
                  <span className="value">${setup.stop_loss?.toFixed(2)}</span>
                </div>
              </div>

              <div className="setup-meta">
                <div className="meta-item">
                  <span className="label">TIME WINDOW:</span>
                  <span className="value">{setup.time_window}</span>
                </div>
                <div className="meta-item">
                  <span className="label">CONFIDENCE:</span>
                  <span className="value">{setup.confidence?.toFixed(1)}%</span>
                </div>
              </div>

              <div className="setup-reasoning">
                {setup.reasoning}
              </div>
            </div>
          ) : (
            <div className="no-setup">
              {setup.reasoning}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default MultiTimeframePanel;
