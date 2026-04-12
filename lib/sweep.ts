import { OKXCandle } from "./okx";

const BREAK_THRESHOLD = 0.001; 
const LOOKBACK = 40; 

export interface SweepResult {
  bullishSweep: boolean; bearishSweep: boolean; sweepLow: number; sweepHigh: number;
}

export function detectLiquiditySweep(candles: OKXCandle[]): SweepResult {
  const result: SweepResult = { bullishSweep: false, bearishSweep: false, sweepLow: 0, sweepHigh: 0 };

  if (candles.length < LOOKBACK + 1) return result;

  const current = candles[candles.length - 1];
  const lookbackCandles = candles.slice(-(LOOKBACK + 1), -1);

  const prevLow = Math.min(...lookbackCandles.map((c) => c.low));
  const prevHigh = Math.max(...lookbackCandles.map((c) => c.high));

  const candleRange = current.high - current.low;
  const lowerWick = Math.min(current.open, current.close) - current.low;
  const upperWick = current.high - Math.max(current.open, current.close);

  const requiredBullBreak = prevLow * (1 - BREAK_THRESHOLD);
  // Rejection logic: Must close > open (green candle)
  if (current.low <= requiredBullBreak && current.close > prevLow && current.close > current.open && candleRange > 0 && (lowerWick / candleRange) > 0.4) {
    result.bullishSweep = true;
    result.sweepLow = prevLow;
  }

  const requiredBearBreak = prevHigh * (1 + BREAK_THRESHOLD);
  // Rejection logic: Must close < open (red candle)
  if (current.high >= requiredBearBreak && current.close < prevHigh && current.close < current.open && candleRange > 0 && (upperWick / candleRange) > 0.4) {
    result.bearishSweep = true;
    result.sweepHigh = prevHigh;
  }

  return result;
}
