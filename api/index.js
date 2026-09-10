'use strict';
// ============================================================================
// MI — Master Intelligence · Vercel serverless adapter
// ----------------------------------------------------------------------------
// Vercel runs this file as a serverless function (Node 18+). It mirrors the
// full REST API of server/index.js in a STATELESS way:
//   • Every request fetches fresh live data (CoinMarketCap + Binance).
//   • /api/chat streams the OpenRouter response.
//   • /api/events emits a full snapshot once with `retry:` — the frontend uses
//     the EventSource reconnect as lightweight polling, plus a manual polling
//     fallback when SSE is unavailable.
//   • Alerts & notifications live in instance memory (serverless has no shared
//     filesystem). Persist them in Vercel KV / Postgres for production scale.
//
// Env vars (Vercel dashboard → Project → Settings → Environment Variables):
//   OPENROUTER_API_KEY   — OpenRouter key for the AI assistant
//   AI_MODEL             — model name (default openai/gpt-4o-mini)
//   CMC_API_KEY          — optional CoinMarketCap Pro key
// ============================================================================

require('../server/config').loadEnv();

const path = require('path');
const fs = require('fs');
const { Router, readJsonBody } = require('../server/httpkit');
const binance = require('../server/binance');
const cmc = require('../server/coinmarketcap');
const signalEngine = require('../server/signalEngine');
const ai = require('../server/ai');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const API_KEY = process.env.OPENROUTER_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'openai/gpt-4o-mini';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// ------------------------------------------------------------------ instance cache
const memo = { market: null, signals: [], summary: null, summaryTs: 0 };

async function loadMarket() {
  if (memo.market && Date.now() - memo.market.ts < 45000) return memo.market;
  let prices = {}, stats24h = {}, global = null, listings = [];
  let src = 'coinmarketcap';
  try {
    const overview = await cmc.getMarketOverview(100);
    prices = overview.prices;
    stats24h = overview.stats24h;
    global = overview.global;
    listings = overview.listings;
  } catch (e) {
    src = 'binance-fallback';
    const [p, s] = await Promise.all([
      binance.getTickerPrices(binance.DEFAULT_SYMBOLS),
      binance.get24hStats(binance.DEFAULT_SYMBOLS),
    ]);
    prices = p; stats24h = s;
  }
  memo.market = { prices, stats24h, global, listings, source: src, ts: Date.now() };
  return memo.market;
}

async function loadSignals(cached = true) {
  if (cached && memo.signals.length && Date.now() - memo.summaryTs < 45000) {
    return { signals: memo.signals, summary: memo.summary };
  }
  const analyses = [];
  await Promise.all(binance.DEFAULT_SYMBOLS.map(async (symbol) => {
    try {
      const klines = await binance.getKlines(symbol, '15m', 200);
      const analysis = signalEngine.analyzeSymbol(symbol, klines);
      if (analysis) analyses.push(analysis);
    } catch { /* skip */ }
  }));
  memo.signals = analyses;
  memo.summary = signalEngine.summarize(analyses);
  memo.summaryTs = Date.now();
  return { signals: analyses, summary: memo.summary };
}

// ------------------------------------------------------------------ JSON helpers
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendSse(res, status) {
  res.writeHead(status, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
// ------------------------------------------------------------------ router
const router = new Router();

router.get('/api/health', async (ctx) => {
  const market = await loadMarket();
  sendJson(ctx.res, 200, {
    status: 'ok',
    version: '5.0.0',
    source: 'CoinMarketCap + Binance public market data',
    marketSource: market.source,
    providers: { coinmarketcap: market.source === 'coinmarketcap', binance: true },
    aiModel: AI_MODEL,
    aiEnabled: !!API_KEY,
    platform: 'vercel-serverless',
    ts: Date.now(),
  });
});

router.get('/api/config', (ctx) => {
  sendJson(ctx.res, 200, {
    symbols: cmc.TRACKED,
    intervals: Object.keys(binance.INTERVALS),
    aiModel: AI_MODEL,
    aiEnabled: !!API_KEY,
    dataSource: 'CoinMarketCap (prices + market) + Binance (candles)',
    cmcKeyConfigured: !!process.env.CMC_API_KEY,
    platform: 'vercel-serverless',
  });
});

router.get('/api/market', async (ctx) => {
  const market = await loadMarket();
  sendJson(ctx.res, 200, {
    prices: market.prices,
    stats24h: market.stats24h,
    global: market.global,
    listings: market.listings,
    ts: Date.now(),
  });
});

router.get('/api/market/ranking', async (ctx) => {
  const market = await loadMarket();
  const limit = Math.min(Number(ctx.query.limit) || 100, 200);
  sendJson(ctx.res, 200, {
    global: market.global,
    listings: (market.listings || []).slice(0, limit),
    source: 'coinmarketcap',
    ts: Date.now(),
  });
});

router.get('/api/market/klines', async (ctx) => {
  const symbol = String(ctx.query.symbol || 'BTCUSDT').toUpperCase();
  const interval = ctx.query.interval || '15m';
  const limit = Number(ctx.query.limit) || 300;
  try {
    const result = await cmc.getKlines(symbol, interval);
    sendJson(ctx.res, 200, {
      symbol, interval,
      candles: result.candles.slice(-limit),
      source: result.source,
    });
  } catch (err) {
    sendJson(ctx.res, 502, { error: err.message });
  }
});

router.get('/api/signals', async (ctx) => {
  const { signals, summary } = await loadSignals(true);
  sendJson(ctx.res, 200, { signals, summary, ts: Date.now() });
});

router.get('/api/signals/:symbol', async (ctx) => {
  const symbol = String(ctx.params.symbol || '').toUpperCase();
  const { signals } = await loadSignals(true);
  const market = await loadMarket();
  const sig = signals.find(s => s.symbol === symbol) || null;
  sendJson(ctx.res, 200, { signal: sig, price: market.prices[symbol] || null });
});

router.get('/api/paper', async (ctx) => {
  const market = await loadMarket();
  sendJson(ctx.res, 200, {
    stats: {
// ---- alerts & notifications (in-memory per instance) ----
let alertsStore = [];
let notifStore = [];
let notifCounter = 0;

router.get('/api/alerts', (ctx) => sendJson(ctx.res, 200, { alerts: alertsStore.slice(0, 40) }));

router.post('/api/alerts', async (ctx) => {
  try {
    const b = ctx.body || {};
    const targetNum = Number(b.target);
    if (!b.symbol || !b.condition || isNaN(targetNum) || targetNum <= 0) {
      return sendJson(ctx.res, 400, { error: 'Invalid alert parameters' });
    }
    const alert = {
      id: 'a' + Math.random().toString(36).slice(2, 8),
      symbol: String(b.symbol).toUpperCase(),
      condition: b.condition === 'below' ? 'below' : 'above',
      target: targetNum,
      note: b.note || '',
      source: 'manual',
      triggered: false,
      createdAt: Date.now(),
      triggerPrice: null,
      triggeredAt: null,
    };
    alertsStore.push(alert);
    if (alertsStore.length > 100) alertsStore.shift();
    sendJson(ctx.res, 200, { alert });
  } catch (err) {
    sendJson(ctx.res, 400, { error: err.message });
// ---- AI chat (streaming). Vercel supports streaming Node responses. ----
router.post('/api/chat', async (ctx) => {
  const history = Array.isArray(ctx.body && ctx.body.messages)
    ? ctx.body.messages.filter(m => m && m.role && typeof m.content === 'string')
    : [];
  if (!history.length) return sendJson(ctx.res, 400, { error: 'messages[] is required' });
  if (!API_KEY) {
    return sendJson(ctx.res, 503, { error: 'OpenRouter API key is not configured. Add OPENROUTER_API_KEY in the Vercel project Environment Variables.' });
  }

  const market = await loadMarket();
  const { signals, summary } = await loadSignals(true);
  const context = {
    prices: market.prices,
    stats24h: market.stats24h,
    globalMetrics: market.global,
    marketRanking: (market.listings || []).slice(0, 25).map(l => ({
      rank: l.rank, symbol: l.symbol, name: l.name, price: l.price,
      marketCap: l.marketCap, percentChange24h: l.percentChange24h,
    })),
    signals: signals.map(s => ({
      symbol: s.symbol, asset: s.asset, action: s.action, confidence: s.confidence,
      price: s.price, entry: s.entry, takeProfit: s.takeProfit, stopLoss: s.stopLoss,
      riskReward: s.riskReward, trend: s.trend, rsi: s.rsi, score: s.score,
    })),
    summary,
  };

  sendSse(ctx.res, 200);
  sendEvent(ctx.res, 'start', { ts: Date.now(), model: AI_MODEL });
  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    try { sendEvent(ctx.res, 'done', {}); } catch {}
    try { ctx.res.end(); } catch {}
  }

  try {
    const nodeStream = await ai.streamChat({ messages: history, context, model: AI_MODEL, apiKey: API_KEY });
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    try {
      for await (const chunk of nodeStream) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const json = JSON.parse(data);
            const delta = json.choices && json.choices[0] && json.choices[0].delta;
            if (delta && typeof delta.content === 'string' && delta.content.length) {
              sendEvent(ctx.res, 'message', { delta: delta.content });
            }
          } catch { /* partial */ }
        }
      }
    } catch { /* stream error */ }
    finish();
  } catch (err) {
    try { ctx.res.write('data: ' + JSON.stringify({ error: err.message }) + '\n\n'); } catch {}
    finish();
  }
});
  }
});

router.delete('/api/alerts/:id', (ctx) => {
  const before = alertsStore.length;
  alertsStore = alertsStore.filter(a => a.id !== ctx.params.id);
  sendJson(ctx.res, 200, { ok: alertsStore.length < before });
});

router.get('/api/notifications', (ctx) => sendJson(ctx.res, 200, { notifications: notifStore }));
router.post('/api/notifications/read-all', (ctx) => {
  notifStore.forEach(n => { n.read = true; });
  sendJson(ctx.res, 200, { ok: true });
});
router.delete('/api/notifications', (ctx) => {
  notifStore = [];
  sendJson(ctx.res, 200, { ok: true });
});
      openPositions: 0, closedTrades: 0, wins: 0, losses: 0, winRate: 0,
      realizedPnl: 0, floatingPnl: 0, totalPnl: 0, direction: 'positive', lastTrade: null,
    },
    positions: [],
    history: [],
    note: 'Paper trading is fully persistent on the local server. On Vercel it resets per instance.',
  });
});
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 10000\n\n');
  return res;
}

function sendEvent(res, event, data) {
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  try { res.write(payload); } catch { /* closed */ }
}