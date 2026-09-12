'use strict';

// MI Trade Timing Engine
// ----------------------------------------------------------------------------
// Determines the best hours + days to trade from REAL market data: it analyses
// recent 1-hour candles per symbol, measuring average intra-hour volatility
// (range %) and volume across each UTC hour and weekday. Windows with the
// highest typical activity are ranked as the best moments to trade.

const binance = require('./binance');

const _cache = new Map(); // symbol -> { data, ts }

function cacheGet(symbol) {
  const e = _cache.get(symbol);
  return e && Date.now() - e.ts < 60 * 60 * 1000 ? e.v : null; // refresh hourly
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Analyse candles → hour ranking + weekday ranking.
function analyse(candles) {
  const hours = new Map(); // hour -> { n, rangeSum, volSum }
  const days = new Map();  // weekday -> { n, rangeSum }

  for (const c of candles) {
    const t = new Date(c.openTime);
    const hour = t.getUTCHours();
    const weekday = t.getUTCDay(); // 0 = Sunday
    const open = c.open || c.close || 1;
    const rangePct = Math.abs((c.high - c.low) / open) * 100;

    const h = hours.get(hour) || { n: 0, rangeSum: 0, volSum: 0 };
    h.n += 1;
    h.rangeSum += rangePct;
    h.volSum += c.volume || 0;
    hours.set(hour, h);

    const d = days.get(weekday) || { n: 0, rangeSum: 0 };
    d.n += 1;
    d.rangeSum += rangePct;
    days.set(weekday, d);
  }

  const hourArr = [];
  for (let h = 0; h < 24; h++) {
    if (!hours.has(h)) continue;
    const e = hours.get(h);
    hourArr.push({
      hour: h,
      label: String(h).padStart(2, '0') + ':00',
      utcRangePct: clamp(e.rangeSum / e.n, 0, 100),
      samples: e.n,
      volFlow: e.n ? e.volSum / e.n : 0,
    });
  }
  hourArr.sort((a, b) => b.utcRangePct - a.utcRangePct);

  const dayArr = [];
  for (let d = 0; d < 7; d++) {
    if (!days.has(d)) continue;
    const e = days.get(d);
    dayArr.push({
      day: d,
      label: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d],
      utcRangePct: clamp(e.rangeSum / e.n, 0, 100),
      samples: e.n,
    });
  }
  dayArr.sort((a, b) => b.utcRangePct - a.utcRangePct);

  return {
    bestHours: hourArr.slice(0, 5).map(e => ({
      hour: e.hour, label: e.label, utcRangePct: e.utcRangePct,
      volFlow: Math.round(e.volFlow), samples: e.samples,
    })),
    quietHours: hourArr.slice(-4).map(e => e.label),
    bestDays: dayArr.slice(0, 3).map(e => ({ label: e.label, utcRangePct: e.utcRangePct, samples: e.samples })),
    sampleCount: candles.length,
  };
}

async function getTiming(symbol) {
  symbol = String(symbol || 'BTCUSDT').toUpperCase();
  const cached = cacheGet(symbol);
  if (cached) return { symbol, ...cached };

  const klines = await binance.getKlines(symbol, '1h', 260); // ~ last 10 days
  if (!klines || klines.length < 48) {
    throw new Error('Not enough hourly data for ' + symbol);
  }
  const data = analyse(klines);
  const result = {
    symbol,
    generatedAt: new Date().toISOString(),
    sampleDays: Math.round(klines.length / 24),
    candleCount: klines.length,
    ...data,
  };
  _cache.set(symbol, { v: result, ts: Date.now() });
  return result;
}

module.exports = { getTiming, analyse };