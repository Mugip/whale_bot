// ─────────────────────────────────────────────────────────────
// lib/backtestRedis.ts
// Standard Redis connection for Backtest Engine
// ─────────────────────────────────────────────────────────────

import Redis from "ioredis";

async function withRedis<T>(action: (redis: Redis) => Promise<T>): Promise<T> {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("Missing REDIS_URL environment variable");
  const redis = new Redis(url);
  try { return await action(redis); } finally { redis.quit(); }
}

const K = {
  session:  (id: string) => `bt:session:${id}`,
  progress: (id: string) => `bt:progress:${id}`,
  results:  (id: string) => `bt:results:${id}`,
  dataset:  (key: string) => `bt:data:${key}`,
  list: "bt:sessions",
};

export interface BacktestSession {
  id: string; label: string; datasetKey: string; totalBars: number;
  processedBars: number; status: "pending" | "running" | "done" | "error";
  startedAt: number; finishedAt?: number; error?: string;
}

export async function createSession(id: string, label: string, datasetKey: string, totalBars: number): Promise<void> {
  await withRedis(async (r) => {
    const session: BacktestSession = { id, label, datasetKey, totalBars, processedBars: 0, status: "pending", startedAt: Date.now() };
    await r.set(K.session(id), JSON.stringify(session), "EX", 86400);
    await r.lpush(K.list, id);
    await r.ltrim(K.list, 0, 49);
  });
}

export async function getSession(id: string): Promise<BacktestSession | null> {
  return withRedis(async (r) => {
    const data = await r.get(K.session(id));
    return data ? JSON.parse(data) : null;
  });
}

export async function updateSession(id: string, patch: Partial<BacktestSession>): Promise<void> {
  await withRedis(async (r) => {
    const data = await r.get(K.session(id));
    if (!data) return;
    const existing = JSON.parse(data);
    await r.set(K.session(id), JSON.stringify({ ...existing, ...patch }), "EX", 86400);
  });
}

export async function listSessions(): Promise<BacktestSession[]> {
  return withRedis(async (r) => {
    const ids = await r.lrange(K.list, 0, 49);
    if (!ids.length) return [];
    const sessions = await Promise.all(ids.map(id => r.get(K.session(id))));
    return sessions.filter(Boolean).map(s => JSON.parse(s!)) as BacktestSession[];
  });
}

export interface ChunkState {
  nextIndex: number; 
  balance: number; 
  peakBalance: number; 
  wins: number; 
  losses: number;
  totalPnlPct: number; 
  equityCurve: number[];
  trade: null | { 
    direction: "long" | "short"; 
    entry: number; 
    stop: number; 
    tp1: number; 
    tp2: number; 
    tp1Hit: boolean; 
    size: number; 
    notional: number; 
    originalNotional: number; 
    realizedUsd: number; 
  };
  trades: any[];
}


export async function saveChunkState(id: string, state: ChunkState): Promise<void> {
  await withRedis(async (r) => { await r.set(K.progress(id), JSON.stringify(state), "EX", 86400); });
}

export async function loadChunkState(id: string): Promise<ChunkState | null> {
  return withRedis(async (r) => {
    const data = await r.get(K.progress(id));
    return data ? JSON.parse(data) : null;
  });
}

export interface BacktestResults {
  totalTrades: number; wins: number; losses: number; winRate: number; finalBalance: number;
  totalPnlPct: number; maxDrawdownPct: number; profitFactor: number; sharpeApprox: number;
  equityCurve: number[]; trades: Array<{ bar: number; direction: string; entry: number; exit: number; pnlPct: number; reason: string; }>;
}

export async function saveResults(id: string, results: BacktestResults): Promise<void> {
  await withRedis(async (r) => { await r.set(K.results(id), JSON.stringify(results), "EX", 86400); });
}

export async function getResults(id: string): Promise<BacktestResults | null> {
  return withRedis(async (r) => {
    const data = await r.get(K.results(id));
    return data ? JSON.parse(data) : null;
  });
}

export async function saveDataset(key: string, bars: any[]): Promise<void> {
  const CHUNK = 1000;
  await withRedis(async (r) => {
    const chunks = Math.ceil(bars.length / CHUNK);
    for (let i = 0; i < chunks; i++) {
      await r.set(`${K.dataset(key)}:${i}`, JSON.stringify(bars.slice(i * CHUNK, (i + 1) * CHUNK)), "EX", 86400);
    }
    await r.set(`${K.dataset(key)}:meta`, JSON.stringify({ length: bars.length, chunks }), "EX", 86400);
  });
}

export async function loadDataset(key: string): Promise<any[] | null> {
  return withRedis(async (r) => {
    const metaStr = await r.get(`${K.dataset(key)}:meta`);
    if (!metaStr) return null;
    const meta = JSON.parse(metaStr);
    const parts = await Promise.all(
      Array.from({ length: meta.chunks }, (_, i) => r.get(`${K.dataset(key)}:${i}`))
    );
    return parts.map(p => p ? JSON.parse(p) : []).flat();
  });
  }
