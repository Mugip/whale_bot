// ─────────────────────────────────────────────────────────────
// api/backtest/results.ts
// GET /api/backtest/results?sessionId=xxx  → full results
// GET /api/backtest/results               → list recent sessions
// ─────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getResults, getSession, listSessions } from "../../lib/backtestRedis";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const auth = req.headers["x-cron-secret"] ?? req.headers["authorization"];
  if (auth !== process.env.CRON_SECRET) return res.status(401).json({ error: "Unauthorized" });

  const { sessionId } = req.query as { sessionId?: string };

  if (sessionId) {
    const [session, results] = await Promise.all([
      getSession(sessionId),
      getResults(sessionId),
    ]);
    return res.status(200).json({ session, results });
  }

  // List mode
  const sessions = await listSessions();
  return res.status(200).json({ sessions });
}
