import { FeatureSet, TradeDirection } from "../state/schema";

export interface SignalResult {
  triggered: boolean;
  direction: TradeDirection | null;
  reasons: string[];
}

export function evaluateSignal(features: FeatureSet): SignalResult {
  const { currentPrice, ema50, ema200, currentRsi, prevRsi, volumeRatio, adx } = features;
  const reasons: string[] =[];

  const isVolumeBreakout = volumeRatio >= 1.0; 
  const isTrending = adx > 20; // NEW: Market must be actively trending

  // ─── LONG CONDITION ───
  const isUptrend = ema50 > ema200 && currentPrice > ema200;
  const isOversoldCrossUp = prevRsi < 45 && currentRsi >= 45; 

  if (isUptrend && isOversoldCrossUp && isVolumeBreakout && isTrending) {
    return { triggered: true, direction: "long", reasons:["Trend Pullback Long (ADX > 20)"] };
  }

  // ─── SHORT CONDITION ───
  const isDowntrend = ema50 < ema200 && currentPrice < ema200;
  const isOverboughtCrossDown = prevRsi > 55 && currentRsi <= 55; 

  if (isDowntrend && isOverboughtCrossDown && isVolumeBreakout && isTrending) {
    return { triggered: true, direction: "short", reasons:["Trend Pullback Short (ADX > 20)"] };
  }

  return { triggered: false, direction: null, reasons };
}
