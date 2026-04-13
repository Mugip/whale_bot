import { computeRSI, computeATR, computeBollingerBands } from "./indicators";
import { calculateRisk, TP1_CLOSE_FRACTION } from "./risk";
import { evaluateSignal } from "./signal";
import { OKXCandle } from "./okx";
import { FeatureSet, TradeDirection } from "../state/schema";

export interface BacktestTrade {
  openBar: number; closeBar: number; direction: TradeDirection; entryPrice: number; exitPrice: number;
  stopLoss: number; takeProfitOne: number; takeProfitTwo: number; pnlPct: number; closeReason: "tp1" | "tp2" | "sl" | "end_of_data" | "be/trail";
}

export interface BacktestResult {
  trades: BacktestTrade[]; totalTrades: number; winRate: number; avgPnlPct: number; totalPnlPct: number;
  maxDrawdownPct: number; profitFactor: number; sharpeApprox: number;
}

export function runBacktest(
  candles15m: OKXCandle[], candles1h: OKXCandle[], initialBalance = 10_000, warmupBars = 50 
): BacktestResult {
  const trades: BacktestTrade[] =[];
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
  let lastTradeBar = -999;

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
        
        // Move stop to entry after TP1 hit to guarantee a risk-free trade
        openTrade.stopLoss = openTrade.entryPrice;
      }

      let closed = false;
      let exitPrice = close;
      let reason: BacktestTrade["closeReason"] = "sl";

      if (slHit) { exitPrice = openTrade.stopLoss; reason = openTrade.tp1Hit ? "be/trail" : "sl"; closed = true; } 
      else if (openTrade.tp1Hit && tp2Hit) { exitPrice = openTrade.takeProfitTwo; reason = "tp2"; closed = true; }

      if (closed) {
        const pnlPct = isLong ? (exitPrice - openTrade.entryPrice) / openTrade.entryPrice : (openTrade.entryPrice - exitPrice) / openTrade.entryPrice;
        balance += openTrade.notional * pnlPct;

        trades.push({
          openBar: openTrade.openBar, closeBar: i, direction: openTrade.direction,
          entryPrice: openTrade.entryPrice, exitPrice, stopLoss: openTrade.stopLoss,
          takeProfitOne: openTrade.takeProfitOne, takeProfitTwo: openTrade.takeProfitTwo,
          pnlPct: pnlPct * 100, closeReason: reason,
        });

        openTrade = null;
        lastTradeBar = i; 

        if (balance > peakBalance) peakBalance = balance;
        const drawdown = ((peakBalance - balance) / peakBalance) * 100;
        if (drawdown > maxDrawdownPct) maxDrawdownPct = drawdown;
      }
      continue; 
    }

    if (slice15m.length < 50) continue; // BB needs less warmup than EMA
    if (i - lastTradeBar < 4) continue; // Short 1-hour cooldown 

    const rsiValues = computeRSI(slice15m, 14); 
    const bb        = computeBollingerBands(slice15m, 20, 2.5); // 15m Bollinger Bands
    const atr       = computeATR(slice1h, 14); // 1H ATR for macro volatility sizing       

    const currentRsi = rsiValues[rsiValues.length - 1];

    const features: FeatureSet = {
      currentPrice: bar.close,
      currentRsi, atr,
      bbUpper: bb.upper, bbMiddle: bb.middle, bbLower: bb.lower
    };

    const signal = evaluateSignal(features);
    if (!signal.triggered || !signal.direction) continue;

    // Hard 2.0 ATR stop
    const baseStop = signal.direction === "long" ? bar.close - (atr * 2.0) : bar.close + (atr * 2.0);
    const risk = calculateRisk(signal.direction, bar.close, baseStop, atr, balance);

    openTrade = {
      direction: signal.direction, entryPrice: bar.close, effectiveEntry: risk.effectiveEntryPrice,
      stopLoss: risk.stopLoss, takeProfitOne: risk.takeProfitOne, takeProfitTwo: risk.takeProfitTwo,
      openBar: i, tp1Hit: false, size: risk.positionSizeUsd / bar.close, notional: risk.positionSizeUsd,
    };
  }

  if (openTrade) {
    const lastBar = candles15m[candles15m.length - 1];
    const exitPrice = lastBar.close;
    const isLong = openTrade.direction === "long";
    const pnlPct = isLong ? (exitPrice - openTrade.entryPrice) / openTrade.entryPrice : (openTrade.entryPrice - exitPrice) / openTrade.entryPrice;

    trades.push({
      openBar: openTrade.openBar, closeBar: candles15m.length - 1, direction: openTrade.direction,
      entryPrice: openTrade.entryPrice, exitPrice, stopLoss: openTrade.stopLoss, takeProfitOne: openTrade.takeProfitOne, takeProfitTwo: openTrade.takeProfitTwo,
      pnlPct: pnlPct * 100, closeReason: "end_of_data",
    });
  }

  const winners = trades.filter((t) => t.pnlPct > 0);
  const losers  = trades.filter((t) => t.pnlPct <= 0);
  const winRate = trades.length > 0 ? winners.length / trades.length : 0;
  const avgPnlPct = trades.length > 0 ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : 0;
  const totalPnlPct = ((balance - initialBalance) / initialBalance) * 100;
  const grossProfit = winners.reduce((s, t) => s + t.pnlPct, 0);
  const grossLoss   = Math.abs(losers.reduce((s, t) => s + t.pnlPct, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;

  const mean = avgPnlPct;
  const variance = trades.length > 1 ? trades.reduce((s, t) => s + Math.pow(t.pnlPct - mean, 2), 0) / (trades.length - 1) : 0;
  const sharpeApprox = variance > 0 ? mean / Math.sqrt(variance) : 0;

  return { trades, totalTrades: trades.length, winRate, avgPnlPct, totalPnlPct, maxDrawdownPct, profitFactor, sharpeApprox };
          }
