// ─────────────────────────────────────────────────────────────
// lib/redis.ts
// Standard Redis connection for Bot State
// ─────────────────────────────────────────────────────────────

import Redis from "ioredis";
import { BotState, createDefaultState } from "../state/schema";

const STATE_KEY = "whale_bot:state";

async function withRedis<T>(action: (redis: Redis) => Promise<T>): Promise<T> {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("Missing REDIS_URL environment variable");
  
  const redis = new Redis(url);
  try {
    return await action(redis);
  } finally {
    redis.quit(); // Crucial for Vercel Serverless!
  }
}

export async function loadState(): Promise<BotState> {
  return withRedis(async (redis) => {
    const raw = await redis.get(STATE_KEY);
    if (!raw) return createDefaultState();
    return JSON.parse(raw) as BotState;
  });
}

export async function saveState(state: BotState): Promise<void> {
  return withRedis(async (redis) => {
    state.lastUpdated = Date.now();
    await redis.set(STATE_KEY, JSON.stringify(state));
  });
}

export async function resetState(): Promise<BotState> {
  const fresh = createDefaultState();
  await saveState(fresh);
  return fresh;
}
