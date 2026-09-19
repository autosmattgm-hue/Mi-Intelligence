/* ============ MI Live Chart — professional edition ============
 * Real OHLCV from Binance / CoinMarketCap via the server.
 * Features: candlesticks + volume + RSI + MACD + Stochastic panels,
 * EMA 9/21/50 + Bollinger + daily-anchored VWAP overlays,
 * scroll-to-zoom + drag-to-pan, crosshair, MI signal levels,
 * live info strip (quote / OHLC / 24h / source) and rich tooltip.
 */
(function () {
  'use strict';

  const state = {
    symbol: 'BTCUSDT',
    tf: '15m',
    mode: 'crypto',
    symbols: [],
    candles: [],
    stats: null,
    source: '',
    show: { ema: true, bb: true, vwap: false, vol: true, rsi: true, macd: true, stoch: true },
    hover: -1,
    cross: { x: -1, price: null },
    view: { count: 140, end: 0 },
    drag: { active: false, startX: 0, startEnd: 0, moved: false },
    flash: { ts: 0, up: true },
  };

  let canvas, ctx, wrap, tooltip, lastMouse = null;

  // ============================================ indicator math
  function emaArr(v, p) {
    const out = new Array(v.length).fill(null);
    if (v.length < p) return out;
    const k = 2 / (p + 1);
    let prev = 0;
    for (let i = 0; i < p; i++) prev += v[i];
    prev /= p; out[p - 1] = prev;
    for (let i = p; i < v.length; i++) { prev = v[i] * k + prev * (1 - k); out[i] = prev; }
    return out;
  }

  function smaArr(v, p) {
    const out = new Array(v.length).fill(null);
    if (v.length < p) return out;
    let s = 0;
    for (let i = 0; i < v.length; i++) {
      s += v[i];
      if (i >= p) s -= v[i - p];
      if (i >= p - 1) out[i] = s / p;
    }
    return out;
  }

  function rsiArr(v) {
    const p = 14, out = new Array(v.length).fill(null);
    if (v.length < p + 1) return out;
    let ag = 0, al = 0;
    for (let i = 1; i <= p; i++) { const d = v[i] - v[i - 1]; ag += Math.max(d, 0); al += Math.max(-d, 0); }
    ag /= p; al /= p;
    out[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    for (let i = p + 1; i < v.length; i++) {
      const d = v[i] - v[i - 1];
      ag = (ag * (p - 1) + Math.max(d, 0)) / p;
      al = (al * (p - 1) + Math.max(-d, 0)) / p;
      out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
    return out;
  }

  function bollArr(v) {
    const p = 20, mid = smaArr(v, p), up = new Array(v.length).fill(null), lo = new Array(v.length).fill(null);
    for (let i = p - 1; i < v.length; i++) {
      let s = 0;
      for (let j = i - p + 1; j <= i; j++) { const d = v[j] - mid[i]; s += d * d; }
      const sd = Math.sqrt(s / p);
      up[i] = mid[i] + 2 * sd; lo[i] = mid[i] - 2 * sd;
    }
    return { up, mid, lo };
  }

  function macdArr(v) {
    const fast = emaArr(v, 12), slow = emaArr(v, 26);
    const line = v.map((_, i) => (fast[i] === null || slow[i] === null) ? null : fast[i] - slow[i]);
    const sig = new Array(v.length).fill(null);
    let prev = null;
    for (let i = 0; i < v.length; i++) {
      if (line[i] === null) continue;
      if (prev === null) { prev = line[i]; sig[i] = line[i]; }
      else { prev = line[i] * 0.2 + prev * 0.8; sig[i] = prev; }
    }
    const hist = line.map((x, i) => (x === null || sig[i] === null) ? null : x - sig[i]);
    return { line, sig, hist };
  }
  function macdScale(closes, macdVals) {
    let mx = 0.0001;
    for (let i = 0; i < closes.length; i++) {
      if (macdVals.hist[i] !== null) {
        mx = Math.max(mx, Math.abs(macdVals.hist[i]), Math.abs(macdVals.line[i] || 0), Math.abs(macdVals.sig[i] || 0));
      }
    }
    return mx;
  }

  // Daily-anchored VWAP (resets at each UTC day boundary).
  function vwapArr(candles) {
    const out = new Array(candles.length).fill(null);
    let day = null, cumPV = 0, cumVol = 0;
    for (let i = 0; i < candles.length; i++) {
      const d = new Date(candles[i].openTime).toISOString().slice(0, 10);
      if (d !== day) { day = d; cumPV = 0; cumVol = 0; }
      cumPV += candles[i].close * candles[i].volume;
      cumVol += candles[i].volume;
      out[i] = cumVol > 0 ? cumPV / cumVol : null;
    }
    return out;
  }

  // Stochastic oscillator (14, 3, 3).
  function stochArr(candles) {
    const p = 14, kP = 3, dP = 3;
    const n = candles.length;
    const raw = new Array(n).fill(null);
    const k = new Array(n).fill(null);
    const d = new Array(n).fill(null);
    for (let i = p - 1; i < n; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - p + 1; j <= i; j++) {
        if (candles[j].high > hh) hh = candles[j].high;
        if (candles[j].low < ll) ll = candles[j].low;
      }
      raw[i] = (hh - ll) === 0 ? 50 : ((candles[i].close - ll) / (hh - ll)) * 100;
    }
    for (let i = 0; i < n; i++) {
      if (raw[i] === null) continue;
      let acc = 0, c = 0;
      for (let w = 0; w < kP; w++) {
        const idx = i - w;
        if (idx >= 0 && raw[idx] !== null) { acc += raw[idx]; c++; }
      }
      if (c === kP) k[i] = acc / kP;
    }
    for (let i = 0; i < n; i++) {
      if (k[i] === null) continue;
      let acc = 0, c = 0;
      for (let w = 0; w < dP; w++) {
        const idx = i - w;
        if (idx >= 0 && k[idx] !==null) { acc += k[idx]; c++; }      }
      if (c === dP) d[i] = acc / dP;
    }
    return { k, d, raw };
  }

// ============================================ formatting
  function pricePrec(symbol) {
    const s = String(symbol || '').toUpperCase();
    if (s === 'US500' || s === 'USTEC' || s === 'US30' || s === 'USOIL' || s === 'XAUUSD' || s === 'XAGUSD') return 2;
    if (s.indexOf('JPY') !== -1) return 3;
    if (s.endsWith('USDT')) return 2;
    return 5;
  }
  function fmtP(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    if (state.mode !== 'crypto') return Number(v).toFixed(pricePrec(state.symbol));
    if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (v >= 1) return v.toFixed(2);
    return v.toFixed(5);
  }
  function fmtBig(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    if (v >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T';
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    return '$' + v.toFixed(0);
  }

  // ============================================ layout geometry
  function layout() {
    const W = canvas.width, H = canvas.height;
    const x0 = 58, x1 = W - 10;
    const avail = H - 30;
    const priceH = Math.round(avail * 0.46);
    const volH = state.show.vol ? Math.round(avail * 0.10) : 0;
    const rsiH = state.show.rsi ? Math.round(avail * 0.14) : 0;
    const stochH = state.show.stoch ? Math.round(avail * 0.14) : 0;
    const macdH = state.show.macd ? Math.round(avail * 0.14) : 0;
    const y0 = 14;
    const gap = 12;
    let y = y0 + priceH + gap;
    const volTop = y; y += volH + (volH ? gap : 0);
    const rsiTop = y; y += rsiH + (rsiH ? gap : 0);
    const stochTop = y; y += stochH + (stochH ? gap : 0);
    const macdTop = y;
    return { x0, x1, y0, priceH, volTop, rsiTop, stochTop, macdTop, volH, rsiH, stochH, macdH };
  }

  function visibleRange() {
    const n = state.candles.length;
    if (!n) return { start: 0, end: 0 };
    let count = Math.min(state.view.count, n);
    let end = state.view.end;
    if (end < count) end = count;
    if (end > n) end = n;
    const start = end - count;
    return { start: Math.max(0, start), end };
  }

  // ============================================ data loading
  async function loadCandles() {
    try {
      const res = await MI.api.get('/api/market/klines?symbol=' + state.symbol + '&interval=' + state.tf + '&limit=300');
      state.candles = res.candles || [];
      state.source = res.source || 'binance';
      const n = state.candles.length;
      state.view.count = Math.min(140, n || 140);
      state.view.end = n; // show the latest
      state.stats = (window.MINotify && MINotify.getStats()) || {};
      updateInfo();
      doDraw();
    } catch (err) {
      MI.toast('error', 'Chart data error', err.message);
    }
  }

  // Live price update from SSE — updates the last visible candle.
  function onMarket(update) {
    const price = update.prices[state.symbol];
    if (!price || !state.candles.length) return;
    const last = state.candles[state.candles.length - 1];
    const wasUp = last.close >= last.open;
    last.close = price;
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    if ((price >= last.open) !== wasUp) {
      state.flash = { ts: Date.now(), up: price >= last.open };
    }
    state.stats = update.stats24h || state.stats || {};
    updateInfo();
    requestAnimationFrame(doDraw);
  }

  // Info strip above the chart (quote OHLC, 24h change/volume, market cap, source).
  function updateInfo() {
    const candles = state.candles;
    if (!candles || !candles.length) return;
    const last = candles[candles.length - 1];
    const first = candles[0];
    const isFx = state.mode === 'forex' || (state.mode === 'pocket' && !String(state.symbol).endsWith('USDT'));
    const changePct = first && first.close ? ((last.close - first.close) / first.close) * 100 : 0;
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('ciPrice', (isFx ? '' : '$') + fmtP(last.close));
    set('ciO', fmtP(last.open));
    set('ciH', fmtP(last.high));
    set('ciL', fmtP(last.low));
    set('ciC', fmtP(last.close));
    const chgEl = document.getElementById('ciChg');
    if (chgEl) {
      chgEl.textContent = (changePct >= 0 ? '+' : '') + changePct.toFixed(2) + '%';
      chgEl.style.color = changePct >= 0 ? 'var(--green)' : 'var(--red)';
    }
    const stat = state.stats && state.stats[state.symbol];
    set('ciVol', isFx ? '—' : (stat ? fmtBig(stat.quoteVolume) : '—'));
    set('ciMc', isFx ? 'FX' : (stat ? fmtBig(stat.marketCap) : '—'));
    const srcEl = document.getElementById('ciSrc');
    if (srcEl) {
      const srcMap = { coinmarketcap: 'CMC + Binance', yahoo: 'Yahoo Finance', binance: 'Binance' };
      srcEl.textContent = 'Data: ' + (srcMap[state.source] || state.source || 'Binance');
      srcEl.className = 'ci-src' + (state.source === 'yahoo' ? ' yahoo' : state.source === 'binance' ? ' binance' : '');
    }
  }

  function updateInfoRange(start, end) {
    const candles = state.candles;
    if (!candles || !candles.length) return;
    const visible = candles.slice(start, end);
    if (!visible.length) return;
    const hi = Math.max.apply(null, visible.map(c => c.high));
    const lo = Math.min.apply(null, visible.map(c => c.low));
    const rngH = document.getElementById('ciRngH');
    const rngL = document.getElementById('ciRngL');
    if (rngH) rngH.textContent = fmtP(hi);
    if (rngL) rngL.textContent = fmtP(lo);
  }

  // ============================================ core draw
  // Returns geometry for the visible window (or null when nothing to draw).
  function draw() {
    if (!ctx) return null;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const candles = state.candles;
    if (!candles.length) return null;

    const L = layout();
    const { start, end } = visibleRange();
    const visC = candles.slice(start, end);
    if (!visC.length) return null;
    const n = visC.length;
    const x0 = L.x0, x1 = L.x1;
    const pw = x1 - x0;
    const spacing = pw / n;
    const cw = Math.max(2, Math.min(16, spacing * 0.62));
    let minP = Math.min.apply(null, visC.map(c => c.low));
    let maxP = Math.max.apply(null, visC.map(c => c.high));
    const rng = (maxP - minP) || 1;
    minP -= rng * 0.06; maxP += rng * 0.06;
    const pr = maxP - minP;
    const yP = v => L.y0 + ((maxP - v) / pr) * L.priceH;

    const geo = {
      visC, start, end, n, spacing, cw, x0, x1, pr, maxP, minP, yP, L,
      cross: state.cross, show: state.show,
    };

    // grid + y-axis price labels
    ctx.font = '10px Consolas, monospace';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 5; i++) {
      const gy = L.y0 + (L.priceH / 5) * i;
      const p = maxP - (pr / 5) * i;
      ctx.strokeStyle = 'rgba(42,58,80,.3)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x0, gy); ctx.lineTo(x1, gy); ctx.stroke();
      ctx.fillStyle = 'rgba(159,177,201,.8)';
      ctx.textAlign = 'left';
      ctx.fillText(fmtP(p), x1 + 6, gy);
    }

    // x-axis time labels
    ctx.textAlign = 'center';
    const labelEvery = Math.max(1, Math.round(n / 8));
    for (let i = start; i < end; i += labelEvery) {
      const x = x0 + spacing * (i - start) + spacing / 2;
      const t = new Date(candles[i].openTime);
      let label;
      if (state.tf === '1d') label = (t.getUTCMonth() + 1) + '/' + t.getUTCDate();
      else if (state.tf === '4h' || state.tf === '1h') label = t.toUTCString().split(' ')[4].slice(0, 5) + ' ' + t.toUTCString().split(' ')[1];
      else label = t.toUTCString().split(' ')[4].slice(0, 5);
      ctx.fillStyle = 'rgba(159,177,201,.6)';
      ctx.fillText(label, x, L.y0 + L.priceH + 15);
    }
    return geo;
  }

  // ------------------------------------------------ candles + volume
  function drawCandles(geo) {
    const { visC, n, spacing, cw, x0, L } = geo;
    let vMax = 1;
    if (L.volH) vMax = Math.max.apply(null, visC.map(c => c.volume)) || 1;
    const volTop = L.volTop, volH = L.volH;

    for (let k = 0; k < n; k++) {
      const c = visC[k];
      const x = x0 + spacing * k + spacing / 2;
      const isUp = c.close >= c.open;
      const col = isUp ? '#10b981' : '#ef4444';
      // wick
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, geo.yP(c.high)); ctx.lineTo(x, geo.yP(c.low)); ctx.stroke();
      // body
      const oy = geo.yP(c.open), cy = geo.yP(c.close);
      ctx.fillStyle = isUp ? 'rgba(16,185,129,.95)' : 'rgba(239,68,68,.95)';
      ctx.beginPath();
      const bodyTop = Math.min(oy, cy), bodyH = Math.max(Math.abs(cy - oy), 1.5);
      if (ctx.roundRect) ctx.roundRect(x - cw / 2, bodyTop, cw, bodyH, 2);
      else ctx.rect(x - cw / 2, bodyTop, cw, bodyH);
      ctx.fill();
      // volume gradient histogram
      if (volH) {
        const vh = (c.volume / vMax) * volH;
        const grad = ctx.createLinearGradient(0, volTop, 0, volTop + volH);
        if (isUp) { grad.addColorStop(0, 'rgba(16,185,129,.75)'); grad.addColorStop(1, 'rgba(16,185,129,.08)'); }
ctx.fillRect(x - cw / 2, volTop + volH - vh, cw, vh);
      }
    }
  }

// ------------------------------------------------ overlays (EMA / BB / VWAP)
  function drawOverlays(geo) {
    const closes = geo.visC.map(c => c.close);
    const e9 = geo.show.ema ? emaArr(closes, 9) : null;
    const e21 = geo.show.ema ? emaArr(closes, 21) : null;
    const e50 = geo.show.ema ? emaArr(closes, 50) : null;
    const bb = geo.show.bb ? bollArr(closes) : null;
    const vwap = geo.show.vwap ? vwapArr(geo.visC) : null;

    const line = (arr, style, width) => {
      if (!arr) return;
      ctx.strokeStyle = style; ctx.lineWidth = width || 1.2;
      ctx.beginPath();
      let started = false;
      for (let k = 0; k < arr.length; k++) {
        if (arr[k] === null) { started = false; continue; }
        const x = geo.x0 + geo.spacing * k + geo.spacing / 2;
        const y = geo.yP(arr[k]);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };

    if (geo.show.bb) { line(bb.up, 'rgba(139,92,246,.45)', 1); line(bb.lo, 'rgba(139,92,246,.45)', 1); }
    if (geo.show.vwap) line(vwap, 'rgba(245,158,11,.85)', 1.4);
    if (geo.show.ema) {
      line(e9, 'rgba(6,182,212,.9)', 1.1);
      line(e21, 'rgba(245,158,11,.9)', 1.1);
      line(e50, 'rgba(139,92,246,.9)', 1.1);
    }
  }

  // ------------------------------------------------ RSI panel
  function drawRSI(geo) {
    const rTop = geo.L.rsiTop, rH = geo.L.rsiH;
    const vals = rsiArr(geo.visC.map(c => c.close));
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(239,68,68,.4)';
    ctx.beginPath(); ctx.moveTo(geo.x0, rTop + rH * 0.3); ctx.lineTo(geo.x1, rTop + rH * 0.3); ctx.stroke();
    ctx.strokeStyle = 'rgba(16,185,129,.4)';
    ctx.beginPath(); ctx.moveTo(geo.x0, rTop + rH * 0.7); ctx.lineTo(geo.x1, rTop + rH * 0.7); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '9px Consolas'; ctx.fillStyle = 'rgba(159,177,201,.7)'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('70', geo.x0 + 2, rTop + rH * 0.3 + 7);
    ctx.fillText('30', geo.x0 + 2, rTop + rH * 0.7 + 7);

    ctx.strokeStyle = '#a78bfa'; ctx.lineWidth = 1.2; ctx.beginPath();
    let started = false;
    for (let k = 0; k < vals.length; k++) {
      if (vals[k] === null) { started = false; continue; }
      const x = geo.x0 + geo.spacing * k + geo.spacing / 2;
      const y = rTop + ((100 - vals[k]) / 100) * rH;
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    const lv = vals[vals.length - 1];
    if (lv != null) {
      ctx.fillStyle = lv > 70 ? '#f87171' : lv < 30 ? '#34d399' : '#a78bfa';
      ctx.font = 'bold 10px Consolas'; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
      ctx.fillText('RSI ' + lv.toFixed(1), geo.x1 - 2, rTop + 8);
    }
  }

  // ------------------------------------------------ Stochastic panel
  function drawStoch(geo) {
    const sTop = geo.L.stochTop, sH = geo.L.stochH;
    const st = stochArr(geo.visC);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(239,68,68,.35)';
    ctx.beginPath(); ctx.moveTo(geo.x0, sTop + sH * 0.2); ctx.lineTo(geo.x1, sTop + sH * 0.2); ctx.stroke();
    ctx.strokeStyle = 'rgba(16,185,129,.35)';
    ctx.beginPath(); ctx.moveTo(geo.x0, sTop + sH * 0.8); ctx.lineTo(geo.x1, sTop + sH * 0.8); ctx.stroke();
    ctx.setLineDash([]);
    const yOf = v => sTop + ((100 - v) / 100) * sH;
    const poly = (arr, style) => {
      ctx.strokeStyle = style; ctx.lineWidth = 1.1; ctx.beginPath();
      let started = false;
      for (let k = 0; k < arr.length; k++) {
        if (arr[k] === null) { started = false; continue; }
        const x = geo.x0 + geo.spacing * k + geo.spacing / 2;
        if (!started) { ctx.moveTo(x, yOf(arr[k])); started = true; } else ctx.lineTo(x, yOf(arr[k]));
      }
      ctx.stroke();
    };
    poly(st.k, '#f59e0b');
    poly(st.d, '#06b6d4');
    const lk = st.k[st.k.length - 1];
    if (lk != null) {
      ctx.fillStyle = '#f59e0b'; ctx.font = 'bold 10px Consolas'; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
      ctx.fillText('Stoch ' + lk.toFixed(1), geo.x1 - 2, sTop + 8);
    }
  }

  // ------------------------------------------------ MACD panel
  function drawMACD(geo) {
    const mTop = geo.L.macdTop, mH = geo.L.macdH;
    const closes = geo.visC.map(c => c.close);
    const m = macdArr(closes);
    const scale = macdScale(closes, m);
    const zeroY = mTop + mH / 2;
    const yOf = v => zeroY - (v / scale) * (mH * 0.42);

    for (let k = 0; k < m.hist.length; k++) {
      if (m.hist[k] === null) continue;
      const x = geo.x0 + geo.spacing * k + geo.spacing / 2;
      const hh = Math.max(1, Math.abs(m.hist[k] / scale) * mH * 0.36);
      ctx.fillStyle = m.hist[k] >= 0 ? 'rgba(16,185,129,.6)' : 'rgba(239,68,68,.6)';
      ctx.fillRect(x - geo.cw / 2, m.hist[k] >= 0 ? zeroY - hh : zeroY, geo.cw, hh);
    }
    const poly = (arr, style) => {
      ctx.strokeStyle = style; ctx.lineWidth = 1.1; ctx.beginPath();
      let started = false;
      for (let k = 0; k < arr.length; k++) {
        if (arr[k] === null) { started = false; continue; }
        const x = geo.x0 + geo.spacing * k + geo.spacing / 2;
        if (!started) { ctx.moveTo(x, yOf(arr[k])); started = true; } else ctx.lineTo(x, yOf(arr[k]));
      }
      ctx.stroke();
    };
    poly(m.line, '#06b6d4');
    poly(m.sig, '#f59e0b');
    ctx.strokeStyle = 'rgba(42,58,80,.7)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(geo.x0, zeroY); ctx.lineTo(geo.x1, zeroY); ctx.stroke();
const lh = m.hist[m.hist.length - 1];
    if (lh != null) {
      ctx.fillStyle = lh >= 0 ? '#34d399' : '#f87171';
      ctx.font = 'bold 10px Consolas'; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
      ctx.fillText('MACD ' + lh.toFixed(2), geo.x1 - 2, mTop + 8);
    }
  }

// ------------------------------------------------ MI signal levels overlay
  function drawSignalLevels(geo) {
    let sig = null;
    try {
      sig = (window.MISignals && MISignals.state.signals.find(s => s.symbol === state.symbol)) || null;
    } catch { sig = null; }
    if (!sig) return;
    const levels = [];
    if (sig.entry != null) levels.push({ label: 'Entry ' + (sig.action === 'BUY' ? '▶' : '▼'), price: sig.entry, color: '#06b6d4' });
    if (sig.takeProfit != null) levels.push({ label: 'TP', price: sig.takeProfit, color: '#10b981' });
    if (sig.stopLoss != null) levels.push({ label: 'SL', price: sig.stopLoss, color: '#ef4444' });
    if (sig.support != null) levels.push({ label: 'Support', price: sig.support, color: '#a78bfa' });
    if (sig.resistance != null) levels.push({ label: 'Resistance', price: sig.resistance, color: '#f59e0b' });

    levels.forEach(lv => {
      if (lv.price == null || lv.price < geo.minP || lv.price > geo.maxP) return;
      const y = geo.yP(lv.price);
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = lv.color; ctx.lineWidth = 1; ctx.globalAlpha = 0.65;
      ctx.beginPath(); ctx.moveTo(geo.x0, y); ctx.lineTo(geo.x1, y); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      ctx.font = 'bold 9px Consolas'; ctx.textBaseline = 'middle';
      const tw = ctx.measureText(lv.label).width + 10;
      const bx = geo.x1 - tw, by = y - 9;
      ctx.fillStyle = lv.color + '22';
      ctx.strokeStyle = lv.color; ctx.lineWidth = 1;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, by, tw, 14, 4); else ctx.rect(bx, by, tw, 14);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = lv.color; ctx.textAlign = 'right';
      ctx.fillText(lv.label, geo.x1 - 5, y);
      ctx.textBaseline = 'alphabetic';
    });
  }

  // ------------------------------------------------ glowing live price line
  function drawLivePrice(geo) {
    const candles = state.candles;
    if (!candles.length) return;
    const lastClose = candles[candles.length - 1].close;
    if (lastClose >= geo.minP && lastClose <= geo.maxP) {
      const y = geo.yP(lastClose);
      ctx.strokeStyle = 'rgba(6,182,212,.85)';
      ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(geo.x0, y); ctx.lineTo(geo.x1, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#06b6d4';
      ctx.font = 'bold 10px Consolas'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(fmtP(lastClose), geo.x1 + 4, y - 6);
    }
    const fl = state.flash;
    if (fl && Date.now() - fl.ts < 1400) {
      const alpha = Math.max(0, 1 - (Date.now() - fl.ts) / 1400) * 0.12;
      if (alpha > 0.01) {
        ctx.fillStyle = (fl.up ? 'rgba(16,185,129,' : 'rgba(239,68,68,') + alpha + ')';
        ctx.fillRect(geo.x0, geo.L.y0, geo.x1 - geo.x0, geo.L.priceH);
      }
    }
  }

  // ------------------------------------------------ crosshair
  function drawCrosshair(geo) {
    if (geo.cross.x < 0) return;
    const cx = geo.cross.x;
    const totalH = geo.L.y0 + geo.L.priceH + geo.L.volH + geo.L.rsiH + geo.L.stochH + geo.L.macdH + 4;
    ctx.strokeStyle = 'rgba(255,255,255,.38)';
    ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(cx, geo.L.y0); ctx.lineTo(cx, totalH); ctx.stroke();
    if (geo.cross.price != null) {
      const clamped = Math.min(Math.max(geo.cross.price, geo.minP), geo.maxP);
      const py = geo.yP(clamped);
      ctx.beginPath(); ctx.moveTo(geo.x0, py); ctx.lineTo(geo.x1, py); ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = 'bold 9px Consolas'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      const tag = ' ' + fmtP(clamped) + ' ';
      const tw = ctx.measureText(tag).width;
      const tx = geo.x0 - tw - 4, ty = py - 9;
      ctx.fillStyle = 'rgba(10,15,26,.92)';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(tx, ty, tw, 15, 3); else ctx.rect(tx, ty, tw, 15);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.3)';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(tx, ty, tw, 15, 3); else ctx.rect(tx, ty, tw, 15);
      ctx.stroke();
      ctx.fillStyle = '#06b6d4';
      ctx.fillText(tag, tx + 2, py - 1);
    }
    ctx.setLineDash([]);
  }

// ------------------------------------------------ hover tooltip
  function drawTooltip(geo) {
    if (state.hover < 0 || !tooltip) { if (tooltip) tooltip.classList.add('hidden'); return; }
    const idx = geo.start + state.hover;
    if (idx < 0 || idx >= state.candles.length) return;
    const c = state.candles[idx];
    const closes = geo.visC.map(k => k.close);
    const local = idx - geo.start;
    const r = rsiArr(closes);
    const m = macdArr(closes);
    const st = stochArr(geo.visC);
    const ttR = r[local];
    const ttM = m.hist[local];
    const ttK = st.k[local];

    let html =
      '<div class="tt-title">' + new Date(c.openTime).toUTCString().replace(' GMT', '') + '</div>' +
      '<div class="tt-row"><span class="tt-k">Open</span><span class="tt-v ' + (c.close >= c.open ? 'green' : 'red') + '">' + fmtP(c.open) + '</span></div>' +
      '<div class="tt-row"><span class="tt-k">High</span><span class="tt-v green">' + fmtP(c.high) + '</span></div>' +
      '<div class="tt-row"><span class="tt-k">Low</span><span class="tt-v red">' + fmtP(c.low) + '</span></div>' +
      '<div class="tt-row"><span class="tt-k">Close</span><span class="tt-v ' + (c.close >= c.open ? 'green' : 'red') + '">' + fmtP(c.close) + '</span></div>' +
      '<div class="tt-row"><span class="tt-k">Volume</span><span class="tt-v">' + c.volume.toLocaleString('en-US', { maximumFractionDigits: 0 }) + '</span></div>';
    if (geo.show.rsi && ttR != null) html += '<div class="tt-row"><span class="tt-k">RSI(14)</span><span class="tt-v purple">' + ttR.toFixed(1) + '</span></div>';
    if (geo.show.macd && ttM != null) html += '<div class="tt-row"><span class="tt-k">MACD</span><span class="tt-v ' + (ttM >= 0 ? 'green' : 'red') + '">' + ttM.toFixed(3) + '</span></div>';
    if (geo.show.stoch && ttK != null) html += '<div class="tt-row"><span class="tt-k">Stoch %K</span><span class="tt-v gold">' + ttK.toFixed(1) + '</span></div>';

    tooltip.innerHTML = html;
    const evt = lastMouse;
    if (evt && wrap) {
      const rect = wrap.getBoundingClientRect();
      const x = evt.clientX - rect.left + 18;
      const y = evt.clientY - rect.top - 90;
      tooltip.style.left = Math.min(Math.max(8, x), rect.width - 210) + 'px';
      tooltip.style.top = Math.max(8, y) + 'px';
      tooltip.classList.remove('hidden');
    } else {
      tooltip.classList.add('hidden');
    }
  }

  // ------------------------------------------------ legend
  function drawLegend(geo) {
    let lx = geo.x0 + 4;
    const ly = geo.L.y0 + geo.L.priceH + (geo.L.volH ? geo.L.volH + 22 : 30);
    ctx.font = '9px Consolas'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    const items = [];
    if (geo.show.ema) { items.push(['EMA 9', '#06b6d4']); items.push(['EMA 21', '#f59e0b']); items.push(['EMA 50', '#8b5cf6']); }
    if (geo.show.bb) items.push(['BB(20,2)', '#a78bfa']);
    if (geo.show.vwap) items.push(['VWAP', '#f59e0b']);
    const first = state.candles[0];
    const last = state.candles[state.candles.length - 1];
    const chg = first && last ? ((last.close - first.close) / first.close) * 100 : 0;
    items.push([(chg >= 0 ? '▲ ' : '▼ ') + Math.abs(chg).toFixed(2) + '%', chg >= 0 ? '#10b981' : '#ef4444']);
    items.forEach(it => {
      ctx.fillStyle = it[1];
      ctx.fillText(it[0], lx, ly);
      lx += ctx.measureText(it[0]).width + 18;
    });
  }

  // ------------------------------------------------ full compose
  function doDraw() {
    const geo = draw();
    if (!geo) return;
    drawCandles(geo);
    drawOverlays(geo);
    if (geo.show.rsi) drawRSI(geo);
    if (geo.show.stoch) drawStoch(geo);
    if (geo.show.macd) drawMACD(geo);
    drawSignalLevels(geo);
    drawLivePrice(geo);
    if (geo.cross.x >= 0) drawCrosshair(geo);
    updateInfoRange(geo.start, geo.end);
    drawLegend(geo);
    drawTooltip(geo);
  }

// ============================================ viewport / interactions
  // Scroll-to-zoom (mouse wheel) — keeps the anchored bar centred.
  function onWheel(e) {
    if (!state.candles.length) return;
    e.preventDefault();
    const dir = e.deltaY > 0 ? -1 : 1; // wheel down → zoom out
    const n = state.candles.length;
    const current = Math.min(state.view.count, n);
    let next = Math.round(current * (dir > 0 ? 1.3 : 1 / 1.3));
    next = Math.max(30, Math.min(n, next));
    if (next === current) return;

    const rect = canvas.getBoundingClientRect();
    const mx = lastMouse ? lastMouse.clientX - rect.left : rect.width / 2;
    const x0 = 58, x1 = canvas.width / (window.devicePixelRatio || 1) - 10;
    const frac = Math.min(1, Math.max(0, (mx - x0) / (x1 - x0)));
    const anchorPriceBarIdx = state.view.end - Math.round((1 - frac) * current);

    state.view.count = next;
    let newEnd = anchorPriceBarIdx + Math.round((1 - frac) * next);
    newEnd = Math.max(next, Math.min(n, newEnd));
    state.view.end = newEnd;
    doDraw();
  }

  // Drag-to-pan
  function onMouseDown(e) {
    state.drag.active = true;
    state.drag.startX = e.clientX;
    state.drag.startEnd = state.view.end;
    state.drag.moved = false;
  }

  function onMouseMove(e) {
    const rect = wrapRect();
    lastMouse = e;
    const scale = (canvas.width / (window.devicePixelRatio || 1)) / rect.width;
    const x = (e.clientX - rect.left) * scale;

    if (state.drag.active) {
      const dxPx = e.clientX - state.drag.startX;
      if (Math.abs(dxPx) > 3) state.drag.moved = true;
      const n = state.candles.length;
      const count = Math.min(state.view.count, n);
      const spacing = (canvas.width / (window.devicePixelRatio || 1) - 68) / count;
      const bars = Math.round(dxPx / spacing);
      const newEnd = Math.max(count, Math.min(n, state.drag.startEnd - bars));
      state.view.end = newEnd;
    } else {
      const x0 = 58;
      const { start, end } = visibleRange();
      const n = end - start;
      const spacing = (canvas.width / (window.devicePixelRatio || 1) - 68) / n;
      const idx = start + Math.floor((x - x0) / spacing);
      state.hover = (idx >= start && idx < end) ? (idx - start) : -1;
      state.cross.x = x;
      const L = layout();
      const y = (e.clientY - rect.top) * scale;
      if (y >= L.y0 && y <= L.y0 + L.priceH) {
        const visC = state.candles.slice(start, end);
        let minP = Math.min.apply(null, visC.map(c => c.low));
        let maxP = Math.max.apply(null, visC.map(c => c.high));
        const rng = (maxP - minP) || 1;
        minP -= rng * 0.06; maxP += rng * 0.06;
        const pr = maxP - minP;
        state.cross.price = maxP - ((y - L.y0) / L.priceH) * pr;
      } else {
        state.cross.price = null;
      }
    }
    doDraw();
  }

  function onMouseUp() {
    state.drag.active = false;
  }

  function onMouseLeave() {
    if (state.drag.active) return;
    state.hover = -1;
    state.cross = { x: -1, price: null };
    if (tooltip) tooltip.classList.add('hidden');
    doDraw();
  }

  // ============================================ resize / events
  function resize() {
    if (!wrap || !canvas) return;
    const rect = wrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    doDraw();
  }

  function wrapRect() {
    return wrap.getBoundingClientRect();
  }

  function setupEvents() {
    if (!canvas) return;
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('mouseleave', onMouseLeave);
    window.addEventListener('resize', resize);

    bindSymbolChange();

    document.querySelectorAll('#chartTimeframes button').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#chartTimeframes button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        state.tf = b.dataset.tf;
        loadCandles();
      });
    });

    document.querySelectorAll('#chartIndicators button').forEach(b => {
      b.addEventListener('click', () => {
        const key = { ema: 'ema', bb: 'bb', vwap: 'vwap', vol: 'vol', rsi: 'rsi', macd: 'macd', stoch: 'stoch' }[b.dataset.ind];
        if (!key) return;
        state.show[key] = !state.show[key];
        b.classList.toggle('active', state.show[key]);
        resize();
      });
    });
  }

  // ============================================ init / export
  function init() {
    canvas = document.getElementById('chart');
    if (!canvas) return;
    wrap = canvas.parentElement;
    tooltip = document.getElementById('chartTooltip');
    ctx = canvas.getContext('2d');
    setupEvents();
    resize();
    if (window.MI && MI.config && MI.config.symbols) populateSymbols(MI.config.symbols);
    loadCandles();
  }

  // Rebind the symbol dropdown safely (survives populateSymbols() re-fills and
// works on both desktop 'change' and mobile 'input').
  function bindSymbolChange() {
    const sel = document.getElementById('chartSymbol');
    if (!sel || sel.dataset.bound) return;
    sel.dataset.bound = '1';
    const pick = () => {
      const v = sel.value;
      if (v && v !== state.symbol) {
        state.symbol = v;
        loadCandles();
        // Keep the primary signal panel in sync with the chosen currency
        // (users pay 1 coin for each new analysis reveal).
        if (window.MISignals && typeof MISignals.revealSymbol === 'function') MISignals.revealSymbol(v);
        else if (window.MISignals && typeof MISignals.followChart === 'function') MISignals.followChart(v);
      }
    };
    sel.addEventListener('change', pick);
    sel.addEventListener('input', pick);
  }

  function populateSymbols(symbols) {
    state.symbols = (symbols || []).slice();
    const label = (s) => String(s).endsWith('USDT')
      ? String(s).replace(/USDT$/, '/USDT')
      : String(s).replace(/^(.{3})(.{3})$/, '$1/$2');
    const sel = document.getElementById('chartSymbol');
    const alertSel = document.getElementById('alertSymbol');
    const addSel = document.getElementById('addSymbol');
    const calcSel = document.getElementById('calcSymbol');
    const opts = state.symbols.map(s =>
      '<option value="' + s + '">' + label(s) + '</option>').join('');
    if (sel) {
      sel.innerHTML = opts;
      if (state.symbols.includes(state.symbol)) sel.value = state.symbol;
    }
    if (alertSel) alertSel.innerHTML = opts;
    if (addSel) addSel.innerHTML = opts;
    if (calcSel) calcSel.innerHTML = opts;
    bindSymbolChange();
  }

  // Called when the user switches Crypto / Pocket / Forex mode.
  function handleModeChange(mode) {
    state.mode = mode || 'crypto';
    if (window.MI && MI.api) {
      MI.api.get('/api/config').then(cfg => {
        const syms = (cfg && cfg.symbols) || [];
        if (syms.length) populateSymbols(syms);
        const def = mode === 'forex' ? 'EURUSD' : 'BTCUSDT';
        if (!state.symbols.includes(state.symbol)) {
          state.symbol = syms.includes(def) ? def : (syms[0] || 'BTCUSDT');
        }
        loadCandles();
      }).catch(() => {});
    } else {
      loadCandles();
    }
  }

  window.MIChart = {
    init, populateSymbols, loadCandles, doDraw, onMarket, resize, handleModeChange,
    setSymbol: function (s) {
      state.symbol = s;
      loadCandles();
      if (window.MISignals && typeof MISignals.followChart === 'function') MISignals.followChart(s);
    },
    getSymbol: function () { return state.symbol; },
  };
})();
