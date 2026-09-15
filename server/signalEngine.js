'use strict';

// MI Signal Engine — multi-timeframe confluence engine.
// Combines 15-minute indicators (EMA trend, EMA crossovers, RSI, MACD,
// Bollinger Bands, ATR, volume) with real price momentum (1h / 6h / 24h %),
// range position and a 15m-vs-1h timeframe confluence bonus so that the
// system produces directional BUY / SELL signals in trending conditions and
// honest HOLD verdicts only when the market is genuinely flat / mixed.
// Everything is computed from REAL market data.

const { ema, rsi, macd, bollinger, atr } = require('./indicators');

function round2(v) { return Math.round(v * 100) / 100; }
function last(arr) { return arr.length ? arr[arr.length - 1] : null; }
function pctChange(a, b) { return (a > 0 && b > 0) ? ((a - b) / b) * 100 : 0; }

// Resample 15m closes into hourly closes for slower-timeframe confluence.
// Pick a recommended binary-option expiry based on volatility + signal strength.
function chooseExpiry(atrPct, absS) {
  if (absS >= 45 && atrPct < 0.35) return '1m';
  if (absS >= 35) return '5m';
  return '15m';
}

// Which FX trading sessions are currently open (UTC).
function activeSessions(t) {
  const h = new Date(t).getUTCHours();
  const s = [];
  if (h >= 21 || h < 6) s.push('Sydney');
  if (h >= 0 && h < 9) s.push('Tokyo');
  if (h >= 7 && h < 16) s.push('London');
  if (h >= 12 && h < 21) s.push('New York');
  return s.length ? s : ['Closed market'];
}

// Wilder smoothing (used by ADX/ATR-style indicators).
function wilders(values, p) {
  const out = new Array(values.length).fill(null);
  if (values.length < p) return out;
  let s = 0;
  for (let i = 0; i < p; i++) s += values[i];
  out[p - 1] = s / p;
  for (let i = p; i < values.length; i++) out[i] = (out[i - 1] * (p - 1) + values[i]) / p;
  return out;
}

// Average Directional Index (14) — tells a REAL trend from chop.
function adxArr(klines, p = 14) {
  const n = klines.length;
  const tr = new Array(n).fill(0), up = new Array(n).fill(0), dn = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const h = klines[i].high, l = klines[i].low, pc = klines[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    const um = h - klines[i - 1].high, dm = klines[i - 1].low - l;
    up[i] = (um > dm && um > 0) ? um : 0;
    dn[i] = (dm > um && dm > 0) ? dm : 0;
  }
  const atr = wilders(tr, p), wUp = wilders(up, p), wDn = wilders(dn, p);
  const dx = new Array(n).fill(0);
  for (let i = p - 1; i < n; i++) {
    const diP = atr[i] > 0 ? 100 * wUp[i] / atr[i] : 0;
    const diM = atr[i] > 0 ? 100 * wDn[i] / atr[i] : 0;
    const s = diP + diM;
    dx[i] = s > 0 ? 100 * Math.abs(diP - diM) / s : 0;
  }
  return wilders(dx, p);
}

// Stochastic oscillator (14, 3, 3).
function stochArr(klines, kp = 14, kSm = 3, dSm = 3) {
  const n = klines.length;
  const raw = new Array(n).fill(null), k = new Array(n).fill(null), d = new Array(n).fill(null);
  for (let i = kp - 1; i < n; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - kp + 1; j <= i; j++) { hi = Math.max(hi, klines[j].high); lo = Math.min(lo, klines[j].low); }
    raw[i] = (hi - lo) > 0 ? 100 * (klines[i].close - lo) / (hi - lo) : 50;
  }
  for (let i = 0; i < n; i++) {
    if (raw[i] === null) continue;
    let a = 0, c = 0;
    for (let j = i - kSm + 1; j <= i; j++) { if (raw[j] !== null) { a += raw[j]; c++; } }
    if (c === kSm) k[i] = a / kSm;
  }
  for (let i = 0; i < n; i++) {
    if (k[i] === null) continue;
    let a = 0, c = 0;
    for (let j = i - dSm + 1; j <= i; j++) { if (k[j] !== null) { a += k[j]; c++; } }
    if (c === dSm) d[i] = a / dSm;
  }
  return { raw, k, d };
}

// Daily VWAP (volume-weighted average price grouped by UTC day).
function dailyVwap(klines) {
  const day = new Map();
  for (const c of klines) {
    const key = new Date(c.openTime).toISOString().slice(0, 10);
    if (!day.has(key)) day.set(key, { pv: 0, v: 0 });
    const g = day.get(key);
    const v = c.volume > 0 ? c.volume : 1;
    g.pv += c.close * v; g.v += v;
  }
  const lastKey = new Date(klines[klines.length - 1].openTime).toISOString().slice(0, 10);
  const g = day.get(lastKey);
  const vwap = g && g.v > 0 ? g.pv / g.v : null;
  const price = klines[klines.length - 1].close;
  const distancePct = (vwap && price) ? ((price - vwap) / vwap) * 100 : null;
  return { vwap, distancePct };
}

// Swing structure — higher-highs/higher-lows vs lower-highs/lower-lows.
function swingStructure(klines) {
  const n = klines.length;
  const highs = [], lows = [];
  for (let i = 2; i < n - 2; i++) {
    const h = klines[i].high;
    if (h > klines[i - 1].high && h > klines[i - 2].high && h > klines[i + 1].high && h > klines[i + 2].high) highs.push(h);
    const l = klines[i].low;
    if (l < klines[i - 1].low && l < klines[i - 2].low && l < klines[i + 1].low && l < klines[i + 2].low) lows.push(l);
  }
  if (highs.length >= 2 && lows.length >= 2) {
    const a = highs[highs.length - 1], b = highs[highs.length - 2];
    const c = lows[lows.length - 1], dLow = lows[lows.length - 2];
    if (a > b && c > dLow) return { type: 'uptrend', count: highs.length + lows.length };
    if (a < b && c < dLow) return { type: 'downtrend', count: highs.length + lows.length };
  }
  return { type: 'mixed', count: highs.length + lows.length };
}

// Confirmatory candlestick pattern on the most recent bar.
function lastCandlePattern(klines) {
  const n = klines.length;
  if (n < 2) return { pattern: null, dir: 0 };
  const c = klines[n - 1], p = klines[n - 2];
  const body = Math.abs(c.close - c.open), range = c.high - c.low;
  if (range <= 0) return { pattern: null, dir: 0 };
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  if (c.close > c.open && c.open < p.close && c.close > p.open) return { pattern: 'Bullish Engulfing', dir: 1 };
  if (c.close < c.open && c.open > p.close && c.close < p.open) return { pattern: 'Bearish Engulfing', dir: -1 };
  if (c.close > c.open && lower >= 2 * body && upper <= body * 0.4 && body > 0) return { pattern: 'Hammer', dir: 1 };
  if (c.close < c.open && upper >= 2 * body && lower <= body * 0.4 && body > 0) return { pattern: 'Shooting Star', dir: -1 };
  if (body <= range * 0.12) return { pattern: 'Doji', dir: 0 };
  return { pattern: null, dir: 0 };
}

// RSI divergence over the last ~8 bars — a smart-money reversal tell.
function rsiDivergence(closes, rArr) {
  const n = closes.length;
  if (n < 12) return null;
  const cur = closes[n - 1], curRsi = rArr[n - 1];
  if (rArr[n - 1] === null) return null;
  let loIdx = n - 9, hiIdx = n - 9, lo = Infinity, hi = -Infinity;
  for (let i = n - 9; i <= n - 3; i++) {
    if (closes[i] < lo) { lo = closes[i]; loIdx = i; }
    if (closes[i] > hi) { hi = closes[i]; hiIdx = i; }
  }
  const rsiLo = rArr[loIdx], rsiHi = rArr[hiIdx];
  if (rsiLo === null || rsiHi === null) return null;
  if (cur < lo && curRsi > rsiLo) return { type: 'bullish', at: curRsi - rsiLo };
  if (cur > hi && curRsi < rsiHi) return { type: 'bearish', at: curRsi - rsiHi };
  return null;
}

function resampleHourly(closes) {
  const out = [];
  for (let i = 0; i + 3 < closes.length; i += 4) {
    out.push((closes[i] + closes[i + 1] + closes[i + 2] + closes[i + 3]) / 4);
  }
  return out;
}

function analyzeSymbol(symbol, klines, opts) {
  if (!klines || klines.length < 60) return null;
  const closes = klines.map(k => k.close);
  const vols = klines.map(k => k.volume);
  const price = last(closes);
  if (!price) return null;
  const n = closes.length;

  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const r = rsi(closes, 14);
  const m = macd(closes, 12, 26, 9);
  const bb = bollinger(closes, 20, 2);
  const at = atr(klines, 14);

  const rsiV = last(r);
  const atrV = last(at);
  const atrPct = atrV && price ? (atrV / price) * 100 : 0;

  const volAvg = vols.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volRatio = volAvg > 0 ? last(vols) / volAvg : 1;

  // Recent 60-candle swing range (support / resistance / range position).
  const recent = klines.slice(-60);
  const resistance = Math.max(...recent.map(k => k.high));
  const support = Math.min(...recent.map(k => k.low));
  const range = resistance - support;
  const rangePos = range > 0 ? ((price - support) / range) * 100 : 50;

  let score = 0;
  const factors = [];

  const e9Now = last(e9), e21Now = last(e21), e50Now = last(e50);
  const e9Prev = e9.length > 1 ? e9[e9.length - 2] : null;
  const e21Prev = e21.length > 1 ? e21[e21.length - 2] : null;

  // 1) Trend (price vs EMA21 vs EMA50)
  const trendUp = price > e21Now && e21Now > e50Now;
  const trendDown = price < e21Now && e21Now < e50Now;
  if (trendUp) { score += 25; factors.push({ name: 'Trend', value: 'Uptrend', impact: 'bull' }); }
  else if (trendDown) { score -= 25; factors.push({ name: 'Trend', value: 'Downtrend', impact: 'bear' }); }
  else factors.push({ name: 'Trend', value: 'Range / Mixed', impact: 'neutral' });

  // 2) EMA 9/21 crossover / position
  if (e9Prev !== null && e21Prev !== null && e9Now !== null && e21Now !== null) {
    const crossUp = e9Prev <= e21Prev && e9Now > e21Now;
    const crossDown = e9Prev >= e21Prev && e9Now < e21Now;
    if (crossUp) { score += 15; factors.push({ name: 'EMA 9/21', value: 'Bullish cross', impact: 'bull' }); }
    else if (crossDown) { score -= 15; factors.push({ name: 'EMA 9/21', value: 'Bearish cross', impact: 'bear' }); }
    else if (e9Now > e21Now) { score += 5; factors.push({ name: 'EMA 9/21', value: 'Above', impact: 'bull' }); }
    else { score -= 5; factors.push({ name: 'EMA 9/21', value: 'Below', impact: 'bear' }); }
  }

  // 3) RSI
  if (rsiV !== null) {
    if (rsiV >= 70) { score -= 15; factors.push({ name: 'RSI', value: rsiV.toFixed(1) + ' — Overbought', impact: 'bear' }); }
    else if (rsiV <= 30) { score += 15; factors.push({ name: 'RSI', value: rsiV.toFixed(1) + ' — Oversold', impact: 'bull' }); }
    else if (rsiV >= 55) { score += 10; factors.push({ name: 'RSI', value: rsiV.toFixed(1) + ' — Bullish', impact: 'bull' }); }
    else if (rsiV <= 45) { score -= 10; factors.push({ name: 'RSI', value: rsiV.toFixed(1) + ' — Bearish', impact: 'bear' }); }
    else factors.push({ name: 'RSI', value: rsiV.toFixed(1) + ' — Neutral', impact: 'neutral' });
  }

  // 4) MACD
  const histNow = last(m.histogram);
  const histPrev = m.histogram.length > 1 ? m.histogram[m.histogram.length - 2] : null;
  if (histNow !== null && histPrev !== null) {
    if (histNow > 0 && histNow > histPrev) { score += 15; factors.push({ name: 'MACD', value: 'Bullish momentum', impact: 'bull' }); }
    else if (histNow < 0 && histNow < histPrev) { score -= 15; factors.push({ name: 'MACD', value: 'Bearish momentum', impact: 'bear' }); }
    else if (histNow > 0) { score += 5; factors.push({ name: 'MACD', value: 'Positive', impact: 'bull' }); }
    else { score -= 5; factors.push({ name: 'MACD', value: 'Negative', impact: 'bear' }); }
  }

  // 5) Bollinger Bands
  const bbUpper = last(bb.upper), bbLower = last(bb.lower);
  if (bbUpper !== null && bbLower !== null) {
    if (price < bbLower) { score += 10; factors.push({ name: 'Bollinger', value: 'Below lower band', impact: 'bull' }); }
    else if (price > bbUpper) { score -= 10; factors.push({ name: 'Bollinger', value: 'Above upper band', impact: 'bear' }); }
    else factors.push({ name: 'Bollinger', value: 'Inside bands', impact: 'neutral' });
  }

  // 6) Volume confirmation
  const volImpact = volRatio >= 1.3 ? (trendUp ? 'bull' : trendDown ? 'bear' : 'neutral') : 'neutral';
  if (volImpact === 'bull') { score += 5; factors.push({ name: 'Volume', value: volRatio.toFixed(2) + 'x avg', impact: 'bull' }); }
  else if (volImpact === 'bear') { score -= 5; factors.push({ name: 'Volume', value: volRatio.toFixed(2) + 'x avg', impact: 'bear' }); }
  else factors.push({ name: 'Volume', value: volRatio.toFixed(2) + 'x avg', impact: 'neutral' });

  // 7) Real price momentum (1h / 6h / 24h % change)
  const m1h = n > 4 ? pctChange(price, closes[n - 5]) : 0;
  const m6h = n > 24 ? pctChange(price, closes[n - 25]) : 0;
  const m24h = n > 96 ? pctChange(price, closes[n - 97]) : 0;
  if (m1h >= 0.15) { score += 8; factors.push({ name: 'Momentum 1H', value: '+' + m1h.toFixed(2) + '%', impact: 'bull' }); }
  else if (m1h <= -0.15) { score -= 8; factors.push({ name: 'Momentum 1H', value: m1h.toFixed(2) + '%', impact: 'bear' }); }
  else factors.push({ name: 'Momentum 1H', value: m1h.toFixed(2) + '%', impact: 'neutral' });
  if (m6h >= 0.4) { score += 8; factors.push({ name: 'Momentum 6H', value: '+' + m6h.toFixed(2) + '%', impact: 'bull' }); }
  else if (m6h <= -0.4) { score -= 8; factors.push({ name: 'Momentum 6H', value: m6h.toFixed(2) + '%', impact: 'bear' }); }
  else factors.push({ name: 'Momentum 6H', value: m6h.toFixed(2) + '%', impact: 'neutral' });
  if (m24h >= 1) { score += 9; factors.push({ name: 'Momentum 24H', value: '+' + m24h.toFixed(2) + '%', impact: 'bull' }); }
  else if (m24h <= -1) { score -= 9; factors.push({ name: 'Momentum 24H', value: m24h.toFixed(2) + '%', impact: 'bear' }); }
  else factors.push({ name: 'Momentum 24H', value: m24h.toFixed(2) + '%', impact: 'neutral' });

  // 8) Range position (where price sits inside the recent swing range)
  if (rangePos <= 30) { score += 8; factors.push({ name: 'Range position', value: rangePos.toFixed(0) + '% — near low', impact: 'bull' }); }
  else if (rangePos >= 70) { score -= 8; factors.push({ name: 'Range position', value: rangePos.toFixed(0) + '% — near high', impact: 'bear' }); }
  else factors.push({ name: 'Range position', value: rangePos.toFixed(0) + '%', impact: 'neutral' });

  // 9) Timeframe confluence (15m vs 1h)
  const hourly = resampleHourly(closes);
  let confluence = 'Mixed';
  if (hourly.length >= 22) {
    const eh21 = ema(hourly, 21);
    const eh50 = ema(hourly, 50);
    const h21 = last(eh21), h50 = last(eh50);
    const hPrice = last(hourly);
    if (h21 && h50 && hPrice) {
      const hourlyUp = hPrice > h21 && h21 > h50;
      const hourlyDown = hPrice < h21 && h21 < h50;
      if (trendUp && hourlyUp) { score += 10; confluence = 'Aligned Bull (15m+1h)'; factors.push({ name: 'Timeframes', value: '15m & 1h aligned', impact: 'bull' }); }
      else if (trendDown && hourlyDown) { score -= 10; confluence = 'Aligned Bear (15m+1h)'; factors.push({ name: 'Timeframes', value: '15m & 1h aligned', impact: 'bear' }); }
      else if (trendUp || hourlyUp) { score += 3; confluence = 'Lean Bull'; factors.push({ name: 'Timeframes', value: 'Lean bullish', impact: 'bull' }); }
      else if (trendDown || hourlyDown) { score -= 3; confluence = 'Lean Bear'; factors.push({ name: 'Timeframes', value: 'Lean bearish', impact: 'bear' }); }
      else factors.push({ name: 'Timeframes', value: 'Mixed trend', impact: 'neutral' });
    } else {
      factors.push({ name: 'Timeframes', value: 'Insufficient 1h data', impact: 'neutral' });
    }
  } else {
    factors.push({ name: 'Timeframes', value: 'Insufficient 1h data', impact: 'neutral' });
  }

  // 10) Daily VWAP position — where price sits vs the day's volume-weighted price
  const vwap = dailyVwap(klines);
  if (vwap.distancePct !== null) {
    if (vwap.distancePct > 0.15) { score += 5; factors.push({ name: 'VWAP', value: 'above daily VWAP +' + vwap.distancePct.toFixed(2) + '%', impact: 'bull' }); }
    else if (vwap.distancePct < -0.15) { score -= 5; factors.push({ name: 'VWAP', value: 'below daily VWAP ' + vwap.distancePct.toFixed(2) + '%', impact: 'bear' }); }
    else factors.push({ name: 'VWAP', value: 'at daily VWAP', impact: 'neutral' });
  }

  // 11) Stochastic (14,3,3) oscillator — momentum cross & exhaustion zones
  const st = stochArr(klines);
  const stK = last(st.k), stD = last(st.d);
  const stKPrev = st.k.length > 1 ? st.k[st.k.length - 2] : stK;
  if (stK !== null) {
    const bullCross = stKPrev !== null && stKPrev < 20 && stK > stD;
    const bearCross = stKPrev !== null && stKPrev > 80 && stK < stD;
    if (bullCross) { score += 6; factors.push({ name: 'Stochastic', value: 'bullish cross in oversold', impact: 'bull' }); }
    else if (bearCross) { score -= 6; factors.push({ name: 'Stochastic', value: 'bearish cross in overbought', impact: 'bear' }); }
    else if (stK < 25) { score += 3; factors.push({ name: 'Stochastic', value: '%K ' + stK.toFixed(0) + ' oversold', impact: 'bull' }); }
    else if (stK > 75) { score -= 3; factors.push({ name: 'Stochastic', value: '%K ' + stK.toFixed(0) + ' overbought', impact: 'bear' }); }
    else factors.push({ name: 'Stochastic', value: '%K ' + stK.toFixed(0), impact: 'neutral' });
  }

  // 12) ADX (14) trend strength — real trends earn credit, chop yields nothing
  const adxV = last(adxArr(klines));
  if (adxV !== null) {
    if (adxV >= 22) { score += (trendUp ? 4 : trendDown ? -4 : 0); factors.push({ name: 'ADX', value: adxV.toFixed(0) + ' — strong trend', impact: trendUp ? 'bull' : trendDown ? 'bear' : 'neutral' }); }
    else if (adxV <= 14) factors.push({ name: 'ADX', value: adxV.toFixed(0) + ' — choppy / weak', impact: 'neutral' });
    else factors.push({ name: 'ADX', value: adxV.toFixed(0) + ' — developing', impact: 'neutral' });
  }

  // 13) Price structure — higher-highs/higher-lows confirm a real trend
  const structure = swingStructure(klines);
  if (structure.type === 'uptrend') { score += 8; factors.push({ name: 'Structure', value: 'HH · HL — uptrend', impact: 'bull' }); }
  else if (structure.type === 'downtrend') { score -= 8; factors.push({ name: 'Structure', value: 'LH · LL — downtrend', impact: 'bear' }); }
  else factors.push({ name: 'Structure', value: 'sideways swings', impact: 'neutral' });

  // 14) Candlestick confirmation on the most recent bar
  const candle = lastCandlePattern(klines);
  if (candle.dir === 1) { score += 6; factors.push({ name: 'Candlestick', value: candle.pattern, impact: 'bull' }); }
  else if (candle.dir === -1) { score -= 6; factors.push({ name: 'Candlestick', value: candle.pattern, impact: 'bear' }); }
  else if (candle.pattern === 'Doji') factors.push({ name: 'Candlestick', value: 'Doji — indecision', impact: 'neutral' });

  // 15) RSI divergence — smart-money reversal signal
  const divergence = rsiDivergence(closes, r);
  if (divergence && divergence.type === 'bullish') { score += 8; factors.push({ name: 'Divergence', value: 'bullish RSI divergence', impact: 'bull' }); }
  else if (divergence && divergence.type === 'bearish') { score -= 8; factors.push({ name: 'Divergence', value: 'bearish RSI divergence', impact: 'bear' }); }

  // ----------------------------------------------------------------------
  // Verdict — confluence score transformed into an actionable signal.
  const mode = (opts && opts.mode) || 'crypto';
  const dir = score >= 25 ? 1 : score <= -25 ? -1 : 0;
  // Pocket Option mode: direction is a CALL (up) or PUT (down) for short
  // expiries. Forex/Crypto: classic BUY / SELL / HOLD.
  let action;
  if (mode === 'pocket') action = dir === 1 ? 'CALL' : dir === -1 ? 'PUT' : 'NEUTRAL';
  else action = dir === 1 ? 'BUY' : dir === -1 ? 'SELL' : 'HOLD';
  const isNeutral = action === 'HOLD' || action === 'NEUTRAL';
  const absS = Math.abs(score);

  // Factor agreement — how many independent signals point the same way.
  // "Sure" signals require AGREEMENT, not just a passing score.
  const bullCount = factors.filter(f => f.impact === 'bull').length;
  const bearCount = factors.filter(f => f.impact === 'bear').length;
  const dominant = Math.max(bullCount, bearCount);

  // Conviction tier — multi-factor, aligned setups earn HIGH conviction.
  // MIDDLE scores that barely pass the threshold stay LOW / MEDIUM so the
  // UI never over-promises on a weak setup.
  let quality = 'LOW';
  if (!isNeutral) {
    if ((absS >= 40 && dominant >= 5) || absS >= 55) quality = 'HIGH';
    else if (absS >= 28 && dominant >= 4) quality = 'MEDIUM';
    else if (absS >= 25 && dominant >= 3) quality = 'LOW';
  }

  const cap = quality === 'HIGH' ? 97 : quality === 'MEDIUM' ? 90 : 82;

  // --- IQ gate: never over-promise against the higher-timeframe trend. ---
  // If the hourly trend clearly disagrees with the intraday direction, the
  // signal is demoted to LOW and its confidence capped, so only setups the
  // whole market structure supports can ever claim "HIGH conviction".
  let effectiveCap = cap;
  if (!isNeutral && mode !== 'pocket') {
    const cf = confluence || '';
    const against =
      (dir === 1 && (cf.indexOf('Bear') !== -1)) ||
      (dir === -1 && (cf.indexOf('Bull') !== -1));
    if (against) { quality = 'LOW'; effectiveCap = 74; }
  }

  const rawConf = isNeutral
    ? Math.round(48 + absS * 0.9)
    : Math.round(52 + Math.min(absS, 80) * 0.9);
  const confidence = isNeutral ? rawConf : Math.min(effectiveCap, rawConf);

  // Trade plan (only when a directional signal exists)
  let entry = price, tp = null, sl = null, rr = null;
  if (!isNeutral && atrV > 0) {
    const isBuy = dir === 1;
    sl = isBuy ? price - atrV * 1.6 : price + atrV * 1.6;
    tp = isBuy ? price + atrV * 2.6 : price - atrV * 2.6;
    rr = round2(Math.abs(tp - price) / Math.abs(price - sl));
  }

  const fxPip = (opts && opts.pip) || 0.0001;
  // Forex prices need their market precision (5 dp majors / 2-3 dp JPY & metals) —
  // not the 2-dp crypto rounding.
  const fpx = Math.pow(10, mode === 'forex' ? ((opts && opts.precision) || 5) : 2);
  const rPrec = (v) => (v === null || v === undefined || isNaN(v)) ? v : Math.round(v * fpx) / fpx;
  const asset = (mode === 'forex' || (mode === 'pocket' && !symbol.endsWith('USDT')))
    ? symbol.replace(/^(.{3})(.{3})$/, '$1/$2')
    : symbol.replace(/USDT$/, '') + '/USDT';

  return {
    symbol,
    asset,
    mode,
    price: rPrec(price),
    time: new Date().toISOString(),
    action,
    confidence,
    entry: rPrec(entry),
    takeProfit: tp ? rPrec(tp) : null,
    stopLoss: sl ? rPrec(sl) : null,
    riskReward: rr,
    duration: isNeutral ? '—' : (mode === 'pocket' ? 'expiry ' + chooseExpiry(atrPct, absS) : '1h – 4h'),
    rating: isNeutral ? '—' : '★'.repeat(Math.min(5, 1 + Math.floor(confidence / 20))),
    trend: trendUp ? 'Uptrend' : trendDown ? 'Downtrend' : 'Sideways',
    rsi: rsiV === null ? null : round2(rsiV),
    atrPct: round2(atrPct),
    volRatio: round2(volRatio),
    support: rPrec(support),
    resistance: rPrec(resistance),
    macdState: histNow === null ? '—' : histNow >= 0 ? 'Bullish' : 'Bearish',
    momentum: { m1h: round2(m1h), m6h: round2(m6h), m24h: round2(m24h) },
    rangePosition: round2(rangePos),
    adx: adxV === null ? null : round2(adxV),
    vwapDistance: vwap.distancePct === null ? null : round2(vwap.distancePct),
    stochasticK: stK === null ? null : round2(stK),
    divergence: divergence ? divergence.type : null,
    structure: structure.type,
    candlePattern: candle.pattern,
    confluence,
    timeframe: mode === 'pocket' ? '5m momentum' : '15m + 1h',
    quality,
    bullCount,
    bearCount,
    direction: mode === 'pocket' ? (dir === 1 ? 'call' : dir === -1 ? 'put' : 'flat') : (score >= 0 ? 'bull' : 'bear'),
    // Forex mode: pip-based plan + sessions
    ...(mode === 'forex' ? {
      precision: (opts && opts.precision) || 5,
      pipValue: fxPip,
      tpPips: tp ? Math.round(Math.abs(tp - price) / fxPip) : null,
      slPips: sl ? Math.round(Math.abs(price - sl) / fxPip) : null,
      sessions: activeSessions(),
      sessionLabel: activeSessions().join(' · '),
    } : {}),
    // Pocket Option mode: expiry, payout estimate (typical 80-94% digital-option payouts), win probability
    ...(mode === 'pocket' ? {
      expiry: chooseExpiry(atrPct, absS),
      payout: Math.max(80, Math.min(94, Math.round(78 + atrPct * 4))),
      winProbability: confidence,
      directionUp: dir === 1,
    } : {}),
    factors,
    score,
  };
}

function summarize(analyses) {
  const valid = analyses.filter(a => a);
  const withSignal = valid.filter(a => a.action !== 'HOLD' && a.action !== 'NEUTRAL');
  const buys = withSignal.filter(a => a.action === 'BUY' || a.action === 'CALL').length;
  const sells = withSignal.filter(a => a.action === 'SELL' || a.action === 'PUT').length;
  const total = valid.length;
  const directional = buys + sells;
  // Sentiment measures the direction of ACTIVE signals only — HOLD verdicts
  // don't count as bearish/bullish, so a quiet market reads "Neutral".
  const bullishPct = directional ? Math.round((buys / directional) * 100) : 50;
  const avgConf = withSignal.length
    ? Math.round(withSignal.reduce((s, a) => s + a.confidence, 0) / withSignal.length)
    : 0;
  const rrVals = withSignal.map(a => a.riskReward).filter(v => v !== null);
  const avgRR = rrVals.length ? (rrVals.reduce((a, b) => a + b, 0) / rrVals.length).toFixed(2) : '—';
  const highConviction = withSignal.filter(a => a.quality === 'HIGH').length;
  return {
    total,
    buys,
    sells,
    holds: total - buys - sells,
    directional,
    highConviction,
    bullishPct,
    sentiment: bullishPct >= 55 ? 'Bullish' : bullishPct <= 35 ? 'Bearish' : 'Neutral',
    avgConfidence: avgConf,
    avgRiskReward: avgRR,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { analyzeSymbol, summarize };