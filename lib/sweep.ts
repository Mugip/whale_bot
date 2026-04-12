// ─────────────────────────────────────────────────────────────
// lib/sweep.ts
// Liquidity sweep detector.
// A sweep is confirmed when price briefly breaks a recent
// swing extreme and closes back inside it — indicating
// liquidity was grabbed and smart money reversed.
// ─────────────────────────────────────────────────────────────

import { OKXCandle } from "./okx";

const BREAK_THRESHOLD = 0.001; // 0.2% break required // Lowered from 0.002 (0.2% -> 0.1% break required)
const LOOKBACK = 20;

export interface SweepResult {
  bullishSweep: boolean; // sweep of lows (bearish stop-hunt → long setup)
  bearishSweep: boolean; // sweep of highs (bullish stop-hunt → short setup)
  sweepLow: number; // level swept on bullish sweep
  sweepHigh: number; // level swept on bearish sweep
}

/**
 * Detects a liquidity sweep on the most recent closed candle.
 *
 * Bullish sweep (supports LONG):
 *   - Current candle low breaks below the lowest low of last N candles
 *     by at least BREAK_THRESHOLD (0.2%)
 *   - Current candle CLOSES ABOVE that previous low
 *
 * Bearish sweep (supports SHORT):
 *   - Current candle high breaks above the highest high of last N candles
 *   - Current candle CLOSES BELOW that previous high
 *
 * @param candles  Oldest-first 15m candles (at least LOOKBACK + 1)
 */
export function detectLiquiditySweep(candles: OKXCandle[]): SweepResult {
  const result: SweepResult = {
    bullishSweep: false,
    bearishSweep: false,
    sweepLow: 0,
    sweepHigh: 0,
  };

  if (candles.length < LOOKBACK + 1) return result;

  const current = candles[candles.length - 1];
  const lookbackCandles = candles.slice(-(LOOKBACK + 1), -1);

  // Previous extreme levels (excluding current candle)
  const prevLow = Math.min(...lookbackCandles.map((c) => c.low));
  const prevHigh = Math.max(...lookbackCandles.map((c) => c.high));

  // ─── Bullish sweep ───────────────────────────────────────
  // Current low broke below prevLow by at least 0.1%
  // AND current close is back above prevLow
  // AND the candle closed GREEN (current.close > current.open)
  const requiredBullBreak = prevLow * (1 - BREAK_THRESHOLD);
  if (current.low <= requiredBullBreak && current.close > prevLow && current.close > current.open) {
    result.bullishSweep = true;
    result.sweepLow = prevLow;
  }

  // ─── Bearish sweep ───────────────────────────────────────
  // Current high broke above prevHigh by at least 0.1%
  // AND current close is back below prevHigh
  // AND the candle closed RED (current.close < current.open)
  const requiredBearBreak = prevHigh * (1 + BREAK_THRESHOLD);
  if (current.high >= requiredBearBreak && current.close < prevHigh && current.close < current.open) {
    result.bearishSweep = true;
    result.sweepHigh = prevHigh;
  }

  return result;
}
