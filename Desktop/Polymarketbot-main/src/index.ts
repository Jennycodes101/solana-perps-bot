import "dotenv/config";
import express from "express";
import http from "http";
import path from "path";
import { WebSocketServer, WebSocket } from "ws";

import { loadStore, saveStore } from "./utils/jsonStore";
import adminRouter from "./admin/tabs";
import limitsApiRouter from "./admin/limitsApi";
import walletApiRouter from "./admin/walletApi";
import { runTradingLoop, stopTradingLoop } from "./bot/trading";
import { getStats, flushStats } from "./admin/stats";
import { 
  initTradingMode, 
  getTradingMode, 
  getTradingModeState, 
  setTradingMode, 
  toggleTradingMode,
  type TradingMode
} from "./admin/tradingMode";
import { initTradingLimits } from "./admin/tradingLimits";
import { 
  startSpeedTrading, 
  stopSpeedTrading, 
  isSpeedTradingRunning, 
  getSpeedTradeState,
  getSpeedTradeHistory
} from "./bot/speedTrade";

// ── Bootstrap ──────────────────────────────────────────────────────────────

loadStore();
initTradingMode();
initTradingLimits();

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const STATS_BROADCAST_INTERVAL = parseInt(process.env.STATS_BROADCAST_INTERVAL_MS ?? "10000", 10);
const SHUTDOWN_TIMEOUT_MS = 10000; // Force shutdown after 10 seconds

const app = express();
app.use(express.json());

// Request logging middleware
app.use((req, _res, next) => {
  console.log(`[http] ${req.method} ${req.path}`);
  next();
});

// Static assets (admin SPA / public pages)
app.use(express.static(path.join(__dirname, "..", "public")));

// Admin API tabs
app.use("/admin", adminRouter);

// Trading Limits API
app.use("/api/trading-limits", limitsApiRouter);

// Wallet API
app.use("/api/wallet", walletApiRouter);

// Simple liveness probe
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Readiness probe (check if trading loop is running)
app.get("/ready", (_req, res) => {
  res.json({ 
    status: "ready", 
    timestamp: new Date().toISOString(),
    stats: getStats(),
    speedTrading: isSpeedTradingRunning()
  });
});

// Speed trading API endpoints
app.get("/api/speed-trade/status", (_req, res) => {
  res.json({
    running: isSpeedTradingRunning(),
    state: getSpeedTradeState(),
    history: getSpeedTradeHistory().slice(-50) // Last 50 trades
  });
});

app.post("/api/speed-trade/start", async (_req, res) => {
  try {
    await startSpeedTrading();
    res.json({ success: true, message: "Speed trading started" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

app.post("/api/speed-trade/stop", (_req, res) => {
  stopSpeedTrading();
  res.json({ success: true, message: "Speed trading stopped" });
});

// ── Trading Mode API endpoints ─────────────────────────────────────────────

// Get current trading mode
app.get("/api/trading-mode", (_req, res) => {
  res.json(getTradingModeState());
});

// Set trading mode
app.post("/api/trading-mode", (req, res) => {
  try {
    const { mode } = req.body as { mode?: string };
    
    if (!mode || (mode !== "paper" && mode !== "live")) {
      res.status(400).json({ 
        success: false, 
        error: "Invalid mode. Must be 'paper' or 'live'."
      });
      return;
    }

    const updated = setTradingMode(mode as TradingMode, "dashboard");
    res.json({ success: true, state: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// Toggle trading mode
app.post("/api/trading-mode/toggle", (req, res) => {
  try {
    const updated = toggleTradingMode("dashboard");
    res.json({ success: true, state: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

// ── WebSocket Stats Broadcast ──────────────────────────────────────────────

const wsServer = new WebSocketServer({ server: undefined, noServer: true });
const connectedClients = new Set<WebSocket>();

function broadcastStats(): void {
  const stats = getStats();
  const message = JSON.stringify({
    event: "stats",
    data: stats,
  });

  connectedClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function startStatsBroadcast(): void {
  console.log(`[ws] Stats broadcast started (interval=${STATS_BROADCAST_INTERVAL}ms)`);
  setInterval(() => broadcastStats(), STATS_BROADCAST_INTERVAL);
}

// Attach WebSocket handler to HTTP upgrade
const server = http.createServer(app);
server.on("upgrade", (request, socket, head) => {
  wsServer.handleUpgrade(request, socket, head, (ws) => {
    console.log("[ws] Client connected");
    connectedClients.add(ws);

    ws.on("message", (data) => {
      // Handle incoming messages if needed
    });

    ws.on("close", () => {
      console.log("[ws] Client disconnected");
      connectedClients.delete(ws);
    });

    ws.on("error", (err) => {
      console.error("[ws] Client error:", err);
    });
  });
});

// ── Graceful Shutdown ──────────────────────────────────────────────────────

async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`\n[server] Received ${signal}, shutting down gracefully...`);

  // Close all WebSocket connections
  connectedClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.close();
    }
  });

  // Stop trading loops
  stopTradingLoop();

  // Save state
  saveStore();

  // Close HTTP server
  server.close(() => {
    console.log("[server] HTTP server closed");
    process.exit(0);
  });

  // Force exit after timeout
  setTimeout(() => {
    console.error("[server] Forced shutdown after timeout");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
}

// Register signal handlers
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Handle uncaught exceptions
process.on("uncaughtException", (err) => {
  console.error("[server] Uncaught exception:", err);
  gracefulShutdown("uncaughtException");
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[server] Unhandled rejection at:", promise, "reason:", reason);
});

// ── Start ──────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT}`);
  console.log(`[server] Admin UI  →  http://localhost:${PORT}/admin`);
  console.log(`[server] Health    →  http://localhost:${PORT}/health`);
  console.log(`[server] Speed Trade API  →  http://localhost:${PORT}/api/speed-trade/status`);
  console.log(`[server] Trading Limits API  →  http://localhost:${PORT}/api/trading-limits`);
  console.log(`[server] Wallet API  →  http://localhost:${PORT}/api/wallet`);
});

// Start auto-broadcast of stats
startStatsBroadcast();

// Start the trading loop (non-blocking)
runTradingLoop().catch((err) => {
  console.error("[bot] Trading loop crashed:", err);
  gracefulShutdown("tradingLoopCrash");
});

// Start speed trading if enabled via environment variable
const ENABLE_SPEED_TRADING = process.env.ENABLE_SPEED_TRADING === "true";
if (ENABLE_SPEED_TRADING) {
  startSpeedTrading().catch((err) => {
    console.error("[bot] Speed trading startup failed:", err);
    // Don't crash the whole server, just log the error
  });
}
