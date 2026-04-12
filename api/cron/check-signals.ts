// ─────────────────────────────────────────────────────────────
// api/cron/check-signals.ts
// Main cron entry point – triggered every 5 minutes.
//
// Execution flow:
//   1. Validate environment
//   2. Fetch all market data in parallel
//   3. Compute features
//   4. Update open positions (TP/SL/trailing)
//   5. Evaluate signal conditions
//   6. If signal: size position and open trade
//   7. Persist state to Redis
//
// FIX: Whale data failure no longer blocks the cycle.
// whaleScore is an optional confirmation; a null result
// is treated as score=0 (neutral) and the cycle continues.
// ─────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadState, saveState } from "../../lib/redis";
import {
  fetchCandles,
  fetchOrderBook,
  fetchMarkPrice,
} from "../../lib/okx";
import { computeWhaleScore } from "../../lib/whales";
import {
  computeRSI,
  detectRSIDivergence,
  computeATR,
  computeVolumeRatio,
} from "../../lib/indicators";
import { detectLiquiditySweep } from "../../lib/sweep";
import { computeOrderBookImbalance } from "../../lib/orderbook";
import { calculateRisk } from "../../lib/risk";
import { evaluateSignal } from "../../lib/signal";
import { openPosition, updatePositions } from "../trade/execute";
import {
  alertSignalTriggered,
  alertError,
  alertCycleSkipped,
} from "../../lib/telegram";
import { logger } from "../../utils/logger";
import { nowMs } from "../../utils/time";
import { FeatureSet, SignalSnapshot } from "../../state/schema";

// ─── Environment validation ──────────────────────────────────

function validateEnv(): string[] {
  const required = [
    "REDIS_URL",
    "OKX_BASE_URL",
    "CRON_SECRET",
    // ETHERSCAN_API_KEY is intentionally NOT required here –
    // whale score is optional and fails gracefully.
  ];
  return required.filter((key) => !process.env[key]);
}

// ─── Main handler ─────────────────────────────────────────────

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const startMs = Date.now();

  // ── 0. Security ────────────────────────────────────────────
  const authHeader =
    req.headers["x-cron-secret"] ?? req.query["secret"];

  if (authHeader !== process.env.CRON_SECRET) {
    logger.warn("Unauthorized cron request");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // ── 1. Validate environment ────────────────────────────────
  const missingEnv = validateEnv();
  if (missingEnv.length > 0) {
    const msg = `Missing env vars: ${missingEnv.join(", ")}`;
    logger.error(msg);
    res.status(500).json({ error: msg });
    return;
  }

  const symbol = process.env.TRADING_SYMBOL ?? "BTC-USDT-SWAP";
  logger.info("Cron cycle started", { symbol });

  // ── 2. Load state ──────────────────────────────────────────
  let state = await loadState();

  // ── 3. Fetch all data in parallel ─────────────────────────
  const LATENCY_LIMIT_MS = 5000;

  let dataFailures = 0;

  const fetchWithTimeout = async <T>(
    name: string,
    fn: () => Promise<T>
  ): Promise<T | null> => {
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), LATENCY_LIMIT_MS)
    );
    try {
      const result = await Promise.race([fn(), timeoutPromise]);
      if (result === null) {
        logger.warn(`Data source timeout: ${name}`);
        dataFailures++;
      }
      return result;
    } catch (err) {
      logger.error(`Data source error: ${name}`, {
        error: (err as Error).message,
      });
      dataFailures++;
      return null;
    }
  };

  // Whale fetch never throws (see whales.ts); timeout still applied
  // so a hung Etherscan call doesn't stall the cycle.
  const [candles15m, candles1h, candles1m, orderBook, markPrice, whaleResult] =
    await Promise.all([
      fetchWithTimeout("candles_15m", () => fetchCandles(symbol, "15m", 30)),
      fetchWithTimeout("candles_1h",  () => fetchCandles(symbol, "1H", 50)),
      fetchWithTimeout("candles_1m",  () => fetchCandles(symbol, "1m", 5)),
      fetchWithTimeout("orderbook",   () => fetchOrderBook(symbol, 5)),
      fetchWithTimeout("mark_price",  () => fetchMarkPrice(symbol)),
      // computeWhaleScore always resolves (never rejects); fallback score=0
      computeWhaleScore(),
    ]);

  // ── 4. Failsafe: skip only if core market data is missing ─
  // Whale data failure (whaleResult.isNeutralFallback) is NOT
  // a skip condition – it becomes a neutral optional confirmation.
  if (dataFailures > 2) {
    const msg = `${dataFailures} data sources failed – skipping cycle`;
    logger.warn(msg);
    await alertCycleSkipped(msg);
    res.status(200).json({ skipped: true, reason: msg });
    return;
  }

  if (whaleResult.isNeutralFallback) {
    logger.info("Whale data unavailable – proceeding with neutral score (optional confirmation)");
  }

  // ── 5. Update whale score history ─────────────────────────
  state.whaleScoreHistory = [
    ...state.whaleScoreHistory.slice(-100),
    {
      timestamp: nowMs(),
      score: whaleResult.score,
      outflowsToCold: whaleResult.outflowsToCold,
      inflowsToExchange: whaleResult.inflowsToExchange,
    },
  ];

  // ── 6. Update open positions ──────────────────────────────
  const currentPrice =
    markPrice ?? candles15m?.[candles15m.length - 1]?.close ?? 0;

  if (currentPrice > 0 && state.openPositions.length > 0) {
    state = await updatePositions(state, currentPrice);
  }

  // ── 7. Compute features ───────────────────────────────────

  const rsiValues = candles1h ? computeRSI(candles1h, 14) : [];
  const rsiDivergence = candles1h
    ? detectRSIDivergence(candles1h, rsiValues)
    : { bullish: false, bearish: false };

  const sweepResult = candles15m
    ? detectLiquiditySweep(candles15m)
    : { bullishSweep: false, bearishSweep: false, sweepLow: 0, sweepHigh: 0 };

  const volumeRatio = candles15m ? computeVolumeRatio(candles15m, 20) : 0;
  const atr = candles1h ? computeATR(candles1h, 14) : 0;

  const obResult = orderBook
    ? computeOrderBookImbalance(orderBook)
    : { imbalance: 0, bidVolume: 0, askVolume: 0, totalVolume: 0, snapshotCount: 0 };

  const features: FeatureSet = {
    whaleScore: whaleResult.score,
    sweepConfirmed: sweepResult.bullishSweep || sweepResult.bearishSweep,
    volumeRatio,
    rsiDivergent: rsiDivergence.bullish || rsiDivergence.bearish,
    rsiDirection: rsiDivergence.bullish
      ? "bullish"
      : rsiDivergence.bearish
      ? "bearish"
      : "none",
    obImbalance: obResult.imbalance,
    currentPrice,
    sweepLow: sweepResult.sweepLow,
    sweepHigh: sweepResult.sweepHigh,
    atr,
  };

  logger.info("Features computed", {
    whaleScore: features.whaleScore.toFixed(3),
    whaleNeutralFallback: whaleResult.isNeutralFallback,
    sweepConfirmed: features.sweepConfirmed,
    volumeRatio: features.volumeRatio.toFixed(2),
    rsiDirection: features.rsiDirection,
    obImbalance: features.obImbalance.toFixed(3),
    obSnapshotCount: obResult.snapshotCount,
    price: currentPrice,
    atr: atr.toFixed(2),
  });

  // ── 8. Signal evaluation ──────────────────────────────────
  const hasOpenPosition = state.openPositions.length > 0;
  const signal = evaluateSignal(features);

  const snapshot: SignalSnapshot = {
    timestamp: nowMs(),
    symbol,
    direction: signal.direction,
    triggered: signal.triggered,
    whaleScore: features.whaleScore,
    sweepConfirmed: features.sweepConfirmed,
    volumeRatio: features.volumeRatio,
    rsiDivergence: features.rsiDivergent,
    obImbalance: features.obImbalance,
    withinTradingHours: true,
  };

  state.lastSignalTimestamp = nowMs();

  // ── 9. Execute trade if signal triggered ──────────────────
  if (signal.triggered && signal.direction && !hasOpenPosition) {
    const sweepExtreme =
      signal.direction === "long"
        ? sweepResult.sweepLow
        : sweepResult.sweepHigh;

    const risk = calculateRisk(
      signal.direction,
      currentPrice,
      sweepExtreme,
      atr,
      state.accountBalance
    );

    logger.info("Opening position", {
      direction: signal.direction,
      entryPrice: risk.entryPrice,
      effectiveEntry: risk.effectiveEntryPrice.toFixed(2),
      positionSizeUsd: risk.positionSizeUsd.toFixed(2),
      sl: risk.stopLoss.toFixed(2),
      tp1: risk.takeProfitOne.toFixed(2),
      tp2: risk.takeProfitTwo.toFixed(2),
      rr: risk.rrRatio.toFixed(2),
      estimatedFeeUsd: risk.estimatedFeeUsd.toFixed(2),
      confirmations: signal.confirmations,
    });

    await alertSignalTriggered(
      signal.direction,
      symbol,
      currentPrice,
      whaleResult.score,
      volumeRatio
    );

    state = await openPosition(state, signal.direction, symbol, risk);
  } else if (signal.triggered && hasOpenPosition) {
    logger.info("Signal triggered but position already open – skipping");
  }

  // ── 10. Persist state ─────────────────────────────────────
  await saveState(state);

  const durationMs = Date.now() - startMs;
  logger.info("Cron cycle complete", {
    durationMs,
    signalTriggered: signal.triggered,
    direction: signal.direction,
    openPositions: state.openPositions.length,
    balance: state.accountBalance.toFixed(2),
  });

  res.status(200).json({
    success: true,
    durationMs,
    signal: snapshot,
    openPositions: state.openPositions.length,
    accountBalance: state.accountBalance,
    whaleNeutralFallback: whaleResult.isNeutralFallback,
    failures: signal.triggered ? [] : signal.reasons,
  });
}
