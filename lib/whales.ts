// ─────────────────────────────────────────────────────────────
// lib/whales.ts
// Etherscan-based whale flow tracker.
// Computes a directional score from large USDT transfers.
// Score range: -1 (fully bearish) to +1 (fully bullish).
//
// FIX: whaleScore is now an OPTIONAL confirmation only.
// A null score (Etherscan unavailable) no longer blocks the
// cron cycle – callers receive score=0 and should treat it as
// a neutral/skipped confirmation rather than a hard gate.
// ─────────────────────────────────────────────────────────────

import axios from "axios";
import { logger } from "../utils/logger";
import { hoursAgoSec, nowSec } from "../utils/time";

// ─── Known exchange hot wallet addresses (partial list) ──────
const EXCHANGE_ADDRESSES = new Set([
  "0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be", // Binance 1
  "0xd551234ae421e3bcba99a0da6d736074f22192ff", // Binance 2
  "0x564286362092d8e7936f0549571a803b203aaced", // Binance 3
  "0x0681d8db095565fe8a346fa0277bffde9c0edbbf", // Binance 4
  "0xfe9e8709d3215310075d67e3ed32a380ccf451c8", // Binance 5
  "0x6fc82a5fe25a5cdb58bc74600a40a69c065263f8", // Gemini 1
  "0x61edcdf5bb737adffe5043706e7c5bb1f1a56eea", // Gemini 2
  "0xa910f92acdaf488fa6ef02174fb86208ad7722ba", // Coinbase 1
  "0x71660c4005ba85c37ccec55d0c4493e66fe775d3", // Coinbase 2
  "0x503828976d22510aad0201ac7ec88293211d23da", // Coinbase 3
  "0xddfabcdc4d8ffc6d5beaf154f18b778f892a0740", // Coinbase 4
]);

interface EtherscanTx {
  hash: string;
  from: string;
  to: string;
  value: string;
  timeStamp: string;
  gasUsed: string;
  gasPrice: string;
}

export interface WhaleFlowResult {
  score: number;
  outflowsToCold: number;
  inflowsToExchange: number;
  totalVolume: number;
  txCount: number;
  /** True if Etherscan was unavailable; score will be 0 (neutral). */
  isNeutralFallback: boolean;
}

const WEI_PER_ETH = 1e18;

function isExchangeAddress(addr: string): boolean {
  return EXCHANGE_ADDRESSES.has(addr.toLowerCase());
}

async function fetchEthPriceUsd(): Promise<number> {
  const okxBase = process.env.OKX_BASE_URL ?? "https://www.okx.com";
  const url = `${okxBase}/api/v5/market/ticker?instId=ETH-USDT`;
  const response = await axios.get(url, { timeout: 5000 });
  return parseFloat(response.data.data[0].last);
}

// ─── Neutral fallback (returned when Etherscan is unavailable) ─

const NEUTRAL_RESULT: WhaleFlowResult = {
  score: 0,
  outflowsToCold: 0,
  inflowsToExchange: 0,
  totalVolume: 0,
  txCount: 0,
  isNeutralFallback: true,
};

/**
 * Fetches large USDT transfers from Etherscan and computes a
 * directional flow score.
 *
 * Score formula:
 *   score = (outflowsToCold - inflowsToExchange) / (total + 1)
 *
 * Positive = bullish (whales withdrawing to cold storage)
 * Negative = bearish (whales depositing to exchanges)
 *
 * IMPORTANT: This function NEVER throws. On any Etherscan error
 * it returns score=0 with isNeutralFallback=true. Callers must
 * treat the whale score as an optional confirmation, not a gate.
 */
export async function computeWhaleScore(): Promise<WhaleFlowResult> {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    logger.warn("ETHERSCAN_API_KEY not set – whale score neutral fallback");
    return NEUTRAL_RESULT;
  }

  try {
    const lookbackHours = parseInt(
      process.env.WHALE_LOOKBACK_HOURS ?? "12",
      10
    );
    const minUsd = parseInt(
      process.env.WHALE_MIN_TRANSFER_USD ?? "500000",
      10
    );

    const startTs = hoursAgoSec(lookbackHours);

    // Approximate block range
    const recentBlockUrl =
      `https://api.etherscan.io/api` +
      `?module=proxy&action=eth_blockNumber&apikey=${apiKey}`;

    const blockResponse = await axios.get(recentBlockUrl, { timeout: 8000 });
    const latestBlock = parseInt(blockResponse.data.result, 16);
    const blocksBack = Math.ceil((lookbackHours * 3600) / 12);
    const startBlock = latestBlock - blocksBack;

    // Track large USDT transfers between exchange and external wallets
    const tokenTxUrl =
      `https://api.etherscan.io/api` +
      `?module=account&action=tokentx` +
      `&contractaddress=0xdac17f958d2ee523a2206206994597c13d831ec7` + // USDT
      `&startblock=${startBlock}&endblock=${latestBlock}` +
      `&sort=desc&page=1&offset=500` +
      `&apikey=${apiKey}`;

    const txResponse = await axios.get(tokenTxUrl, { timeout: 10000 });

    if (txResponse.data.status !== "1" && txResponse.data.message !== "OK") {
      logger.warn("Etherscan returned non-OK – whale score neutral fallback", {
        message: txResponse.data.message,
      });
      return NEUTRAL_RESULT;
    }

    const txs: EtherscanTx[] = txResponse.data.result ?? [];
    const USDT_DECIMALS = 1e6;

    let outflowsToCold = 0;
    let inflowsToExchange = 0;
    let totalVolume = 0;
    let txCount = 0;

    for (const tx of txs) {
      const txTs = parseInt(tx.timeStamp, 10);
      if (txTs < startTs) break;

      const valueUsd = parseInt(tx.value, 10) / USDT_DECIMALS;
      if (valueUsd < minUsd) continue;

      txCount++;
      totalVolume += valueUsd;

      const fromIsExchange = isExchangeAddress(tx.from);
      const toIsExchange = isExchangeAddress(tx.to);

      if (fromIsExchange && !toIsExchange) {
        outflowsToCold += valueUsd;
      } else if (!fromIsExchange && toIsExchange) {
        inflowsToExchange += valueUsd;
      }
    }

    const score =
      totalVolume === 0
        ? 0
        : (outflowsToCold - inflowsToExchange) / (totalVolume + 1);

    logger.info("Whale score computed", {
      score: score.toFixed(4),
      outflowsToCold,
      inflowsToExchange,
      totalVolume,
      txCount,
    });

    return {
      score: Math.max(-1, Math.min(1, score)),
      outflowsToCold,
      inflowsToExchange,
      totalVolume,
      txCount,
      isNeutralFallback: false,
    };
  } catch (err) {
    // Non-fatal: log and return neutral so the cron cycle continues
    logger.warn("Whale score computation failed – neutral fallback", {
      error: (err as Error).message,
    });
    return NEUTRAL_RESULT;
  }
}
