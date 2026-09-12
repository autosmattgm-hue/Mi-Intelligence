'use strict';

// Technical analysis primitives. Pure functions — no I/O.

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length < period + 1) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    avgGain += Math.max(diff, 0);
    avgLoss += Math.max(-diff, 0);
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = Math.max(diff, 0);
    const loss = Math.max(-diff, 0);
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function macd(values, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = values.map((_, i) => (emaFast[i] === null || emaSlow[i] === null) ? null : emaFast[i] - emaSlow[i]);

  const signalLine = new Array(values.length).fill(null);
  const k = 2 / (signal + 1);
  let prev = null;
  for (let i = 0; i < macdLine.length; i++) {
    if (macdLine[i] === null) continue;
    if (prev === null) { prev = macdLine[i]; signalLine[i] = macdLine[i]; }
    else { prev = macdLine[i] * k + prev * (1 - k); signalLine[i] = prev; }
  }

  const histogram = macdLine.map((v, i) => (v === null || signalLine[i] === null) ? null : v - signalLine[i]);
  return { macdLine, signalLine, histogram };
}

function bollinger(values, period = 20, mult = 2) {
  const mid = sma(values, period);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) { const d = values[j] - mid[i]; s += d * d; }
    const sd = Math.sqrt(s / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { upper, mid, lower };
}

function atr(klines, period = 14) {
  const out = new Array(klines.length).fill(null);
  const n = klines.length;
  let prevATR = null;
  for (let i = 0; i < n; i++) {
    const k = klines[i];
    const tr = i === 0
      ? k.high - k.low
      : Math.max(k.high - k.low, Math.abs(k.high - klines[i - 1].close), Math.abs(k.low - klines[i - 1].close));
    if (i < period) {
      if (prevATR === null) prevATR = 0;
      prevATR += tr;
      if (i === period - 1) { prevATR /= period; out[i] = prevATR; }
    } else {
      prevATR = (prevATR * (period - 1) + tr) / period;
      out[i] = prevATR;
    }
  }
  return out;
}

module.exports = { sma, ema, rsi, macd, bollinger, atr };