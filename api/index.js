'use strict';
// ============================================================================
// MI - Master Intelligence - Vercel serverless adapter
// ----------------------------------------------------------------------------
// Vercel runs this file as a serverless function (Node 18+). It mirrors the
// full REST API of server/index.js in a STATELESS way:
//   - Every request fetches fresh live data (CoinMarketCap + Binance).
//   - /api/chat streams the OpenRouter response.
//   - /api/events emits a full snapshot once with a retry: hint - the frontend
//     uses the EventSource reconnect as lightweight polling, plus a manual
//     polling fallback when SSE is unavailable.
//   - Alerts and notifications live in instance memory (serverless has no
//     shared filesystem). Persist them in Vercel KV / Postgres for scale.
//
// Env vars (Vercel dashboard -> Project -> Settings -> Environment Variables):
//   OPENROUTER_API_KEY   - OpenRouter key for the AI assistant
//   AI_MODEL             - model name (default openai/gpt-4o-mini)
//   CMC_API_KEY          - optional CoinMarketCap Pro key
// ============================================================================

require('../server/config').loadEnv();

const path = require('path');
const fs = require('fs');
const { Router, readJsonBody } = require('../server/httpkit');
const binance = require('../server/binance');
const cmc = require('../server/coinmarketcap');
const signalEngine = require('../server/signalEngine');
const ai = require('../server/ai');
const timing = require('../server/timing');
const push = require('../server/push');
const marketModes = require('../server/marketModes');
const fx = require('../server/fx');
const Accuracy = require('../server/accuracy');
const backtest = require('../server/backtest');
const sentimentApi = require('../server/sentiment');
const calendarApi = require('../server/calendar');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const API_KEY = process.env.OPENROUTER_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'openai/gpt-4o-mini';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// ------------------------------------------------------------------ instance cache
const memo = { market: null, signals: [], summary: null, summaryTs: 0 };
// Signal history + push subscriptions live in instance memory on Vercel
// (add Vercel KV/Postgres later for cross-instance persistence).
const signalHistory = [];
const lastSignalState = {};
const pushSubs = [];
// Signal-accuracy store (instance memory on Vercel; persisted on local npm start).
const accuracy = new Accuracy({ data: { signalAccuracy: [] }, save() { /* memory only */ } });

function recordSignalHistory(analyses) {
  for (const a of analyses) {
    if (!a || a.action === 'HOLD' || a.action === 'NEUTRAL') continue;
    const stateKey = a.action + '|' + a.quality + '|' + a.confidence;
    if (lastSignalState[a.symbol] === stateKey) continue;
    lastSignalState[a.symbol] = stateKey;
    signalHistory.push({
      id: a.symbol + '-' + Date.now(),
      ts: Date.now(),
      symbol: a.symbol, asset: a.asset, action: a.action, confidence: a.confidence,
      price: a.price, takeProfit: a.takeProfit, stopLoss: a.stopLoss,
      riskReward: a.riskReward, quality: a.quality, score: a.score, trend: a.trend,
    });
  }
  if (signalHistory.length > 500) signalHistory.splice(0, signalHistory.length - 500);
}

async function loadMarket(mode = 'crypto') {
  mode = marketModes.isValid(mode) ? mode : 'crypto';
  const key = 'market:' + mode;
  if (memo[key] && Date.now() - memo[key].ts < 45000) return memo[key];
  let prices = {}, stats24h = {}, global = null, listings = [];
  let src;
  if (mode === 'crypto') {
    src = 'coinmarketcap';
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
  } else {
    const r = await marketModes.getPrices(mode);
    prices = r.prices; stats24h = r.stats24h; src = r.source || 'mixed';
  }
  memo[key] = { prices, stats24h, global, listings, source: src, mode, ts: Date.now() };
  return memo[key];
}

async function loadSignals(mode = 'crypto', cached = true) {
  mode = marketModes.isValid(mode) ? mode : 'crypto';
  const sigKey = 'signals:' + mode;
  const tsKey = 'summaryTs:' + mode;
  if (cached && memo[sigKey] && memo[sigKey].length && Date.now() - memo[tsKey] < 45000) {
    return { signals: memo[sigKey], summary: memo['summary:' + mode] };
  }
  const mCfg = marketModes.MODES[mode] || marketModes.MODES.crypto;
  const interval = mCfg.klineInterval;
  const analyses = [];
  await Promise.all(mCfg.symbols.map(async (symbol) => {
    try {
      const klines = fx.isFxCandidate(symbol)
        ? await fx.getKlines(symbol, interval, 200)
        : await binance.getKlines(symbol, interval, 200);
      const opts = { mode };
      if ((mode === 'forex' || mode === 'pocket') && fx.isFxCandidate(symbol)) {
        opts.precision = fx.precision(symbol);
        opts.pip = fx.pipSize(symbol);
      }
      const analysis = signalEngine.analyzeSymbol(symbol, klines, opts);
      if (analysis) analyses.push(analysis);
    } catch { /* skip */ }
  }));
  memo[sigKey] = analyses;
  memo['summary:' + mode] = signalEngine.summarize(analyses);
  memo[tsKey] = Date.now();
  recordSignalHistory(analyses);
  for (const a of analyses) accuracy.observe(a);
  return { signals: analyses, summary: memo['summary:' + mode] };
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
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 10000\n\n');
  return res;
}

function sendEvent(res, event, data) {
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  try { res.write(payload); } catch { /* closed */ }
}
// ------------------------------------------------------------------ router
const router = new Router();

router.get('/api/health', async (ctx) => {
  const mode = marketModes.isValid(ctx.query.mode) ? ctx.query.mode : marketModes.DEFAULT_MODE;
  const market = await loadMarket(mode);
  sendJson(ctx.res, 200, {
    status: 'ok',
    version: '6.0.0',
    mode,
    source: 'CoinMarketCap + Binance + Yahoo Finance public market data',
    marketSource: market.source,
    providers: { coinmarketcap: market.source === 'coinmarketcap', binance: true },
    aiModel: AI_MODEL,
    aiEnabled: !!API_KEY,
    platform: 'vercel-serverless',
    ts: Date.now(),
  });
});

router.get('/api/config', (ctx) => {
  const mode = marketModes.isValid(ctx.query.mode) ? ctx.query.mode : marketModes.DEFAULT_MODE;
  sendJson(ctx.res, 200, {
    symbols: marketModes.getSymbols(mode),
    intervals: Object.keys(binance.INTERVALS),
    aiModel: AI_MODEL,
    aiEnabled: !!API_KEY,
    dataSource: 'CoinMarketCap (prices + market) + Binance (candles) + Yahoo Finance (FX)',
    cmcKeyConfigured: !!process.env.CMC_API_KEY,
    platform: 'vercel-serverless',
    mode,
    modes: Object.keys(marketModes.MODES).map(k => ({
      id: k, label: marketModes.MODES[k].label, icon: marketModes.MODES[k].icon,
      description: marketModes.MODES[k].description, symbols: marketModes.MODES[k].symbols,
    })),
  });
});

// Vercel is stateless — mode is carried per request via ?mode=. Accept the
// frontend's POST so the hosted app never 404s (returns the requested mode).
router.post('/api/mode', (ctx) => {
  const mode = marketModes.isValid(ctx.body && ctx.body.mode)
    ? ctx.body.mode
    : marketModes.DEFAULT_MODE;
  sendJson(ctx.res, 200, { ok: true, mode, symbols: marketModes.getSymbols(mode) });
});

router.get('/api/market', async (ctx) => {
  const mode = marketModes.isValid(ctx.query.mode) ? ctx.query.mode : marketModes.DEFAULT_MODE;
  const market = await loadMarket(mode);
  sendJson(ctx.res, 200, {
    prices: market.prices,
    stats24h: market.stats24h,
    global: market.global,
    listings: market.listings,
    mode,
    ts: Date.now(),
  });
});

router.get('/api/market/ranking', async (ctx) => {
  const mode = marketModes.isValid(ctx.query.mode) ? ctx.query.mode : marketModes.DEFAULT_MODE;
  const market = await loadMarket(mode);
  const limit = Math.min(Number(ctx.query.limit) || 100, 200);
  sendJson(ctx.res, 200, {
    global: market.global,
    listings: (market.listings || []).slice(0, limit),
    source: market.source,
    mode,
    ts: Date.now(),
  });
});

router.get('/api/market/klines', async (ctx) => {
  const symbol = String(ctx.query.symbol || 'BTCUSDT').toUpperCase();
  const interval = ctx.query.interval || '15m';
  const limit = Number(ctx.query.limit) || 300;
  const mode = marketModes.isValid(ctx.query.mode) ? ctx.query.mode : marketModes.DEFAULT_MODE;
  try {
    let candles, source;
    if (fx.isFxCandidate(symbol)) {
      candles = await fx.getKlines(symbol, interval, limit);
      source = 'yahoo';
    } else {
      const result = await cmc.getKlines(symbol, interval);
      candles = result.candles.slice(-limit);
      source = result.source;
    }
    sendJson(ctx.res, 200, { symbol, interval, mode, candles, source });
  } catch (err) {
    sendJson(ctx.res, 502, { error: err.message });
  }
});

router.get('/api/signals', async (ctx) => {
  const mode = marketModes.isValid(ctx.query.mode) ? ctx.query.mode : marketModes.DEFAULT_MODE;
  const { signals, summary } = await loadSignals(mode, true);
  sendJson(ctx.res, 200, { signals, summary, mode, ts: Date.now() });
});

// NOTE: registered BEFORE /api/signals/:symbol so it isn't shadowed by the param route.
router.get('/api/signals/history', (ctx) => {
  sendJson(ctx.res, 200, { history: signalHistory.slice().sort((a, b) => b.ts - a.ts).slice(0, 200), stored: false });
});
router.delete('/api/signals/history', (ctx) => {
  signalHistory.length = 0;
  Object.keys(lastSignalState).forEach(k => delete lastSignalState[k]);
  sendJson(ctx.res, 200, { ok: true });
});
router.get('/api/signals/:symbol', async (ctx) => {
  const symbol = String(ctx.params.symbol || '').toUpperCase();
  const mode = marketModes.isValid(ctx.query.mode) ? ctx.query.mode : marketModes.DEFAULT_MODE;
  const { signals } = await loadSignals(mode, true);
  const market = await loadMarket(mode);
  const sig = signals.find(s => s.symbol === symbol) || null;
  sendJson(ctx.res, 200, { signal: sig, price: market.prices[symbol] || null, mode });
});

router.get('/api/paper', async (ctx) => {
  const market = await loadMarket();
  void market;
  sendJson(ctx.res, 200, {
    stats: {
      openPositions: 0, closedTrades: 0, wins: 0, losses: 0, winRate: 0,
      realizedPnl: 0, floatingPnl: 0, totalPnl: 0, direction: 'positive', lastTrade: null,
    },
    positions: [],
    history: [],
    note: 'Paper trading is fully persistent on the local server. On Vercel it resets per instance.',
  });
});
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
// ---- web push (outside-the-app notifications) ----
router.get('/api/push/vapid', (ctx) => sendJson(ctx.res, 200, { publicKey: push.getPublicKey() }));
router.get('/api/push/status', (ctx) => sendJson(ctx.res, 200, { enabled: pushSubs.length > 0, count: pushSubs.length, supported: true }));
router.post('/api/push/subscribe', (ctx) => {
  try {
    const { endpoint, keys, userAgent } = ctx.body || {};
    if (!endpoint || !keys || !keys.p256dh || !keys.auth) return sendJson(ctx.res, 400, { error: 'endpoint + keys.p256dh + keys.auth required' });
    const idx = pushSubs.findIndex(s => s.endpoint === endpoint);
    if (idx !== -1) pushSubs[idx] = { endpoint: String(endpoint), keys: { p256dh: String(keys.p256dh), auth: String(keys.auth) }, userAgent: userAgent || '' };
    else pushSubs.push({ endpoint: String(endpoint), keys: { p256dh: String(keys.p256dh), auth: String(keys.auth) }, userAgent: userAgent || '' });
    while (pushSubs.length > 20) pushSubs.shift();
    sendJson(ctx.res, 200, { ok: true, count: pushSubs.length });
  } catch (err) { sendJson(ctx.res, 400, { error: err.message }); }
});
router.post('/api/push/unsubscribe', (ctx) => {
  const { endpoint } = ctx.body || {};
  const before = pushSubs.length;
  const idx = pushSubs.findIndex(s => s.endpoint === endpoint);
  if (idx !== -1) pushSubs.splice(idx, 1);
  sendJson(ctx.res, 200, { ok: before > pushSubs.length });
});
// ---- AI chat (streaming). Vercel supports streaming Node responses. ----
router.post('/api/chat', async (ctx) => {
  const history = Array.isArray(ctx.body && ctx.body.messages)
    ? ctx.body.messages.filter(m => m && m.role && typeof m.content === 'string')
    : [];
  if (!history.length) return sendJson(ctx.res, 400, { error: 'messages[] is required' });
  if (!API_KEY) {
    return sendJson(ctx.res, 503, { error: 'OpenRouter API key is not configured. Add OPENROUTER_API_KEY in the Vercel project Environment Variables.' });
  }

  const mode = marketModes.isValid(ctx.body && ctx.body.mode) ? ctx.body.mode : marketModes.DEFAULT_MODE;
  const market = await loadMarket(mode);
  const { signals, summary } = await loadSignals(mode, true);

  // Optional image uploads (vision models) + audience level.
  const images = Array.isArray(ctx.body && ctx.body.images)
    ? ctx.body.images.filter(img => img && typeof img.dataUrl === 'string' && img.dataUrl.length < 3_000_000).slice(-3)
    : [];
  const audience = String(ctx.body && ctx.body.level || 'balanced');
  const timingSymbol = String(ctx.body && ctx.body.timingSymbol || 'BTCUSDT');
  const focusSymbol = history.length && typeof history[history.length - 1].content === 'string'
    ? (String(history[history.length - 1].content).match(/\b(BTCUSDT|ETHUSDT|SOLUSDT|XRPUSDT|ADAUSDT|DOGEUSDT|AVAXUSDT|LINKUSDT|DOTUSDT|LTCUSDT|BNBUSDT|POLUSDT)\b/) || [null, timingSymbol])[1]
    : timingSymbol;

  let tradeTiming = null;
  try { tradeTiming = await timing.getTiming(focusSymbol); } catch { /* optional */ }
  let sSentiment = null, sCalendar = null;
  try { sSentiment = await sentimentApi.getSentiment(); } catch { /* optional */ }
  try { sCalendar = await calendarApi.getCalendar(); } catch { /* optional */ }

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
    audience,
    tradeTiming,
    sentiment: sSentiment,
    economicCalendar: sCalendar ? {
      source: sCalendar.source,
      high: (sCalendar.high || []).slice(0, 10).map(e => ({ title: e.title, country: e.country, time: e.time, impact: e.impact })),
      imminentHigh: (sCalendar.imminentHigh || []).slice(0, 4).map(e => ({ title: e.title, country: e.country, time: e.time })),
    } : null,
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
    const nodeStream = await ai.streamChat({ messages: history, context, model: AI_MODEL, apiKey: API_KEY, images });
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
// ---- trade timing (real best-hours/day analysis) ----
router.get('/api/timing', async (ctx) => {
  const symbol = String(ctx.query.symbol || 'BTCUSDT').toUpperCase();
  try {
    const data = await timing.getTiming(symbol);
    sendJson(ctx.res, 200, data);
  } catch (err) {
    sendJson(ctx.res, 502, { error: err.message });
  }
});

// ---- auth (password gate) ----
router.post('/api/login', (ctx) => {
  const pass = String((ctx.body && ctx.body.password) || '');
  const expected = process.env.MI_PASSWORD || 'Admin2026';
  if (pass === expected) return sendJson(ctx.res, 200, { ok: true });
  return sendJson(ctx.res, 401, { error: 'Invalid password' });
});

// ---- signal accuracy, backtest, sentiment & calendar ----
router.get('/api/accuracy', async (ctx) => {
  try {
    const mode = marketModes.isValid(ctx.query.mode) ? ctx.query.mode : 'crypto';
    const market = await loadMarket(mode);
    accuracy.check(market.prices);
    sendJson(ctx.res, 200, { stats: accuracy.stats(), history: accuracy.history() });
  } catch (e) { sendJson(ctx.res, 502, { error: e.message }); }
});
router.delete('/api/accuracy', (ctx) => {
  accuracy.clear();
  sendJson(ctx.res, 200, { ok: true });
});
router.get('/api/backtest', async (ctx) => {
  try {
    const result = await backtest.runBacktest({
      symbol: String(ctx.query.symbol || 'BTCUSDT'),
      mode: ctx.query.mode || 'crypto',
      interval: ctx.query.interval || '1h',
      bars: Number(ctx.query.bars) || 720,
    });
    sendJson(ctx.res, 200, result);
  } catch (e) { sendJson(ctx.res, 502, { error: e.message }); }
});
router.get('/api/sentiment', async (ctx) => {
  try { sendJson(ctx.res, 200, await sentimentApi.getSentiment()); }
  catch (e) { sendJson(ctx.res, 502, { error: e.message }); }
});
router.get('/api/calendar', async (ctx) => {
  try { sendJson(ctx.res, 200, await calendarApi.getCalendar()); }
  catch (e) { sendJson(ctx.res, 502, { error: e.message }); }
});

// ---- SSE live feed: full snapshot once, then the frontend reconnects (polling) ----
router.get('/api/events', async (ctx) => {
  const mode = marketModes.isValid(ctx.query.mode) ? ctx.query.mode : marketModes.DEFAULT_MODE;
  const market = await loadMarket(mode);
  const { signals, summary } = await loadSignals(mode, true);
  sendSse(ctx.res, 200);
  sendEvent(ctx.res, 'hello', { ts: Date.now() });
  sendEvent(ctx.res, 'market', {
    prices: market.prices, stats24h: market.stats24h,
    global: market.global, listings: market.listings, ts: Date.now(), mode,
  });
  sendEvent(ctx.res, 'signals', { signals, summary, ts: Date.now(), mode });
  ctx.res.end();
});

// ---- static files ----
function serveStatic(req, res) {
  const pathname = decodeURIComponent(String(req.path || req.url || '/').split('?')[0]);
  let rel = pathname === '/' ? '/index.html' : pathname;
  if (rel.startsWith('/api/')) return false;
  const abs = path.normalize(path.join(PUBLIC_DIR, '.' + rel));
  if (!abs.startsWith(PUBLIC_DIR)) return false;
  let data;
  try { data = fs.readFileSync(abs); } catch { return false; }
  const ext = path.extname(abs).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'Content-Length': data.length,
  });
  res.end(data);
  return true;
}

// ------------------------------------------------------------------ entry point
module.exports = async (req, res) => {
  try {
    const qs = req.query
      ? new URLSearchParams(req.query).toString()
      : (String(req.url || '').includes('?') ? String(req.url).split('?')[1] || '' : '');
    req.url = (req.path || (req.url && req.url.split('?')[0]) || '/') + (qs ? '?' + qs : '');

    const match = router.match(req);
    const ctx = { req, res, params: match ? match.params : {}, query: match ? match.query : {}, body: null };
    if (!match) {
      if (!serveStatic(req, res)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
      }
      return;
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      // Vercel's Node runtime pre-parses JSON bodies into req.body.
      ctx.body = (req.body && typeof req.body === 'object' && Object.keys(req.body).length > -1)
        ? req.body
        : await readJsonBody(req);
    }
    await match.handler(ctx);
  } catch (err) {
    console.error('[serverless]', String(err && err.message));
    if (!res.headersSent) {
      const body = JSON.stringify({ error: String(err && err.message || 'Internal error') });
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    } else {
      try { res.end(); } catch { /* ignore */ }
    }
  }
};
