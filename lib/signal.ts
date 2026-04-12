// ─────────────────────────────────────────────────────────────
// lib/signal.ts
// Signal engine with tiered confluence validation.
//
// CORE conditions (both must pass):
//   - sweepConfirmed
//   - volumeRatio >= VOLUME_RATIO_THRESHOLD
//
// OPTIONAL confirmations (at least MIN_CONFIRMATIONS of 3 must pass):
//   - whaleScore (downgraded from core – on-chain data is off-exchange)
//   - RSI divergence
//   - orderbook imbalance
//
// This replaces the original all-or-nothing logic to increase
// signal frequency while maintaining edge quality.
// ─────────────────────────────────────────────────────────────

import { FeatureSet } from "../state/schema";
import { TradeDirection } from "../state/schema";
import { isWithinTradingHours } from "../utils/time";
import { logger } from "../utils/logger";

// ─── Thresholds ──────────────────────────────────────────────

const WHALE_SCORE_THRESHOLD = 0.4;
const VOLUME_RATIO_THRESHOLD = 1.3;
const OB_IMBALANCE_THRESHOLD = 0.15;

/**
 * Minimum optional confirmations required (out of 3:
 * whaleScore, RSI divergence, orderbook imbalance).
 */
/**
 * Change to 1! In backtests, Whale and OB data are missing (0),
 * so RSI is the ONLY confirmation available. 
 */
const MIN_CONFIRMATIONS = 1;

export interface SignalResult {
  triggered: boolean;
  direction: TradeDirection | null;
  reasons: string[];
  confirmations?: number; // how many optional confirmations passed
}

// ─── Core condition checkers ──────────────────────────────────

function checkLongCore(
  features: FeatureSet,
  withinHours: boolean
): { pass: boolean; failures: string[] } {
  const failures: string[] = [];

  if (!features.sweepConfirmed) {
    failures.push("bullish liquidity sweep not confirmed");
  }
  if (features.volumeRatio < VOLUME_RATIO_THRESHOLD) {
    failures.push(
      `volumeRatio ${features.volumeRatio.toFixed(2)} < ${VOLUME_RATIO_THRESHOLD}`
    );
  }
  if (!withinHours) {
    failures.push("outside trading hours (08:00–20:00 UTC)");
  }

  return { pass: failures.length === 0, failures };
}

function checkShortCore(
  features: FeatureSet,
  withinHours: boolean
): { pass: boolean; failures: string[] } {
  const failures: string[] = [];

  if (!features.sweepConfirmed) {
    failures.push("bearish liquidity sweep not confirmed");
  }
  if (features.volumeRatio < VOLUME_RATIO_THRESHOLD) {
    failures.push(
      `volumeRatio ${features.volumeRatio.toFixed(2)} < ${VOLUME_RATIO_THRESHOLD}`
    );
  }
  if (!withinHours) {
    failures.push("outside trading hours (08:00–20:00 UTC)");
  }

  return { pass: failures.length === 0, failures };
}

// ─── Optional confirmation counters ───────────────────────────

function countLongConfirmations(
  features: FeatureSet
): { count: number; details: string[] } {
  const details: string[] = [];
  let count = 0;

  if (features.whaleScore >= WHALE_SCORE_THRESHOLD) {
    count++;
    details.push(`whaleScore ${features.whaleScore.toFixed(3)} ✓`);
  } else {
    details.push(
      `whaleScore ${features.whaleScore.toFixed(3)} < ${WHALE_SCORE_THRESHOLD} (optional, skipped)`
    );
  }

  if (features.rsiDirection === "bullish") {
    count++;
    details.push("RSI bullish divergence ✓");
  } else {
    details.push(`RSI direction '${features.rsiDirection}', want 'bullish' (optional, skipped)`);
  }

  if (features.obImbalance >= OB_IMBALANCE_THRESHOLD) {
    count++;
    details.push(`obImbalance ${features.obImbalance.toFixed(3)} ✓`);
  } else {
    details.push(
      `obImbalance ${features.obImbalance.toFixed(3)} < ${OB_IMBALANCE_THRESHOLD} (optional, skipped)`
    );
  }

  return { count, details };
}

function countShortConfirmations(
  features: FeatureSet
): { count: number; details: string[] } {
  const details: string[] = [];
  let count = 0;

  if (features.whaleScore <= -WHALE_SCORE_THRESHOLD) {
    count++;
    details.push(`whaleScore ${features.whaleScore.toFixed(3)} ✓`);
  } else {
    details.push(
      `whaleScore ${features.whaleScore.toFixed(3)} > ${-WHALE_SCORE_THRESHOLD} (optional, skipped)`
    );
  }

  if (features.rsiDirection === "bearish") {
    count++;
    details.push("RSI bearish divergence ✓");
  } else {
    details.push(`RSI direction '${features.rsiDirection}', want 'bearish' (optional, skipped)`);
  }

  if (features.obImbalance <= -OB_IMBALANCE_THRESHOLD) {
    count++;
    details.push(`obImbalance ${features.obImbalance.toFixed(3)} ✓`);
  } else {
    details.push(
      `obImbalance ${features.obImbalance.toFixed(3)} > ${-OB_IMBALANCE_THRESHOLD} (optional, skipped)`
    );
  }

  return { count, details };
}

// ─── Main signal evaluation ───────────────────────────────────

export function evaluateSignal(features: FeatureSet): SignalResult {
  const withinHours = isWithinTradingHours();

  // ── LONG ────────────────────────────────────────────────
  const longCore = checkLongCore(features, withinHours);
  if (longCore.pass) {
    const { count, details } = countLongConfirmations(features);
    if (count >= MIN_CONFIRMATIONS) {
      logger.info("LONG signal triggered", {
        confirmations: count,
        whaleScore: features.whaleScore,
        volumeRatio: features.volumeRatio,
        obImbalance: features.obImbalance,
        details,
      });
      return { triggered: true, direction: "long", reasons: [], confirmations: count };
    }
    logger.debug("LONG core passed – insufficient optional confirmations", {
      confirmations: count,
      required: MIN_CONFIRMATIONS,
      details,
    });
  }

  // ── SHORT ────────────────────────────────────────────────
  const shortCore = checkShortCore(features, withinHours);
  if (shortCore.pass) {
    const { count, details } = countShortConfirmations(features);
    if (count >= MIN_CONFIRMATIONS) {
      logger.info("SHORT signal triggered", {
        confirmations: count,
        whaleScore: features.whaleScore,
        volumeRatio: features.volumeRatio,
        obImbalance: features.obImbalance,
        details,
      });
      return { triggered: true, direction: "short", reasons: [], confirmations: count };
    }
    logger.debug("SHORT core passed – insufficient optional confirmations", {
      confirmations: count,
      required: MIN_CONFIRMATIONS,
      details,
    });
  }

  const allFailures = [
    ...longCore.failures.map((f) => `[LONG-CORE] ${f}`),
    ...shortCore.failures.map((f) => `[SHORT-CORE] ${f}`),
  ];

  logger.debug("No signal – core conditions not met", { failures: allFailures });

  return { triggered: false, direction: null, reasons: allFailures };
}
