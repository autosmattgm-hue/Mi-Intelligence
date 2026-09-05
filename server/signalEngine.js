'use strict';

// MI Signal Engine.
// Combines EMA trend, EMA crossovers, RSI, MACD, Bollinger Bands, ATR and
// volume into a single confluence score that produces BUY / SELL / HOLD
// signals with confidence, take-profit / stop-loss and risk-reward levels.
// Everything is computed from REAL market data.

const { ema, rsi, macd, bollinger, atr } = require('./indicators');

function round2(v) { return Math.round(v * 100) / 100; }
function last(arr) { return arr.length ? arr[arr.length - 1] : null; }

function analyzeSymbol(symbol, klines) {
  if (!klines || klines.length < 60) return null;
  const closes = klines.map(k => k.close);
  const vols = klines.map(k => k.volume);
  const price = last(closes);
  if (!price) return null;

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

  let score = 0;
  const factors = [];

  // 1) Trend (price vs EMA21 vs EMA50)
  const e9Now = last(e9), e21Now = last(e21), e50Now = last(e50);
  const e9Prev = e9.length > 1 ? e9[e9.length - 2] : null;
  const e21Prev = e21.length > 1 ? e21[e21.length - 2] : null;
  const highs = klines.map(k => k.high);
  const lows = klines.map(k => k.low);

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

  const action = score >= 30 ? 'BUY' : score <= -30 ? 'SELL' : 'HOLD';
  const confidence = action === 'HOLD'
    ? Math.round(52 + Math.abs(score) * 0.5)
    : Math.min(97, Math.round(52 + Math.abs(score) * 1.12));

  // Support / resistance from recent extremes (nearest swing levels)
  const recent = klines.slice(-60);
  const support = Math.min(...recent.map(k => k.low));
  const resistance = Math.max(...recent.map(k => k.high));

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
    duration: action === 'HOLD' ? '—' : '4h – 8h',
    rating: action === 'HOLD' ? '—' : '★'.repeat(Math.min(5, 1 + Math.floor(confidence / 20))),
    trend: trendUp ? 'Uptrend' : trendDown ? 'Downtrend' : 'Sideways',
    rsi: rsiV === null ? null : round2(rsiV),
    atrPct: round2(atrPct),
    volRatio: round2(volRatio),
    support: round2(support),
    resistance: round2(resistance),
    macdState: histNow === null ? '—' : histNow >= 0 ? 'Bullish' : 'Bearish',
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
  const bullishPct = total ? Math.round((buys / total) * 100) : 0;
  const avgConf = withSignal.length
    ? Math.round(withSignal.reduce((s, a) => s + a.confidence, 0) / withSignal.length)
    : 0;
  const rrVals = withSignal.map(a => a.riskReward).filter(v => v !== null);
  const avgRR = rrVals.length ? (rrVals.reduce((a, b) => a + b, 0) / rrVals.length).toFixed(2) : '—';
  return {
    total,
    buys,
    sells,
    holds: total - buys - sells,
    bullishPct,
    sentiment: bullishPct >= 55 ? 'Bullish' : bullishPct <= 35 ? 'Bearish' : 'Neutral',
    avgConfidence: avgConf,
    avgRiskReward: avgRR,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { analyzeSymbol, summarize };