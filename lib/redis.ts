// ─────────────────────────────────────────────────────────────
// lib/redis.ts
// Upstash Redis state persistence layer.
// All bot state is stored under a single JSON key so that
// reads and writes are atomic at the application level.
// ─────────────────────────────────────────────────────────────

import { Redis } from "@upstash/redis";
import { BotState, createDefaultState } from "../state/schema";
import { logger } from "../utils/logger";

const STATE_KEY = "whale_bot:state";

function getRedisClient(): Redis {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error(
      "Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN"
    );
  }

  return new Redis({ url, token });
}

/**
 * Loads bot state from Redis.
 * Returns the default initial state if no state has been stored yet.
 */
export async function loadState(): Promise<BotState> {
  try {
    const redis = getRedisClient();
    const raw = await redis.get<BotState>(STATE_KEY);

    if (!raw) {
      logger.info("No existing state found – using defaults");
      return createDefaultState();
    }

    return raw as BotState;
  } catch (err) {
    logger.error("Failed to load state from Redis", {
      error: (err as Error).message,
    });
    throw err;
  }
}

/**
 * Persists bot state to Redis.
 */
export async function saveState(state: BotState): Promise<void> {
  try {
    const redis = getRedisClient();
    state.lastUpdated = Date.now();
    await redis.set(STATE_KEY, state);
    logger.debug("State saved to Redis");
  } catch (err) {
    logger.error("Failed to save state to Redis", {
      error: (err as Error).message,
    });
    throw err;
  }
}

/**
 * Resets bot state to defaults (useful for testing / paper reset).
 */
export async function resetState(): Promise<BotState> {
  const fresh = createDefaultState();
  await saveState(fresh);
  logger.info("State reset to defaults");
  return fresh;
}
