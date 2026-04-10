// ─────────────────────────────────────────────────────────────
// lib/orderbook.ts
// Order book imbalance calculator with rolling snapshot history.
//
// FIX: Single snapshots are easily spoofed and not predictive.
// We now maintain a rolling history of recent snapshots and
// compute a trend-averaged imbalance rather than relying on
// any single point-in-time snapshot.
// ─────────────────────────────────────────────────────────────

import { OKXOrderBook } from "./okx";

export interface ImbalanceResult {
  imbalance: number;    // -1 (full ask) to +1 (full bid)
  bidVolume: number;
  askVolume: number;
  totalVolume: number;
  /** Number of snapshots averaged into this result. */
  snapshotCount: number;
}

interface ImbalanceSnapshot {
  timestamp: number;
  imbalance: number;
}

// ─── Rolling snapshot store (in-process memory) ──────────────
// Stores up to MAX_SNAPSHOTS recent imbalance readings.
// In a multi-instance deployment swap this for a Redis list.

const MAX_SNAPSHOTS = 5;
const snapshotHistory: ImbalanceSnapshot[] = [];

/**
 * Computes order book imbalance from top-N bid/ask levels.
 *
 *   imbalance = (bidVolume - askVolume) / totalVolume
 *
 * Returns the average across the last MAX_SNAPSHOTS readings
 * to smooth out spoofed / transient order book walls.
 */
export function computeOrderBookImbalance(
  book: OKXOrderBook
): ImbalanceResult {
  const bidVolume = book.bids.reduce((sum, level) => sum + level.size, 0);
  const askVolume = book.asks.reduce((sum, level) => sum + level.size, 0);
  const totalVolume = bidVolume + askVolume;

  const rawImbalance =
    totalVolume === 0 ? 0 : (bidVolume - askVolume) / totalVolume;

  // Append to rolling history
  snapshotHistory.push({ timestamp: Date.now(), imbalance: rawImbalance });
  if (snapshotHistory.length > MAX_SNAPSHOTS) {
    snapshotHistory.shift();
  }

  // Average across available snapshots
  const avgImbalance =
    snapshotHistory.reduce((sum, s) => sum + s.imbalance, 0) /
    snapshotHistory.length;

  return {
    imbalance: avgImbalance,
    bidVolume,
    askVolume,
    totalVolume,
    snapshotCount: snapshotHistory.length,
  };
}

/**
 * Clears the rolling snapshot history.
 * Useful for testing or after extended downtime.
 */
export function resetOrderBookHistory(): void {
  snapshotHistory.length = 0;
}
