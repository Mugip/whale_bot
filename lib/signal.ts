import { FeatureSet, TradeDirection } from "../state/schema";

export interface SignalResult {
  triggered: boolean;
  direction: TradeDirection | null;
  reasons: string[];
}

export function evaluateSignal(features: FeatureSet): SignalResult {
  const { currentPrice, ema50, ema200, currentRsi, prevRsi, volumeRatio } = features;
  const reasons: string[] =[];

  const isVolumeBreakout = volumeRatio >= 1.0; // Current volume must be above the 20-period average

  // ─── LONG CONDITION: Trend + RSI Crosses back ABOVE 40 + High Volume ───
  const isUptrend = ema50 > ema200 && currentPrice > ema200;
  const isOversoldCrossUp = prevRsi < 40 && currentRsi >= 40;

  if (isUptrend && isOversoldCrossUp && isVolumeBreakout) {
    return { triggered: true, direction: "long", reasons: ["Trend Pullback Long (RSI Cross Up + Volume)"] };
  }

  // ─── SHORT CONDITION: Trend + RSI Crosses back BELOW 60 + High Volume ───
  const isDowntrend = ema50 < ema200 && currentPrice < ema200;
  const isOverboughtCrossDown = prevRsi > 60 && currentRsi <= 60;

  if (isDowntrend && isOverboughtCrossDown && isVolumeBreakout) {
    return { triggered: true, direction: "short", reasons:["Trend Pullback Short (RSI Cross Down + Volume)"] };
  }

  return { triggered: false, direction: null, reasons };
}
