'use strict';

// Real market data layer.
// Source: Binance public market data API (no API key required).
const BASE = 'https://data-api.binance.vision';

// Symbols tracked by the MI engine.
const DEFAULT_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT',
  'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT', 'LTCUSDT',
  'BNBUSDT', 'POLUSDT',
];

const INTERVALS = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
};

const _klineCache = new Map();

async function fetchJson(path) {
  const url = BASE + path;
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`Binance API ${res.status} for ${url}`);
  return res.json();
}

function mapKline(k) {
  return {
    openTime: k[0],
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    volume: +k[5],
    closeTime: k[6],
  };
}

// Cached fetch of klines (invalidate before live refresh cycles).
async function getKlines(symbol, interval = '1h', limit = 200) {
  const key = symbol + '|' + interval + '|' + limit;
  if (_klineCache.has(key)) return _klineCache.get(key);
  const arr = await fetchJson(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  const data = arr.map(mapKline);
  _klineCache.set(key, data);
  return data;
}

function invalidateKlines(symbol) {
  for (const key of [..._klineCache.keys()]) {
    if (key.startsWith(symbol + '|')) _klineCache.delete(key);
  }
}

// Batch price fetch. Returns { BTCUSDT: 12345.67, ... }
async function getTickerPrices(symbols) {
  if (!symbols || symbols.length === 0) return {};
  const encoded = encodeURIComponent(JSON.stringify(symbols));
  const arr = await fetchJson(`/api/v3/ticker/price?symbols=${encoded}`);
  const out = {};
  for (const t of arr) out[t.symbol] = +t.price;
  return out;
}

// Batch 24h stats fetch. Returns { BTCUSDT: { priceChangePercent, high24h, low24h, quoteVolume, lastPrice, ... } }
async function get24hStats(symbols) {
  if (!symbols || symbols.length === 0) return {};
  const encoded = encodeURIComponent(JSON.stringify(symbols));
  const arr = await fetchJson(`/api/v3/ticker/24hr?symbols=${encoded}`);
  const out = {};
  for (const t of arr) {
    out[t.symbol] = {
      priceChange: +t.priceChange,
      priceChangePercent: +t.priceChangePercent,
      high24h: +t.highPrice,
      low24h: +t.lowPrice,
      volume: +t.volume,
      quoteVolume: +t.quoteVolume,
      lastPrice: +t.lastPrice,
    };
  }
  return out;
}

module.exports = { DEFAULT_SYMBOLS, INTERVALS, getKlines, getTickerPrices, get24hStats, invalidateKlines };