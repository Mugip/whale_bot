// ─────────────────────────────────────────────────────────────
// lib/risk.ts
// Position sizing and risk management.
//
// FIXES applied:
//   1. Slippage + fee offset on effective entry/exit prices.
//      Prevents strategies from looking profitable on paper
//      while fees and spread silently erode real RR.
//   2. ATR-based take-profit levels (TP1 = ATR×1.5, TP2 = ATR×3)
//      instead of fixed percentage targets.  Market volatility
//      adapts the targets automatically.
// ─────────────────────────────────────────────────────────────

import { TradeDirection } from "../state/schema";

const STOP_BUFFER_PCT = 0.005;         // 1 % buffer beyond sweep extreme // Tightened from 1% to 0.5% buffer beyond sweep
const TRAILING_ACTIVATION_PCT = 0.015; // activate trailing at +4 % // Activate trailing at +1.5% profit (was 4%)
const TRAILING_DISTANCE_PCT = 0.005;   // trail by 1 % // Trail price by 0.5% (was 1%)

// ─── Slippage / fee constants ─────────────────────────────────
// OKX taker fee ≈ 0.05 %; add a conservative 0.05 % for spread.
// Total round-trip assumption: ~0.2 % (entry + exit).
const ENTRY_FEE_PCT = 0.001;  // 0.1 % effective entry slippage+fee
const EXIT_FEE_PCT  = 0.001;  // 0.1 % effective exit slippage+fee

// ─── ATR TP multipliers ──────────────────────────────────────
const ATR_TP1_MULT = 1.2; // Was 1.5
const ATR_TP2_MULT = 2.5; // Was 3.0

export interface RiskCalculation {
  positionSizeUsd: number;
  entryPrice: number;           // raw market price
  effectiveEntryPrice: number;  // after slippage + fees
  stopLoss: number;
  takeProfitOne: number;        // ATR-based
  takeProfitTwo: number;        // ATR-based
  trailingActivationPrice: number;
  riskAmountUsd: number;
  rrRatio: number;              // reward:risk to TP1 (on effective prices)
  estimatedFeeUsd: number;
}

/**
 * Calculates position size and levels for a new trade.
 *
 * @param direction     "long" or "short"
 * @param entryPrice    Current market price
 * @param sweepExtreme  The low (long) or high (short) that was swept
 * @param atr           Average True Range – drives TP placement
 * @param accountBalance Account balance in USD
 */
export function calculateRisk(
  direction: TradeDirection,
  entryPrice: number,
  sweepExtreme: number,
  atr: number,
  accountBalance: number
): RiskCalculation {
  const riskPct =
    parseFloat(process.env.RISK_PER_TRADE_PCT ?? "2") / 100;
  const maxPositionPct =
    parseFloat(process.env.MAX_POSITION_PCT ?? "5") / 100;

  const riskAmountUsd = accountBalance * riskPct;
  const maxPositionUsd = accountBalance * maxPositionPct;

  // ── Effective entry price (accounts for slippage + taker fee) ─
  const effectiveEntryPrice =
    direction === "long"
      ? entryPrice * (1 + ENTRY_FEE_PCT)
      : entryPrice * (1 - ENTRY_FEE_PCT);

  // ── Stop loss: beyond the swept extreme with buffer ───────────
  let stopLoss: number;
  if (direction === "long") {
    stopLoss = sweepExtreme * (1 - STOP_BUFFER_PCT);
  } else {
    stopLoss = sweepExtreme * (1 + STOP_BUFFER_PCT);
  }

  // ATR volatility check: widen stop if it's tighter than 0.5×ATR
  const stopDistance = Math.abs(effectiveEntryPrice - stopLoss);
  const effectiveStopDistance = Math.max(stopDistance, atr * 0.5);
  if (effectiveStopDistance > stopDistance) {
    stopLoss =
      direction === "long"
        ? effectiveEntryPrice - effectiveStopDistance
        : effectiveEntryPrice + effectiveStopDistance;
  }

  // ── ATR-based take-profit levels ──────────────────────────────
  // Uses effective entry so the targets already factor in fees.
  let takeProfitOne: number;
  let takeProfitTwo: number;
  let trailingActivationPrice: number;

  if (direction === "long") {
    takeProfitOne = effectiveEntryPrice + atr * ATR_TP1_MULT;
    takeProfitTwo = effectiveEntryPrice + atr * ATR_TP2_MULT;
    trailingActivationPrice = effectiveEntryPrice * (1 + TRAILING_ACTIVATION_PCT);
  } else {
    takeProfitOne = effectiveEntryPrice - atr * ATR_TP1_MULT;
    takeProfitTwo = effectiveEntryPrice - atr * ATR_TP2_MULT;
    trailingActivationPrice = effectiveEntryPrice * (1 - TRAILING_ACTIVATION_PCT);
  }

  // ── Position sizing ───────────────────────────────────────────
  const riskPerUnit = Math.abs(effectiveEntryPrice - stopLoss);
  let positionSizeUsd =
    riskPerUnit > 0 ? (riskAmountUsd / riskPerUnit) * effectiveEntryPrice : 0;
  positionSizeUsd = Math.min(positionSizeUsd, maxPositionUsd);

  // ── Estimated round-trip fee ──────────────────────────────────
  const estimatedFeeUsd =
    positionSizeUsd * (ENTRY_FEE_PCT + EXIT_FEE_PCT);

  // ── Reward:Risk ratio (effective prices) ─────────────────────
  const rrRatio =
    riskPerUnit > 0
      ? Math.abs(takeProfitOne - effectiveEntryPrice) / riskPerUnit
      : 0;

  return {
    positionSizeUsd,
    entryPrice,
    effectiveEntryPrice,
    stopLoss,
    takeProfitOne,
    takeProfitTwo,
    trailingActivationPrice,
    riskAmountUsd,
    rrRatio,
    estimatedFeeUsd,
  };
}

/**
 * Returns updated stop loss after trailing stop moves.
 * Returns current stop if trailing should not move yet.
 */
export function updateTrailingStop(
  direction: TradeDirection,
  currentPrice: number,
  currentStop: number,
  trailingActive: boolean
): number {
  if (!trailingActive) return currentStop;

  const newStop =
    direction === "long"
      ? currentPrice * (1 - TRAILING_DISTANCE_PCT)
      : currentPrice * (1 + TRAILING_DISTANCE_PCT);

  return direction === "long"
    ? Math.max(currentStop, newStop)
    : Math.min(currentStop, newStop);
}

export const TRAILING_ACTIVATION_PCT_EXPORT = TRAILING_ACTIVATION_PCT;
export const TP1_CLOSE_FRACTION = 0.5; // close 50 % of position at TP1
