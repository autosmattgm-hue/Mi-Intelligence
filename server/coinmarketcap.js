'use strict';

// CoinMarketCap real market-data layer.
//
// Sources (all real, no simulated data):
//   - Keyless public API: /public-api/v1/cryptocurrency/listings/latest
//                         /public-api/v1/global-metrics/quotes/latest
//                         /public-api/v1/cryptocurrency/map
//   - If CMC_API_KEY is set: authenticated /v1/... endpoints for richer quotes
//     and historical OHLCV candles.
//
// CoinMarketCap's keyless surface does NOT expose OHLCV candles, so chart
// candles come from the Binance public market API (real exchange data). When
// CMC_API_KEY is set, OHLCV is served by CoinMarketCap where supported.

const BASE = 'https://pro-api.coinmarketcap.com';

// Symbols tracked by the MI engine (Binance-style base+QUOTE). CMC identifies
// assets by base symbol, so we map CMC base symbol -> "XXXUSDT".
const TRACKED = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT',
  'AVAXUSDT', 'LINKUSDT', 'DOTUSDT', 'LTCUSDT', 'BNBUSDT', 'POLUSDT',
];

const API_KEY = process.env.CMC_API_KEY || '';

const _cache = new Map();

function cacheGet(key, ttl) {
  const e = _cache.get(key);
  return e && Date.now() - e.ts < ttl ? e.v : null;
}
function cacheSet(key, v) { _cache.set(key, { v, ts: Date.now() }); }

// When a CMC Pro key is configured we use the authenticated /v1/ endpoints
// (they need X-CMC_PRO_API_KEY). When no key is set we use the keyless
// /public-api/ endpoints (they REJECT the auth header).
async function fetchJson(path, { ttl = 55000, useCache = true } = {}) {
  const keyPath = path;
  if (useCache) {
    const hit = cacheGet(keyPath, ttl);
    if (hit) return hit;
  }
  const headers = { Accept: 'application/json' };
  if (API_KEY) headers['X-CMC_PRO_API_KEY'] = API_KEY;
  const res = await fetch(BASE + path, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('CoinMarketCap API ' + res.status + ' for ' + path);
  const data = await res.json();
  if (data.status && data.status.error_message) {
    throw new Error('CoinMarketCap: ' + data.status.error_message);
  }
  if (useCache) cacheSet(keyPath, data);
  return data;
}

function baseSymbol(symbol) { return String(symbol || '').replace(/USDT$/, ''); }

// Choose endpoint prefix: authenticated /v1/ when a key is configured,
// keyless /public-api/ when not.
function ep(endpoint) {
  return API_KEY ? '/v1' + endpoint : '/public-api/v1' + endpoint;
}

// -------------------------------------------------------------------------
// Top-100 listings. Real aggregate market data from CMC.
async function getListings(limit = 120) {
  const json = await fetchJson(
    ep('/cryptocurrency/listings/latest?start=1&limit=' + limit + '&convert=USD'),
    { ttl: 55000 }
  );
  return (json && json.data) || [];
}

// Map of base symbol -> normalized listing entry.
async function getListingMap() {
  const listings = await getListings(120);
  const map = {};
  for (const item of listings) {
    const q = item.quote && item.quote.USD;
    if (!q) continue;
    map[item.symbol] = {
      symbol: item.symbol,
      name: item.name,
      rank: item.cmc_rank,
      price: q.price,
      volume24h: q.volume_24h,
      percentChange1h: q.percent_change_1h,
      percentChange24h: q.percent_change_24h,
      percentChange7d: q.percent_change_7d,
      percentChange30d: q.percent_change_30d,
      marketCap: q.market_cap,
      dominance: q.market_cap_dominance,
      circulatingSupply: item.circulating_supply,
      totalSupply: item.total_supply,
      maxSupply: item.max_supply,
      lastUpdated: q.last_updated,
    };
  }
  return map;
}

// Normalized, ranked array (same shape as getListingMap values).
async function getRankings(limit = 100) {
  const map = await getListingMap();
  return Object.values(map)
    .sort((a, b) => (a.rank || 0) - (b.rank || 0))
    .slice(0, limit);
}

// Live prices for tracked symbols -> { BTCUSDT: 12345.67 }
async function getMarketPrices(symbols) {
  symbols = symbols || TRACKED;
  const map = await getListingMap();
  const out = {};
  for (const sym of symbols) {
    const e = map[baseSymbol(sym)];
    if (e && e.price != null) out[sym] = e.price;
  }
  return out;
}

// 24h-style stats for tracked symbols -> { BTCUSDT: { priceChangePercent, quoteVolume, ... } }
async function getMarketStats(symbols) {
  symbols = symbols || TRACKED;
  const map = await getListingMap();
  const out = {};
  for (const sym of symbols) {
    const e = map[baseSymbol(sym)];
    if (!e) continue;
    out[sym] = {
      priceChangePercent: e.percentChange24h,
      percentChange1h: e.percentChange1h,
      percentChange7d: e.percentChange7d,
      percentChange30d: e.percentChange30d,
      quoteVolume: e.volume24h,
      marketCap: e.marketCap,
      marketCapDominance: e.dominance,
      rank: e.rank,
      price: e.price,
      symbol: e.symbol,
      name: e.name,
      lastUpdated: e.lastUpdated,
    };
  }
  return out;
}

// Global market metrics.
async function getGlobalMetrics() {
  const json = await fetchJson(ep('/global-metrics/quotes/latest?convert=USD'), { ttl: 55000 });
  const d = json && json.data;
  const u = d && d.quote && d.quote.USD;
  if (!u) throw new Error('CoinMarketCap global metrics unavailable');
  const g = {
    totalMarketCap: u.total_market_cap,
    totalVolume24h: u.total_volume_24h,
    totalMarketCapYesterday: u.total_market_cap_yesterday,
    marketCapChange24h: u.total_market_cap_yesterday_percentage_change,
    volumeChange24h: u.total_volume_24h_yesterday_percentage_change,
    altcoinMarketCap: u.altcoin_market_cap,
    altcoinVolume24h: u.altcoin_volume_24h,
    lastUpdated: d.last_updated || new Date().toISOString(),
  };
  // BTC/ETH dominance are not present in the keyless global-metrics payload,
  // but ARE present per-coin in the listings. Try to enrich from a cached map.
  try {
    const map = await getListingMap();
    if (!g.btcDominance && map.BTC) g.btcDominance = map.BTC.dominance;
    if (!g.ethDominance && map.ETH) g.ethDominance = map.ETH.dominance;
  } catch { /* optional enrichment */ }
  return g;
}

// Single-call market overview: one listings fetch + one global-metrics fetch,
// then derives prices, stats and the ranking array for the tracked symbols.
// Returns { prices, stats24h, global, listings }.
async function getMarketOverview(limit = 100) {
  const [global, map] = await Promise.all([getGlobalMetrics(), getListingMap()]);
  if (!global.btcDominance && map.BTC) global.btcDominance = map.BTC.dominance;
  if (!global.ethDominance && map.ETH) global.ethDominance = map.ETH.dominance;
  const prices = {};
  const stats24h = {};
  for (const sym of TRACKED) {
    const e = map[baseSymbol(sym)];
    if (!e) continue;
    if (e.price != null) prices[sym] = e.price;
    if (e) {
      stats24h[sym] = {
        priceChangePercent: e.percentChange24h,
        percentChange1h: e.percentChange1h,
        percentChange7d: e.percentChange7d,
        percentChange30d: e.percentChange30d,
        quoteVolume: e.volume24h,
        marketCap: e.marketCap,
        marketCapDominance: e.dominance,
        rank: e.rank,
        price: e.price,
        symbol: e.symbol,
        name: e.name,
        lastUpdated: e.lastUpdated,
      };
    }
  }
  const listings = Object.values(map)
    .sort((a, b) => (a.rank || 0) - (b.rank || 0))
    .slice(0, limit);
  return { prices, stats24h, global, listings };
}
// -------------------------------------------------------------------------
// OHLCV candles.
//   - Binance public API is the default (real exchange candles).
//   - When CMC_API_KEY is set, 1H and 1D candles come from CoinMarketCap
//     historical OHLCV, falling back to Binance if CMC is unavavaible.
const CMC_INTERVALS = { '1h': 'hourly', '1d': 'daily' };

async function getCmcId(base) {
  const key = 'id:' + base;
  const hit = cacheGet(key, 86400000);
  if (hit) return hit;
  let id = null;
  try {
    const json = await fetchJson(ep('/cryptocurrency/map?symbol=' + base), { ttl: 86400000 });
    if (json && json.data && json.data[0]) id = json.data[0].id;
  } catch { /* fall back to Binance */ }
  cacheSet(key, id);
  return id;
}

async function getBinanceKlines(symbol, interval) {
  const binance = require('./binance');
  return binance.getKlines(symbol, interval, 300);
}

async function getKlines(symbol, interval) {
  symbol = String(symbol || 'BTCUSDT').toUpperCase();
  const base = baseSymbol(symbol);
  if (API_KEY && CMC_INTERVALS[interval]) {
    try {
      const id = await getCmcId(base);
      if (id) {
        const json = await fetchJson(
          ep('/cryptocurrency/ohlcv/historical?id=' + id + '&time_period=' + CMC_INTERVALS[interval] + '&count=300&convert=USD'),
          { ttl: 300000, useCache: false }
        );
        const quotes = (json && json.data && json.data.quotes) || [];
        const candles = quotes
          .map(qi => {
            const u = qi && qi.quote && qi.quote.USD;
            if (!u) return null;
            return {
              openTime: Date.parse(qi.time_open || qi.time),
              open: u.open,
              high: u.high,
              low: u.low,
              close: u.close,
              volume: u.volume || 0,
              closeTime: Date.parse(qi.time_close || qi.time),
            };
          })
          .filter(c => c && c.openTime && c.close !== null && c.close !== undefined);
        if (candles.length > 20) return { source: 'coinmarketcap', candles };
      }
    } catch (err) {
      console.warn('[cmc-ohlcv] fallback to Binance:', err.message);
    }
  }
  const candles = await getBinanceKlines(symbol, interval);
  return { source: 'binance', candles };
}

module.exports = {
  TRACKED,
  baseSymbol,
  getListings,
  getListingMap,
  getRankings,
  getMarketPrices,
  getMarketStats,
  getGlobalMetrics,
  getMarketOverview,
  getKlines,
};