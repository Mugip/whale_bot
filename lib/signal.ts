import { FeatureSet, TradeDirection } from "../state/schema";

export interface SignalResult {
  triggered: boolean;
  direction: TradeDirection | null;
  reasons: string[];
}

export function evaluateSignal(features: FeatureSet): SignalResult {
  const { currentPrice, ema50, ema200, currentRsi, prevRsi } = features;
  const reasons: string[] = [];

  // ─── LONG CONDITION: Trend + RSI Crosses back ABOVE 40 ───
  const isUptrend = ema50 > ema200 && currentPrice > ema200;
  const isOversoldCrossUp = prevRsi < 40 && currentRsi >= 40; // True Momentum Shift

  if (isUptrend && isOversoldCrossUp) {
    return { triggered: true, direction: "long", reasons: ["Trend Pullback Long (RSI Cross Up)"] };
  }

  // ─── SHORT CONDITION: Trend + RSI Crosses back BELOW 60 ───
  const isDowntrend = ema50 < ema200 && currentPrice < ema200;
  const isOverboughtCrossDown = prevRsi > 60 && currentRsi <= 60; // True Momentum Shift

  if (isDowntrend && isOverboughtCrossDown) {
    return { triggered: true, direction: "short", reasons: ["Trend Pullback Short (RSI Cross Down)"] };
  }

  return { triggered: false, direction: null, reasons };
}
