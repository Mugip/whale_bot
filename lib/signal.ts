import { FeatureSet, TradeDirection } from "../state/schema";

export interface SignalResult {
  triggered: boolean;
  direction: TradeDirection | null;
  reasons: string[];
}

export function evaluateSignal(features: FeatureSet): SignalResult {
  const { currentPrice, ema50, ema200, currentRsi, prevRsi, volumeRatio } = features;
  const reasons: string[] =[];

  const isVolumeBreakout = volumeRatio >= 1.0; 

  // ─── LONG CONDITION: Trend + RSI Crosses back ABOVE 45 + High Volume ───
  const isUptrend = ema50 > ema200 && currentPrice > ema200;
  const isOversoldCrossUp = prevRsi < 45 && currentRsi >= 45; // Changed from 40 to 45

  if (isUptrend && isOversoldCrossUp && isVolumeBreakout) {
    return { triggered: true, direction: "long", reasons:["Trend Pullback Long (RSI Cross Up + Volume)"] };
  }

  // ─── SHORT CONDITION: Trend + RSI Crosses back BELOW 55 + High Volume ───
  const isDowntrend = ema50 < ema200 && currentPrice < ema200;
  const isOverboughtCrossDown = prevRsi > 55 && currentRsi <= 55; // Changed from 60 to 55

  if (isDowntrend && isOverboughtCrossDown && isVolumeBreakout) {
    return { triggered: true, direction: "short", reasons:["Trend Pullback Short (RSI Cross Down + Volume)"] };
  }

  return { triggered: false, direction: null, reasons };
}
