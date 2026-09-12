# Push to GitHub & Deploy to Vercel

MI — Master Intelligence runs as a **Node server** locally and as a **serverless function** on Vercel. This guide walks you through: (1) pushing to GitHub, (2) connecting to Vercel, (3) setting env vars, and (4) deploying.

---

## 1) Push to GitHub

Install the GitHub CLI first, or use a Personal Access Token (below).

### Option A — with GitHub CLI (easiest)

```powershell
# 1. Install gh CLI: https://cli.github.com  (winget install GitHub.cli)
gh auth login
cd "f:\Mi Trading"
gh repo create mi-trading --public --source=. --push
```

### Option B — with a Personal Access Token (no gh install)

```powershell
# 1. Create a token at https://github.com/settings/tokens (scope: repo)
# 2. Set your git identity (one-time)
git -C "f:\Mi Trading" config user.name  "YOUR_NAME"
git -C "f:\Mi Trading" config user.email "you@example.com"

# 3. Init + first commit
cd "f:\Mi Trading"
git init -b main
git add .
git commit -m "MI - Master Intelligence Trading Suite: live market data, AI assistant, professional charts"

# 4. Create an EMPTY repo on https://github.com/new  (e.g. mi-trading)
# 5. Add remote using your token and push
git remote add origin https://YOUR_TOKEN@github.com/YOUR_NAME/mi-trading.git
git push -u origin main
```

> 🔒 **The `.env` file (with your API keys) is git-ignored** — it never reaches GitHub. The `.env.example` template is committed instead.

---

## 2) Deploy to Vercel

### Option A — Dashboard (zero terminal)

1. Go to **https://vercel.com/new**
2. Import your **`mi-trading`** GitHub repo
3. Vercel auto-detects Node + the `api/` directory
4. In **Settings → Environment Variables** add:

| Name | Value |
| --- | --- |
| `OPENROUTER_API_KEY` | `sk-or-v1-...` |
| `AI_MODEL` | `openai/gpt-4o-mini` |
| `CMC_API_KEY` | *(optional)* your CoinMarketCap pro key |

5. Click **Deploy** ✅

### Option B — Vercel CLI

```powershell
npm i -g vercel
cd "f:\Mi Trading"
vercel login
vercel            # first deploy (preview)
vercel --prod     # production
```

Add env vars with:

```powershell
vercel env add OPENROUTER_API_KEY
vercel env add AI_MODEL
vercel env add CMC_API_KEY
vercel --prod
```

---

## 3) How it works on Vercel

`vercel.json` routes **all traffic** to one serverless function `api/index.js`, which:

- Serves the static frontend (`public/`)
- Proxies the **live market APIs** (CoinMarketCap + Binance) — no user-side keys
- Streams the **OpenRouter AI chat**
- Serves a full SSE snapshot on `/api/events` — the frontend reconnects every ~10s as lightweight polling

**Serverless notes**

- Market data is cached for 45s per warm instance (faster + fewer upstream calls).
- **Alerts & notifications are in-memory** (they reset when Vercel recycles an instance). If you need them to survive restarts, add **Vercel Postgres or KV** — the endpoint shapes already match a DB-backed store.
- **Paper trading** statistics reset per instance on Vercel; the full persistent paper-trading engine remains the local-server feature (run locally with `npm start` for the complete experience).

---

## 4) Environment variables (both platforms)

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `OPENROUTER_API_KEY` | yes (for AI) | — | OpenRouter key for the MI assistant |
| `AI_MODEL` | no | `openai/gpt-4o-mini` | Which OpenRouter model |
| `CMC_API_KEY` | no | *(empty)* | CoinMarketCap Pro key (authenticated endpoints) |
| `PORT` | no | `3009` | Local server port only |

---

## 5) Local dev (unchanged)

```powershell
npm start            # → http://localhost:3009
```

The serverless environment runs the same code path as the local server for market data & AI, so behaviour is consistent between local and deployed.

---

## 6) Useful endpoints after deploy

| Endpoint | Description |
| --- | --- |
| `https://YOUR-APP.vercel.app/api/health` | Status + data source |
| `https://YOUR-APP.vercel.app/api/market` | Prices, stats, global metrics, top-100 |
| `https://YOUR-APP.vercel.app/api/signals` | MI signal engine output |
| `https://YOUR-APP.vercel.app/api/market/klines?symbol=BTCUSDT&interval=15m` | Chart candles |
| `https://YOUR-APP.vercel.app/api/chat` | AI assistant (streams) |