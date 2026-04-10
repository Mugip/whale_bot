# Backtest Dashboard — Drop-in Files

## Files to add to your project

```
api/
  backtest/
    upload.ts      ← POST  /api/backtest/upload   (upload OHLCV dataset)
    run.ts         ← POST  /api/backtest/run       (process one chunk)
    results.ts     ← GET   /api/backtest/results   (fetch results / session list)
lib/
  backtestRedis.ts ← Redis helpers (isolated from bot state)
  backtestChunk.ts ← Chunk engine wired to your real signal pipeline
public/
  backtest.html    ← Dashboard UI (served at /backtest)
vercel.json.patch  ← Routes to merge into your existing vercel.json
```

## Setup Steps

### 1. Copy files into your project
Drop everything under `api/`, `lib/`, and `public/` into your existing
whale-bot project. No new dependencies required — it uses the same
`@upstash/redis` you already have.

### 2. Update vercel.json
Merge the routes from `vercel.json.patch` into your existing `vercel.json`.
The full merged file is shown in the patch file.

### 3. Deploy
```bash
vercel --prod
```

### 4. Open the dashboard
Navigate to: `https://your-app.vercel.app/backtest`

---

## How to get OHLCV data

Fetch historical 15m candles from OKX and save as JSON:

```bash
curl "https://www.okx.com/api/v5/market/history-candles?instId=BTC-USDT-SWAP&bar=15m&limit=300" \
  | node -e "
    const d=[];process.stdin.resume();let r='';
    process.stdin.on('data',c=>r+=c);
    process.stdin.on('end',()=>{
      const candles=JSON.parse(r).data;
      candles.forEach(c=>d.push({timestamp:+c[0],open:+c[1],high:+c[2],low:+c[3],close:+c[4],vol:+c[5]}));
      process.stdout.write(JSON.stringify(d));
    });
  " > btc_15m.json
```

Then upload via the dashboard **Dataset Upload** panel.

---

## Backtest Flow

```
1. Upload JSON → POST /api/backtest/upload
2. Dashboard loops: POST /api/backtest/run  (≤200 bars per call)
3. Each call returns { done, nextIndex, progressPct }
4. On done=true → results returned and rendered automatically
5. Past sessions stored 24h in Redis — click any session to reload
```

## Redis Keys Used

All keys are namespaced under `bt:` so they never collide with your
bot's `whale_bot:state` key.

| Key | Content |
|-----|---------|
| `bt:data:{key}:0..N` | OHLCV bar chunks |
| `bt:session:{id}` | Session metadata |
| `bt:progress:{id}` | Chunk state (balance, trade, equity curve) |
| `bt:results:{id}` | Final results JSON |
| `bt:sessions` | Redis list of recent session IDs |

## Signal Logic

The chunk engine uses your **real** `evaluateSignal()`, `calculateRisk()`,
`detectLiquiditySweep()`, `computeRSI()`, `computeATR()`, and `computeVolumeRatio()`
functions — the same ones running in production.

`whaleScore` and `obImbalance` are set to 0 (neutral) in backtests since
live Etherscan and order book data aren't available historically. This means
only **2 optional confirmations out of RSI + whale + OB** are evaluated:
- If RSI confirms → 1 of 3 confirmations
- whale = 0 → skipped
- OB = 0 → skipped
You may want to temporarily set `MIN_CONFIRMATIONS = 1` in `signal.ts`
when backtesting to allow RSI-only confirmation.
