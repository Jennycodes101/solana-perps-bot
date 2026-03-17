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
    
    // Check if RPC URL is configured
    if (!process.env.POLYGON_RPC_URL) {
      return res.status(500).json({
        success: false,
        error: "POLYGON_RPC_URL not configured",
        message: "Please set POLYGON_RPC_URL in your .env file (e.g., https://polygon-rpc.com)",
        wallet: { address }
      });
    }

    // Fetch balances
    const maticBalance = await getBalance();
    const usdcBalance = await getTokenBalance("USDC");
    const wethBalance = await getTokenBalance("WETH");

    res.json({
      success: true,
      wallet: {
        address,
        network: "Polygon (137)",
        balances: {
          MATIC: {
            balance: maticBalance,
            symbol: "MATIC",
            decimals: 18,
            note: "Gas fees"
          },
          USDC: {
            balance: usdcBalance,
            symbol: "USDC",
            decimals: 6,
            note: "Trading token"
          },
          WETH: {
            balance: wethBalance,
            symbol: "WETH",
            decimals: 18,
            note: "Not used in Polymarket"
          },
        },
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[walletApi] Error:", message);
    res.status(500).json({ 
      success: false, 
      error: message,
      hint: "Make sure POLYGON_RPC_URL is set in .env and your wallet has USDC + MATIC on Polygon network"
    });
  }
});

export default router;
