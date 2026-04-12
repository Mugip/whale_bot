import { computeRSI, detectRSIDivergence, computeATR, computeVolumeRatio, computeEMA } from "./indicators";
import { detectLiquiditySweep } from "./sweep";
import { computeOrderBookImbalance } from "./orderbook";
import { calculateRisk, TP1_CLOSE_FRACTION } from "./risk";
import { evaluateSignal } from "./signal";
import { OKXCandle } from "./okx";
import { FeatureSet, TradeDirection } from "../state/schema";

export interface BacktestTrade {
  openBar: number; closeBar: number; direction: TradeDirection; entryPrice: number; exitPrice: number;
  stopLoss: number; takeProfitOne: number; takeProfitTwo: number; pnlPct: number; closeReason: "tp1" | "tp2" | "sl" | "end_of_data";
}

export interface BacktestResult {
  trades: BacktestTrade[]; totalTrades: number; winRate: number; avgPnlPct: number; totalPnlPct: number;
  maxDrawdownPct: number; profitFactor: number; sharpeApprox: number;
}

export function runBacktest(candles15m: OKXCandle[], candles1h: OKXCandle[], initialBalance = 10_000, warmupBars = 30): BacktestResult {
  const trades: BacktestTrade[] = [];
  let balance = initialBalance;
  let peakBalance = initialBalance;
  let maxDrawdownPct = 0;

  const getH1Index = (bar15mTs: number): number => {
    let idx = 0;
    for (let i = 0; i < candles1h.length; i++) {
      if (candles1h[i].ts <= bar15mTs) idx = i; else break;
    }
    return idx;
  };

  let openTrade: any = null;
  let lastTradeBar = -999; // Cooldown tracker

  for (let i = warmupBars; i < candles15m.length; i++) {
    const bar = candles15m[i];
    const slice15m = candles15m.slice(0, i + 1);
    const h1Idx = getH1Index(bar.ts);
    const slice1h = candles1h.slice(0, h1Idx + 1);

    if (openTrade) {
      const { high, low, close } = bar;
      const isLong = openTrade.direction === "long";

      const slHit = isLong ? low <= openTrade.stopLoss : high >= openTrade.stopLoss;
      const tp1Hit = isLong ? high >= openTrade.takeProfitOne : low <= openTrade.takeProfitOne;
      const tp2Hit = isLong ? high >= openTrade.takeProfitTwo : low <= openTrade.takeProfitTwo;

      if (!openTrade.tp1Hit && tp1Hit) {
        openTrade.tp1Hit = true;
        const partialPnl = isLong ? (openTrade.takeProfitOne - openTrade.entryPrice) / openTrade.entryPrice : (openTrade.entryPrice - openTrade.takeProfitOne) / openTrade.entryPrice;
        balance += openTrade.notional * TP1_CLOSE_FRACTION * partialPnl;
        openTrade.size *= 1 - TP1_CLOSE_FRACTION;
        openTrade.notional *= 1 - TP1_CLOSE_FRACTION;
        openTrade.stopLoss = openTrade.entryPrice;
      }

      let closed = false;
      let exitPrice = close;
      let reason: BacktestTrade["closeReason"] = "sl";

      if (slHit) { exitPrice = openTrade.stopLoss; reason = "sl"; closed = true; } 
      else if (openTrade.tp1Hit && tp2Hit) { exitPrice = openTrade.takeProfitTwo; reason = "tp2"; closed = true; }

      if (closed) {
        const pnlPct = isLong ? (exitPrice - openTrade.entryPrice) / openTrade.entryPrice : (openTrade.entryPrice - exitPrice) / openTrade.entryPrice;
        balance += openTrade.notional * pnlPct;

        trades.push({
          openBar: openTrade.openBar, closeBar: i, direction: openTrade.direction, entryPrice: openTrade.entryPrice,
          exitPrice, stopLoss: openTrade.stopLoss, takeProfitOne: openTrade.takeProfitOne, takeProfitTwo: openTrade.takeProfitTwo,
          pnlPct: pnlPct * 100, closeReason: reason,
        });

        openTrade = null;
        lastTradeBar = i; // Reset cooldown

        if (balance > peakBalance) peakBalance = balance;
        const drawdown = ((peakBalance - balance) / peakBalance) * 100;
        if (drawdown > maxDrawdownPct) maxDrawdownPct = drawdown;
      }
      continue;
    }

    if (slice1h.length < 200) continue; // Need 200 bars for EMA
    if (i - lastTradeBar < 8) continue; // 2 hour cooldown

    const rsiValues = computeRSI(slice1h, 14);
    const rsiDivergence = detectRSIDivergence(slice1h, rsiValues);
    const sweepResult = detectLiquiditySweep(slice15m);
    const volumeRatio = computeVolumeRatio(slice15m, 20);
    const atr = computeATR(slice1h, 14);
    const ema200 = computeEMA(slice1h, 200);

    const features: FeatureSet = {
      whaleScore: 0, sweepConfirmed: sweepResult.bullishSweep || sweepResult.bearishSweep,
      volumeRatio, rsiDivergent: rsiDivergence.bullish || rsiDivergence.bearish,
      rsiDirection: rsiDivergence.bullish ? "bullish" : rsiDivergence.bearish ? "bearish" : "none",
      obImbalance: 0, currentPrice: bar.close, sweepLow: sweepResult.sweepLow, sweepHigh: sweepResult.sweepHigh,
      atr, ema200
    };

    const signal = evaluateSignal(features);
    if (!signal.triggered || !signal.direction) continue;

    const sweepExtreme = signal.direction === "long" ? sweepResult.sweepLow : sweepResult.sweepHigh;
    const risk = calculateRisk(signal.direction, bar.close, sweepExtreme, atr, balance);

    openTrade = {
      direction: signal.direction, entryPrice: bar.close, effectiveEntry: risk.effectiveEntryPrice,
      stopLoss: risk.stopLoss, takeProfitOne: risk.takeProfitOne, takeProfitTwo: risk.takeProfitTwo,
      openBar: i, tp1Hit: false, size: risk.positionSizeUsd / bar.close, notional: risk.positionSizeUsd,
    };
  }

  // Returns logic omitted for brevity (keep your existing return logic at the bottom of lib/backtest.ts)
  return { trades, totalTrades: trades.length, winRate: 0, avgPnlPct: 0, totalPnlPct: 0, maxDrawdownPct, profitFactor: 0, sharpeApprox: 0 };
      }
