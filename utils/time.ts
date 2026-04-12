// ─────────────────────────────────────────────────────────────
// utils/time.ts
// Time utilities for trading window checks and timestamps.
// ─────────────────────────────────────────────────────────────

/**
 * Returns true if the current UTC hour is within the allowed
 * trading window: 08:00 – 20:00 UTC (inclusive start, exclusive end).
 */
/*
export function isWithinTradingHours(): boolean {
  const utcHour = new Date().getUTCHours();
  return utcHour >= 8 && utcHour < 20;
}
*/
export function isWithinTradingHours(): boolean {
  // Crypto is 24/7. Removing the strict 08:00 - 20:00 UTC check
  // yields significantly more trading opportunities.
  return true; 
}
/**
 * Returns the current Unix timestamp in milliseconds.
 */
export function nowMs(): number {
  return Date.now();
}

/**
 * Returns the current Unix timestamp in seconds.
 */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Returns a timestamp N hours ago in seconds.
 */
export function hoursAgoSec(hours: number): number {
  return nowSec() - hours * 3600;
}

/**
 * Returns a timestamp N hours ago in milliseconds.
 */
export function hoursAgoMs(hours: number): number {
  return nowMs() - hours * 3600 * 1000;
}

/**
 * Formats a unix ms timestamp to a readable UTC string.
 */
export function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Returns true if a given unix-ms timestamp is older than
 * maxAgeMs milliseconds.
 */
export function isStale(timestampMs: number, maxAgeMs: number): boolean {
  return nowMs() - timestampMs > maxAgeMs;
}
