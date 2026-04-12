import { TradeDirection } from "../state/schema";

const ENTRY_FEE_PCT = 0.001;  
const EXIT_FEE_PCT  = 0.001;  

const ATR_TP1_MULT = 1.5; // Quick 1:1 risk/reward to secure capital
const ATR_TP2_MULT = 4.5; // Let the runners run massively

export interface RiskCalculation {
  positionSizeUsd: number; entryPrice: number; effectiveEntryPrice: number; stopLoss: number;
  takeProfitOne: number; takeProfitTwo: number; trailingActivationPrice: number;
  riskAmountUsd: number; rrRatio: number; estimatedFeeUsd: number;
}

export function calculateRisk(
  direction: TradeDirection, entryPrice: number, baseStop: number, atr: number, accountBalance: number
): RiskCalculation {
  const riskPct = parseFloat(process.env.RISK_PER_TRADE_PCT ?? "2") / 100;
  const maxPositionPct = parseFloat(process.env.MAX_POSITION_PCT ?? "100") / 100;

  const riskAmountUsd = accountBalance * riskPct;
  const maxPositionUsd = accountBalance * maxPositionPct;

  const effectiveEntryPrice = direction === "long" ? entryPrice * (1 + ENTRY_FEE_PCT) : entryPrice * (1 - ENTRY_FEE_PCT);

  let stopLoss = baseStop;

  let takeProfitOne: number; let takeProfitTwo: number; 
  const trailingActivationPrice = 0; // Disabled trailing logic in favor of hard targets

  if (direction === "long") {
    takeProfitOne = effectiveEntryPrice + atr * ATR_TP1_MULT;
    takeProfitTwo = effectiveEntryPrice + atr * ATR_TP2_MULT;
  } else {
    takeProfitOne = effectiveEntryPrice - atr * ATR_TP1_MULT;
    takeProfitTwo = effectiveEntryPrice - atr * ATR_TP2_MULT;
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

export const TP1_CLOSE_FRACTION = 0.5;
