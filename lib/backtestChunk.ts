import { ChunkState } from "./backtestRedis";
import { computeRSI, computeATR, computeEMA, computeVolumeRatio } from "./indicators";
import { calculateRisk, TP1_CLOSE_FRACTION } from "./risk";
import { evaluateSignal } from "./signal";
import { FeatureSet } from "../state/schema";

export interface OHLCVBar {
  timestamp: number; open: number; high: number; low: number; close: number; vol: number;
}

export function runChunk(
  bars: OHLCVBar[],
  startIndex: number,
  chunkSize: number,
  incomingState: ChunkState | null
): any {
  const INITIAL_BALANCE = 10_000;
  
  const state: ChunkState = incomingState ?? {
    nextIndex: startIndex, balance: INITIAL_BALANCE, peakBalance: INITIAL_BALANCE, 
    wins: 0, losses: 0, totalPnlPct: 0, equityCurve:[INITIAL_BALANCE], trade: null, trades:[]
  };

  const trades: any[] =[];
  const end = Math.min(startIndex + chunkSize, bars.length);

  for (let i = startIndex; i < end; i++) {
    const bar = bars[i];

    if (state.trade) {
      const t = state.trade as any;
      const isLong = t.direction === "long";

      const slHit  = isLong ? bar.low  <= t.stop : bar.high >= t.stop;
      const tp1Hit = isLong ? bar.high >= t.tp1  : bar.low  <= t.tp1;
      const tp2Hit = isLong ? bar.high >= t.tp2  : bar.low  <= t.tp2;

      if (!t.tp1Hit && tp1Hit) {
        t.tp1Hit = true;
        const partialPnlPct = isLong ? (t.tp1 - t.entry) / t.entry : (t.entry - t.tp1) / t.entry;
        const profitSecured = t.notional * TP1_CLOSE_FRACTION * partialPnlPct;
        
        state.balance += profitSecured;
        t.realizedUsd = (t.realizedUsd || 0) + profitSecured;
        
        t.size *= (1 - TP1_CLOSE_FRACTION);
        t.notional *= (1 - TP1_CLOSE_FRACTION);
        
        t.stop = t.entry; // Smart Breakeven after TP1
      }

      let closed = false;
      let exitPrice = bar.close;
      let reason = "sl";

      if (slHit) {
        exitPrice = t.stop; reason = t.tp1Hit ? "be/trail" : "sl"; closed = true;
      } else if (t.tp1Hit && tp2Hit) {
        exitPrice = t.tp2; reason = "tp2"; closed = true;
      }

      if (closed) {
        const finalPnlPct = isLong ? (exitPrice - t.entry) / t.entry : (t.entry - exitPrice) / t.entry;
        const finalProfit = t.notional * finalPnlPct;
        
        state.balance += finalProfit;
        t.realizedUsd = (t.realizedUsd || 0) + finalProfit;
        const blendedPnlPct = (t.realizedUsd / t.originalNotional) * 100;
        
        if (blendedPnlPct > 0) state.wins++; else state.losses++;
        state.totalPnlPct = ((state.balance - INITIAL_BALANCE) / INITIAL_BALANCE) * 100;

        const tRec = { bar: i, direction: t.direction, entry: t.entry, exit: exitPrice, pnlPct: blendedPnlPct, reason };
        trades.push(tRec);
        state.trades.push(tRec);
        state.trade = null;
        if (state.balance > state.peakBalance) state.peakBalance = state.balance;
      }
    }

    if (i % 50 === 0) state.equityCurve.push(parseFloat(state.balance.toFixed(2)));

    if (state.trade) continue;

    const lastTradeBar = state.trades.length > 0 ? state.trades[state.trades.length - 1].bar : -999;
    if (i < 200) continue; 
    if (i - lastTradeBar < 4) continue; // 1-hour cooldown between trades

    const slice = bars.slice(Math.max(0, i - 200), i + 1);
    
    const rsiValues   = computeRSI(slice as any, 14);
    const atr         = computeATR(slice as any, 14);
    const ema200      = computeEMA(slice as any, 200);
    const ema50       = computeEMA(slice as any, 50);
    const volumeRatio = computeVolumeRatio(slice as any, 20); 
    
    const currentRsi = rsiValues[rsiValues.length - 1];
    const prevRsi    = rsiValues[rsiValues.length - 2];

    const features: FeatureSet = {
      currentPrice: bar.close,
      ema200, ema50, currentRsi, prevRsi, atr, volumeRatio,
      isGreen: bar.close > bar.open, isRed: bar.close < bar.open
    };

    const signal = evaluateSignal(features);
    if (!signal.triggered || !signal.direction) continue;

    // 2.5 ATR Base Stop
    const baseStop = signal.direction === "long" ? bar.close - (atr * 2.5) : bar.close + (atr * 2.5);
    const risk = calculateRisk(signal.direction, bar.close, baseStop, atr, state.balance);

    state.trade = {
      direction: signal.direction, entry: bar.close, stop: risk.stopLoss,
      tp1: risk.takeProfitOne, tp2: risk.takeProfitTwo, tp1Hit: false,
      size: risk.positionSizeUsd / bar.close, notional: risk.positionSizeUsd,
      originalNotional: risk.positionSizeUsd, realizedUsd: 0
    } as any;
  }

  state.nextIndex = end;
  return { state, trades, nextIndex: end, done: end >= bars.length };
  }
