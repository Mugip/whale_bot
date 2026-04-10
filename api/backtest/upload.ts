// ─────────────────────────────────────────────────────────────
// api/backtest/upload.ts
// Accepts a JSON array of OHLCV bars and stores them in Redis.
// POST body: { key: string, bars: OHLCVBar[] }
// ─────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { saveDataset } from "../../lib/backtestRedis";
import { logger } from "../../utils/logger";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const auth = req.headers["x-cron-secret"] ?? req.headers["authorization"];
  if (auth !== process.env.CRON_SECRET) return res.status(401).json({ error: "Unauthorized" });

  try {
    const { key, bars } = req.body as { key: string; bars: any[] };

    if (!key || !Array.isArray(bars) || bars.length === 0) {
      return res.status(400).json({ error: "Provide { key, bars[] }" });
    }
    if (bars.length > 20_000) {
      return res.status(400).json({ error: "Max 20,000 bars per upload" });
    }

    await saveDataset(key, bars);
    logger.info("Dataset uploaded", { key, bars: bars.length });

    return res.status(200).json({ ok: true, key, bars: bars.length });
  } catch (err) {
    logger.error("Upload failed", { error: (err as Error).message });
    return res.status(500).json({ error: (err as Error).message });
  }
}
