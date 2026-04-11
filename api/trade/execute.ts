// ─────────────────────────────────────────────────────────────
// api/trade/execute.ts
// Order execution engine.
// Handles both paper trading and live order placement.
// Called internally by the cron scanner.
// ─────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { randomUUID } from "crypto";
import { BotState, Position, ClosedTrade, TradeDirection } from "../../state/schema";
import { loadState, saveState } from "../../lib/redis";
import { placeMarketOrder } from "../../lib/okx";
import { RiskCalculation, TP1_CLOSE_FRACTION } from "../../lib/risk";
import { alertTradeExecuted, alertTradeClosed } from "../../lib/telegram";
import { logger } from "../../utils/logger";
import { nowMs } from "../../utils/time";

// Simple UUID replacement (Node.js crypto, no extra dep)
function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

// ─── Open Position ───────────────────────────────────────────

export async function openPosition(
  state: BotState,
  direction: TradeDirection,
  symbol: string,
  risk: RiskCalculation
): Promise<BotState> {
  const mode = process.env.TRADING_MODE ?? "paper";
  const size = risk.positionSizeUsd / risk.entryPrice;

  const position: Position = {
    id: generateId(),
    symbol,
    direction,
    entryPrice: risk.entryPrice,
    size,
    notionalUsd: risk.positionSizeUsd,
    stopLoss: risk.stopLoss,
    takeProfitOne: risk.takeProfitOne,
    takeProfitTwo: risk.takeProfitTwo,
    trailingStopActive: false,
    trailingStopPrice: null,
    tp1Hit: false,
    openedAt: nowMs(),
    status: "open",
  };

  if (mode === "live") {
    const side = direction === "long" ? "buy" : "sell";
    try {
      const result = await placeMarketOrder(symbol, side, direction, Math.floor(size));
      if (result.code !== "0") {
        throw new Error(`OKX order failed: ${result.message}`);
      }
      logger.info("Live order placed", { orderId: result.orderId });
    } catch (err) {
      logger.error("Live order placement failed", { error: (err as Error).message });
      throw err;
    }
  } else {
    logger.info("Paper trade opened", {
      direction,
      entry: risk.entryPrice,
      sizeUsd: risk.positionSizeUsd.toFixed(2),
      sl: risk.stopLoss.toFixed(2),
      tp1: risk.takeProfitOne.toFixed(2),
      tp2: risk.takeProfitTwo.toFixed(2),
    });
  }

  const newState: BotState = {
    ...state,
    openPositions: [...state.openPositions, position],
    accountBalance: mode === "paper"
      ? state.accountBalance // balance updates on close in paper mode
      : state.accountBalance,
  };

  await alertTradeExecuted(position);
  return newState;
}

// ─── Update Open Positions (TP / SL / Trailing) ──────────────

export async function updatePositions(
  state: BotState,
  currentPrice: number
): Promise<BotState> {
  const updatedPositions: Position[] = [];
  const newClosedTrades: ClosedTrade[] = [];
  let balanceDelta = 0;

  for (const pos of state.openPositions) {
    if (pos.status !== "open") {
      updatedPositions.push(pos);
      continue;
    }

    let updated = { ...pos };
    let closed = false;
    let closeReason: ClosedTrade["closeReason"] = "sl";
    let exitPrice = currentPrice;

    const isLong = pos.direction === "long";

    // ─── Check Stop Loss ──────────────────────────────────
    const slHit = isLong
      ? currentPrice <= pos.stopLoss
      : currentPrice >= pos.stopLoss;

    // ─── Check TP1 ────────────────────────────────────────
    const tp1Hit = isLong
      ? currentPrice >= pos.takeProfitOne
      : currentPrice <= pos.takeProfitOne;

    // ─── Check TP2 ────────────────────────────────────────
    const tp2Hit = isLong
      ? currentPrice >= pos.takeProfitTwo
      : currentPrice <= pos.takeProfitTwo;

    // ─── Check Trailing Stop ──────────────────────────────
    const trailingActivation = isLong
      ? currentPrice >= pos.entryPrice * (1 + 0.04)
      : currentPrice <= pos.entryPrice * (1 - 0.04);

    if (!updated.trailingStopActive && trailingActivation) {
      updated.trailingStopActive = true;
      updated.trailingStopPrice = isLong
        ? currentPrice * (1 - 0.01)
        : currentPrice * (1 + 0.01);
    }

    if (updated.trailingStopActive && updated.trailingStopPrice !== null) {
      // Update trailing price
      const newTrail = isLong
        ? currentPrice * (1 - 0.01)
        : currentPrice * (1 + 0.01);

      updated.trailingStopPrice = isLong
        ? Math.max(updated.trailingStopPrice, newTrail)
        : Math.min(updated.trailingStopPrice, newTrail);

      // Check if trailing stop was hit
      const trailHit = isLong
        ? currentPrice <= updated.trailingStopPrice
        : currentPrice >= updated.trailingStopPrice;

      if (trailHit) {
        closed = true;
        closeReason = "trailing_stop";
        exitPrice = updated.trailingStopPrice;
      }
    }

    // ─── Close on SL ──────────────────────────────────────
    if (slHit && !closed) {
      closed = true;
      closeReason = "sl";
      exitPrice = pos.stopLoss;
    }

    // ─── Close remaining at TP2 ───────────────────────────
    if (tp2Hit && !closed && pos.tp1Hit) {
      closed = true;
      closeReason = "tp2";
      exitPrice = pos.takeProfitTwo;
    }

    // ─── Partial close at TP1 (simulate by closing all here) ─
    if (tp1Hit && !pos.tp1Hit && !closed) {
      // In paper mode: record TP1 partial, leave position open for TP2
      updated.tp1Hit = true;
      const partialSize = pos.size * TP1_CLOSE_FRACTION;
      const partialPnl = isLong
        ? (pos.takeProfitOne - pos.entryPrice) * partialSize
        : (pos.entryPrice - pos.takeProfitOne) * partialSize;

      balanceDelta += partialPnl;

      const partialTrade: ClosedTrade = {
        id: generateId(),
        symbol: pos.symbol,
        direction: pos.direction,
        entryPrice: pos.entryPrice,
        exitPrice: pos.takeProfitOne,
        size: partialSize,
        pnlUsd: partialPnl,
        pnlPct: (partialPnl / (pos.notionalUsd * TP1_CLOSE_FRACTION)) * 100,
        openedAt: pos.openedAt,
        closedAt: nowMs(),
        closeReason: "tp1",
      };

      newClosedTrades.push(partialTrade);
      await alertTradeClosed(partialTrade);

      // Move stop loss to break-even after TP1
      updated.stopLoss = pos.entryPrice;
      updated.size = pos.size * (1 - TP1_CLOSE_FRACTION);
      logger.info("TP1 hit – partial close", {
        symbol: pos.symbol,
        pnl: partialPnl.toFixed(2),
      });
    }

    if (closed) {
      const pnlUsd = isLong
        ? (exitPrice - pos.entryPrice) * updated.size
        : (pos.entryPrice - exitPrice) * updated.size;

      balanceDelta += pnlUsd;
      updated.status = "closed";

      const closedTrade: ClosedTrade = {
        id: generateId(),
        symbol: pos.symbol,
        direction: pos.direction,
        entryPrice: pos.entryPrice,
        exitPrice,
        size: updated.size,
        pnlUsd,
        pnlPct: (pnlUsd / pos.notionalUsd) * 100,
        openedAt: pos.openedAt,
        closedAt: nowMs(),
        closeReason,
      };

      newClosedTrades.push(closedTrade);
      await alertTradeClosed(closedTrade);

      logger.info("Position closed", {
        symbol: pos.symbol,
        reason: closeReason,
        pnlUsd: pnlUsd.toFixed(2),
      });
    } else {
      updatedPositions.push(updated);
    }
  }

  return {
    ...state,
    openPositions: updatedPositions,
    tradeHistory: [...state.tradeHistory, ...newClosedTrades],
    accountBalance: state.accountBalance + balanceDelta,
  };
}

// ─── HTTP handler (manual execution endpoint) ─────────────────

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // This endpoint is primarily internal – protect with cron secret
  const authHeader = req.headers["x-cron-secret"];
  if (authHeader !== process.env.CRON_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const state = await loadState();
    res.status(200).json({
      openPositions: state.openPositions.length,
      accountBalance: state.accountBalance,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
