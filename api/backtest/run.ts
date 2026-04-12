// ─────────────────────────────────────────────────────────────
// api/backtest/run.ts
// Processes one chunk of bars (≤200) and persists progress.
// The frontend calls this in a loop until done=true.
//
// POST body: { sessionId, datasetKey, chunkSize? }
// ─────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  createSession,
  getSession,
  updateSession,
  loadChunkState,
  saveChunkState,
  loadDataset,
  saveResults,
  BacktestResults,
} from "../../lib/backtestRedis";
import { runChunk } from "../../lib/backtestChunk";
import { logger } from "../../utils/logger";

// Simple ID generator
function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const auth = req.headers["x-cron-secret"];
  if (auth !== process.env.CRON_SECRET && req.headers["authorization"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const {
      sessionId: incomingId,
      datasetKey,
      label = "Backtest",
      chunkSize = 200,
    } = req.body as {
      sessionId?: string;
      datasetKey: string;
      label?: string;
      chunkSize?: number;
    };

    if (!datasetKey) return res.status(400).json({ error: "datasetKey required" });

    const bars = await loadDataset(datasetKey);
    if (!bars) return res.status(404).json({ error: `Dataset '${datasetKey}' not found` });

    // ── Create or resume session ──────────────────────────
    let sessionId = incomingId;
    if (!sessionId) {
      sessionId = genId();
      await createSession(sessionId, label, datasetKey, bars.length);
    }

    const session = await getSession(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });

    if (session.status === "done") {
      return res.status(200).json({ done: true, sessionId, message: "Already complete" });
    }

    await updateSession(sessionId, { status: "running" });

    // ── Load existing chunk state ─────────────────────────
    const prevState = await loadChunkState(sessionId);
    const startIndex = prevState?.nextIndex ?? 50; // skip warm-up

    // ── Run one chunk ─────────────────────────────────────
    const result = runChunk(bars as any, startIndex, Math.min(chunkSize, 200), prevState);

    // ── Persist progress ──────────────────────────────────
    await saveChunkState(sessionId, result.state);
    await updateSession(sessionId, { processedBars: result.nextIndex });

    // ── Finalise if complete ──────────────────────────────
    if (result.done) {
      const s = result.state;
      const INITIAL = 10_000;
      const winRate = (s.wins + s.losses) > 0 ? s.wins / (s.wins + s.losses) : 0;
      
      // Grab accumulated trades safely
      let allTrades = result.trades;
      if (s.trades) {
        allTrades = s.trades;
      }

      // Max drawdown from equity curve
      let maxDD = 0;
      let peak = INITIAL;
      for (const v of s.equityCurve) {
        if (v > peak) peak = v;
        const dd = ((peak - v) / peak) * 100;
        if (dd > maxDD) maxDD = dd;
      }

      
      // Gross profit / loss for profit factor
      const grossProfit = allTrades.filter((t: any) => t.pnlPct > 0).reduce((a: number, t: any) => a + t.pnlPct, 0);
      const grossLoss   = Math.abs(allTrades.filter((t: any) => t.pnlPct <= 0).reduce((a: number, t: any) => a + t.pnlPct, 0));
      const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;

      // Sharpe approx
      const pnls = allTrades.map((t: any) => t.pnlPct);
      const mean = pnls.length ? pnls.reduce((a: number, b: number) => a + b, 0) / pnls.length : 0;
      const variance = pnls.length > 1
        ? pnls.reduce((a: number, b: number) => a + Math.pow(b - mean, 2), 0) / (pnls.length - 1)
        : 0;
      const sharpe = variance > 0 ? mean / Math.sqrt(variance) : 0;

      const finalResults: BacktestResults = {
        totalTrades:   s.wins + s.losses,
        wins:          s.wins,
        losses:        s.losses,
        winRate,
        finalBalance:  parseFloat(s.balance.toFixed(2)),
        totalPnlPct:   parseFloat(s.totalPnlPct.toFixed(2)),
        maxDrawdownPct: parseFloat(maxDD.toFixed(2)),
        profitFactor:  parseFloat(profitFactor.toFixed(2)),
        sharpeApprox:  parseFloat(sharpe.toFixed(3)),
        equityCurve:   s.equityCurve,
        trades:        allTrades,
      };

      await saveResults(sessionId, finalResults);
      await updateSession(sessionId, { status: "done", finishedAt: Date.now() });

      return res.status(200).json({
        done: true,
        sessionId,
        nextIndex: result.nextIndex,
        results: finalResults,
      });
    }

    return res.status(200).json({
      done: false,
      sessionId,
      nextIndex: result.nextIndex,
      processedBars: result.nextIndex,
      totalBars: bars.length,
      progressPct: parseFloat(((result.nextIndex / bars.length) * 100).toFixed(1)),
    });

  } catch (err) {
    logger.error("Backtest chunk failed", { error: (err as Error).message });
    return res.status(500).json({ error: (err as Error).message });
  }
}
