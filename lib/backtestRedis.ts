// ─────────────────────────────────────────────────────────────
// lib/backtestRedis.ts
// Redis helpers scoped specifically to backtest state.
// Isolated from main bot state to avoid collisions.
// ─────────────────────────────────────────────────────────────

import { Redis } from "@upstash/redis";

function getRedis(): Redis {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Missing Upstash env vars");
  return new Redis({ url, token });
}

// Key namespace
const K = {
  session:  (id: string) => `bt:session:${id}`,
  progress: (id: string) => `bt:progress:${id}`,
  results:  (id: string) => `bt:results:${id}`,
  dataset:  (key: string) => `bt:data:${key}`,
  list: "bt:sessions",
};

// ─── Session ─────────────────────────────────────────────────

export interface BacktestSession {
  id: string;
  label: string;
  datasetKey: string;
  totalBars: number;
  processedBars: number;
  status: "pending" | "running" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

export async function createSession(
  id: string,
  label: string,
  datasetKey: string,
  totalBars: number
): Promise<void> {
  const r = getRedis();
  const session: BacktestSession = {
    id, label, datasetKey, totalBars,
    processedBars: 0,
    status: "pending",
    startedAt: Date.now(),
  };
  await r.set(K.session(id), session, { ex: 86400 }); // 24h TTL
  await r.lpush(K.list, id);
  await r.ltrim(K.list, 0, 49); // keep last 50 sessions
}

export async function getSession(id: string): Promise<BacktestSession | null> {
  return getRedis().get<BacktestSession>(K.session(id));
}

export async function updateSession(
  id: string,
  patch: Partial<BacktestSession>
): Promise<void> {
  const r = getRedis();
  const existing = await r.get<BacktestSession>(K.session(id));
  if (!existing) return;
  await r.set(K.session(id), { ...existing, ...patch }, { ex: 86400 });
}

export async function listSessions(): Promise<BacktestSession[]> {
  const r = getRedis();
  const ids = await r.lrange<string>(K.list, 0, 49);
  if (!ids.length) return [];
  const sessions = await Promise.all(ids.map((id) => r.get<BacktestSession>(K.session(id))));
  return sessions.filter(Boolean) as BacktestSession[];
}

// ─── Chunked progress state ──────────────────────────────────

export interface ChunkState {
  nextIndex: number;
  balance: number;
  peakBalance: number;
  wins: number;
  losses: number;
  totalPnlPct: number;
  equityCurve: number[];  // sampled every 50 bars
  trade: null | {
    direction: "long" | "short";
    entry: number;
    stop: number;
    tp1: number;
    tp2: number;
    tp1Hit: boolean;
    size: number;
    notional: number;
  };
}

export async function saveChunkState(id: string, state: ChunkState): Promise<void> {
  await getRedis().set(K.progress(id), state, { ex: 86400 });
}

export async function loadChunkState(id: string): Promise<ChunkState | null> {
  return getRedis().get<ChunkState>(K.progress(id));
}

// ─── Final results ────────────────────────────────────────────

export interface BacktestResults {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  finalBalance: number;
  totalPnlPct: number;
  maxDrawdownPct: number;
  profitFactor: number;
  sharpeApprox: number;
  equityCurve: number[];
  trades: Array<{
    bar: number;
    direction: string;
    entry: number;
    exit: number;
    pnlPct: number;
    reason: string;
  }>;
}

export async function saveResults(id: string, results: BacktestResults): Promise<void> {
  await getRedis().set(K.results(id), results, { ex: 86400 });
}

export async function getResults(id: string): Promise<BacktestResults | null> {
  return getRedis().get<BacktestResults>(K.results(id));
}

// ─── Dataset storage ──────────────────────────────────────────

export async function saveDataset(key: string, bars: any[]): Promise<void> {
  // Store in 1000-bar chunks to stay under 5MB Redis value limit
  const CHUNK = 1000;
  const r = getRedis();
  const chunks = Math.ceil(bars.length / CHUNK);
  for (let i = 0; i < chunks; i++) {
    await r.set(`${K.dataset(key)}:${i}`, bars.slice(i * CHUNK, (i + 1) * CHUNK), { ex: 86400 });
  }
  await r.set(`${K.dataset(key)}:meta`, { length: bars.length, chunks }, { ex: 86400 });
}

export async function loadDataset(key: string): Promise<any[] | null> {
  const r = getRedis();
  const meta = await r.get<{ length: number; chunks: number }>(`${K.dataset(key)}:meta`);
  if (!meta) return null;
  const parts = await Promise.all(
    Array.from({ length: meta.chunks }, (_, i) => r.get<any[]>(`${K.dataset(key)}:${i}`))
  );
  return parts.flat().filter(Boolean);
}
