import { Router } from "express";

const router = Router();

router.get("/", (_req, res) => {
  try {
    // For paper trading, return mock wallet data
    const balance = 1000;
    const inTrades = 39 * 2.56; // Approximate from logs
    const availableBalance = balance - inTrades;
    
    res.json({
      success: true,
      data: {
        address: "0xpaper-trading-mode",
        balance: balance,
        availableBalance: Math.max(availableBalance, 500),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

export default router;
