import { FeatureSet, TradeDirection } from "../state/schema";
import { isWithinTradingHours } from "../utils/time";

const WHALE_SCORE_THRESHOLD = 0.4;
const VOLUME_RATIO_THRESHOLD = 1.2;
const OB_IMBALANCE_THRESHOLD = 0.15;
const MIN_CONFIRMATIONS = 1;

export interface SignalResult {
  triggered: boolean; direction: TradeDirection | null; reasons: string[]; confirmations?: number;
}

function checkLongCore(features: FeatureSet, withinHours: boolean): { pass: boolean; failures: string[] } {
  const failures: string[] = [];
  if (!features.sweepConfirmed) failures.push("bullish sweep not confirmed");
  if (features.volumeRatio < VOLUME_RATIO_THRESHOLD) failures.push("volume too low");
  if (features.currentPrice < features.ema200) failures.push("Price below 200 EMA (Downtrend)");
  return { pass: failures.length === 0, failures };
}

function checkShortCore(features: FeatureSet, withinHours: boolean): { pass: boolean; failures: string[] } {
  const failures: string[] = [];
  if (!features.sweepConfirmed) failures.push("bearish sweep not confirmed");
  if (features.volumeRatio < VOLUME_RATIO_THRESHOLD) failures.push("volume too low");
  if (features.currentPrice > features.ema200) failures.push("Price above 200 EMA (Uptrend)");
  return { pass: failures.length === 0, failures };
}

function countLongConfirmations(features: FeatureSet): { count: number; details: string[] } {
  const details: string[] = []; let count = 0;
  if (features.whaleScore >= WHALE_SCORE_THRESHOLD) { count++; details.push("whaleScore ✓"); }
  if (features.rsiDirection === "bullish") { count++; details.push("RSI bullish divergence ✓"); }
  if (features.obImbalance >= OB_IMBALANCE_THRESHOLD) { count++; details.push("obImbalance ✓"); }
  return { count, details };
}

function countShortConfirmations(features: FeatureSet): { count: number; details: string[] } {
  const details: string[] = []; let count = 0;
  if (features.whaleScore <= -WHALE_SCORE_THRESHOLD) { count++; details.push("whaleScore ✓"); }
  if (features.rsiDirection === "bearish") { count++; details.push("RSI bearish divergence ✓"); }
  if (features.obImbalance <= -OB_IMBALANCE_THRESHOLD) { count++; details.push("obImbalance ✓"); }
  return { count, details };
}

export function evaluateSignal(features: FeatureSet): SignalResult {
  const withinHours = isWithinTradingHours();

  const longCore = checkLongCore(features, withinHours);
  if (longCore.pass) {
    const { count, details } = countLongConfirmations(features);
    if (count >= MIN_CONFIRMATIONS) return { triggered: true, direction: "long", reasons: [], confirmations: count };
  }

  const shortCore = checkShortCore(features, withinHours);
  if (shortCore.pass) {
    const { count, details } = countShortConfirmations(features);
    if (count >= MIN_CONFIRMATIONS) return { triggered: true, direction: "short", reasons: [], confirmations: count };
  }

  return { triggered: false, direction: null, reasons: [...longCore.failures, ...shortCore.failures] };
}
