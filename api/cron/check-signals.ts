import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadState, saveState } from "../../lib/redis";
import { fetchCandles, fetchOrderBook, fetchMarkPrice } from "../../lib/okx";
import { computeWhaleScore } from "../../lib/whales";
import {
  computeRSI,
  detectRSIDivergence,
  computeATR,
  computeVolumeRatio,
  computeEMA // <-- IMPORTED HERE
} from "../../lib/indicators";
import { detectLiquiditySweep } from "../../lib/sweep";
import { computeOrderBookImbalance } from "../../lib/orderbook";
import { calculateRisk } from "../../lib/risk";
import { evaluateSignal } from "../../lib/signal";
import { openPosition, updatePositions } from "../trade/execute";
import { alertSignalTriggered, alertCycleSkipped } from "../../lib/telegram";
import { logger } from "../../utils/logger";
import { nowMs } from "../../utils/time";
import { FeatureSet, SignalSnapshot } from "../../state/schema";

function validateEnv(): string[] {
  return ["REDIS_URL", "OKX_BASE_URL", "CRON_SECRET"].filter((key) => !process.env[key]);
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const startMs = Date.now();
  const authHeader = req.headers["x-cron-secret"] ?? req.query["secret"];

  if (authHeader !== process.env.CRON_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const missingEnv = validateEnv();
  if (missingEnv.length > 0) {
    res.status(500).json({ error: `Missing env vars: ${missingEnv.join(", ")}` });
    return;
  }

  const symbol = process.env.TRADING_SYMBOL ?? "BTC-USDT-SWAP";
  let state = await loadState();

  const LATENCY_LIMIT_MS = 5000;
  let dataFailures = 0;

  const fetchWithTimeout = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), LATENCY_LIMIT_MS));
    try {
      const result = await Promise.race([fn(), timeoutPromise]);
      if (result === null) dataFailures++;
      return result;
    } catch {
      dataFailures++;
      return null;
    }
  };

  const [candles15m, candles1h, candles1m, orderBook, markPrice, whaleResult] = await Promise.all([
      fetchWithTimeout("candles_15m", () => fetchCandles(symbol, "15m", 30)),
      fetchWithTimeout("candles_1h",  () => fetchCandles(symbol, "1H", 250)), // Increased to 250 for 200 EMA
      fetchWithTimeout("candles_1m",  () => fetchCandles(symbol, "1m", 5)),
      fetchWithTimeout("orderbook",   () => fetchOrderBook(symbol, 5)),
      fetchWithTimeout("mark_price",  () => fetchMarkPrice(symbol)),
      computeWhaleScore(),
  ]);

  if (dataFailures > 2) {
    await alertCycleSkipped("Multiple data sources failed");
    res.status(200).json({ skipped: true });
    return;
  }

  state.whaleScoreHistory = [...state.whaleScoreHistory.slice(-100), {
      timestamp: nowMs(), score: whaleResult.score, outflowsToCold: whaleResult.outflowsToCold, inflowsToExchange: whaleResult.inflowsToExchange,
  }];

  const currentPrice = markPrice ?? candles15m?.[candles15m.length - 1]?.close ?? 0;

  if (currentPrice > 0 && state.openPositions.length > 0) {
    state = await updatePositions(state, currentPrice);
  }

  const rsiValues = candles1h ? computeRSI(candles1h, 14) : [];
  const rsiDivergence = candles1h ? detectRSIDivergence(candles1h, rsiValues) : { bullish: false, bearish: false };
  const sweepResult = candles15m ? detectLiquiditySweep(candles15m) : { bullishSweep: false, bearishSweep: false, sweepLow: 0, sweepHigh: 0 };
  const volumeRatio = candles15m ? computeVolumeRatio(candles15m, 20) : 0;
  
  // Use 1H candles for ATR and EMA
  const atr = candles1h ? computeATR(candles1h, 14) : 0;
  const ema200 = candles1h ? computeEMA(candles1h, 200) : 0;

  const obResult = orderBook ? computeOrderBookImbalance(orderBook) : { imbalance: 0, bidVolume: 0, askVolume: 0, totalVolume: 0, snapshotCount: 0 };

  const features: FeatureSet = {
    whaleScore: whaleResult.score,
    sweepConfirmed: sweepResult.bullishSweep || sweepResult.bearishSweep,
    volumeRatio,
    rsiDivergent: rsiDivergence.bullish || rsiDivergence.bearish,
    rsiDirection: rsiDivergence.bullish ? "bullish" : rsiDivergence.bearish ? "bearish" : "none",
    obImbalance: obResult.imbalance,
    currentPrice,
    sweepLow: sweepResult.sweepLow,
    sweepHigh: sweepResult.sweepHigh,
    atr,
    ema200 // <-- ADDED HERE
  };

  const hasOpenPosition = state.openPositions.length > 0;
  const signal = evaluateSignal(features);

  if (signal.triggered && signal.direction && !hasOpenPosition) {
    const sweepExtreme = signal.direction === "long" ? sweepResult.sweepLow : sweepResult.sweepHigh;
    const risk = calculateRisk(signal.direction, currentPrice, sweepExtreme, atr, state.accountBalance);

    await alertSignalTriggered(signal.direction, symbol, currentPrice, whaleResult.score, volumeRatio);
    state = await openPosition(state, signal.direction, symbol, risk);
  }

  await saveState(state);

  res.status(200).json({
    success: true,
    durationMs: Date.now() - startMs,
    signal: { direction: signal.direction, triggered: signal.triggered },
    openPositions: state.openPositions.length,
    accountBalance: state.accountBalance,
  });
}
