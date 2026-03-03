import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { TrendingUp, AlertCircle, Activity, DollarSign, Target, Clock } from 'lucide-react';
import './Dashboard.css';

const Dashboard = () => {
  const [signals, setSignals] = useState([]);
  const [trades, setTrades] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [performance, setPerformance] = useState({});
  const [isRunning, setIsRunning] = useState(false);
  const [darkMode, setDarkMode] = useState(true);
  const [loading, setLoading] = useState(false);
  const [theme, setTheme] = useState('default');

  const API_URL = 'http://localhost:8000';

  const themeColors = {
    default: {
      primary: '#3b82f6',
      success: '#10b981',
      danger: '#ef4444',
      warning: '#f59e0b',
      name: 'Default',
    },
    ocean: {
      primary: '#0ea5e9',
      success: '#06b6d4',
      danger: '#f43f5e',
      warning: '#facc15',
      name: 'Ocean',
    },
    sunset: {
      primary: '#f97316',
      success: '#ec4899',
      danger: '#dc2626',
      warning: '#f59e0b',
      name: 'Sunset',
    },
    forest: {
      primary: '#059669',
      success: '#10b981',
      danger: '#dc2626',
      warning: '#fbbf24',
      name: 'Forest',
    },
  };

  const colors = themeColors[theme];

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [signalsRes, tradesRes, alertsRes, perfRes] = await Promise.all([
        axios.get(`${API_URL}/api/signals`).catch(() => ({ data: [] })),
        axios.get(`${API_URL}/api/trades`).catch(() => ({ data: [] })),
        axios.get(`${API_URL}/api/alerts`).catch(() => ({ data: [] })),
        axios.get(`${API_URL}/api/performance`).catch(() => ({ data: {} })),
      ]);

      setSignals(signalsRes.data || []);
      setTrades(tradesRes.data || []);
      setAlerts(alertsRes.data || []);
      setPerformance(perfRes.data || {});
    } catch (error) {
      console.error('Error fetching data:', error);
    } finally {
      setLoading(false);
    }
  };

  const startBot = async () => {
    try {
      await axios.post(`${API_URL}/api/signals/start`, {
        symbols: ['SOL', 'ETH', 'WBTC']
      }).catch(() => {});
      setIsRunning(true);
    } catch (error) {
      console.error('Error starting bot:', error);
    }
  };

  const stopBot = async () => {
    try {
      await axios.post(`${API_URL}/api/signals/stop`).catch(() => {});
      setIsRunning(false);
    } catch (error) {
      console.error('Error stopping bot:', error);
    }
  };

  const getSignalColor = (signal) => {
    if (signal === 'LONG') return colors.success;
    if (signal === 'SHORT') return colors.danger;
    return '#6b7280';
  };

  const getSignalBgColor = (signal) => {
    if (signal === 'LONG') return colors.success + '20';
    if (signal === 'SHORT') return colors.danger + '20';
    return '#f3f4f6';
  };

  return (
    <div className={`dashboard ${darkMode ? 'dark' : 'light'}`}>
      <header className="header" style={{ borderColor: colors.primary + '40' }}>
        <div className="header-left">
          <h1 style={{ 
            background: `linear-gradient(135deg, ${colors.primary}, ${colors.success})`,
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
          }}>
            🤖 Jupiter Perps
          </h1>
          <span className={`status ${isRunning ? 'running' : 'stopped'}`} style={isRunning ? {
            background: colors.success + '15',
            color: colors.success,
            borderColor: colors.success,
          } : {}}>
            {isRunning ? '🟢 Live' : '⚫ Stopped'}
          </span>
        </div>
        <div className="header-right">
          <select 
            value={theme} 
            onChange={(e) => setTheme(e.target.value)}
            style={{
              padding: '0.625rem 1rem',
              borderRadius: '0.75rem',
              border: `2px solid ${colors.primary}`,
              background: colors.primary + '10',
              color: colors.primary,
              cursor: 'pointer',
              fontWeight: '600',
              fontSize: '0.875rem',
            }}
          >
            <option value="default">🎨 Default</option>
            <option value="ocean">🌊 Ocean</option>
            <option value="sunset">🌅 Sunset</option>
            <option value="forest">🌲 Forest</option>
          </select>

          <button 
            className="btn-toggle-theme"
            onClick={() => setDarkMode(!darkMode)}
            style={{ fontSize: '1.5rem' }}
          >
            {darkMode ? '☀️' : '🌙'}
          </button>
          {!isRunning ? (
            <button 
              className="btn-start" 
              onClick={startBot}
              style={{
                background: `linear-gradient(135deg, ${colors.success}, #059669)`,
                color: 'white',
                boxShadow: `0 4px 15px ${colors.success}4d`,
              }}
            >
              ▶️ Start
            </button>
          ) : (
            <button 
              className="btn-stop" 
              onClick={stopBot}
              style={{
                background: `linear-gradient(135deg, ${colors.danger}, #dc2626)`,
                color: 'white',
                boxShadow: `0 4px 15px ${colors.danger}4d`,
              }}
            >
              ⏹️ Stop
            </button>
          )}
          <button 
            className="btn-refresh" 
            onClick={fetchData} 
            disabled={loading}
            style={{
              background: `linear-gradient(135deg, ${colors.primary}, #2563eb)`,
              color: 'white',
              boxShadow: `0 4px 15px ${colors.primary}4d`,
            }}
          >
            {loading ? '⏳' : '🔄'}
          </button>
        </div>
      </header>

      <main className="main-content">
        <section className="section signals-section">
          <h2>📊 Live Trading Signals</h2>
          {signals.length === 0 ? (
            <div className="empty-state">
              <p>No signals available yet. Start the bot to see live signals!</p>
            </div>
          ) : (
            <div className="signals-grid">
              {signals.map(signal => (
                <div 
                  key={signal.symbol}
                  className="signal-card"
                  style={{ 
                    backgroundColor: getSignalBgColor(signal.signal), 
                    borderColor: getSignalColor(signal.signal),
                    borderWidth: '2px',
                  }}
                >
                  <div className="signal-header">
                    <h3>{signal.symbol}</h3>
                    <span 
                      className="signal-badge"
                      style={{ backgroundColor: getSignalColor(signal.signal), color: 'white' }}
                    >
                      {signal.signal}
                    </span>
                  </div>

                  <div className="signal-details">
                    <div className="detail">
                      <span className="label">Price</span>
                      <span className="value">${signal.price?.toFixed(2) || 'N/A'}</span>
                    </div>
                    <div className="detail">
                      <span className="label">Confidence</span>
                      <span className="value">{signal.confidence?.toFixed(1) || 'N/A'}%</span>
                    </div>
                    <div className="detail">
                      <span className="label">RSI</span>
                      <span className="value">{signal.rsi?.toFixed(1) || 'N/A'}</span>
                    </div>
                    <div className="detail">
                      <span className="label">Funding</span>
                      <span className="value">{signal.funding_rate?.toFixed(5) || 'N/A'}</span>
                    </div>
                  </div>

                  <div className="signal-targets">
                    <div className="target">
                      <Target size={16} />
                      <span>TP: ${signal.take_profit?.toFixed(2) || 'N/A'}</span>
                    </div>
                    <div className="target">
                      <AlertCircle size={16} />
                      <span>SL: ${signal.stop_loss?.toFixed(2) || 'N/A'}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="section metrics-section">
          <h2>📈 Performance Metrics</h2>
          <div className="metrics-grid">
            <div className="metric-card">
              <div className="metric-icon" style={{ background: `linear-gradient(135deg, ${colors.primary}, #2563eb)`, color: 'white' }}>
                <Activity size={24} />
              </div>
              <div className="metric-content">
                <span className="metric-label">Total Trades</span>
                <span className="metric-value">{performance.total_trades || 0}</span>
              </div>
            </div>

            <div className="metric-card">
              <div className="metric-icon" style={{ background: `linear-gradient(135deg, ${colors.success}, #059669)`, color: 'white' }}>
                <TrendingUp size={24} />
              </div>
              <div className="metric-content">
                <span className="metric-label">Win Rate</span>
                <span className="metric-value">{performance.win_rate?.toFixed(1) || 0}%</span>
              </div>
            </div>

            <div className="metric-card">
              <div className="metric-icon" style={{ background: `linear-gradient(135deg, #a855f7, #9333ea)`, color: 'white' }}>
                <DollarSign size={24} />
              </div>
              <div className="metric-content">
                <span className="metric-label">Total P&L</span>
                <span className={`metric-value`} style={{ color: (performance.total_pnl || 0) >= 0 ? colors.success : colors.danger }}>
                  ${(performance.total_pnl || 0).toFixed(2)}
                </span>
              </div>
            </div>

            <div className="metric-card">
              <div className="metric-icon" style={{ background: `linear-gradient(135deg, ${colors.warning}, #ea580c)`, color: 'white' }}>
                <Clock size={24} />
              </div>
              <div className="metric-content">
                <span className="metric-label">Avg P&L</span>
                <span className={`metric-value`} style={{ color: (performance.avg_trade_pnl || 0) >= 0 ? colors.success : colors.danger }}>
                  ${(performance.avg_trade_pnl || 0).toFixed(2)}
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className="section alerts-section">
          <h2>🔔 Recent Alerts</h2>
          {alerts.length === 0 ? (
            <div className="empty-state">
              <p>No alerts yet</p>
            </div>
          ) : (
            <div className="alerts-list">
              {alerts.slice(-10).reverse().map(alert => (
                <div 
                  key={alert.id} 
                  className={`alert alert-${alert.severity}`}
                  style={{
                    borderColor: alert.severity === 'error' ? colors.danger : alert.severity === 'warning' ? colors.warning : colors.primary,
                  }}
                >
                  <span className="alert-icon">
                    {alert.severity === 'error' ? '❌' : alert.severity === 'warning' ? '⚠️' : 'ℹ️'}
                  </span>
                  <div className="alert-content">
                    <span className="alert-message">{alert.message}</span>
                    <span className="alert-time">{new Date(alert.timestamp).toLocaleTimeString()}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="section trades-section">
          <h2>📋 Trade History</h2>
          {trades.length === 0 ? (
            <div className="empty-state">
              <p>No trades yet. Start the bot to begin trading!</p>
            </div>
          ) : (
            <div className="trades-table">
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Side</th>
                    <th>Entry</th>
                    <th>Exit</th>
                    <th>Size</th>
                    <th>P&L</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.slice(-20).reverse().map(trade => (
                    <tr key={trade.id}>
                      <td><strong>{trade.symbol}</strong></td>
                      <td style={{ color: trade.side === 'LONG' ? colors.success : colors.danger, fontWeight: '700' }}>
                        {trade.side}
                      </td>
                      <td>${trade.entry_price?.toFixed(2)}</td>
                      <td>{trade.exit_price ? `$${trade.exit_price.toFixed(2)}` : '-'}</td>
                      <td>{trade.size}</td>
                      <td style={{ color: trade.pnl >= 0 ? colors.success : colors.danger }}>
                        {trade.pnl ? `$${trade.pnl.toFixed(2)}` : '-'}
                      </td>
                      <td style={{ color: trade.status === 'closed' ? colors.success : colors.warning }}>
                        {trade.status}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
};

export default Dashboard;
