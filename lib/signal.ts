import { FeatureSet, TradeDirection } from "../state/schema";

export interface SignalResult {
  triggered: boolean;
  direction: TradeDirection | null;
  reasons: string[];
}

export function evaluateSignal(features: FeatureSet): SignalResult {
  const { currentPrice, ema50, ema200, currentRsi, prevRsi, isGreen, isRed } = features;
  const reasons: string[] = [];

  // ─── LONG CONDITION: Trend + Oversold Pullback + Bullish Resumption ───
  const isUptrend = ema50 > ema200 && currentPrice > ema200;
  const isOversoldPullback = prevRsi < 40; // RSI dipped indicating a pullback
  const isTurningUp = currentRsi > prevRsi && isGreen; // Momentum returning

  if (isUptrend && isOversoldPullback && isTurningUp) {
    return { triggered: true, direction: "long", reasons: ["Trend Pullback Long"] };
  }

  // ─── SHORT CONDITION: Downtrend + Overbought Pullback + Bearish Resumption ───
  const isDowntrend = ema50 < ema200 && currentPrice < ema200;
  const isOverboughtPullback = prevRsi > 60; // RSI spiked indicating a relief rally
  const isTurningDown = currentRsi < prevRsi && isRed; // Momentum returning down

  if (isDowntrend && isOverboughtPullback && isTurningDown) {
    return { triggered: true, direction: "short", reasons: ["Trend Pullback Short"] };
  }

  // Debugging info (optional)
  if (!isUptrend && !isDowntrend) reasons.push("No clear trend (EMA 50/200 conflict)");
  if (isUptrend && !isOversoldPullback) reasons.push("Waiting for RSI < 40 pullback");
  if (isDowntrend && !isOverboughtPullback) reasons.push("Waiting for RSI > 60 pullback");

  return { triggered: false, direction: null, reasons };
}
