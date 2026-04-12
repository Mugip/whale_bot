// ─────────────────────────────────────────────────────────────
// state/schema.ts
// Central type definitions and state schema for the whale bot.
// ─────────────────────────────────────────────────────────────

export type TradeDirection = "long" | "short";
export type TradeStatus = "open" | "closed" | "cancelled";
export type TradingMode = "paper" | "live";

// ─── Position ────────────────────────────────────────────────

export interface Position {
  id: string;
  symbol: string;
  direction: TradeDirection;
  entryPrice: number;
  size: number; // number of contracts / units
  notionalUsd: number;
  stopLoss: number;
  takeProfitOne: number;
  takeProfitTwo: number;
  trailingStopActive: boolean;
  trailingStopPrice: number | null;
  tp1Hit: boolean;
  openedAt: number; // unix ms
  status: TradeStatus;
}

// ─── Trade History ───────────────────────────────────────────

export interface ClosedTrade {
  id: string;
  symbol: string;
  direction: TradeDirection;
  entryPrice: number;
  exitPrice: number;
  size: number;
  pnlUsd: number;
  pnlPct: number;
  openedAt: number;
  closedAt: number;
  closeReason: "tp1" | "tp2" | "sl" | "trailing_stop" | "manual";
}

// ─── Signal snapshot ─────────────────────────────────────────

export interface SignalSnapshot {
  timestamp: number;
  symbol: string;
  direction: TradeDirection | null;
  triggered: boolean;
  whaleScore: number;
  sweepConfirmed: boolean;
  volumeRatio: number;
  rsiDivergence: boolean;
  obImbalance: number;
  withinTradingHours: boolean;
}

// ─── Whale Score History entry ───────────────────────────────

export interface WhaleScoreEntry {
  timestamp: number;
  score: number;
  outflowsToCold: number;
  inflowsToExchange: number;
}

// ─── Bot State (stored in Redis) ─────────────────────────────

export interface BotState {
  openPositions: Position[];
  tradeHistory: ClosedTrade[];
  lastSignalTimestamp: number;
  whaleScoreHistory: WhaleScoreEntry[];
  accountBalance: number; // USD
  lastUpdated: number; // unix ms
}

// ─── Default initial state ───────────────────────────────────

export function createDefaultState(): BotState {
  const initialBalance = parseFloat(
    process.env.PAPER_INITIAL_BALANCE ?? "10000"
  );

  return {
    openPositions: [],
    tradeHistory: [],
    lastSignalTimestamp: 0,
    whaleScoreHistory: [],
    accountBalance: initialBalance,
    lastUpdated: Date.now(),
  };
}

// ─── Feature snapshot (internal, not persisted directly) ─────

export interface FeatureSet {
  whaleScore: number;
  sweepConfirmed: boolean;
  volumeRatio: number;
  rsiDivergent: boolean;
  rsiDirection: "bullish" | "bearish" | "none";
  obImbalance: number;
  currentPrice: number;
  sweepLow: number;
  sweepHigh: number;
  atr: number;
  ema200: number;
}
