import { Router, Request, Response } from "express";
import { getAddress, getBalance, getTokenBalance } from "../utils/wallet";

const router = Router();

const ADMIN_SECRET = process.env.ADMIN_SECRET;

/** Authentication middleware */
function authMiddleware(req: Request, res: Response, next: Function): void {
  const token = req.headers["x-admin-secret"] || req.query.secret;

  if (!ADMIN_SECRET) {
    console.warn("[walletApi] ADMIN_SECRET not configured — API is unprotected");
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
 * GET /api/wallet — Get wallet address and balances
 */
router.get("/", async (_req: Request, res: Response) => {
  try {
    const address = getAddress();
    
    // Fetch balances
    const maticBalance = await getBalance();
    const usdcBalance = await getTokenBalance("USDC");
    const wethBalance = await getTokenBalance("WETH");

    res.json({
      success: true,
      wallet: {
        address,
        balances: {
          MATIC: {
            balance: maticBalance,
            symbol: "MATIC",
            decimals: 18,
          },
          USDC: {
            balance: usdcBalance,
            symbol: "USDC",
            decimals: 6,
          },
          WETH: {
            balance: wethBalance,
            symbol: "WETH",
            decimals: 18,
          },
        },
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

export default router;
