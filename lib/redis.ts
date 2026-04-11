// ─────────────────────────────────────────────────────────────
// lib/redis.ts
// Redis state persistence layer (Supports Vercel KV & Upstash).
// ─────────────────────────────────────────────────────────────

import { Redis } from "@upstash/redis";
import { BotState, createDefaultState } from "../state/schema";

const STATE_KEY = "whale_bot:state";

function getRedisClient(): Redis {
  // Look for Vercel KV first, fallback to Upstash
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error("Missing Redis credentials (KV_REST_API_URL / KV_REST_API_TOKEN)");
  }

  return new Redis({ url, token });
}

export async function loadState(): Promise<BotState> {
  try {
    const redis = getRedisClient();
    const raw = await redis.get<BotState>(STATE_KEY);
    if (!raw) return createDefaultState();
    return raw as BotState;
  } catch (err) {
    throw err;
  }
}

export async function saveState(state: BotState): Promise<void> {
  try {
    const redis = getRedisClient();
    state.lastUpdated = Date.now();
    await redis.set(STATE_KEY, state);
  } catch (err) {
    throw err;
  }
}

export async function resetState(): Promise<BotState> {
  const fresh = createDefaultState();
  await saveState(fresh);
  return fresh;
}
