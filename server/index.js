'use strict';

const { loadEnv } = require('./config');
loadEnv();

const path = require('path');
const { createServer, Router, readJsonBody, sendJson, decorateRes, serveStatic } = require('./httpkit');

const Store = require('./store');
const binance = require('./binance');
const signalEngine = require('./signalEngine');
const PaperEngine = require('./paper');
const Alerts = require('./alerts');
const ai = require('./ai');

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
}

// ---------------------------------------------------------------- live state
const market = {
  prices: {},
  stats24h: {},
  signals: [],
  summary: null,
  health: { dataSource: 'starting', lastTicker: 0, lastSignals: 0 },
};

const paper = new PaperEngine(store, broadcast);
const alerts = new Alerts(store, broadcast);

// ---------------------------------------------------------------- data loops
async function refreshMarket() {
  try {
    const [prices, stats24h] = await Promise.all([
      binance.getTickerPrices(binance.DEFAULT_SYMBOLS),
      binance.get24hStats(binance.DEFAULT_SYMBOLS),
    ]);
    market.prices = Object.assign({}, prices);
    market.stats24h = Object.assign({}, stats24h);
    market.health.lastTicker = Date.now();
    market.health.dataSource = 'online';
    broadcast('market', { prices, stats24h, ts: Date.now() });
    paper.integrate(market.signals, market.prices);
  } catch (err) {
    market.health.dataSource = 'error';
    console.error('[ticker]', err.message);
  }
}

async function refreshSignals() {
  try {
    const analyses = [];
    for (const symbol of binance.DEFAULT_SYMBOLS) {
      try {
        const klines = await binance.getKlines(symbol, '15m', 200);
        const analysis = signalEngine.analyzeSymbol(symbol, klines);
        if (analysis) analyses.push(analysis);
      } catch (e) {
        console.warn('[signals] skip', symbol, e.message);
      }
    }
    market.signals = analyses;
    market.summary = signalEngine.summarize(analyses);
    market.health.lastSignals = Date.now();
    broadcast('signals', { signals: analyses, summary: market.summary, ts: Date.now() });

    alerts.check(market.prices, analyses);
    paper.integrate(analyses, market.prices);

    for (const symbol of binance.DEFAULT_SYMBOLS) binance.invalidateKlines(symbol);
  } catch (err) {
    console.error('[signals]', err.message);
  }
}

// ---------------------------------------------------------------- router
const router = new Router();

router.get('/api/health', (ctx) => {
  ctx.res.sendJson(200, {
    status: 'ok',
    version: '4.0.0',
    source: 'Binance public market data',
    aiModel: AI_MODEL,
    aiEnabled: !!API_KEY,
    market: market.health,
    ts: Date.now(),
  });
});

router.get('/api/config', (ctx) => {
  ctx.res.sendJson(200, {
    symbols: binance.DEFAULT_SYMBOLS,
    intervals: Object.keys(binance.INTERVALS),
    aiModel: AI_MODEL,
    aiEnabled: !!API_KEY,
    dataSource: 'Binance public market data',
  });
});

router.get('/api/market', (ctx) => {
  ctx.res.sendJson(200, { prices: market.prices, stats24h: market.stats24h, ts: Date.now() });
});

router.get('/api/market/klines', async (ctx) => {
  const symbol = String(ctx.query.symbol || 'BTCUSDT').toUpperCase();
  const interval = ctx.query.interval || '15m';
  const limit = Number(ctx.query.limit) || 300;
  try {
    const candles = await binance.getKlines(symbol, interval, limit);
    ctx.res.sendJson(200, { symbol, interval, candles });
  } catch (err) {
    ctx.res.sendJson(502, { error: err.message });
  }
});

router.get('/api/signals', (ctx) => {
  ctx.res.sendJson(200, { signals: market.signals, summary: market.summary, ts: Date.now() });
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

  const context = {
    prices: market.prices,
    stats24h: market.stats24h,
    summary: market.summary,
    signals: market.signals.map(s => ({
      symbol: s.symbol, asset: s.asset, action: s.action, confidence: s.confidence,
      price: s.price, entry: s.entry, takeProfit: s.takeProfit, stopLoss: s.stopLoss,
      riskReward: s.riskReward, trend: s.trend, rsi: s.rsi, score: s.score,
    })),
    paperTrading: paper.stats(market.prices),
  };
  const res = ctx.res;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: start\ndata: ${JSON.stringify({ ts: Date.now(), model: AI_MODEL })}\n\n`);

  try {
    const nodeStream = await ai.streamChat({ messages: history, context, model: AI_MODEL, apiKey: API_KEY });
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

// ---------------------------------------------------------------- HTTP server
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
  console.log('   ➜ Source:  ' + binance.DEFAULT_SYMBOLS.length + ' assets via Binance public market data');
  console.log('   ➜ AI:      ' + AI_MODEL + ' ' + (API_KEY ? '(enabled)' : '(NOT CONFIGURED — add OPENROUTER_API_KEY to .env)'));
  refreshMarket();
  setTimeout(refreshSignals, 1000);
  setInterval(refreshMarket, TICKER_INTERVAL);
  setInterval(refreshSignals, SIGNAL_INTERVAL);
  setInterval(() => alerts.check(market.prices, market.signals), 10000);
});