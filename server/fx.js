'use strict';
// MI Forex & commodity data provider — Yahoo Finance public chart API (keyless).
// Returns OHLCV candles and live prices for FX pairs / gold / silver so the
// app can run Professional Forex mode and Pocket Option (binary) mode.

const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36' };

// MI symbol (EURUSD) -> Yahoo symbol (EURUSD=X).
// OTC symbols (EURUSD_OTC) reuse the same Yahoo feed — OTC has no public feed,
// so MI prices/signals the OTC contract from its live underlying (standard,
// honest OTC practice) and tags the signal otc:true + market:'OTC'.
// Includes FX majors, minors, exotics, metals, oil and the stock indices
// Pocket Option trades (US500 S&P 500, USTEC Nasdaq 100, US30 Dow Jones)
// — v6 expansion: 20+ extra professional assets + 30 OTC live signals + 17 more.
const SYMBOL_MAP = {
  EURUSD: 'EURUSD=X', GBPUSD: 'GBPUSD=X', USDJPY: 'USDJPY=X', AUDUSD: 'AUDUSD=X',
  USDCHF: 'USDCHF=X', USDCAD: 'USDCAD=X', NZDUSD: 'NZDUSD=X', EURGBP: 'EURGBP=X',
  EURJPY: 'EURJPY=X', GBPJPY: 'GBPJPY=X', XAUUSD: 'GC=F', XAGUSD: 'SI=F',
  US500: '^GSPC', USTEC: '^NDX', US30: '^DJI', USOIL: 'CL=F',
  // --- expansion: minors / exotics ---
  EURAUD: 'EURAUD=X', EURNZD: 'EURNZD=X', EURCAD: 'EURCAD=X', EURCHF: 'EURCHF=X',
  GBPCHF: 'GBPCHF=X', GBPCAD: 'GBPCAD=X', GBPAUD: 'GBPAUD=X', AUDJPY: 'AUDJPY=X',
  AUDNZD: 'AUDNZD=X', NZDJPY: 'NZDJPY=X', CADJPY: 'CADJPY=X', CHFJPY: 'CHFJPY=X',
  USDMXN: 'USDMXN=X', USDZAR: 'USDZAR=X', USDTRY: 'USDTRY=X',
  // --- expansion: energy / metals / indices / crypto-vs-fiat for coverage ---
  UKOIL: 'BZ=F', XPTUSD: 'PL=F', XPDUSD: 'PA=F',
  GER40: '^GDAXI', UK100: '^FTSE', JPN225: '^N225',
  BTCUSD: 'BTC-USD', ETHUSD: 'ETH-USD',
  // --- 17 more live minors/exotics (covers AUD/CAD, AUD/CHF + more) ---
  AUDCAD: 'AUDCAD=X', AUDCHF: 'AUDCHF=X',
  CADCHF: 'CADCHF=X', NZDCAD: 'NZDCAD=X', NZDCHF: 'NZDCHF=X',
  EURSEK: 'EURSEK=X', EURNOK: 'EURNOK=X', EURZAR: 'EURZAR=X',
  GBPSEK: 'GBPSEK=X', GBPNZD: 'GBPNZD=X',
  USDSGD: 'USDSGD=X', USDHKD: 'USDHKD=X', USDPLN: 'USDPLN=X',
  USDCZK: 'USDCZK=X', USDHUF: 'USDHUF=X', USDILS: 'USDILS=X',
  USDSAR: 'USDSAR=X',
  // --- 30 OTC live signals (Pocket Option OTC weekend/market contracts) ---
  EURUSD_OTC: 'EURUSD=X', GBPUSD_OTC: 'GBPUSD=X', USDJPY_OTC: 'USDJPY=X',
  AUDUSD_OTC: 'AUDUSD=X', USDCHF_OTC: 'USDCHF=X', USDCAD_OTC: 'USDCAD=X',
  NZDUSD_OTC: 'NZDUSD=X', EURGBP_OTC: 'EURGBP=X', EURJPY_OTC: 'EURJPY=X',
  GBPJPY_OTC: 'GBPJPY=X', EURAUD_OTC: 'EURAUD=X', EURCAD_OTC: 'EURCAD=X',
  GBPCHF_OTC: 'GBPCHF=X', AUDJPY_OTC: 'AUDJPY=X', NZDJPY_OTC: 'NZDJPY=X',
  CADJPY_OTC: 'CADJPY=X', USDMXN_OTC: 'USDMXN=X', USDZAR_OTC: 'USDZAR=X',
  USDTRY_OTC: 'USDTRY=X', XAUUSD_OTC: 'GC=F', XAGUSD_OTC: 'SI=F',
  US500_OTC: '^GSPC', USTEC_OTC: '^NDX', US30_OTC: '^DJI',
  USOIL_OTC: 'CL=F', UKOIL_OTC: 'BZ=F', BTCUSD_OTC: 'BTC-USD',
  ETHUSD_OTC: 'ETH-USD', GER40_OTC: '^GDAXI', UK100_OTC: '^FTSE',
  // --- 17 more OTC (AUD/CAD OTC, AUD/CHF OTC + 15 more) ---
  AUDCAD_OTC: 'AUDCAD=X', AUDCHF_OTC: 'AUDCHF=X',
  CADCHF_OTC: 'CADCHF=X', NZDCAD_OTC: 'NZDCAD=X', NZDCHF_OTC: 'NZDCHF=X',
  EURSEK_OTC: 'EURSEK=X', EURNOK_OTC: 'EURNOK=X', EURZAR_OTC: 'EURZAR=X',
  GBPSEK_OTC: 'GBPSEK=X', GBPNZD_OTC: 'GBPNZD=X',
  USDSGD_OTC: 'USDSGD=X', USDHKD_OTC: 'USDHKD=X', USDPLN_OTC: 'USDPLN=X',
  USDCZK_OTC: 'USDCZK=X', USDHUF_OTC: 'USDHUF=X', USDILS_OTC: 'USDILS=X',
  USDSAR_OTC: 'USDSAR=X',
};

const OTC_SUFFIX = '_OTC';
function isOtc(symbol) { return String(symbol || '').toUpperCase().endsWith(OTC_SUFFIX); }
function underlying(symbol) {
  const s = String(symbol || '').toUpperCase();
  return isOtc(s) ? s.slice(0, -OTC_SUFFIX.length) : s;
}

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
// JPY pairs in 0.01, everything else in 0.0001. OTC inherits underlying.
function pipSize(symbol) {
  const s = underlying(String(symbol).toUpperCase());
  if (s === 'US500' || s === 'USTEC' || s === 'US30' || s === 'USOIL' || s === 'UKOIL' || s === 'GER40' || s === 'UK100' || s === 'JPN225') return 1;
  if (s === 'XAUUSD' || s === 'XAGUSD' || s === 'XPTUSD' || s === 'XPDUSD') return 0.01;
  if (s === 'BTCUSD' || s === 'ETHUSD') return 1;
  if (s.includes('JPY')) return 0.01;
  return 0.0001;
}

// Display decimals for a symbol (OTC inherits underlying).
function precision(symbol) {
  const s = underlying(String(symbol).toUpperCase());
  if (s === 'US500' || s === 'USTEC' || s === 'US30' || s === 'USOIL' || s === 'UKOIL' || s === 'GER40' || s === 'UK100' || s === 'JPN225') return 2;
  if (s === 'XAUUSD' || s === 'XAGUSD' || s === 'XPTUSD' || s === 'XPDUSD') return 2;
  if (s === 'BTCUSD' || s === 'ETHUSD') return 2;
  if (s.includes('JPY')) return 3;
  if (s.includes('MXN') || s.includes('ZAR') || s.includes('TRY')) return 4;
  return 5;
}

function isFxCandidate(symbol) {
  return !!toYahoo(symbol);
}

module.exports = { DEFAULT_SYMBOLS, getKlines, getPrices, pipSize, precision, isFxCandidate, isOtc, underlying, OTC_SUFFIX, SYMBOL_MAP };