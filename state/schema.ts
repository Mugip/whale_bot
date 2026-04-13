export type TradeDirection = "long" | "short";
export type TradeStatus = "open" | "closed" | "cancelled";
export type TradingMode = "paper" | "live";

export interface Position {
  id: string; symbol: string; direction: TradeDirection; entryPrice: number; size: number;
  notionalUsd: number; stopLoss: number; takeProfitOne: number; takeProfitTwo: number;
  trailingStopActive: boolean; trailingStopPrice: number | null; tp1Hit: boolean;
  openedAt: number; status: TradeStatus;
}

export interface ClosedTrade {
  id: string; symbol: string; direction: TradeDirection; entryPrice: number; exitPrice: number;
  size: number; pnlUsd: number; pnlPct: number; openedAt: number; closedAt: number;
  closeReason: "tp1" | "tp2" | "sl" | "trailing_stop" | "manual";
}

export interface SignalSnapshot {
  timestamp: number; symbol: string; direction: TradeDirection | null; triggered: boolean;
}

export interface BotState {
  openPositions: Position[]; tradeHistory: ClosedTrade[]; lastSignalTimestamp: number;
  accountBalance: number; lastUpdated: number;
  whaleScoreHistory: any[]; 
}

export function createDefaultState(): BotState {
  return {
    openPositions:[], tradeHistory:[], lastSignalTimestamp: 0,
    whaleScoreHistory:[], accountBalance: parseFloat(process.env.PAPER_INITIAL_BALANCE ?? "10000"), lastUpdated: Date.now(),
  };
}

export interface FeatureSet {
  currentPrice: number;
  currentRsi: number;
  atr: number;
  bbUpper: number;
  bbLower: number;
  bbMiddle: number;
}
