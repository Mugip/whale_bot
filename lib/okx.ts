// ─────────────────────────────────────────────────────────────
// lib/okx.ts
// OKX REST API wrapper.
// Covers: candles, order book, account balance, order placement.
// ─────────────────────────────────────────────────────────────

import axios, { AxiosRequestConfig } from "axios";
import * as crypto from "crypto";
import { logger } from "../utils/logger";

// ─── Types ───────────────────────────────────────────────────

export interface OKXCandle {
  ts: number; // open timestamp ms
  open: number;
  high: number;
  low: number;
  close: number;
  vol: number; // base currency volume
  volCcy: number; // quote currency volume
}

export interface OKXOrderBookLevel {
  price: number;
  size: number;
}

export interface OKXOrderBook {
  bids: OKXOrderBookLevel[];
  asks: OKXOrderBookLevel[];
  ts: number;
}

export interface OKXOrderResult {
  orderId: string;
  clientOrderId: string;
  code: string;
  message: string;
}

// ─── Constants ───────────────────────────────────────────────

const TIMEOUT_MS = 8000; // abort if OKX doesn't respond in time

function getBaseUrl(): string {
  return process.env.OKX_BASE_URL ?? "https://www.okx.com";
}

// ─── Auth Helpers ─────────────────────────────────────────────

function buildSignature(
  timestamp: string,
  method: string,
  path: string,
  body: string,
  secret: string
): string {
  const prehash = timestamp + method.toUpperCase() + path + body;
  return crypto.createHmac("sha256", secret).update(prehash).digest("base64");
}

function getAuthHeaders(
  method: string,
  path: string,
  body: string = ""
): Record<string, string> {
  const apiKey = process.env.OKX_API_KEY ?? "";
  const secret = process.env.OKX_API_SECRET ?? "";
  const passphrase = process.env.OKX_PASSPHRASE ?? "";
  const timestamp = new Date().toISOString();

  return {
    "OK-ACCESS-KEY": apiKey,
    "OK-ACCESS-SIGN": buildSignature(timestamp, method, path, body, secret),
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": passphrase,
    "Content-Type": "application/json",
  };
}

// ─── Public API (no auth) ────────────────────────────────────

/**
 * Fetch OHLCV candles from OKX.
 * @param instId  e.g. "BTC-USDT-SWAP"
 * @param bar     e.g. "1m", "15m", "1H"
 * @param limit   number of candles (max 300)
 */
export async function fetchCandles(
  instId: string,
  bar: string,
  limit: number = 50
): Promise<OKXCandle[]> {
  const path = `/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`;
  const url = getBaseUrl() + path;

  const config: AxiosRequestConfig = { timeout: TIMEOUT_MS };
  const response = await axios.get(url, config);

  if (response.data.code !== "0") {
    throw new Error(`OKX candles error: ${response.data.msg}`);
  }

  // OKX returns newest-first; reverse to oldest-first
  // Each row: [ts, open, high, low, close, vol, volCcy, volCcyQuote, confirm]
  const raw: string[][] = response.data.data;
  return raw
    .map((row) => ({
      ts: parseInt(row[0], 10),
      open: parseFloat(row[1]),
      high: parseFloat(row[2]),
      low: parseFloat(row[3]),
      close: parseFloat(row[4]),
      vol: parseFloat(row[5]),
      volCcy: parseFloat(row[6]),
    }))
    .reverse();
}

/**
 * Fetch order book top N levels from OKX.
 * @param instId  e.g. "BTC-USDT-SWAP"
 * @param depth   number of levels (5 is sufficient for our use)
 */
export async function fetchOrderBook(
  instId: string,
  depth: number = 5
): Promise<OKXOrderBook> {
  const path = `/api/v5/market/books?instId=${instId}&sz=${depth}`;
  const url = getBaseUrl() + path;

  const config: AxiosRequestConfig = { timeout: TIMEOUT_MS };
  const response = await axios.get(url, config);

  if (response.data.code !== "0") {
    throw new Error(`OKX order book error: ${response.data.msg}`);
  }

  const raw = response.data.data[0];

  return {
    bids: raw.bids.map((b: string[]) => ({
      price: parseFloat(b[0]),
      size: parseFloat(b[1]),
    })),
    asks: raw.asks.map((a: string[]) => ({
      price: parseFloat(a[0]),
      size: parseFloat(a[1]),
    })),
    ts: parseInt(raw.ts, 10),
  };
}

/**
 * Fetch the current mark price for an instrument.
 */
export async function fetchMarkPrice(instId: string): Promise<number> {
  const path = `/api/v5/public/mark-price?instId=${instId}&instType=SWAP`;
  const url = getBaseUrl() + path;

  const config: AxiosRequestConfig = { timeout: TIMEOUT_MS };
  const response = await axios.get(url, config);

  if (response.data.code !== "0") {
    throw new Error(`OKX mark price error: ${response.data.msg}`);
  }

  return parseFloat(response.data.data[0].markPx);
}

// ─── Private API (auth required) ─────────────────────────────

/**
 * Fetch trading account balance (USDT).
 */
export async function fetchAccountBalance(): Promise<number> {
  const path = "/api/v5/account/balance?ccy=USDT";
  const headers = getAuthHeaders("GET", path);
  const url = getBaseUrl() + path;

  const config: AxiosRequestConfig = { headers, timeout: TIMEOUT_MS };
  const response = await axios.get(url, config);

  if (response.data.code !== "0") {
    throw new Error(`OKX account balance error: ${response.data.msg}`);
  }

  const details = response.data.data[0]?.details ?? [];
  const usdtDetail = details.find((d: { ccy: string }) => d.ccy === "USDT");
  return parseFloat(usdtDetail?.availBal ?? "0");
}

/**
 * Place a market order.
 * @param instId    instrument ID
 * @param side      "buy" | "sell"
 * @param posSide   "long" | "short" (for hedge mode)
 * @param size      number of contracts
 */
export async function placeMarketOrder(
  instId: string,
  side: "buy" | "sell",
  posSide: "long" | "short",
  size: number
): Promise<OKXOrderResult> {
  const path = "/api/v5/trade/order";
  const body = JSON.stringify({
    instId,
    tdMode: "cross",
    side,
    posSide,
    ordType: "market",
    sz: String(size),
  });

  const headers = getAuthHeaders("POST", path, body);
  const url = getBaseUrl() + path;

  const config: AxiosRequestConfig = { headers, timeout: TIMEOUT_MS };
  const response = await axios.post(url, body, config);

  const result = response.data.data[0];

  logger.info("OKX order placed", {
    orderId: result.ordId,
    code: result.sCode,
    msg: result.sMsg,
  });

  return {
    orderId: result.ordId,
    clientOrderId: result.clOrdId,
    code: result.sCode,
    message: result.sMsg,
  };
}
