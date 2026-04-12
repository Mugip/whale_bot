import { TradeDirection } from "../state/schema";

const STOP_BUFFER_PCT = 0.004;         // Widened to 0.4%
const TRAILING_ACTIVATION_PCT = 0.015;
const TRAILING_DISTANCE_PCT = 0.01;    

const ENTRY_FEE_PCT = 0.001;  
const EXIT_FEE_PCT  = 0.001;  

const ATR_TP1_MULT = 2.0; // Widened
const ATR_TP2_MULT = 4.0; // Let runners run

export interface RiskCalculation {
  positionSizeUsd: number; entryPrice: number; effectiveEntryPrice: number; stopLoss: number;
  takeProfitOne: number; takeProfitTwo: number; trailingActivationPrice: number;
  riskAmountUsd: number; rrRatio: number; estimatedFeeUsd: number;
}

export function calculateRisk(
  direction: TradeDirection, entryPrice: number, sweepExtreme: number, atr: number, accountBalance: number
): RiskCalculation {
  const riskPct = parseFloat(process.env.RISK_PER_TRADE_PCT ?? "2") / 100;
  const maxPositionPct = parseFloat(process.env.MAX_POSITION_PCT ?? "100") / 100;

  const riskAmountUsd = accountBalance * riskPct;
  const maxPositionUsd = accountBalance * maxPositionPct;

  const effectiveEntryPrice = direction === "long" ? entryPrice * (1 + ENTRY_FEE_PCT) : entryPrice * (1 - ENTRY_FEE_PCT);

  let stopLoss: number;
  if (direction === "long") stopLoss = sweepExtreme * (1 - STOP_BUFFER_PCT);
  else stopLoss = sweepExtreme * (1 + STOP_BUFFER_PCT);

  const stopDistance = Math.abs(effectiveEntryPrice - stopLoss);
  const effectiveStopDistance = Math.max(stopDistance, atr * 1.0);
  if (effectiveStopDistance > stopDistance) {
    stopLoss = direction === "long" ? effectiveEntryPrice - effectiveStopDistance : effectiveEntryPrice + effectiveStopDistance;
  }

  let takeProfitOne: number; let takeProfitTwo: number; let trailingActivationPrice: number;

  if (direction === "long") {
    takeProfitOne = effectiveEntryPrice + atr * ATR_TP1_MULT;
    takeProfitTwo = effectiveEntryPrice + atr * ATR_TP2_MULT;
    trailingActivationPrice = effectiveEntryPrice * (1 + TRAILING_ACTIVATION_PCT);
  } else {
    takeProfitOne = effectiveEntryPrice - atr * ATR_TP1_MULT;
    takeProfitTwo = effectiveEntryPrice - atr * ATR_TP2_MULT;
    trailingActivationPrice = effectiveEntryPrice * (1 - TRAILING_ACTIVATION_PCT);
  }

  const riskPerUnit = Math.abs(effectiveEntryPrice - stopLoss);
  let positionSizeUsd = riskPerUnit > 0 ? (riskAmountUsd / riskPerUnit) * effectiveEntryPrice : 0;
  positionSizeUsd = Math.min(positionSizeUsd, maxPositionUsd);

  const estimatedFeeUsd = positionSizeUsd * (ENTRY_FEE_PCT + EXIT_FEE_PCT);
  const rrRatio = riskPerUnit > 0 ? Math.abs(takeProfitOne - effectiveEntryPrice) / riskPerUnit : 0;

  return {
    positionSizeUsd, entryPrice, effectiveEntryPrice, stopLoss, takeProfitOne, takeProfitTwo,
    trailingActivationPrice, riskAmountUsd, rrRatio, estimatedFeeUsd,
  };
}

export function updateTrailingStop(direction: TradeDirection, currentPrice: number, currentStop: number, trailingActive: boolean): number {
  if (!trailingActive) return currentStop;
  const newStop = direction === "long" ? currentPrice * (1 - TRAILING_DISTANCE_PCT) : currentPrice * (1 + TRAILING_DISTANCE_PCT);
  return direction === "long" ? Math.max(currentStop, newStop) : Math.min(currentStop, newStop);
}

export const TRAILING_ACTIVATION_PCT_EXPORT = TRAILING_ACTIVATION_PCT;
export const TP1_CLOSE_FRACTION = 0.5;
