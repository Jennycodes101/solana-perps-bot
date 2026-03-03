"""
FastAPI Backend for Trading Bot Dashboard.
Provides real-time WebSocket updates, REST API, and trade management.
"""

import asyncio
import json
from datetime import datetime
from typing import Dict, List, Optional
import sys
sys.path.insert(0, '/Users/ashleyberndt/solana-perps-bot')

from fastapi import FastAPI, WebSocket, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

from data_loader import DataLoader
from signal_generator import SignalGenerator
from logger import logger

# Initialize FastAPI app
app = FastAPI(
    title="Jupiter Perps Bot API",
    description="Real-time trading bot dashboard API",
    version="1.0.0"
)

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global state
class BotState:
    def __init__(self):
        self.signals: Dict = {}
        self.prices: Dict = {}
        self.trades: List = []
        self.alerts: List = []
        self.performance_metrics: Dict = {}
        self.websocket_clients: List[WebSocket] = []
        self.is_running = False
        self.data_loader = DataLoader()
        self.signal_gen: Optional[SignalGenerator] = None
        self.signal_task: Optional[asyncio.Task] = None

bot_state = BotState()

# Pydantic models
class Signal(BaseModel):
    symbol: str
    signal: str
    price: float
    confidence: float
    rsi: float
    funding_rate: float
    stop_loss: float
    take_profit: float
    timestamp: str

class Trade(BaseModel):
    id: str
    symbol: str
    side: str
    entry_price: float
    exit_price: Optional[float]
    size: float
    pnl: Optional[float]
    entry_time: str
    exit_time: Optional[str]
    status: str

class Alert(BaseModel):
    id: str
    symbol: str
    message: str
    severity: str
    timestamp: str

class PriceData(BaseModel):
    symbol: str
    price: float
    high: float
    low: float
    volume: float
    change_24h: float
    timestamp: str

# REST API Endpoints

@app.get("/api/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "ok",
        "timestamp": datetime.now().isoformat(),
        "bot_running": bot_state.is_running,
        "signals_count": len(bot_state.signals),
    }

@app.get("/api/signals")
async def get_signals(symbols: Optional[str] = Query(None)):
    """Get current trading signals."""
    signals_list = list(bot_state.signals.values())
    if symbols:
        symbol_list = symbols.split(",")
        signals_list = [s for s in signals_list if s["symbol"] in symbol_list]
    return signals_list

@app.get("/api/prices")
async def get_prices(symbols: Optional[str] = Query(None)):
    """Get current prices."""
    prices_list = list(bot_state.prices.values())
    if symbols:
        symbol_list = symbols.split(",")
        prices_list = [p for p in prices_list if p["symbol"] in symbol_list]
    return prices_list

@app.get("/api/trades")
async def get_trades(
    symbol: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    limit: int = Query(100)
):
    """Get trade history."""
    trades = bot_state.trades
    if symbol:
        trades = [t for t in trades if t["symbol"] == symbol]
    if status:
        trades = [t for t in trades if t["status"] == status]
    return trades[-limit:]

@app.get("/api/alerts")
async def get_alerts(limit: int = Query(50)):
    """Get recent alerts."""
    return bot_state.alerts[-limit:]

@app.get("/api/performance")
async def get_performance():
    """Get performance metrics."""
    return bot_state.performance_metrics

@app.post("/api/signals/start")
async def start_signal_generation(symbols: List[str] = None):
    """Start signal generation."""
    if bot_state.is_running:
        raise HTTPException(status_code=400, detail="Bot already running")
    
    symbols = symbols or ["SOL", "ETH", "WBTC"]
    bot_state.signal_gen = SignalGenerator(symbols=symbols, timeframe="5m")
    bot_state.is_running = True
    
    # Start background task
    bot_state.signal_task = asyncio.create_task(run_signal_loop())
    
    logger.info(f"Signal generation started for symbols: {symbols}")
    
    return {
        "status": "started",
        "symbols": symbols,
        "timestamp": datetime.now().isoformat()
    }

@app.post("/api/signals/stop")
async def stop_signal_generation():
    """Stop signal generation."""
    bot_state.is_running = False
    if bot_state.signal_task:
        bot_state.signal_task.cancel()
    logger.info("Signal generation stopped")
    return {"status": "stopped", "timestamp": datetime.now().isoformat()}

# WebSocket endpoint for real-time updates
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for real-time updates."""
    await websocket.accept()
    bot_state.websocket_clients.append(websocket)
    logger.info(f"WebSocket client connected. Total clients: {len(bot_state.websocket_clients)}")
    
    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            
            if message.get("type") == "subscribe":
                logger.info(f"Client subscribed to: {message.get('symbols')}")
            
            elif message.get("type") == "unsubscribe":
                logger.info(f"Client unsubscribed from: {message.get('symbols')}")
            
            await asyncio.sleep(0.1)
    
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
    finally:
        if websocket in bot_state.websocket_clients:
            bot_state.websocket_clients.remove(websocket)
        logger.info(f"WebSocket client disconnected. Total clients: {len(bot_state.websocket_clients)}")

# Background tasks

async def fetch_with_retry(symbol: str, max_retries: int = 3, delay: int = 2):
    """Fetch data with exponential backoff retry logic."""
    for attempt in range(max_retries):
        try:
            df = await bot_state.data_loader.fetch_coingecko_ohlcv(
                symbol, "5m", days=180
            )
            if df is not None and not df.empty:
                return df
        except Exception as e:
            logger.warning(f"Attempt {attempt + 1}/{max_retries} failed for {symbol}: {e}")
            if attempt < max_retries - 1:
                wait_time = delay * (2 ** attempt)  # Exponential backoff
                logger.info(f"Retrying {symbol} in {wait_time}s...")
                await asyncio.sleep(wait_time)
    
    return None

async def run_signal_loop():
    """Main signal generation loop - Updates every 60 seconds."""
    logger.info("Signal loop started - Updating every 60 seconds")
    while bot_state.is_running:
        try:
            if not bot_state.signal_gen:
                await asyncio.sleep(5)
                continue
            
            symbols = bot_state.signal_gen.symbols
            logger.info(f"🔄 Fetching signals for: {symbols}")
            
            # Process symbols sequentially with delays to avoid rate limiting
            for idx, symbol in enumerate(symbols):
                try:
                    # Add delay between requests to avoid rate limiting
                    if idx > 0:
                        await asyncio.sleep(1)  # Reduced from 2 to 1 second
                    
                    # Fetch live data with retry logic
                    df = await fetch_with_retry(symbol, max_retries=3, delay=2)
                    
                    if df is not None and not df.empty:
                        # Generate signal
                        sig = bot_state.signal_gen.generate_signal(symbol, df, funding_rate=0.0)
                        
                        logger.info(f"✅ {symbol}: {sig['signal']} @ ${sig['price']:.2f}")
                        
                        # Update state
                        bot_state.signals[symbol] = {
                            "symbol": sig["symbol"],
                            "signal": sig["signal"],
                            "price": sig["price"],
                            "confidence": sig["confidence"],
                            "rsi": sig["rsi"],
                            "funding_rate": sig["funding_rate"],
                            "stop_loss": sig["stop_loss"],
                            "take_profit": sig["take_profit"],
                            "timestamp": datetime.now().isoformat(),
                        }
                        
                        # Update prices
                        bot_state.prices[symbol] = {
                            "symbol": symbol,
                            "price": sig["price"],
                            "high": df['high'].iloc[-1],
                            "low": df['low'].iloc[-1],
                            "volume": df['volume'].iloc[-1] if 'volume' in df else 0,
                            "change_24h": sig["price_change_pct"],
                            "timestamp": datetime.now().isoformat(),
                        }
                        
                        # Broadcast to WebSocket clients
                        await broadcast_update({
                            "type": "signal_update",
                            "data": bot_state.signals[symbol]
                        })
                    else:
                        logger.warning(f"⚠️ No data for {symbol}")
                
                except Exception as e:
                    logger.error(f"❌ Error processing {symbol}: {e}")
            
            # Update performance metrics
            await update_performance_metrics()
            
            logger.info(f"✨ Cycle complete: {list(bot_state.signals.keys())} | Next update in 60s...")
            
            # Wait 60 seconds before next cycle (changed from 300)
            await asyncio.sleep(60)
        
        except asyncio.CancelledError:
            logger.info("Signal loop cancelled")
            break
        except Exception as e:
            logger.error(f"Error in signal loop: {e}")
            await asyncio.sleep(10)
    
    logger.info("Signal loop ended")

async def update_performance_metrics():
    """Update performance metrics."""
    if not bot_state.trades:
        bot_state.performance_metrics = {
            "total_trades": 0,
            "winning_trades": 0,
            "losing_trades": 0,
            "win_rate": 0,
            "total_pnl": 0,
            "avg_trade_pnl": 0,
        }
        return
    
    closed_trades = [t for t in bot_state.trades if t.get("status") == "closed"]
    
    if not closed_trades:
        return
    
    winning = sum(1 for t in closed_trades if t.get("pnl", 0) > 0)
    losing = sum(1 for t in closed_trades if t.get("pnl", 0) < 0)
    total_pnl = sum(t.get("pnl", 0) for t in closed_trades)
    
    bot_state.performance_metrics = {
        "total_trades": len(closed_trades),
        "winning_trades": winning,
        "losing_trades": losing,
        "win_rate": (winning / len(closed_trades) * 100) if closed_trades else 0,
        "total_pnl": total_pnl,
        "avg_trade_pnl": total_pnl / len(closed_trades) if closed_trades else 0,
        "timestamp": datetime.now().isoformat(),
    }

async def broadcast_update(message: dict):
    """Broadcast update to all WebSocket clients."""
    disconnected = []
    
    for client in bot_state.websocket_clients:
        try:
            await client.send_json(message)
        except Exception as e:
            logger.error(f"Failed to send to client: {e}")
            disconnected.append(client)
    
    # Remove disconnected clients
    for client in disconnected:
        if client in bot_state.websocket_clients:
            bot_state.websocket_clients.remove(client)

@app.on_event("startup")
async def startup_event():
    """Initialize on startup."""
    logger.info("FastAPI server started on http://0.0.0.0:8000")
    # Automatically start signal generation on startup
    try:
        await start_signal_generation(symbols=["SOL", "ETH", "WBTC"])
    except Exception as e:
        logger.warning(f"Could not auto-start signals: {e}")

@app.on_event("shutdown")
async def shutdown_event():
    """Cleanup on shutdown."""
    bot_state.is_running = False
    if bot_state.signal_task:
        bot_state.signal_task.cancel()
    logger.info("FastAPI server shutdown")

if __name__ == "__main__":
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8000,
        log_level="info"
    )
