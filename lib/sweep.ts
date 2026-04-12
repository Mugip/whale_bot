import { OKXCandle } from "./okx";

const BREAK_THRESHOLD = 0.001; // 0.1% break required
const LOOKBACK = 40; // Increased to 40 candles (10 hours) for major levels

export interface SweepResult {
  bullishSweep: boolean;
  bearishSweep: boolean;
  sweepLow: number;
  sweepHigh: number;
}

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

  const prevLow = Math.min(...lookbackCandles.map((c) => c.low));
  const prevHigh = Math.max(...lookbackCandles.map((c) => c.high));

  // Calculate wick sizes relative to the whole candle
  const candleRange = current.high - current.low;
  const lowerWick = Math.min(current.open, current.close) - current.low;
  const upperWick = current.high - Math.max(current.open, current.close);

  // ─── Bullish sweep ───────────────────────────────────────
  const requiredBullBreak = prevLow * (1 - BREAK_THRESHOLD);
  // Break low, close back inside, AND the lower wick is > 40% of the candle
  if (current.low <= requiredBullBreak && current.close > prevLow && candleRange > 0 && (lowerWick / candleRange) > 0.4) {
    result.bullishSweep = true;
    result.sweepLow = prevLow;
  }

  // ─── Bearish sweep ───────────────────────────────────────
  const requiredBearBreak = prevHigh * (1 + BREAK_THRESHOLD);
  // Break high, close back inside, AND the upper wick is > 40% of the candle
  if (current.high >= requiredBearBreak && current.close < prevHigh && candleRange > 0 && (upperWick / candleRange) > 0.4) {
    result.bearishSweep = true;
    result.sweepHigh = prevHigh;
  }

  return result;
}
