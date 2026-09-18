'use strict';

const { loadEnv } = require('./config');
loadEnv();

const path = require('path');
const { createServer, Router, readJsonBody, sendJson, decorateRes, serveStatic } = require('./httpkit');

const Store = require('./store');
const binance = require('./binance');
const cmc = require('./coinmarketcap');
const signalEngine = require('./signalEngine');
const PaperEngine = require('./paper');
const Alerts = require('./alerts');
const ai = require('./ai');
const timing = require('./timing');
const push = require('./push');
const marketModes = require('./marketModes');
const fx = require('./fx');
const Accuracy = require('./accuracy');
const backtest = require('./backtest');
const sentimentApi = require('./sentiment');
const calendarApi = require('./calendar');

const PORT = process.env.PORT || 3009;
const API_KEY = process.env.OPENROUTER_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'openai/gpt-4o-mini';
const SIGNAL_INTERVAL = Number(process.env.SIGNAL_INTERVAL_MS) || 60000;
const TICKER_INTERVAL = Number(process.env.TICKER_INTERVAL_MS) || 5000;

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const store = new Store().load();

// ---------------------------------------------------------------- SSE hub
const clients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
  for (const res of [...clients]) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
  // 🔔 Forward in-app notifications to the user's DEVICE (Web Push) so they
  // arrive even when the app is closed.
  if (event === 'notification' && data && typeof data === 'object' && data.title) {
    push.notifyAll(store.data.pushSubscriptions || [], {
      title: data.title,
      body: data.body || '',
      url: '/',
      tag: 'mi-' + (data.type || 'notif'),
    }).then((r) => {
      if (r.dead && r.dead.length) {
        const deadSet = new Set(r.dead);
        store.data.pushSubscriptions = (store.data.pushSubscriptions || []).filter(s => !deadSet.has(s.endpoint));
        store.save(true);
      }
    }).catch((e) => console.error('[push]', e.message));
  }
}

// ---- signal history — persisted locally until the user deletes it ----
const lastSignalState = new Map();
function recordSignalHistory(analyses) {
  for (const a of analyses) {
    if (!a || a.action === 'HOLD' || a.action === 'NEUTRAL') continue;
    const stateKey = a.action + '|' + a.quality + '|' + a.confidence;
    if (lastSignalState.get(a.symbol) === stateKey) continue; // unchanged verdict
    lastSignalState.set(a.symbol, stateKey);
    store.data.signalHistory.push({
      id: a.symbol + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e4),
      ts: Date.now(),
      symbol: a.symbol,
      asset: a.asset,
      action: a.action,
      confidence: a.confidence,
      price: a.price,
      takeProfit: a.takeProfit,
      stopLoss: a.stopLoss,
      riskReward: a.riskReward,
      quality: a.quality,
      score: a.score,
      trend: a.trend,
    });
  }
  if (store.data.signalHistory.length > 500) {
    store.data.signalHistory.splice(0, store.data.signalHistory.length - 500);
  }
  store.save();
}

// ---------------------------------------------------------------- live state
// The app runs in three modes (crypto | pocket | forex), each with its own
// market state so switching modes keeps previously-fetched data warm.
let CURRENT_MODE = process.env.MI_MODE || marketModes.DEFAULT_MODE;
if (!marketModes.isValid(CURRENT_MODE)) CURRENT_MODE = marketModes.DEFAULT_MODE;

function newModeState() {
  return {
    prices: {},
    stats24h: {},
    global: null,
    listings: [],
    signals: [],
    summary: null,
    health: {
      dataSource: 'starting',
      lastTicker: 0,
      lastSignals: 0,
      providers: { coinmarketcap: false, binance: false },
    },
  };
}
const modeStates = {};
function getModeState() {
  if (!modeStates[CURRENT_MODE]) modeStates[CURRENT_MODE] = newModeState();
  return modeStates[CURRENT_MODE];
}
let market = getModeState();

const paper = new PaperEngine(store, broadcast);
const alerts = new Alerts(store, broadcast);
const accuracy = new Accuracy(store);
let calendarWarned = new Set(); // debounce economic-calendar notifications

// Notify once per high-impact event arriving within the next 12 hours.
async function warnHighImpact() {
  try {
    const cal = await calendarApi.getCalendar();
    for (const ev of (cal.imminentHigh || [])) {
      const key = ev.title + '|' + ev.time;
      if (!calendarWarned.has(key)) {
        calendarWarned.add(key);
        const hm = new Date(ev.time).getUTCHours().toString().padStart(2, '0') +
          ':' + new Date(ev.time).getUTCMinutes().toString().padStart(2, '0');
        alerts.addNotification(
          'calendar',
          '🕐 High-impact news in the next 12h',
          `${ev.title} (${ev.country}) at ${hm} UTC — expect volatility. Consider smaller size or waiting.`,
          { source: 'calendar', time: ev.time }
        );
      }
    }
    if (calendarWarned.size > 40) calendarWarned = new Set([...calendarWarned].slice(-30));
  } catch { /* calendar optional */ }
}

// ---------------------------------------------------------------- data loops
async function refreshMarket() {
  const mode = CURRENT_MODE;
  const st = getModeState();
  try {
    let prices, stats24h, global, listings, source;
    if (mode === 'crypto') {
      try {
        const overview = await cmc.getMarketOverview(100);
        prices = overview.prices;
        stats24h = overview.stats24h;
        global = overview.global;
        listings = overview.listings;
        st.health.providers.coinmarketcap = true;
        source = 'coinmarketcap';
      } catch (cmcErr) {
        console.error('[ticker][cmc]', cmcErr.message);
        st.health.providers.coinmarketcap = false;
        const fallback = await Promise.all([
          binance.getTickerPrices(binance.DEFAULT_SYMBOLS),
          binance.get24hStats(binance.DEFAULT_SYMBOLS),
        ]);
        prices = fallback[0];
        stats24h = fallback[1];
        global = null;
        listings = [];
        source = 'binance-fallback';
      }
    } else {
      const r = await marketModes.getPrices(mode);
      prices = r.prices;
      stats24h = r.stats24h;
      global = null;
      listings = [];
      source = r.source || 'mixed';
    }

    st.prices = Object.assign({}, prices);
    st.stats24h = Object.assign({}, stats24h);
    st.global = global;
    st.listings = listings;
    st.health.providers.binance = true;
    st.health.lastTicker = Date.now();
    st.health.dataSource = source;
    accuracy.check(st.prices);
    broadcast('market', { prices: st.prices, stats24h: st.stats24h, global: st.global, listings: st.listings, ts: Date.now(), mode });
    if (mode === 'crypto') paper.integrate(st.signals, st.prices);
  } catch (err) {
    st.health.dataSource = 'error';
    console.error('[ticker]', err.message);
  }
}

async function refreshSignals() {
  const mode = CURRENT_MODE;
  const st = getModeState();
  try {
    const mCfg = marketModes.MODES[mode] || marketModes.MODES.crypto;
    const interval = mCfg.klineInterval;
    const analyses = [];
    for (const symbol of mCfg.symbols) {
      try {
        let klines;
        if (fx.isFxCandidate(symbol)) klines = await fx.getKlines(symbol, interval, 200);
        else klines = await binance.getKlines(symbol, interval, 200);
        const opts = { mode };
        if ((mode === 'forex' || mode === 'pocket') && fx.isFxCandidate(symbol)) {
          opts.precision = fx.precision(symbol);
          opts.pip = fx.pipSize(symbol);
        }
        const analysis = signalEngine.analyzeSymbol(symbol, klines, opts);
        if (analysis) analyses.push(analysis);
      } catch (e) {
        console.warn('[signals] skip', symbol, e.message);
      }
    }
    st.signals = analyses;
    st.summary = signalEngine.summarize(analyses);
    recordSignalHistory(analyses);
    for (const a of analyses) accuracy.observe(a);
    st.health.lastSignals = Date.now();
    broadcast('signals', { signals: analyses, summary: st.summary, ts: Date.now(), mode });

    // Signals → notifications for EVERY mode, so high-conviction calls in
    // pocket/forex also trigger in-app + device (Web Push) notifications even
    // when the app is closed.
    alerts.check(st.prices, analyses);
    if (mode === 'crypto') {
      paper.integrate(analyses, st.prices);
    }

    for (const symbol of mCfg.symbols) {
      if (!fx.isFxCandidate(symbol)) binance.invalidateKlines(symbol);
    }
  } catch (err) {
    console.error('[signals]', err.message);
  }
}

// ---------------------------------------------------------------- router
const router = new Router();

router.get('/api/health', (ctx) => {
  ctx.res.sendJson(200, {
    status: 'ok',
    version: '6.0.0',
    mode: CURRENT_MODE,
    source: 'CoinMarketCap + Binance + Yahoo Finance public market data',
    marketSource: market.health.dataSource,
    providers: market.health.providers,
    aiModel: AI_MODEL,
    aiEnabled: !!API_KEY,
    cmcKeyConfigured: !!process.env.CMC_API_KEY,
    market: market.health,
    ts: Date.now(),
  });
});

router.get('/api/config', (ctx) => {
  const queryMode = ctx.query.mode;
  const mode = marketModes.isValid(queryMode) ? queryMode : CURRENT_MODE;
  ctx.res.sendJson(200, {
    symbols: marketModes.getSymbols(mode),
    intervals: Object.keys(binance.INTERVALS),
    aiModel: AI_MODEL,
    aiEnabled: !!API_KEY,
    dataSource: 'CoinMarketCap (prices + market data) + Binance (candles) + Yahoo Finance (FX)',
    cmcKeyConfigured: !!process.env.CMC_API_KEY,
    mode: CURRENT_MODE,
    modes: Object.keys(marketModes.MODES).map(k => ({
      id: k,
      label: marketModes.MODES[k].label,
      icon: marketModes.MODES[k].icon,
      description: marketModes.MODES[k].description,
      symbols: marketModes.MODES[k].symbols,
    })),
  });
});

// Switch the whole dashboard between Crypto / Pocket Option / Forex modes.
router.post('/api/mode', (ctx) => {
  const next = ctx.body && ctx.body.mode;
  if (!marketModes.isValid(next)) return ctx.res.sendJson(400, { error: 'Invalid mode. Use: crypto | pocket | forex' });
  if (next !== CURRENT_MODE) {
    CURRENT_MODE = next;
    market = getModeState();
    // Warm the new mode immediately (state is kept per mode, so switching
    // back is instant).
    refreshMarket();
    refreshSignals();
    broadcast('mode', { mode: CURRENT_MODE, ts: Date.now() });
  }
  ctx.res.sendJson(200, {
    ok: true,
    mode: CURRENT_MODE,
    symbols: marketModes.getSymbols(CURRENT_MODE),
    modes: Object.keys(marketModes.MODES).map(k => ({ id: k, label: marketModes.MODES[k].label, icon: marketModes.MODES[k].icon })),
  });
});

router.get('/api/market', (ctx) => {
  ctx.res.sendJson(200, {
    prices: market.prices,
    stats24h: market.stats24h,
    global: market.global,
    listings: market.listings,
    ts: Date.now(),
  });
});

// CoinMarketCap-style ranked market overview (top 100 coins).
router.get('/api/market/ranking', (ctx) => {
  const limit = Math.min(Number(ctx.query.limit) || 100, 200);
  ctx.res.sendJson(200, {
    global: market.global,
    listings: market.listings.slice(0, limit),
    source: 'coinmarketcap',
    ts: Date.now(),
  });
});

router.get('/api/market/klines', async (ctx) => {
  const symbol = String(ctx.query.symbol || 'BTCUSDT').toUpperCase();
  const interval = ctx.query.interval || '15m';
  const limit = Number(ctx.query.limit) || 300;
  const mode = marketModes.isValid(ctx.query.mode) ? ctx.query.mode : CURRENT_MODE;
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
    ctx.res.sendJson(200, {
      symbol,
      interval,
      mode,
      candles,
      source,
    });
  } catch (err) {
    ctx.res.sendJson(502, { error: err.message });
  }
});

router.get('/api/signals', (ctx) => {
  ctx.res.sendJson(200, { signals: market.signals, summary: market.summary, ts: Date.now() });
});

// ---------------------------------------------------------------- signal history (stored locally until deleted)
// NOTE: registered BEFORE /api/signals/:symbol so it isn't shadowed by the param route.
router.get('/api/signals/history', (ctx) => {
  ctx.res.sendJson(200, {
    history: store.data.signalHistory.slice().sort((a, b) => b.ts - a.ts).slice(0, 200),
    stored: true, // persisted in data/db.json until the user deletes it
  });
});
router.delete('/api/signals/history', (ctx) => {
  store.data.signalHistory = [];
  lastSignalState.clear();
  store.save(true);
  ctx.res.sendJson(200, { ok: true });
});
router.get('/api/signals/:symbol', (ctx) => {
  const symbol = String(ctx.params.symbol || '').toUpperCase();
  const sig = market.signals.find(s => s.symbol === symbol) || null;
  ctx.res.sendJson(200, { signal: sig, price: market.prices[symbol] || null });
});

router.get('/api/paper', (ctx) => {
  ctx.res.sendJson(200, {
    stats: paper.stats(market.prices),
    positions: paper.positions,
    history: paper.history.slice(-50),
  });
});
// One-click manual paper trade from the signal panel (BUY/SELL only).
router.post('/api/paper', (ctx) => {
  try {
    const symbol = String((ctx.body && ctx.body.symbol) || '').toUpperCase();
    const sig = market.signals.find(s => s.symbol === symbol);
    if (!sig || sig.action === 'HOLD' || sig.action === 'NEUTRAL') {
      return ctx.res.sendJson(400, { error: 'No actionable signal for ' + symbol });
    }
    if (market.health.dataSource === 'starting' || !market.prices[symbol]) {
      return ctx.res.sendJson(400, { error: 'Live price not ready for ' + symbol });
    }
    const ok = paper.openManual(sig, Date.now());
    ctx.res.sendJson(ok ? 200 : 409, ok ? { ok: true } : { error: 'A paper position is already open on ' + symbol });
  } catch (err) {
    ctx.res.sendJson(400, { error: err.message });
  }
});

// ---------------------------------------------------------------- alerts API
router.get('/api/alerts', (ctx) => {
  ctx.res.sendJson(200, { alerts: alerts.list().slice(0, 40) });
});

router.post('/api/alerts', async (ctx) => {
  try {
    const created = alerts.add(ctx.body || {});
    ctx.res.sendJson(200, { alert: created });
  } catch (err) {
    ctx.res.sendJson(400, { error: err.message });
  }
});

router.delete('/api/alerts/:id', (ctx) => {
  ctx.res.sendJson(200, { ok: alerts.remove(ctx.params.id) });
});

// ---------------------------------------------------------------- notifications API
router.get('/api/notifications', (ctx) => {
  ctx.res.sendJson(200, { notifications: alerts.notifications() });
});

router.post('/api/notifications/read-all', (ctx) => {
  alerts.markAllRead();
  ctx.res.sendJson(200, { ok: true });
});

router.delete('/api/notifications', (ctx) => {
  alerts.clearAll();
  ctx.res.sendJson(200, { ok: true });
});
// ---------------------------------------------------------------- web push (outside-the-app notifications)
router.get('/api/push/vapid', (ctx) => {
  ctx.res.sendJson(200, { publicKey: push.getPublicKey() });
});
router.get('/api/push/status', (ctx) => {
  ctx.res.sendJson(200, {
    enabled: (store.data.pushSubscriptions || []).length > 0,
    count: (store.data.pushSubscriptions || []).length,
    supported: true,
  });
});
router.post('/api/push/subscribe', (ctx) => {
  try {
    const { endpoint, keys, userAgent } = ctx.body || {};
    if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
      return ctx.res.sendJson(400, { error: 'endpoint + keys.p256dh + keys.auth required' });
    }
    const sub = { endpoint: String(endpoint), keys: { p256dh: String(keys.p256dh), auth: String(keys.auth) }, userAgent: userAgent || '', createdAt: Date.now() };
    const subs = store.data.pushSubscriptions || [];
    const idx = subs.findIndex(s => s.endpoint === sub.endpoint);
    if (idx !== -1) subs[idx] = Object.assign(subs[idx], sub);
    else subs.push(sub);
    while (subs.length > 20) subs.shift(); // keep the store tidy
    store.save(true);
    ctx.res.sendJson(200, { ok: true, count: subs.length });
  } catch (err) {
    ctx.res.sendJson(400, { error: err.message });
  }
});
router.post('/api/push/unsubscribe', (ctx) => {
  const { endpoint } = ctx.body || {};
  const subs = store.data.pushSubscriptions || [];
  const before = subs.length;
  store.data.pushSubscriptions = subs.filter(s => s.endpoint !== endpoint);
  if (store.data.pushSubscriptions.length !== before) store.save(true);
  ctx.res.sendJson(200, { ok: true });
});
router.post('/api/push/test', async (ctx) => {
  try {
    const r = await push.notifyAll(store.data.pushSubscriptions || [], {
      title: 'MI test push',
      body: 'Device notifications are working ✅',
      tag: 'mi-test',
      url: '/',
    });
    ctx.res.sendJson(200, { ok: true, delivered: r.delivered, dead: r.dead.length });
  } catch (err) {
    ctx.res.sendJson(502, { error: err.message });
  }
});
// ---------------------------------------------------------------- AI chat (streaming SSE)
router.post('/api/chat', async (ctx) => {
  const history = Array.isArray(ctx.body && ctx.body.messages)
    ? ctx.body.messages.filter(m => m && m.role && typeof m.content === 'string')
    : [];
  if (history.length === 0) {
    return ctx.res.sendJson(400, { error: 'messages[] is required' });
  }
  if (!API_KEY) {
    return ctx.res.sendJson(503, { error: 'OpenRouter API key is not configured. Add OPENROUTER_API_KEY to the .env file and restart the server.' });
  }

  // Optional image uploads (vision models) + audience level.
  const images = Array.isArray(ctx.body && ctx.body.images)
    ? ctx.body.images.filter(img => img && typeof img.dataUrl === 'string' && img.dataUrl.length < 3_000_000).slice(-3)
    : [];
  const audience = String(ctx.body && ctx.body.level || 'balanced');
  const userProfile = (ctx.body && ctx.body.profile) || null;
  const timingSymbol = String(ctx.body && ctx.body.timingSymbol || 'BTCUSDT');
  const focusSymbol = history.length && typeof history[history.length - 1].content === 'string'
    ? (String(history[history.length - 1].content).match(/\b(BTCUSDT|ETHUSDT|SOLUSDT|XRPUSDT|ADAUSDT|DOGEUSDT|AVAXUSDT|LINKUSDT|DOTUSDT|LTCUSDT|BNBUSDT|POLUSDT)\b/) || [null, timingSymbol])[1]
    : timingSymbol;

  let tradeTiming = null;
  try { tradeTiming = await timing.getTiming(focusSymbol); } catch { /* timing is optional */ }
  let sentiment = null, calendar = null;
  try { sentiment = await sentimentApi.getSentiment(); } catch { /* optional */ }
  try { calendar = await calendarApi.getCalendar(); } catch { /* optional */ }

  const context = {
    prices: market.prices,
    stats24h: market.stats24h,
    summary: market.summary,
    globalMetrics: market.global,
    marketRanking: market.listings.slice(0, 25).map(l => ({
      rank: l.rank, symbol: l.symbol, name: l.name, price: l.price,
      marketCap: l.marketCap, percentChange24h: l.percentChange24h,
    })),
    signals: market.signals.map(s => ({
      symbol: s.symbol, asset: s.asset, action: s.action, confidence: s.confidence,
      price: s.price, entry: s.entry, takeProfit: s.takeProfit, stopLoss: s.stopLoss,
      riskReward: s.riskReward, trend: s.trend, rsi: s.rsi, score: s.score,
    })),
    paperTrading: paper.stats(market.prices),
    audience,
    tradeTiming,
    sentiment,
    userProfile,
    economicCalendar: calendar ? {
      source: calendar.source,
      high: (calendar.high || []).slice(0, 10).map(e => ({ title: e.title, country: e.country, time: e.time, impact: e.impact })),
      imminentHigh: (calendar.imminentHigh || []).slice(0, 4).map(e => ({ title: e.title, country: e.country, time: e.time })),
    } : null,
  };
  const res = ctx.res;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: start\ndata: ${JSON.stringify({ ts: Date.now(), model: AI_MODEL, hasImages: images.length })}\n\n`);

  try {
    const nodeStream = await ai.streamChat({ messages: history, context, model: AI_MODEL, apiKey: API_KEY, images });
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
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
            res.write(`data: ${JSON.stringify({ delta: delta.content })}\n\n`);
          }
        } catch { /* partial line */ }
      }
    }
    res.write('event: done\ndata: {}\n\n');
  } catch (err) {
    console.error('[chat]', err.message);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  }
  res.end();
});

// ---------------------------------------------------------------- trade timing
router.get('/api/timing', async (ctx) => {
  const symbol = String(ctx.query.symbol || 'BTCUSDT').toUpperCase();
  try {
    const data = await timing.getTiming(symbol);
    ctx.res.sendJson(200, data);
  } catch (err) {
    ctx.res.sendJson(502, { error: err.message });
  }
});

// ---------------------------------------------------------------- signal accuracy & backtest
router.get('/api/accuracy', (ctx) => {
  ctx.res.sendJson(200, { stats: accuracy.stats(), history: accuracy.history() });
});
router.delete('/api/accuracy', (ctx) => {
  accuracy.clear();
  ctx.res.sendJson(200, { ok: true });
});
router.get('/api/backtest', async (ctx) => {
  try {
    const symbol = String(ctx.query.symbol || 'BTCUSDT');
    const mode = ctx.query.mode || CURRENT_MODE;
    const interval = ctx.query.interval || '1h';
    const bars = Number(ctx.query.bars) || 720;
    const result = await backtest.runBacktest({ symbol, mode, interval, bars });
    ctx.res.sendJson(200, result);
  } catch (err) {
    ctx.res.sendJson(502, { error: err.message });
  }
});

// ---------------------------------------------------------------- market sentiment & economic calendar
router.get('/api/sentiment', async (ctx) => {
  try { ctx.res.sendJson(200, await sentimentApi.getSentiment()); }
  catch (err) { ctx.res.sendJson(502, { error: err.message }); }
});
router.get('/api/calendar', async (ctx) => {
  try { ctx.res.sendJson(200, await calendarApi.getCalendar()); }
  catch (err) { ctx.res.sendJson(502, { error: err.message }); }
});

// ---------------------------------------------------------------- signal accuracy & backtest
router.get('/api/accuracy', (ctx) => {
  ctx.res.sendJson(200, { stats: accuracy.stats(), history: accuracy.history() });
});
router.delete('/api/accuracy', (ctx) => {
  accuracy.clear();
  ctx.res.sendJson(200, { ok: true });
});
router.get('/api/backtest', async (ctx) => {
  try {
    const symbol = String(ctx.query.symbol || 'BTCUSDT');
    const mode = ctx.query.mode || CURRENT_MODE;
    const interval = ctx.query.interval || '1h';
    const bars = Number(ctx.query.bars) || 720;
    const result = await backtest.runBacktest({ symbol, mode, interval, bars });
    ctx.res.sendJson(200, result);
  } catch (err) {
    ctx.res.sendJson(502, { error: err.message });
  }
});

// ---------------------------------------------------------------- sentiment & economic calendar
router.get('/api/sentiment', async (ctx) => {
  try { ctx.res.sendJson(200, await sentimentApi.getSentiment()); }
  catch (err) { ctx.res.sendJson(502, { error: err.message }); }
});
router.get('/api/calendar', async (ctx) => {
  try { ctx.res.sendJson(200, await calendarApi.getCalendar()); }
  catch (err) { ctx.res.sendJson(502, { error: err.message }); }
});

// ---------------------------------------------------------------- SSE live feed
router.get('/api/events', (ctx) => {
  const res = ctx.res;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
  clients.add(res);
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* dead */ }
  }, 25000);
  ctx.req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

// ---------------------------------------------------------------- auth
router.post('/api/login', (ctx) => {
  const pass = String((ctx.body && ctx.body.password) || '');
  const expected = process.env.MI_PASSWORD || 'Admin2026';
  if (pass === expected) return ctx.res.sendJson(200, { ok: true });
  return ctx.res.sendJson(401, { error: 'Invalid password' });
});

// ---------------------------------------------------------------- router
const server = createServer(async (req, res) => {
  decorateRes(res);
  const match = router.match(req);
  if (!match) {
    const served = serveStatic(req, res, PUBLIC_DIR);
    if (!served && !res.headersSent) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
    return;
  }
  const ctx = { req, res, params: match.params, query: match.query, body: null };
  try {
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
      ctx.body = await readJsonBody(req);
    }
    await match.handler(ctx);
  } catch (err) {
    console.error('[route]', req.method, req.url, err.message);
    if (!res.headersSent) res.sendJson(500, { error: err.message });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log('\n\ud83c\udfe6  MI — Master Intelligence Trading Suite');
  console.log('   ➜ Local:   http://localhost:' + PORT);
  console.log('   ➜ Source:  ' + cmc.TRACKED.length + ' assets via CoinMarketCap (prices/market) + Binance (chart candles)');
  console.log('   ➜ CMC key: ' + (process.env.CMC_API_KEY ? 'configured (authenticated endpoints enabled)' : 'keyless public API (free tier)'));
  console.log('   ➜ AI:      ' + AI_MODEL + ' ' + (API_KEY ? '(enabled)' : '(NOT CONFIGURED — add OPENROUTER_API_KEY to .env)'));
  refreshMarket();
  setTimeout(refreshSignals, 1000);
  setInterval(refreshMarket, TICKER_INTERVAL);
  setInterval(refreshSignals, SIGNAL_INTERVAL);
  setInterval(() => alerts.check(market.prices, market.signals), 10000);
  setInterval(() => accuracy.check(getModeState().prices), 10000);
  warnHighImpact();
  setInterval(warnHighImpact, 15 * 60 * 1000);
});