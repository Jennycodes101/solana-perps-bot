import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import MultiTimeframePanel from './MultiTimeframePanel';
import './Dashboard.css';

const Dashboard = () => {
  const [signals, setSignals] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [performance, setPerformance] = useState({});
  const [isRunning, setIsRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [callHistory, setCallHistory] = useState([]);
  const [chartData, setChartData] = useState({});
  const [time, setTime] = useState(new Date());

  const API_URL = 'http://localhost:8000';

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [signalsRes, alertsRes, perfRes, historyRes] = await Promise.all([
        axios.get(`${API_URL}/api/signals`).catch(() => ({ data: [] })),
        axios.get(`${API_URL}/api/alerts`).catch(() => ({ data: [] })),
        axios.get(`${API_URL}/api/performance`).catch(() => ({ data: {} })),
        axios.get(`${API_URL}/api/signal-history`).catch(() => ({ data: [] })),
      ]);

      setSignals(signalsRes.data || []);
      setAlerts(alertsRes.data || []);
      setPerformance(perfRes.data || {});
      setCallHistory(historyRes.data || []);
      
      generateChartData(signalsRes.data || []);
    } catch (error) {
      console.error('Error fetching data:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000);
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => {
      clearInterval(interval);
      clearInterval(timer);
    };
  }, [fetchData]);

  const generateChartData = (signals) => {
    const data = {};
    
    signals.forEach(signal => {
      const symbol = signal.symbol;
      const basePrice = signal.price;
      const priceData = [];
      
      for (let i = -20; i <= 20; i++) {
        const price = basePrice + (Math.sin(i / 5) * basePrice * 0.02);
        priceData.push({
          time: i,
          price: parseFloat(price.toFixed(2)),
          entry: i === 0 && signal.signal !== 'HOLD' ? signal.price : null,
          stopLoss: signal.stop_loss,
          takeProfit: signal.take_profit,
        });
      }
      
      data[symbol] = priceData;
    });
    
    setChartData(data);
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
    if (signal === 'LONG') return '#00ff00';
    if (signal === 'SHORT') return '#ff0000';
    return '#00aa00';
  };

  const formatTime = (dateString) => {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    return date.toLocaleTimeString();
  };

  return (
    <div className="matrix-dashboard">
      {/* Scanlines effect */}
      <div className="scanlines"></div>

      {/* Header */}
      <header className="matrix-header">
        <div className="header-title">
          <span className="cursor">{'>'}</span>
          <span className="glow">JUPITER PERPS BOT v2.0</span>
          <span className="timestamp">{time.toLocaleTimeString()}</span>
        </div>
        <div className="header-status">
          <span className={`status-indicator ${isRunning ? 'active' : 'inactive'}`}></span>
          <span className="status-text">{isRunning ? '[SYSTEM ACTIVE]' : '[SYSTEM OFFLINE]'}</span>
        </div>
      </header>

      {/* Control Panel */}
      <div className="matrix-controls">
        <button 
          className={`matrix-btn ${isRunning ? 'stop' : 'start'}`}
          onClick={isRunning ? stopBot : startBot}
        >
          {isRunning ? '■ STOP' : '▶ START'}
        </button>
        <button 
          className="matrix-btn refresh"
          onClick={fetchData} 
          disabled={loading}
        >
          {loading ? '◇ LOADING...' : '◆ REFRESH'}
        </button>
      </div>

      {/* Main Content */}
      <div className="matrix-content">
        {/* Live Signals Section */}
        <section className="matrix-section signals-section">
          <div className="section-header">
            <span className="bracket">[</span>
            <span>LIVE SIGNALS</span>
            <span className="bracket">]</span>
          </div>

          {signals.length === 0 ? (
            <div className="terminal-text">_ no active signals _</div>
          ) : (
            <div className="signals-container">
              {signals.map(signal => (
                <div key={signal.symbol} className="signal-group">
                  <div 
                    className="signal-card"
                    style={{ borderColor: getSignalColor(signal.signal) }}
                  >
                    <div className="signal-header">
                      <span className="symbol">{signal.symbol}</span>
                      <span className="signal-badge" style={{ color: getSignalColor(signal.signal) }}>
                        [{signal.signal}]
                      </span>
                    </div>

                    <div className="signal-data">
                      <div className="data-row">
                        <span className="label">PRICE:</span>
                        <span className="value">${signal.price?.toFixed(2)}</span>
                      </div>
                      <div className="data-row">
                        <span className="label">CONF:</span>
                        <span className="value" style={{ color: signal.confidence > 70 ? '#00ff00' : signal.confidence > 40 ? '#ffff00' : '#ff0000' }}>
                          {signal.confidence?.toFixed(1)}%
                        </span>
                      </div>
                      <div className="data-row">
                        <span className="label">RSI:</span>
                        <span className="value">{signal.rsi?.toFixed(1)}</span>
                      </div>
                      <div className="data-row">
                        <span className="label">TIME:</span>
                        <span className="value">{formatTime(signal.timestamp)}</span>
                      </div>
                    </div>

                    <div className="trade-levels">
                      <div className="level tp">TP: ${signal.take_profit?.toFixed(2)}</div>
                      <div className="level sl">SL: ${signal.stop_loss?.toFixed(2)}</div>
                    </div>

                    {/* Mini Chart */}
                    {chartData[signal.symbol] && (
                      <div className="signal-chart">
                        <ResponsiveContainer width="100%" height={150}>
                          <ScatterChart data={chartData[signal.symbol]} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#00aa00" opacity={0.2} />
                            <XAxis type="number" dataKey="time" stroke="#00aa00" tick={{ fontSize: 11 }} />
                            <YAxis stroke="#00aa00" tick={{ fontSize: 11 }} />
                            <Tooltip 
                              contentStyle={{ backgroundColor: '#001a00', border: '1px solid #00ff00', color: '#00ff00', fontFamily: 'Courier New' }}
                              formatter={(value) => value.toFixed(2)}
                            />
                            <Scatter 
                              name="Price" 
                              data={chartData[signal.symbol]} 
                              fill="#00ff00"
                              stroke="#00aa00"
                            />
                          </ScatterChart>
                        </ResponsiveContainer>
                      </div>
                    )}
                  </div>

                  {/* Multi-Timeframe Analysis */}
                  <MultiTimeframePanel symbol={signal.symbol} />
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Performance Metrics */}
        <section className="matrix-section">
          <div className="section-header">
            <span className="bracket">[</span>
            <span>SYSTEM METRICS</span>
            <span className="bracket">]</span>
          </div>
          <div className="metrics-grid">
            <div className="metric">
              <span className="metric-label">TRADES:</span>
              <span className="metric-value">{performance.total_trades || 0}</span>
            </div>
            <div className="metric">
              <span className="metric-label">WIN RATE:</span>
              <span className="metric-value">{performance.win_rate?.toFixed(1) || 0}%</span>
            </div>
            <div className="metric">
              <span className="metric-label">P&L:</span>
              <span className="metric-value" style={{ color: (performance.total_pnl || 0) >= 0 ? '#00ff00' : '#ff0000' }}>
                ${(performance.total_pnl || 0).toFixed(2)}
              </span>
            </div>
            <div className="metric">
              <span className="metric-label">AVG P&L:</span>
              <span className="metric-value" style={{ color: (performance.avg_trade_pnl || 0) >= 0 ? '#00ff00' : '#ff0000' }}>
                ${(performance.avg_trade_pnl || 0).toFixed(2)}
              </span>
            </div>
          </div>
        </section>

        {/* Signal History */}
        <section className="matrix-section">
          <div className="section-header">
            <span className="bracket">[</span>
            <span>SIGNAL HISTORY</span>
            <span className="bracket">]</span>
          </div>
          {callHistory.length === 0 ? (
            <div className="terminal-text">_ no history _</div>
          ) : (
            <div className="history-table">
              <div className="table-header">
                <div>TIME</div>
                <div>SYMBOL</div>
                <div>SIGNAL</div>
                <div>PRICE</div>
                <div>CONF</div>
              </div>
              {callHistory.slice().reverse().map((call, idx) => (
                <div key={idx} className="table-row" style={{ borderLeftColor: getSignalColor(call.signal) }}>
                  <div>{formatTime(call.timestamp)}</div>
                  <div>{call.symbol}</div>
                  <div style={{ color: getSignalColor(call.signal) }}>[{call.signal}]</div>
                  <div>${call.price?.toFixed(2)}</div>
                  <div style={{ color: call.confidence > 70 ? '#00ff00' : '#ffff00' }}>{call.confidence?.toFixed(1)}%</div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Alerts */}
        <section className="matrix-section">
          <div className="section-header">
            <span className="bracket">[</span>
            <span>SYSTEM ALERTS</span>
            <span className="bracket">]</span>
          </div>
          {alerts.length === 0 ? (
            <div className="terminal-text">_ no alerts _</div>
          ) : (
            <div className="alerts-list">
              {alerts.slice(-5).reverse().map(alert => (
                <div key={alert.id} className={`alert ${alert.severity}`}>
                  <span>{alert.message}</span>
                  <span className="time">{formatTime(alert.timestamp)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Footer */}
      <footer className="matrix-footer">
        <span>{'>'} SYSTEM READY {'<'}</span>
      </footer>
    </div>
  );
};

export default Dashboard;
