'use strict';
// MI market modes — the app runs in three professional trading modes:
//   - crypto : CoinMarketCap + Binance spot dashboard (default)
//   - pocket : short-expiry binary/digital option mode (Pocket Option style)
//   - forex  : FX majors + gold/silver with pip-based trade plans
// Every mode has its own symbol basket and data provider routing.

const binance = require('./binance');
const fx = require('./fx');

const MODES = {
  crypto: {
    label: 'Crypto',
    icon: '💠',
    description: 'CoinMarketCap + Binance · BUY/SELL signals',
    horizon: '15m + 1h',
    klineInterval: '15m',
    symbols: binance.DEFAULT_SYMBOLS,
  },
  pocket: {
    label: 'Pocket Option',
    icon: '⏱️',
    description: 'Short-expiry digital options · CALL/PUT with expiry & payout',
    horizon: '5m momentum',
    klineInterval: '5m',
    symbols: [
      'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'AVAXUSDT',
      'EURUSD', 'GBPUSD', 'USDJPY', 'GBPJPY', 'EURGBP', 'XAUUSD',
    ],
  },
  forex: {
    label: 'Forex',
    icon: '💱',
    description: 'FX majors + XAU/XAG · pip-based plans & sessions',
    horizon: '15m + 1h',
    klineInterval: '15m',
    symbols: fx.DEFAULT_SYMBOLS,
  },
};

const DEFAULT_MODE = 'crypto';
const VALID = Object.keys(MODES);

function isValid(mode) { return VALID.includes(mode); }

function getSymbols(mode) {
  const m = MODES[mode] || MODES.crypto;
  return m.symbols.slice();
}

// Route a symbol to the right provider given the active mode + symbol.
function getKlines(mode, symbol, interval, limit) {
  const m = MODES[mode] || MODES.crypto;
  symbol = String(symbol).toUpperCase();
  if (m.provider === 'yahoo' || (m !== MODES.crypto && fx.isFxCandidate(symbol))) {
    return fx.getKlines(symbol, interval, limit);
  }
  const binance = require('./binance');
  return binance.getKlines(symbol, interval, limit);
}

// Live prices (and approximate 24h change) for every symbol in a mode.
async function getPrices(mode) {
  const m = MODES[mode] || MODES.crypto;
  const out = {};
  let stats24h = {};
  if (mode === 'crypto') {
    const cmcMod = require('./coinmarketcap');
    try {
      const overview = await cmcMod.getMarketOverview(100);
      return { prices: overview.prices, stats24h: overview.stats24h, global: overview.global, listings: overview.listings, source: 'coinmarketcap' };
    } catch { /* fall through to binance ticker */ }
  }
  // Split the basket into crypto (Binance) and fx (Yahoo) symbols.
  const cryptoSymbols = [];
  const fxSymbols = [];
  for (const s of m.symbols) {
    (fx.isFxCandidate(s) ? fxSymbols : cryptoSymbols).push(s);
  }
  if (cryptoSymbols.length) {
    try {
      const [p, st] = await Promise.all([binance.getTickerPrices(cryptoSymbols), binance.get24hStats(cryptoSymbols)]);
      Object.assign(out, p);
      Object.assign(stats24h, st);
    } catch { /* some crypto symbols may fail */ }
  }
  if (fxSymbols.length) {
    try {
      const fp = await fx.getPrices(fxSymbols);
      for (const s of fxSymbols) {
        if (fp[s]) {
          out[s] = fp[s].price;
          stats24h[s] = { priceChangePercent: fp[s].changePercent, quoteVolume: 0 };
        }
      }
    } catch { /* ignore fx fetch issues */ }
  }
  return { prices: out, stats24h, global: null, listings: [], source: 'mixed' };
}

module.exports = { MODES, DEFAULT_MODE, isValid, getSymbols, getKlines, getPrices, VALID };