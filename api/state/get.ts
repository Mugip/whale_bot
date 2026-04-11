// ─────────────────────────────────────────────────────────────
// api/state/get.ts
// Securely fetches the live bot state (balance, positions, etc.)
// ─────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadState } from "../../lib/redis";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  // Authenticate using the CRON_SECRET
  const auth = req.headers["x-cron-secret"] ?? req.query["secret"];
  if (auth !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const state = await loadState();
    return res.status(200).json(state);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
}
