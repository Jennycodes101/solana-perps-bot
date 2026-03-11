# Add these imports to app.py at the top
from multi_timeframe_analyzer import MultiTimeframeAnalyzer

# Add this to BotState class
mtf_analyzer = MultiTimeframeAnalyzer()
multi_timeframe_data: Dict = {}

# Add these endpoints to app.py

@app.get("/api/multi-timeframe/{symbol}")
async def get_multi_timeframe_analysis(symbol: str):
    """Get multi-timeframe analysis for a symbol."""
    try:
        analysis = await bot_state.mtf_analyzer.analyze_symbol(symbol)
        bot_state.multi_timeframe_data[symbol] = analysis
        return analysis
    except Exception as e:
        logger.error(f"Error in multi-timeframe endpoint: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/scalping-setup/{symbol}")
async def get_scalping_setup(symbol: str):
    """Get high-probability scalping setup based on multi-timeframe analysis."""
    try:
        # Get multi-timeframe analysis first
        if symbol not in bot_state.multi_timeframe_data:
            analysis = await bot_state.mtf_analyzer.analyze_symbol(symbol)
            bot_state.multi_timeframe_data[symbol] = analysis
        else:
            analysis = bot_state.multi_timeframe_data[symbol]
        
        # Get scalping setup
        setup = await bot_state.mtf_analyzer.get_scalping_setup(symbol, analysis)
        return setup
    except Exception as e:
        logger.error(f"Error in scalping setup endpoint: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/multi-timeframe-all")
async def get_all_multi_timeframe():
    """Get multi-timeframe analysis for all tracked symbols."""
    symbols = ['SOL', 'ETH', 'WBTC']
    results = {}
    
    for symbol in symbols:
        try:
            analysis = await bot_state.mtf_analyzer.analyze_symbol(symbol)
            bot_state.multi_timeframe_data[symbol] = analysis
            results[symbol] = analysis
        except Exception as e:
            logger.error(f"Error analyzing {symbol}: {e}")
            results[symbol] = {'error': str(e)}
    
    return results

@app.get("/api/chart-data/{symbol}")
async def get_chart_data(symbol: str, timeframe: str = "1m"):
    """Get price chart data for display."""
    try:
        df = await bot_state.data_loader.fetch_coingecko_ohlcv(symbol, timeframe, days=7)
        
        if df is None or df.empty:
            return {"error": "No data available"}
        
        # Prepare chart data
        chart_data = []
        for idx, row in df.iterrows():
            chart_data.append({
                'time': int(idx.timestamp()),
                'open': float(row['open']),
                'high': float(row['high']),
                'low': float(row['low']),
                'close': float(row['close']),
                'volume': float(row['volume']) if 'volume' in row else 0,
            })
        
        return {
            'symbol': symbol,
            'timeframe': timeframe,
            'data': chart_data,
            'length': len(chart_data)
        }
    except Exception as e:
        logger.error(f"Error fetching chart data: {e}")
        raise HTTPException(status_code=500, detail=str(e))
