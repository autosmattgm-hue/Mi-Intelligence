'use strict';
// MI Backtest — replays the signal engine over historical candles and grades
// every emitted signal (TP hit first = win, SL hit first = loss, else expired).
// Real, no-look-ahead: each signal is generated ONLY from bars that existed
// before it, then graded against the following bars.

const binance = require('./binance');
const fx = require('./fx');
const signalEngine = require('./signalEngine');

const LOOKBACK = 60;   // bars needed for analysis
const HORIZON = 12;    // bars ahead to grade

async function runBacktest({ symbol, mode = 'crypto', interval = '1h', bars = 720 }) {
  symbol = String(symbol || 'BTCUSDT').toUpperCase();
  mode = ['crypto', 'forex', 'pocket'].includes(mode) ? mode : 'crypto';
  const limit = Math.min(Math.max(Number(bars) || 720, LOOKBACK + HORIZON + 5), 1000);
  const klines = fx.isFxCandidate(symbol)
    ? await fx.getKlines(symbol, interval, limit)
    : await binance.getKlines(symbol, interval, limit);
  if (!klines || klines.length < LOOKBACK + HORIZON) {
    throw new Error('Not enough candles for ' + symbol + ' (' + (klines || []).length + ')');
  }

  const opts = { mode };
  if (mode === 'forex') { opts.precision = fx.precision(symbol); opts.pip = fx.pipSize(symbol); }

  const signals = [];
  for (let i = LOOKBACK; i < klines.length - HORIZON; i++) {
    const window = klines.slice(i - LOOKBACK + 1, i + 1);
    const sig = signalEngine.analyzeSymbol(symbol, window, opts);
    if (!sig || sig.action === 'HOLD' || sig.action === 'NEUTRAL' || !sig.takeProfit || !sig.stopLoss) continue;

    const isBuy = sig.action === 'BUY' || sig.action === 'CALL';
    let result = 'expired';
    for (let j = i + 1; j < i + 1 + HORIZON; j++) {
      const bar = klines[j];
      if (!bar) break;
      if (isBuy) {
        if (bar.high >= sig.takeProfit) { result = 'win'; break; }
        if (bar.low <= sig.stopLoss) { result = 'loss'; break; }
      } else {
        if (bar.low <= sig.takeProfit) { result = 'win'; break; }
        if (bar.high >= sig.stopLoss) { result = 'loss'; break; }
      }
    }
    signals.push({
      time: new Date(klines[i].openTime).toISOString(),
      action: sig.action,
      confidence: sig.confidence,
      quality: sig.quality,
      price: sig.entry,
      tp: sig.takeProfit,
      sl: sig.stopLoss,
      rr: sig.riskReward,
      result,
    });
  }

  const wins = signals.filter(s => s.result === 'win').length;
  const losses = signals.filter(s => s.result === 'loss').length;
  const graded = wins + losses;
  const gradedRR = signals.filter(s => s.result !== 'expired').map(s => s.rr || 1);
  const totalR = signals.reduce((a, s) => s.result === 'win' ? a + (s.rr || 1) : a, 0) - losses;
  const expectation = graded ? totalR / graded : 0;

  return {
    symbol,
    mode,
    interval,
    candles: klines.length,
    signals: signals.length,
    wins,
    losses,
    expired: signals.length - graded,
    graded,
    winRate: graded ? Math.round((wins / graded) * 100) : 0,
    avgRR: gradedRR.length ? +(gradedRR.reduce((a, b) => a + b, 0) / gradedRR.length).toFixed(2) : 0,
    expectancy: +expectation.toFixed(3),
    projection30d: +(expectation * 0.02 * 2 * 30 * 100).toFixed(0),
    from: signals.length ? signals[0].time : null,
    to: signals.length ? signals[signals.length - 1].time : null,
    recent: signals.slice(-15).reverse(),
  };
}

module.exports = { runBacktest };