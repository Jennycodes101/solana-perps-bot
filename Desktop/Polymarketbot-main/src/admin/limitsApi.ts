import { Router, Request, Response } from "express";
import { getTradingLimits, updateTradingLimits } from "./tradingLimits";

const router = Router();

const ADMIN_SECRET = process.env.ADMIN_SECRET;

/** Authentication middleware */
function authMiddleware(req: Request, res: Response, next: Function): void {
  const token = req.headers["x-admin-secret"] || req.query.secret;

  if (!ADMIN_SECRET) {
    console.warn("[limitsApi] ADMIN_SECRET not configured — API is unprotected");
    next();
    return;
  }

  if (token !== ADMIN_SECRET) {
    res.status(401).json({ error: "Unauthorized", message: "Invalid or missing admin secret" });
    return;
  }

  next();
}

router.use(authMiddleware);

/**
 * GET /api/trading-limits — Get current trading limits
 */
router.get("/", (_req: Request, res: Response) => {
  try {
    const limits = getTradingLimits();
    res.json({
      success: true,
      limits,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

/**
 * POST /api/trading-limits — Update trading limits
 */
router.post("/", (req: Request, res: Response) => {
  try {
    const { maxConcurrentTrades, maxPositionSizeUSDC } = req.body;

    const updates: any = {};
    if (maxConcurrentTrades !== undefined) {
      updates.maxConcurrentTrades = maxConcurrentTrades;
    }
    if (maxPositionSizeUSDC !== undefined) {
      updates.maxPositionSizeUSDC = maxPositionSizeUSDC;
    }

    const updated = updateTradingLimits(updates, "dashboard");
    res.json({
      success: true,
      message: "Trading limits updated",
      limits: updated,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ success: false, error: message });
  }
});

export default router;
