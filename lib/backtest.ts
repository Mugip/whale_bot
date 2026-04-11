// ─────────────────────────────────────────────────────────────
// lib/backtest.ts
// Simple bar-by-bar backtesting engine.
//
// Replays historical candles through the same signal/risk
// pipeline used in production and accumulates a trade log.
//
// Usage (standalone script):
//   npx ts-node lib/backtest.ts
//
// Or import and call runBacktest() with your own candle array.
// ─────────────────────────────────────────────────────────────

import {
  computeRSI,
  detectRSIDivergence,
  computeATR,
  computeVolumeRatio,
} from "./indicators";
import { detectLiquiditySweep } from "./sweep";
import { computeOrderBookImbalance } from "./orderbook";
import { calculateRisk, TP1_CLOSE_FRACTION } from "./risk";
import { evaluateSignal } from "./signal";
import { OKXCandle } from "./okx";
import { FeatureSet, TradeDirection } from "../state/schema";

// ─── Types ───────────────────────────────────────────────────

export interface BacktestTrade {
  openBar: number;
  closeBar: number;
  direction: TradeDirection;
  entryPrice: number;
  exitPrice: number;
  stopLoss: number;
  takeProfitOne: number;
  takeProfitTwo: number;
  pnlPct: number;
  closeReason: "tp1" | "tp2" | "sl" | "end_of_data";
}

export interface BacktestResult {
  trades: BacktestTrade[];
  totalTrades: number;
  winRate: number;           // 0–1
  avgPnlPct: number;
  totalPnlPct: number;
  maxDrawdownPct: number;
  profitFactor: number;
  sharpeApprox: number;      // approximate (daily, no risk-free rate)
}

// ─── Engine ──────────────────────────────────────────────────

/**
 * Runs a bar-by-bar backtest over historical 15m candles.
 *
 * @param candles15m  Oldest-first 15m OHLCV candles
 * @param candles1h   Oldest-first 1h OHLCV candles (same date range)
 * @param initialBalance  Starting account balance in USD
 * @param warmupBars  Number of bars to skip for indicator warm-up
 */
export function runBacktest(
  candles15m: OKXCandle[],
  candles1h: OKXCandle[],
  initialBalance = 10_000,
  warmupBars = 30
): BacktestResult {
  const trades: BacktestTrade[] = [];
  let balance = initialBalance;
  let peakBalance = initialBalance;
  let maxDrawdownPct = 0;

  // Map 15m bar timestamps to 1h bar indices for indicator alignment
  const getH1Index = (bar15mTs: number): number => {
    // Return the most recent 1h candle index whose ts <= bar15mTs
    let idx = 0;
    for (let i = 0; i < candles1h.length; i++) {
      if (candles1h[i].ts <= bar15mTs) idx = i;
      else break;
    }
    return idx;
  };

  let openTrade: {
    direction: TradeDirection;
    entryPrice: number;
    effectiveEntry: number;
    stopLoss: number;
    takeProfitOne: number;
    takeProfitTwo: number;
    openBar: number;
    tp1Hit: boolean;
    size: number;
    notional: number;
  } | null = null;

  for (let i = warmupBars; i < candles15m.length; i++) {
    const bar = candles15m[i];
    const slice15m = candles15m.slice(0, i + 1);

    const h1Idx = getH1Index(bar.ts);
    const slice1h = candles1h.slice(0, h1Idx + 1);

    // ── Update open trade against current bar ──────────────
    if (openTrade) {
      const { high, low, close } = bar;
      const isLong = openTrade.direction === "long";

      // Check SL
      const slHit = isLong ? low <= openTrade.stopLoss : high >= openTrade.stopLoss;
      // Check TP1
      const tp1Hit = isLong
        ? high >= openTrade.takeProfitOne
        : low <= openTrade.takeProfitOne;
      // Check TP2
      const tp2Hit = isLong
        ? high >= openTrade.takeProfitTwo
        : low <= openTrade.takeProfitTwo;

      if (!openTrade.tp1Hit && tp1Hit) {
        // Partial close at TP1
        openTrade.tp1Hit = true;
        const partialPnl = isLong
          ? (openTrade.takeProfitOne - openTrade.entryPrice) / openTrade.entryPrice
          : (openTrade.entryPrice - openTrade.takeProfitOne) / openTrade.entryPrice;
        balance += openTrade.notional * TP1_CLOSE_FRACTION * partialPnl;
        openTrade.size *= 1 - TP1_CLOSE_FRACTION;
        openTrade.notional *= 1 - TP1_CLOSE_FRACTION;
        // Move stop to break-even
        openTrade.stopLoss = openTrade.entryPrice;
      }

      let closed = false;
      let exitPrice = close;
      let reason: BacktestTrade["closeReason"] = "sl";

      if (slHit) {
        exitPrice = openTrade.stopLoss;
        reason = "sl";
        closed = true;
      } else if (openTrade.tp1Hit && tp2Hit) {
        exitPrice = openTrade.takeProfitTwo;
        reason = "tp2";
        closed = true;
      }

      if (closed) {
        const pnlPct = isLong
          ? (exitPrice - openTrade.entryPrice) / openTrade.entryPrice
          : (openTrade.entryPrice - exitPrice) / openTrade.entryPrice;

        balance += openTrade.notional * pnlPct;

        trades.push({
          openBar: openTrade.openBar,
          closeBar: i,
          direction: openTrade.direction,
          entryPrice: openTrade.entryPrice,
          exitPrice,
          stopLoss: openTrade.stopLoss,
          takeProfitOne: openTrade.takeProfitOne,
          takeProfitTwo: openTrade.takeProfitTwo,
          pnlPct: pnlPct * 100,
          closeReason: reason,
        });

        openTrade = null;

        // Track drawdown
        if (balance > peakBalance) peakBalance = balance;
        const drawdown = ((peakBalance - balance) / peakBalance) * 100;
        if (drawdown > maxDrawdownPct) maxDrawdownPct = drawdown;
      }

      continue; // Don't look for new entry while in a trade
    }

    // ── Compute features for entry evaluation ──────────────
    if (slice1h.length < 15) continue; // not enough 1h data

    const rsiValues = computeRSI(slice1h, 14);
    const rsiDivergence = detectRSIDivergence(slice1h, rsiValues);
    const sweepResult = detectLiquiditySweep(slice15m);
    const volumeRatio = computeVolumeRatio(slice15m, 20);
    const atr = computeATR(slice1h, 14);

    // Order book imbalance not available in backtests –
    // use neutral value (0) so it acts as a non-confirming optional.
    const obImbalance = 0;

    const features: FeatureSet = {
      whaleScore: 0, // not available historically
      sweepConfirmed: sweepResult.bullishSweep || sweepResult.bearishSweep,
      volumeRatio,
      rsiDivergent: rsiDivergence.bullish || rsiDivergence.bearish,
      rsiDirection: rsiDivergence.bullish
        ? "bullish"
        : rsiDivergence.bearish
        ? "bearish"
        : "none",
      obImbalance,
      currentPrice: bar.close,
      sweepLow: sweepResult.sweepLow,
      sweepHigh: sweepResult.sweepHigh,
      atr,
    };

    const signal = evaluateSignal(features);
    if (!signal.triggered || !signal.direction) continue;

    // ── Open simulated position ────────────────────────────
    const sweepExtreme =
      signal.direction === "long"
        ? sweepResult.sweepLow
        : sweepResult.sweepHigh;

    const risk = calculateRisk(
      signal.direction,
      bar.close,
      sweepExtreme,
      atr,
      balance
    );

    openTrade = {
      direction: signal.direction,
      entryPrice: bar.close,
      effectiveEntry: risk.effectiveEntryPrice,
      stopLoss: risk.stopLoss,
      takeProfitOne: risk.takeProfitOne,
      takeProfitTwo: risk.takeProfitTwo,
      openBar: i,
      tp1Hit: false,
      size: risk.positionSizeUsd / bar.close,
      notional: risk.positionSizeUsd,
    };
  }

  // ── Close any remaining open trade at end of data ─────────
  if (openTrade) {
    const lastBar = candles15m[candles15m.length - 1];
    const exitPrice = lastBar.close;
    const isLong = openTrade.direction === "long";
    const pnlPct = isLong
      ? (exitPrice - openTrade.entryPrice) / openTrade.entryPrice
      : (openTrade.entryPrice - exitPrice) / openTrade.entryPrice;

    trades.push({
      openBar: openTrade.openBar,
      closeBar: candles15m.length - 1,
      direction: openTrade.direction,
      entryPrice: openTrade.entryPrice,
      exitPrice,
      stopLoss: openTrade.stopLoss,
      takeProfitOne: openTrade.takeProfitOne,
      takeProfitTwo: openTrade.takeProfitTwo,
      pnlPct: pnlPct * 100,
      closeReason: "end_of_data",
    });
  }

  // ── Summary statistics ─────────────────────────────────────
  const winners = trades.filter((t) => t.pnlPct > 0);
  const losers  = trades.filter((t) => t.pnlPct <= 0);

  const winRate = trades.length > 0 ? winners.length / trades.length : 0;
  const avgPnlPct =
    trades.length > 0
      ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length
      : 0;
  const totalPnlPct =
    ((balance - initialBalance) / initialBalance) * 100;

  const grossProfit = winners.reduce((s, t) => s + t.pnlPct, 0);
  const grossLoss   = Math.abs(losers.reduce((s, t) => s + t.pnlPct, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Approximate Sharpe (mean/std of per-trade returns)
  const mean = avgPnlPct;
  const variance =
    trades.length > 1
      ? trades.reduce((s, t) => s + Math.pow(t.pnlPct - mean, 2), 0) /
        (trades.length - 1)
      : 0;
  const sharpeApprox = variance > 0 ? mean / Math.sqrt(variance) : 0;

  return {
    trades,
    totalTrades: trades.length,
    winRate,
    avgPnlPct,
    totalPnlPct,
    maxDrawdownPct,
    profitFactor,
    sharpeApprox,
  };
}

// ─── CLI runner ───────────────────────────────────────────────

if (require.main === module) {
  console.log(`
╔══════════════════════════════════════════════════════╗
║  whale-bot backtester                               ║
║                                                     ║
║  To run a real backtest:                            ║
║    1. Fetch historical candles from OKX REST API    ║
║    2. Pass them to runBacktest(candles15m, candles1h)║
║    3. Inspect the BacktestResult                    ║
║                                                     ║
║  Example fetch endpoint:                            ║
║    GET /api/v5/market/history-candles               ║
║      ?instId=BTC-USDT-SWAP&bar=15m&limit=300        ║
╚══════════════════════════════════════════════════════╝
  `);
  console.log("No candle data provided. Supply candles to runBacktest() to begin.");
}
