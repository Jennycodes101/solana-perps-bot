import express from "express";
import path from "path";
import { runTradingLoop, stopTradingLoop } from "./bot/trading";
import limitsApiRouter from "./admin/limitsApi";
import walletApiRouter from "./admin/walletApi";
import analyticsRouter from "./admin/analyticsApi";
import tradesRouter from "./admin/tradesApi";
import { initTradingMode } from "./admin/tradingMode";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use((req, _res, next) => {
  console.log(`[http] ${req.method} ${req.path}`);
  next();
});

app.use(express.static(path.join(__dirname, "..", "public")));

app.use("/api/trading-limits", limitsApiRouter);
app.use("/api/wallet", walletApiRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/trades", tradesRouter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

initTradingMode();

const server = app.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT}`);
  console.log(`[server] Admin  →  http://localhost:${PORT}/admin.html`);
  console.log(`[server] Health  →  http://localhost:${PORT}/health`);
});

runTradingLoop();

process.on("SIGINT", () => {
  console.log("\n[server] Shutting down gracefully...");
  stopTradingLoop();
  server.close(() => {
    console.log("[server] Server closed");
    process.exit(0);
  });
});
