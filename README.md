# MI — Master Intelligence | Advanced Trading AI Suite

A **professional, real-data trading dashboard** with a built-in **AI market analyst**.

**No simulated data.** Prices, market capitalizations, rankings and global metrics come
from the **CoinMarketCap** API (live). Chart candles come from the **Binance public market
API** (live exchange data). Signals are computed on-server from real technical indicators.
The bundled AI assistant (OpenRouter) answers with **real-time market context** injected
into every message.

---

## ✨ Features

| Area | What it does |
| --- | --- |
| **Live charts** | Real OHLCV candlesticks · 1m–1D · EMA 9/21/50, Bollinger Bands, Volume, RSI, MACD · hover tooltip |
| **Market rankings** | Live **CoinMarketCap** top-100 table — price, 1h/24h/7d/30d change, market cap, volume, dominance, circulating supply + global metrics (total market cap, 24h volume, BTC dominance) |
| **Signal engine** | Computes EMA trend, EMA crossovers, RSI, MACD, Bollinger, ATR and volume confluence → BUY / SELL / HOLD with confidence %, entry / take-profit / stop-loss / risk-reward on every symbol |
| **Portfolio** | Track your holdings (stored in your browser) valued at **live** prices, with PnL and 24h change |
| **Risk Manager** | Position-size calculator + live **paper trading** (real signals + real prices → measured win rate & PnL) |
| **Price Alerts** | Create "above / below target" alerts. MI watches the market and pops up an **in-app notification** |
| **Notifications** | Fully in-app permission system (no browser spam). Toast pop-ups, sound toggle, notification center, badge |
| **MI Assistant** | Real streaming AI chat powered by OpenRouter. Grounded in live prices + signals + CoinMarketCap market data |
| **Chart scanning** | Upload a chart / screenshot — MI's **vision** detects patterns and turns it into a trade plan |
| **Trade timing** | The **MI timing engine** analyses real hourly candles to recommend the best hours & days to trade |
| **Beginner → Pro** | Adaptive answers: switch to simple step-by-step guidance or advanced professional analysis |
| **Real-time push** | Server-Sent Events push live prices, fresh signals, alerts and paper trades to the open page |
| **High-conviction signals** | Every BUY/SELL carries a **conviction tier** (🔥 HIGH / ⚡ MEDIUM / ○ LOW) based on factor agreement + score, so the app never over-promises a weak setup |
| **Installable app (PWA)** | **Download MI as an app** — install button + manifest + service worker. Works offline once loaded, with shortcuts straight to Signals / Market / Assistant |
| **Notifications outside the app** | Real **device / OS notifications** via Web Push (VAPID + encrypted payloads). Alerts & signals pop up even when MI is closed — with its own ON/OFF toggle in the 🔔 center |
| **Saved locally until deleted** | **Price alerts** and **notification history** persist in `data/db.json`; every new **signal verdict** is saved to a **Signal History** panel in the Signals view — everything stays until *you* delete it |
| **💠 Crypto mode** | Default — CoinMarketCap + Binance **spot** dashboard: top-100 rankings, global metrics, BUY/SELL signals with TP/SL |
| **⏱️ Pocket Option mode** | Short-expiry **digital-option** signals on crypto + FX: instant **CALL / PUT** verdicts with recommended **expiry** (1m/5m/15m), **payout estimate** (80–94%) and win probability, scanned on 5m momentum |
| **💱 Forex mode** | FX majors + **XAU/USD & XAG/USD** (live Yahoo Finance data): **pip-based** trade plans (TP/SL in pips), per-pair precision, and the **active trading sessions** (Tokyo / London / New York / Sydney) |
| **Mode switcher** | One tap in the top bar — every view (chart, signals, stats, portfolio, assistant) instantly re-works for the active mode; local server keeps per-mode state, Vercel uses `?mode=` |
| **🔐 Login page** | Password-protected entry (`Admin2026` by default, change via `MI_PASSWORD`). Session lasts 7 days; 🚪 button in the top bar logs you out |
| **📱 Fully responsive** | Optimized for phones & tablets — scrollable tables, stacked panels, mobile-bottom notification drawer, touch-friendly nav |

---

## 🚀 Quick start

**Requirements:** Node.js 18+ (tested on Node 24). **No install step — zero npm dependencies.**

```bash
# 1. Go to the project folder
cd "f:\Mi Trading"

# 2. (Optional) put your OpenRouter key in .env
#    OPENROUTER_API_KEY=sk-or-v1-...

# 3. Start
npm start            # or: node server/index.js
```

Then open **http://localhost:3009** in your browser.

---

## ⚙️ Environment (`.env`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3009` | HTTP port |
| `MI_PASSWORD` | `Admin2026` | Password for the **login page** (change in `.env` or Vercel env vars) |
| `OPENROUTER_API_KEY` | *(empty)* | AI assistant key (get one at https://openrouter.ai/keys) |
| `AI_MODEL` | `openai/gpt-4o-mini` | Which OpenRouter model powers MI |
| `CMC_API_KEY` | *(empty)* | Optional CoinMarketCap Pro key (https://coinmarketcap.com/api/). Leave empty for the keyless public API. When set, authenticated quotes/ohlcv endpoints are enabled. |
| `MI_CONTACT_EMAIL` | `mi@localhost` | Contact used in the Web Push VAPID JWT (`sub`) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | *(auto)* | Optional explicit Web Push keys (base64url public / PEM private). If unset, MI generates and stores them in `data/vapid.json` on first use. |
| `SIGNAL_INTERVAL_MS` | `60000` | Signal engine refresh rate |
| `TICKER_INTERVAL_MS` | `5000` | Live price refresh rate |
| `MI_MODE` | `crypto` | Default market mode on boot (`crypto` / `pocket` / `forex`) |

> ⚠️ **Security:** `.env` is git-ignored and must never be committed or shared.
> Your API keys stay on the server — the browser never sees them.

---

## 📡 API reference

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | Service + data-source status (includes current `mode`) |
| GET | `/api/config?mode=` | Symbols, intervals, AI model + **all modes** |
| POST | `/api/mode` | Switch the server between `crypto` / `pocket` / `forex` |
| GET | `/api/market?mode=` | Latest prices + 24h stats + global metrics + top-100 listings |
| GET | `/api/market/ranking?limit=100` | CoinMarketCap-style ranked market overview |
| GET | `/api/market/klines?symbol=BTCUSDT&interval=15m&limit=300` | OHLCV candles (Binance; CMC when keyed) |
| GET | `/api/signals` | All signals + market summary |
| GET | `/api/signals/:symbol` | Single signal |
| GET | `/api/paper` | Paper-trading stats, open positions, history |
| GET/POST | `/api/alerts` | List / create price alerts |
| DELETE | `/api/alerts/:id` | Remove an alert |
| GET | `/api/notifications` | Notification history |
| POST | `/api/notifications/read-all` | Mark all as read |
| DELETE | `/api/notifications` | Clear history |
| POST | `/api/chat` | Streaming AI chat (SSE) |
| GET | `/api/events` | Live SSE push (market, signals, notifications, alerts, paper) |

---

## 💡 How signals are calculated

The MI engine pulls the latest **200 × 15-minute candles** per asset from Binance and computes:

- **Trend** — price vs EMA(21) vs EMA(50)
- **EMA crossovers** — EMA(9)/EMA(21)
- **RSI(14)** — overbought / oversold / momentum
- **MACD(12,26,9)** — histogram + signal
- **Bollinger Bands(20, 2σ)** — position within bands
- **Volume** — current vs 20-bar average
- **ATR(14)** — volatility → stop-loss & take-profit distance

Each factor scores the confluence. **BUY** ≥ +30, **SELL** ≤ −30, otherwise **HOLD**.
Confidence scales with the score. TP/SL come from ATR multiples so they adapt to real volatility.

---

## 🔔 Notifications — how it works

1. The first time you open the app you're asked to **enable MI notifications** — this is MI's
   own in-app permission (stored in your browser), **not** the OS/browser notification API.
2. While enabled, price alerts, high-confidence signals and paper-trade outcomes pop up as
   toasts with an optional sound.
3. Everything is also recorded in the **Notification Center** (🔔 bell in the top bar),
   even when permission is off.

---

## 📁 Project structure

```
f:\Mi Trading
├── server/                  # Node.js backend (zero dependencies)
│   ├── index.js             # HTTP server + routes
│   ├── httpkit.js           # Minimal zero-dep HTTP/router/static toolkit
│   ├── config.js            # Tiny .env loader
│   ├── coinmarketcap.js     # Real market-data layer (CoinMarketCap prices/rankings/global metrics)
│   ├── binance.js           # OHLCV candle layer (Binance public API)
│   ├── indicators.js        # EMA, RSI, MACD, Bollinger, ATR, SMA
│   ├── signalEngine.js      # MI confluence signal engine
│   ├── paper.js             # Paper-trading engine (real prices)
│   ├── alerts.js            # Price alerts + notifications
│   ├── ai.js                # OpenRouter streaming proxy
│   └── store.js             # JSON persistence (data/db.json)
├── public/                  # Frontend (vanilla JS, no build step)
│   ├── index.html
│   ├── css/style.css
│   └── js/ (api, app, chart, chat, market, notifications, portfolio, signals)
├── data/db.json             # Runtime state (auto-created)
├── .env                     # Secrets (git-ignored)
└── package.json
```

---

## ⚠️ Disclaimer

**MI is an analytical tool, not financial advice.** Markets carry risk of loss.
Always do your own research and use stop-losses and position sizing that fit
your own risk tolerance. AI output can contain errors.