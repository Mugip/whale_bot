// ─────────────────────────────────────────────────────────────
// lib/backtestChunk.ts
// Chunked backtesting engine wired to the real signal pipeline.
// Each call processes at most chunkSize bars and returns state
// for the next chunk – this keeps Vercel under the 60s timeout.
// ─────────────────────────────────────────────────────────────

import { ChunkState } from "./backtestRedis";
import { computeRSI, detectRSIDivergence, computeATR, computeVolumeRatio } from "./indicators";
import { detectLiquiditySweep } from "./sweep";
import { calculateRisk, TP1_CLOSE_FRACTION } from "./risk";
import { evaluateSignal } from "./signal";
import { FeatureSet } from "../state/schema";

export interface OHLCVBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  vol: number;
}

interface TradeRecord {
  bar: number;
  direction: "long" | "short";
  entry: number;
  exit: number;
  pnlPct: number;
  reason: string;
}

export interface ChunkResult {
  state: ChunkState;
  trades: TradeRecord[];
  nextIndex: number;
  done: boolean;
}

const INITIAL_BALANCE = 10_000;
const EQUITY_SAMPLE_EVERY = 50; // record equity every N bars

export function runChunk(
  bars: OHLCVBar[],
  startIndex: number,
  chunkSize: number,
  incomingState: ChunkState | null
): ChunkResult {
  // ── Restore or initialise state ──────────────────────────
  const state: ChunkState = incomingState ?? {
    nextIndex: startIndex,
    balance: INITIAL_BALANCE,
    peakBalance: INITIAL_BALANCE,
    wins: 0,
    losses: 0,
    totalPnlPct: 0,
    equityCurve: [INITIAL_BALANCE],
    trade: null,
  };

  const trades: TradeRecord[] = [];
  const end = Math.min(startIndex + chunkSize, bars.length);

  for (let i = startIndex; i < end; i++) {
    const bar = bars[i];

    // ── Manage open trade ──────────────────────────────────
    if (state.trade) {
      const t = state.trade;
      const isLong = t.direction === "long";

      // --- Trailing Stop Logic ---
      const TRAILING_ACTIVATION_PCT = 0.015; // 1.5%
      const TRAILING_DISTANCE_PCT = 0.01;   // changed from 0.5%
      const trailActPrice = isLong ? t.entry * (1 + TRAILING_ACTIVATION_PCT) : t.entry * (1 - TRAILING_ACTIVATION_PCT);
      
      if (isLong && bar.high >= trailActPrice) {
          const newStop = bar.close * (1 - TRAILING_DISTANCE_PCT);
          if (newStop > t.stop) t.stop = newStop;
      } else if (!isLong && bar.low <= trailActPrice) {
          const newStop = bar.close * (1 + TRAILING_DISTANCE_PCT);
          if (newStop < t.stop) t.stop = newStop;
      }
      // ---------------------------

      const slHit  = isLong ? bar.low  <= t.stop : bar.high >= t.stop;
      const tp1Hit = isLong ? bar.high >= t.tp1  : bar.low  <= t.tp1;
      const tp2Hit = isLong ? bar.high >= t.tp2  : bar.low  <= t.tp2;

      // Partial close at TP1
      if (!t.tp1Hit && tp1Hit) {
        t.tp1Hit = true;
        const partialPnl = isLong
          ? (t.tp1 - t.entry) / t.entry
          : (t.entry - t.tp1) / t.entry;
        state.balance += t.notional * TP1_CLOSE_FRACTION * partialPnl;
        t.size     *= (1 - TP1_CLOSE_FRACTION);
        t.notional *= (1 - TP1_CLOSE_FRACTION);
        // Move stop to break-even (or keep trailing if higher)
        t.stop = isLong ? Math.max(t.stop, t.entry) : Math.min(t.stop, t.entry);
      }

      let closed = false;
      let exitPrice = bar.close;
      let reason = "sl";

      if (slHit) {
        exitPrice = t.stop; reason = "sl/trail"; closed = true;
      } else if (t.tp1Hit && tp2Hit) {
        exitPrice = t.tp2; reason = "tp2"; closed = true;
      }

      if (closed) {
        const pnlPct = isLong
          ? (exitPrice - t.entry) / t.entry
          : (t.entry - exitPrice) / t.entry;

        state.balance += t.notional * pnlPct;
        if (pnlPct > 0) state.wins++; else state.losses++;
        state.totalPnlPct = ((state.balance - INITIAL_BALANCE) / INITIAL_BALANCE) * 100;

        trades.push({ bar: i, direction: t.direction, entry: t.entry, exit: exitPrice, pnlPct: pnlPct * 100, reason });
        state.trade = null;

        if (state.balance > state.peakBalance) state.peakBalance = state.balance;
      }
    }

    

    // Sample equity curve
    if (i % EQUITY_SAMPLE_EVERY === 0) {
      state.equityCurve.push(parseFloat(state.balance.toFixed(2)));
    }

    // ── Look for new entry (only if no open trade) ────────
    if (state.trade) continue;

    // Need at least 50 bars of history for indicators
    if (i < 50) continue;

    const slice = bars.slice(Math.max(0, i - 60), i + 1);

    const rsiValues   = computeRSI(slice as any, 14);
    const rsiDiv      = detectRSIDivergence(slice as any, rsiValues);
    const sweepResult = detectLiquiditySweep(slice as any);
    const volumeRatio = computeVolumeRatio(slice as any, 20);
    const atr         = computeATR(slice as any, 14);

    const features: FeatureSet = {
      whaleScore:    0,        // not available in backtest
      sweepConfirmed: sweepResult.bullishSweep || sweepResult.bearishSweep,
      volumeRatio,
      rsiDivergent:  rsiDiv.bullish || rsiDiv.bearish,
      rsiDirection:  rsiDiv.bullish ? "bullish" : rsiDiv.bearish ? "bearish" : "none",
      obImbalance:   0,        // not available in backtest
      currentPrice:  bar.close,
      sweepLow:      sweepResult.sweepLow,
      sweepHigh:     sweepResult.sweepHigh,
      atr,
    };

    const signal = evaluateSignal(features);
    if (!signal.triggered || !signal.direction) continue;

    const sweepExtreme = signal.direction === "long"
      ? sweepResult.sweepLow
      : sweepResult.sweepHigh;

    const risk = calculateRisk(
      signal.direction, bar.close, sweepExtreme, atr, state.balance
    );

    state.trade = {
      direction: signal.direction,
      entry:     bar.close,
      stop:      risk.stopLoss,
      tp1:       risk.takeProfitOne,
      tp2:       risk.takeProfitTwo,
      tp1Hit:    false,
      size:      risk.positionSizeUsd / bar.close,
      notional:  risk.positionSizeUsd,
    };
  }

  state.nextIndex = end;

  return {
    state,
    trades,
    nextIndex: end,
    done: end >= bars.length,
  };
}
