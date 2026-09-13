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
function resampleHourly(closes) {
  const out = [];
  for (let i = 0; i + 3 < closes.length; i += 4) {
    out.push((closes[i] + closes[i + 1] + closes[i + 2] + closes[i + 3]) / 4);
  }
  return out;
}

function analyzeSymbol(symbol, klines) {
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

  // ----------------------------------------------------------------------
  // Verdict — confluence score transformed into an actionable signal.
  const action = score >= 25 ? 'BUY' : score <= -25 ? 'SELL' : 'HOLD';
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
  if (action !== 'HOLD') {
    if ((absS >= 40 && dominant >= 5) || absS >= 55) quality = 'HIGH';
    else if (absS >= 28 && dominant >= 4) quality = 'MEDIUM';
    else if (absS >= 25 && dominant >= 3) quality = 'LOW';
  }

  const cap = quality === 'HIGH' ? 97 : quality === 'MEDIUM' ? 90 : 82;
  const rawConf = action === 'HOLD'
    ? Math.round(48 + absS * 0.9)
    : Math.round(52 + Math.min(absS, 80) * 0.9);
  const confidence = action === 'HOLD' ? rawConf : Math.min(cap, rawConf);

  // Trade plan (only when a directional signal exists)
  let entry = price, tp = null, sl = null, rr = null;
  if (action !== 'HOLD' && atrV > 0) {
    const isBuy = action === 'BUY';
    sl = isBuy ? price - atrV * 1.6 : price + atrV * 1.6;
    tp = isBuy ? price + atrV * 2.6 : price - atrV * 2.6;
    rr = round2(Math.abs(tp - price) / Math.abs(price - sl));
  }

  return {
    symbol,
    asset: symbol.replace(/USDT$/, '') + '/USDT',
    price: round2(price),
    time: new Date().toISOString(),
    action,
    confidence,
    entry: round2(entry),
    takeProfit: tp ? round2(tp) : null,
    stopLoss: sl ? round2(sl) : null,
    riskReward: rr,
    duration: action === 'HOLD' ? '—' : '1h – 4h',
    rating: action === 'HOLD' ? '—' : '★'.repeat(Math.min(5, 1 + Math.floor(confidence / 20))),
    trend: trendUp ? 'Uptrend' : trendDown ? 'Downtrend' : 'Sideways',
    rsi: rsiV === null ? null : round2(rsiV),
    atrPct: round2(atrPct),
    volRatio: round2(volRatio),
    support: round2(support),
    resistance: round2(resistance),
    macdState: histNow === null ? '—' : histNow >= 0 ? 'Bullish' : 'Bearish',
    momentum: { m1h: round2(m1h), m6h: round2(m6h), m24h: round2(m24h) },
    rangePosition: round2(rangePos),
    confluence,
    timeframe: '15m + 1h',
    quality,
    bullCount,
    bearCount,
    direction: score >= 0 ? 'bull' : 'bear',
    factors,
    score,
  };
}

function summarize(analyses) {
  const valid = analyses.filter(a => a);
  const withSignal = valid.filter(a => a.action !== 'HOLD');
  const buys = withSignal.filter(a => a.action === 'BUY').length;
  const sells = withSignal.filter(a => a.action === 'SELL').length;
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