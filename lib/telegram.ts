// ─────────────────────────────────────────────────────────────
// lib/telegram.ts
// Telegram alert sender via Bot API.
// ─────────────────────────────────────────────────────────────

import axios from "axios";
import { logger } from "../utils/logger";
import { Position, ClosedTrade } from "../state/schema";

const TIMEOUT_MS = 5000;

function getTelegramConfig(): { token: string; chatId: string } | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    logger.warn("Telegram not configured – skipping alert");
    return null;
  }

  return { token, chatId };
}

async function sendMessage(text: string): Promise<void> {
  const config = getTelegramConfig();
  if (!config) return;

  const url = `https://api.telegram.org/bot${config.token}/sendMessage`;

  try {
    await axios.post(
      url,
      {
        chat_id: config.chatId,
        text,
        parse_mode: "Markdown",
      },
      { timeout: TIMEOUT_MS }
    );
  } catch (err) {
    logger.error("Failed to send Telegram alert", {
      error: (err as Error).message,
    });
    // Don't throw – alerts are non-critical
  }
}

// ─── Alert Templates ─────────────────────────────────────────

export async function alertSignalTriggered(
  direction: "long" | "short",
  symbol: string,
  price: number,
  whaleScore: number,
  volumeRatio: number
): Promise<void> {
  const emoji = direction === "long" ? "🟢" : "🔴";
  const text =
    `${emoji} *SIGNAL TRIGGERED*\n` +
    `Symbol: \`${symbol}\`\n` +
    `Direction: *${direction.toUpperCase()}*\n` +
    `Price: \`${price.toFixed(2)}\`\n` +
    `Whale Score: \`${whaleScore.toFixed(3)}\`\n` +
    `Volume Ratio: \`${volumeRatio.toFixed(2)}x\``;
  await sendMessage(text);
}

export async function alertTradeExecuted(position: Position): Promise<void> {
  const emoji = position.direction === "long" ? "📈" : "📉";
  const mode = process.env.TRADING_MODE === "live" ? "LIVE" : "PAPER";
  const text =
    `${emoji} *TRADE EXECUTED [${mode}]*\n` +
    `Symbol: \`${position.symbol}\`\n` +
    `Direction: *${position.direction.toUpperCase()}*\n` +
    `Entry: \`${position.entryPrice.toFixed(2)}\`\n` +
    `Size: \`${position.notionalUsd.toFixed(2)} USD\`\n` +
    `SL: \`${position.stopLoss.toFixed(2)}\`\n` +
    `TP1: \`${position.takeProfitOne.toFixed(2)}\`\n` +
    `TP2: \`${position.takeProfitTwo.toFixed(2)}\``;
  await sendMessage(text);
}

export async function alertTradeClosed(trade: ClosedTrade): Promise<void> {
  const profitable = trade.pnlUsd >= 0;
  const emoji = profitable ? "✅" : "❌";
  const text =
    `${emoji} *TRADE CLOSED*\n` +
    `Symbol: \`${trade.symbol}\`\n` +
    `Direction: ${trade.direction.toUpperCase()}\n` +
    `Entry: \`${trade.entryPrice.toFixed(2)}\`\n` +
    `Exit: \`${trade.exitPrice.toFixed(2)}\`\n` +
    `PnL: \`${trade.pnlUsd >= 0 ? "+" : ""}${trade.pnlUsd.toFixed(2)} USD (${trade.pnlPct.toFixed(2)}%)\`\n` +
    `Reason: ${trade.closeReason}`;
  await sendMessage(text);
}

export async function alertError(context: string, error: string): Promise<void> {
  const text =
    `⚠️ *BOT ERROR*\n` +
    `Context: ${context}\n` +
    `Error: \`${error}\``;
  await sendMessage(text);
}

export async function alertCycleSkipped(reason: string): Promise<void> {
  const text = `⏭️ *Cycle skipped*\nReason: ${reason}`;
  await sendMessage(text);
}
