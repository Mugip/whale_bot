import { OKXCandle } from "./okx";

export function computeRSI(candles: OKXCandle[], period: number = 14): number[] {
  const closes = candles.map((c) => c.close);
  const rsi: number[] = new Array(closes.length).fill(NaN);

  if (closes.length < period + 1) return rsi;

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) {
      avgGain += diff;
    } else {
      avgLoss += Math.abs(diff);
    }
  }

  avgGain /= period;
  avgLoss /= period;

  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return rsi;
}

export interface DivergenceResult {
  bullish: boolean;
  bearish: boolean;
}

export function detectRSIDivergence(
  candles: OKXCandle[],
  rsiValues: number[]
): DivergenceResult {
  const LOOKBACK = 40;
  if (candles.length < LOOKBACK + 1) return { bullish: false, bearish: false };

  const current = candles[candles.length - 1];
  const currentRsi = rsiValues[rsiValues.length - 1];

  const pastCandles = candles.slice(-(LOOKBACK + 1), -1);
  const pastRsi = rsiValues.slice(-(LOOKBACK + 1), -1);

  let minLow = Infinity;
  let minLowRsi = 100;
  let maxHigh = -Infinity;
  let maxHighRsi = 0;

  for (let i = 0; i < pastCandles.length; i++) {
    if (pastCandles[i].low < minLow) {
      minLow = pastCandles[i].low;
      minLowRsi = pastRsi[i];
    }
    if (pastCandles[i].high > maxHigh) {
      maxHigh = pastCandles[i].high;
      maxHighRsi = pastRsi[i];
    }
  }

  const bullish = current.low <= minLow && currentRsi > minLowRsi;
  const bearish = current.high >= maxHigh && currentRsi < maxHighRsi;

  return { bullish, bearish };
}

export function computeATR(candles: OKXCandle[], period: number = 14): number {
  if (candles.length < period + 1) {
    const last = candles[candles.length - 1];
    return last.high - last.low;
  }

  const trValues: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trValues.push(tr);
  }

  let atr = trValues.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < trValues.length; i++) {
    atr = (atr * (period - 1) + trValues[i]) / period;
  }

  return atr;
}

export function computeVolumeRatio(
  candles: OKXCandle[],
  lookback: number = 20
): number {
  if (candles.length < lookback + 1) return 0;

  const current = candles[candles.length - 1];
  const previous = candles.slice(-(lookback + 1), -1);

  const avgVolume =
    previous.reduce((sum, c) => sum + c.vol, 0) / previous.length;

  if (avgVolume === 0) return 0;

  return current.vol / avgVolume;
}

export function computeEMA(candles: OKXCandle[], period: number = 200): number {
  if (candles.length < period) return candles[candles.length - 1]?.close || 0;
  
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += candles[i].close;
  let ema = sum / period;

  for (let i = period; i < candles.length; i++) {
    ema = (candles[i].close - ema) * k + ema;
  }
  
  return ema;
}
