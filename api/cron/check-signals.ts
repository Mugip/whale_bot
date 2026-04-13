import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadState, saveState } from "../../lib/redis";
import { fetchCandles, fetchMarkPrice } from "../../lib/okx";
import { computeRSI, computeATR, computeBollingerBands } from "../../lib/indicators";
import { calculateRisk } from "../../lib/risk";
import { evaluateSignal } from "../../lib/signal";
import { openPosition, updatePositions } from "../trade/execute";
import { alertSignalTriggered } from "../../lib/telegram";
import { FeatureSet } from "../../state/schema";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const authHeader = req.headers["x-cron-secret"] ?? req.query["secret"];
  if (authHeader !== process.env.CRON_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const symbol = process.env.TRADING_SYMBOL ?? "ETH-USDT-SWAP";
  let state = await loadState();

  try {
    const[candles15m, candles1h, markPrice] = await Promise.all([
        fetchCandles(symbol, "15m", 100), // 100 bars is plenty to warm up 20-period Bollinger Bands
        fetchCandles(symbol, "1H", 50),   // 50 bars is plenty for 14-period ATR
        fetchMarkPrice(symbol),
    ]);

    const currentPrice = markPrice ?? candles15m?.[candles15m.length - 1]?.close ?? 0;

    if (currentPrice > 0 && state.openPositions.length > 0) {
      state = await updatePositions(state, currentPrice);
    }

    if (!candles15m || !candles1h) {
        res.status(200).json({ skipped: true, reason: "Missing candle data" });
        return;
    }

    const rsiValues = computeRSI(candles15m, 14);
    const currentRsi = rsiValues[rsiValues.length - 1];
    
    const atr = computeATR(candles1h, 14);
    const bb = computeBollingerBands(candles15m, 20, 2.5); // 2.5 StdDev BB

    const features: FeatureSet = {
      currentPrice, currentRsi, atr,
      bbUpper: bb.upper, bbMiddle: bb.middle, bbLower: bb.lower
    };

    const hasOpenPosition = state.openPositions.length > 0;
    const signal = evaluateSignal(features);

    if (signal.triggered && signal.direction && !hasOpenPosition) {
      // Hard 2.0 ATR STOP
      const baseStop = signal.direction === "long" ? currentPrice - (atr * 2.0) : currentPrice + (atr * 2.0);
      const risk = calculateRisk(signal.direction, currentPrice, baseStop, atr, state.accountBalance);

      // Pass 0 for whale score / volume since they are no longer required in Telegram alerts
      await alertSignalTriggered(signal.direction, symbol, currentPrice, 0, 0); 
      state = await openPosition(state, signal.direction, symbol, risk);
    }

    await saveState(state);
    res.status(200).json({ success: true, signal: { direction: signal.direction, triggered: signal.triggered }, openPositions: state.openPositions.length });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
      }
