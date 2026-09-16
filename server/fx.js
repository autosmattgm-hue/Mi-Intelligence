'use strict';
// MI Forex & commodity data provider — Yahoo Finance public chart API (keyless).
// Returns OHLCV candles and live prices for FX pairs / gold / silver so the
// app can run Professional Forex mode and Pocket Option (binary) mode.

const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36' };

// MI symbol (EURUSD) -> Yahoo symbol (EURUSD=X).
// Includes FX majors, metals, oil and the stock indices Pocket Option trades
// (US500 S&P 500, USTEC Nasdaq 100, US30 Dow Jones).
const SYMBOL_MAP = {
  EURUSD: 'EURUSD=X', GBPUSD: 'GBPUSD=X', USDJPY: 'USDJPY=X', AUDUSD: 'AUDUSD=X',
  USDCHF: 'USDCHF=X', USDCAD: 'USDCAD=X', NZDUSD: 'NZDUSD=X', EURGBP: 'EURGBP=X',
  EURJPY: 'EURJPY=X', GBPJPY: 'GBPJPY=X', XAUUSD: 'GC=F', XAGUSD: 'SI=F',
  US500: '^GSPC', USTEC: '^NDX', US30: '^DJI', USOIL: 'CL=F',
};

const DEFAULT_SYMBOLS = Object.keys(SYMBOL_MAP);

const INTERVAL_MAP = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '60m', '1d': '1d' };
const RANGE_MAP = { '1m': '1d', '5m': '5d', '15m': '1mo', '30m': '1mo', '1h': '1mo', '4h': '3mo', '1d': '1mo' };

function toYahoo(symbol) {
  return SYMBOL_MAP[String(symbol).toUpperCase()] || null;
}

function mapCandles(ts, quote) {
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    // Yahoo can return nulls for gaps (weekends / holidays) — skip them.
    const o = quote.open[i], h = quote.high[i], l = quote.low[i], c = quote.close[i];
    if (o === null || c === null || h === null || l === null) continue;
    out.push({
      openTime: ts[i] * 1000,
      open: o, high: h, low: l, close: c,
      volume: quote.volume && quote.volume[i] != null ? quote.volume[i] : 0,
    });
  }
  return out;
}

async function fetchChart(symbol, interval, range) {
  const url = `${YAHOO}${toYahoo(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error('yahoo ' + res.status + ' for ' + symbol);
  const json = await res.json();
  const r = json && json.chart && json.chart.result && json.chart.result[0];
  if (!r || !r.timestamp) throw new Error('no data for ' + symbol);
  return r;
}

// OHLCV candles for the chart + signal engine.
async function getKlines(symbol, interval = '15m', limit = 300) {
  symbol = String(symbol).toUpperCase();
  const y = toYahoo(symbol);
  if (!y) throw new Error('unsupported fx symbol ' + symbol);
  const yInterval = INTERVAL_MAP[interval] || '15m';
  const range = RANGE_MAP[interval] || '1mo';
  const r = await fetchChart(symbol, yInterval, range);
  const quotes = r.indicators && r.indicators.quote && r.indicators.quote[0];
  const candles = mapCandles(r.timestamp, quotes || {});
  return candles.slice(-limit);
}

// Live price + session change for a list of symbols -> { EURUSD: { price, changePercent } }
async function getPrices(symbols) {
  symbols = symbols || DEFAULT_SYMBOLS;
  const out = {};
  await Promise.all(symbols.map(async (symbol) => {
    try {
      const r = await fetchChart(symbol, '1m', '1d');
      const meta = r.meta || {};
      const price = meta.regularMarketPrice != null ? meta.regularMarketPrice : null;
      if (price == null) return;
      const prev = meta.chartPreviousClose != null ? meta.chartPreviousClose : meta.previousClose;
      const changePercent = prev ? ((price - prev) / prev) * 100 : 0;
      out[String(symbol).toUpperCase()] = { price, changePercent, time: (meta.regularMarketTime || 0) * 1000 };
    } catch { /* skip symbol on failure */ }
  }));
  return out;
}

// Price unit rules: indices quote in points (1), metals/oil in 0.01,
// JPY pairs in 0.01, everything else in 0.0001.
function pipSize(symbol) {
  const s = String(symbol).toUpperCase();
  if (s === 'US500' || s === 'USTEC' || s === 'US30' || s === 'USOIL') return 1;
  if (s === 'XAUUSD' || s === 'XAGUSD') return 0.01;
  if (s.includes('JPY')) return 0.01;
  return 0.0001;
}

// Display decimals for a symbol.
function precision(symbol) {
  const s = String(symbol).toUpperCase();
  if (s === 'US500' || s === 'USTEC' || s === 'US30' || s === 'USOIL') return 2;
  if (s === 'XAUUSD' || s === 'XAGUSD') return 2;
  if (s.includes('JPY')) return 3;
  return 5;
}

function isFxCandidate(symbol) {
  return !!toYahoo(symbol);
}

module.exports = { DEFAULT_SYMBOLS, getKlines, getPrices, pipSize, precision, isFxCandidate, SYMBOL_MAP };