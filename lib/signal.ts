import { FeatureSet, TradeDirection } from "../state/schema";

export interface SignalResult {
  triggered: boolean;
  direction: TradeDirection | null;
  reasons: string[];
}

export function evaluateSignal(features: FeatureSet): SignalResult {
  const { currentPrice, currentRsi, bbUpper, bbLower } = features;

  // ─── LONG CONDITION: Price pierces bottom BB (2.5 StdDev) + RSI Panic ───
  const isExtremePanic = currentPrice < bbLower && currentRsi < 30;

  if (isExtremePanic) {
    return { triggered: true, direction: "long", reasons:["Mean Reversion Long (Panic Bounce)"] };
  }

  // ─── SHORT CONDITION: Price pierces top BB (2.5 StdDev) + RSI Euphoria ───
  const isExtremeEuphoria = currentPrice > bbUpper && currentRsi > 70;

  if (isExtremeEuphoria) {
    return { triggered: true, direction: "short", reasons:["Mean Reversion Short (Euphoria Fade)"] };
  }

  return { triggered: false, direction: null, reasons:[] };
}
