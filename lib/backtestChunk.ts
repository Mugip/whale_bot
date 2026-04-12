// ─────────────────────────────────────────────────────────────
// lib/backtestChunk.ts
// ─────────────────────────────────────────────────────────────

import { ChunkState } from "./backtestRedis";
import { computeRSI, detectRSIDivergence, computeATR, computeVolumeRatio } from "./indicators";
import { detectLiquiditySweep } from "./sweep";
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
    wins: 0, losses: 0, totalPnlPct: 0, equityCurve:[INITIAL_BALANCE], trade: null, trades: []
  };

  const trades: any[] =[];
  const end = Math.min(startIndex + chunkSize, bars.length);

  for (let i = startIndex; i < end; i++) {
    const bar = bars[i];

    // ── Manage open trade ──────────────────────────────────
    if (state.trade) {
      const t = state.trade;
      const isLong = t.direction === "long";

      // Calculate trailing activation (disabled/widened mostly, relies on TP1/TP2)
      const trailActPrice = isLong ? t.entry * (1 + 0.05) : t.entry * (1 - 0.05);
      if (isLong && bar.high >= trailActPrice) {
          const newStop = bar.close * (1 - 0.02);
          if (newStop > t.stop) t.stop = newStop;
      } else if (!isLong && bar.low <= trailActPrice) {
          const newStop = bar.close * (1 + 0.02);
          if (newStop < t.stop) t.stop = newStop;
      }

      const slHit  = isLong ? bar.low  <= t.stop : bar.high >= t.stop;
      const tp1Hit = isLong ? bar.high >= t.tp1  : bar.low  <= t.tp1;
      const tp2Hit = isLong ? bar.high >= t.tp2  : bar.low  <= t.tp2;

      // Partial close at TP1
      if (!t.tp1Hit && tp1Hit) {
        t.tp1Hit = true;
        const partialPnlPct = isLong ? (t.tp1 - t.entry) / t.entry : (t.entry - t.tp1) / t.entry;
        const profitSecured = t.notional * TP1_CLOSE_FRACTION * partialPnlPct;
        
        state.balance += profitSecured;
        t.realizedUsd = (t.realizedUsd || 0) + profitSecured; // Track secured profit
        
        t.size *= (1 - TP1_CLOSE_FRACTION);
        t.notional *= (1 - TP1_CLOSE_FRACTION);
        t.stop = isLong ? Math.max(t.stop, t.entry) : Math.min(t.stop, t.entry); // Move to Break-Even
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

        // Calculate blended PnL % based on ORIGINAL full position size
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

    let lastTradeBar = -999;

    if (i % 50 === 0) state.equityCurve.push(parseFloat(state.balance.toFixed(2)));

    if (state.trade) continue;
    if (i < 50) continue;
    if (i - lastTradeBar < 8) continue; // NEW: 2 hour cooldown after a closed trade

    const slice = bars.slice(Math.max(0, i - 60), i + 1);
    const rsiValues   = computeRSI(slice as any, 14);
    const rsiDiv      = detectRSIDivergence(slice as any, rsiValues);
    const sweepResult = detectLiquiditySweep(slice as any);
    const volumeRatio = computeVolumeRatio(slice as any, 20);
    const atr         = computeATR(slice as any, 14);

    const features: FeatureSet = {
      whaleScore: 0, sweepConfirmed: sweepResult.bullishSweep || sweepResult.bearishSweep,
      volumeRatio, rsiDivergent: rsiDiv.bullish || rsiDiv.bearish,
      rsiDirection: rsiDiv.bullish ? "bullish" : rsiDiv.bearish ? "bearish" : "none",
      obImbalance: 0, currentPrice: bar.close, sweepLow: sweepResult.sweepLow, sweepHigh: sweepResult.sweepHigh, atr,
    };

    const signal = evaluateSignal(features);
    if (!signal.triggered || !signal.direction) continue;

    lastTradeBar = i; // NEW: Record when we entered

    const sweepExtreme = signal.direction === "long" ? sweepResult.sweepLow : sweepResult.sweepHigh;
    const risk = calculateRisk(signal.direction, bar.close, sweepExtreme, atr, state.balance);

    state.trade = {
      direction: signal.direction, entry: bar.close, stop: risk.stopLoss,
      tp1: risk.takeProfitOne, tp2: risk.takeProfitTwo, tp1Hit: false,
      size: risk.positionSizeUsd / bar.close, notional: risk.positionSizeUsd,
      originalNotional: risk.positionSizeUsd, realizedUsd: 0
    };
  }

  state.nextIndex = end;
  return { state, trades, nextIndex: end, done: end >= bars.length };
}
