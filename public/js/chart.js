/* ============ MI live chart — real OHLCV from Binance via server ============ */
(function () {
  'use strict';

  const state = {
    symbol: 'BTCUSDT',
    tf: '15m',
    candles: [],
    show: { ema: true, bb: true, vol: true, rsi: true, macd: true },
    hover: -1,
  };

  let canvas, ctx, wrap, tooltip;

  // ------------------------------------------------ indicator maths (mirrors server engine)
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
    for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= p) s -= v[i - p]; if (i >= p - 1) out[i] = s / p; }
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
  // data fetch
  async function loadCandles() {
    try {
      const res = await MI.api.get('/api/market/klines?symbol=' + state.symbol + '&interval=' + state.tf + '&limit=300');
      state.candles = res.candles || [];
      draw();
    } catch (err) {
      MI.toast('error', 'Chart data error', err.message);
    }
  }

  function onMarket(update) {
    const price = update.prices[state.symbol];
    if (!price || !state.candles.length) return;
    const last = state.candles[state.candles.length - 1];
    last.close = price;
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    requestAnimationFrame(draw);
  }
// ------------------------------------------------ drawing helpers
  function fmtP(v) {
    if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (v >= 1) return v.toFixed(2);
    return v.toFixed(5);
  }

  function roundRect(x, y, w, h, r) {
    if (!ctx.roundRect) { ctx.fillRect(x, y, w, h); return; }
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
  }

  function drawLine(arr, yMap) {
    const n = state.candles.length;
    const spacing = (canvas.width - 128) / n;
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      if (arr[i] === null) { started = false; continue; }
      const x = 64 + spacing * i + spacing / 2;
      const y = yMap(arr[i]);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function macdScale(closes, macdVals) {
    let mx = 0.0001;
    for (let i = 0; i < closes.length; i++) {
      if (macdVals.hist[i] !== null) mx = Math.max(mx, Math.abs(macdVals.hist[i]), Math.abs(macdVals.line[i] || 0), Math.abs(macdVals.sig[i] || 0));
    }
    return mx;
  }

  function drawMacdLines(x0, spacing, macdY, macdH, closes, macdVals) {
    const scale = macdScale(closes, macdVals);
    const zeroY = macdY + macdH / 2;
    const n = closes.length;
    const yOf = (v) => zeroY - (v / scale) * (macdH * 0.42);
    // macd line
    ctx.strokeStyle = '#06b6d4'; ctx.lineWidth = 1.1; ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      if (macdVals.line[i] === null) { started = false; continue; }
      const x = x0 + spacing * i + spacing / 2;
      const y = yOf(macdVals.line[i]);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // signal line
    ctx.strokeStyle = '#f59e0b'; ctx.beginPath();
    started = false;
    for (let i = 0; i < n; i++) {
      if (macdVals.sig[i] === null) { started = false; continue; }
      const x = x0 + spacing * i + spacing / 2;
      const y = yOf(macdVals.sig[i]);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // zero line
    ctx.strokeStyle = 'rgba(42,58,80,.7)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, zeroY); ctx.lineTo(x0 + spacing * n, zeroY); ctx.stroke();
  }

  function drawRsiZones(x0, spacing, rsiY, rsiH, rsiVals) {
    const n = rsiVals.length;
    // 70 / 30 guide lines
    ctx.strokeStyle = 'rgba(239,68,68,.35)'; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(x0, rsiY + rsiH * 0.3); ctx.lineTo(x0 + spacing * n, rsiY + rsiH * 0.3); ctx.stroke();
    ctx.strokeStyle = 'rgba(16,185,129,.35)';
    ctx.beginPath(); ctx.moveTo(x0, rsiY + rsiH * 0.7); ctx.lineTo(x0 + spacing * n, rsiY + rsiH * 0.7); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '9px Consolas'; ctx.fillStyle = 'rgba(159,177,201,.6)'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('70', x0 + 2, rsiY + rsiH * 0.3 + 8);
    ctx.fillText('30', x0 + 2, rsiY + rsiH * 0.7 + 8);
  }
// ------------------------------------------------ main draw
  function draw() {
    if (!canvas) return;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const candles = state.candles;
    if (!candles.length) return;

    const x0 = 64, x1 = W - 64, pw = x1 - x0;
    const y0 = 28;
    const avail = H - 24 - 22 - 42; // top pad, bottom time labels, 3 gaps
    const priceH = Math.round(avail * 0.55);
    const volH = state.show.vol ? Math.round(avail * 0.09) : 0;
    const rsiH = state.show.rsi ? Math.round(avail * 0.15) : 0;
    const macdH = state.show.macd ? Math.round(avail * 0.15) : 0;
    const gap = 14;

    const n = candles.length;
    const spacing = pw / n;
    const cw = Math.max(2, Math.min(14, spacing * 0.62));
    const highs = candles.map(c => c.high), lows = candles.map(c => c.low);
    let minP = Math.min(...lows), maxP = Math.max(...highs);
    const rng = (maxP - minP) || 1;
    minP -= rng * 0.06; maxP += rng * 0.06;
    const pr = maxP - minP;
    const yP = (v) => y0 + ((maxP - v) / pr) * priceH;

    // grid + price labels
    ctx.font = '10px Consolas, monospace';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 5; i++) {
      const gy = y0 + (priceH / 5) * i;
      const p = maxP - (pr / 5) * i;
      ctx.strokeStyle = 'rgba(42,58,80,.3)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x0, gy); ctx.lineTo(x1, gy); ctx.stroke();
      ctx.fillStyle = 'rgba(159,177,201,.75)'; ctx.textAlign = 'left';
      ctx.fillText(fmtP(p), x1 + 6, gy);
    }
    ctx.textAlign = 'center';
    const labelEvery = Math.max(1, Math.floor(n / 8));
    for (let i = 0; i < n; i += labelEvery) {
      const x = x0 + spacing * i + spacing / 2;
      const t = new Date(candles[i].openTime);
      const label = state.tf === '1d'
        ? (t.getUTCMonth() + 1) + '/' + t.getUTCDate()
        : t.toUTCString().split(' ')[4].slice(0, 5);
      ctx.fillStyle = 'rgba(159,177,201,.6)';
      ctx.fillText(label, x, y0 + priceH + 14);
    }

    // indicators data
    const closes = candles.map(c => c.close);
    const e9 = state.show.ema ? emaArr(closes, 9) : null;
    const e21 = state.show.ema ? emaArr(closes, 21) : null;
    const e50 = state.show.ema ? emaArr(closes, 50) : null;
    const bb = state.show.bb ? bollArr(closes) : null;
    const rsiVals = state.show.rsi ? rsiArr(closes) : null;
    const macdVals = state.show.macd ? macdArr(closes) : null;

    let vMax = 1;
    if (volH) vMax = Math.max(...candles.map(c => c.volume));
    const volTop = y0 + priceH + gap;
    const rsiY = volTop + volH + gap;
    const macdY = rsiY + rsiH + gap;

    // candles + volume + rsi + macd hist
    candles.forEach((c, i) => {
      const x = x0 + spacing * i + spacing / 2;
      const isUp = c.close >= c.open;
      const col = isUp ? '#10b981' : '#ef4444';
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, yP(c.high)); ctx.lineTo(x, yP(c.low)); ctx.stroke();
      const oy = yP(c.open), cy = yP(c.close);
      ctx.fillStyle = isUp ? 'rgba(16,185,129,.95)' : 'rgba(239,68,68,.95)';
      roundRect(x - cw / 2, Math.min(oy, cy), cw, Math.max(Math.abs(cy - oy), 1.5), 2);
      ctx.fill();
      if (volH) {
        const vh = (c.volume / vMax) * volH;
        ctx.fillStyle = isUp ? 'rgba(16,185,129,.5)' : 'rgba(239,68,68,.5)';
        ctx.fillRect(x - cw / 2, volTop + volH - vh, cw, vh);
      }
      if (rsiVals && i > 0 && rsiVals[i] !== null && rsiVals[i - 1] !== null) {
        const y = (v) => rsiY + ((100 - v) / 100) * rsiH;
        ctx.strokeStyle = rsiVals[i] > 70 ? '#ef4444' : rsiVals[i] < 30 ? '#10b981' : '#06b6d4';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x - spacing, y(rsiVals[i - 1]));
        ctx.lineTo(x, y(rsiVals[i]));
        ctx.stroke();
      }
      if (macdVals && macdVals.hist[i] !== null) {
        const scale = macdScale(closes, macdVals);
        const zeroY = macdY + macdH / 2;
        const hh = Math.max(1, Math.abs(macdVals.hist[i] / scale) * macdH * 0.36);
        ctx.fillStyle = macdVals.hist[i] >= 0 ? 'rgba(16,185,129,.65)' : 'rgba(239,68,68,.65)';
        ctx.fillRect(x - cw / 2, macdVals.hist[i] >= 0 ? zeroY - hh : zeroY, cw, hh);
      }
    });

    // sub-panel separators + circles
    if (volH) { ctx.strokeStyle = 'rgba(42,58,80,.5)'; ctx.beginPath(); ctx.moveTo(x0, volTop); ctx.lineTo(x1, volTop); ctx.stroke(); }
    if (rsiVals) drawRsiZones(x0, spacing, rsiY, rsiH, rsiVals);
    if (macdVals) drawMacdLines(x0, spacing, macdY, macdH, closes, macdVals);

    // overlays
    if (bb) {
      ctx.strokeStyle = 'rgba(139,92,246,.5)'; drawLine(bb.up, yP);
      ctx.strokeStyle = 'rgba(139,92,246,.5)'; drawLine(bb.lo, yP);
    }
    if (e9) { ctx.strokeStyle = '#06b6d4'; drawLine(e9, yP); }
    if (e21) { ctx.strokeStyle = '#f59e0b'; drawLine(e21, yP); }
    if (e50) { ctx.strokeStyle = '#8b5cf6'; drawLine(e50, yP); }

    // current price line + label
    const lastC = candles[n - 1];
    const lastY = yP(lastC.close);
    ctx.setLineDash([5, 4]); ctx.strokeStyle = '#06b6d4'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, lastY); ctx.lineTo(x1, lastY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#06b6d4'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(fmtP(lastC.close), x1 + 6, lastY);

    // % change
    const firstC = candles[0].close;
    const chg = ((lastC.close - firstC) / firstC) * 100;
    ctx.fillStyle = chg >= 0 ? '#10b981' : '#ef4444';
    ctx.fillText((chg >= 0 ? '+' : '') + chg.toFixed(2) + '%', x0 + 2, 12);

    drawHover(x0, spacing, volTop, volH, rsiY, rsiH, macdY, macdH, x1);
  }
// ------------------------------------------------ crosshair + tooltip
  function drawHover(x0, spacing, volTop, volH, rsiY, rsiH, macdY, macdH, x1) {
    if (state.hover < 0 || !state.candles.length) return;
    const i = state.hover;
    const c = state.candles[i];
    const x = x0 + spacing * i + spacing / 2;
    const closes = state.candles.map(k => k.close);
    ctx.strokeStyle = 'rgba(255,255,255,.35)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, 24); ctx.lineTo(x, volTop + volH + (rsiValsVisible() ? rsiH + 14 : 0) + (macdValsVisible() ? macdH : 0)); ctx.stroke();
    ctx.setLineDash([]);

    // hover marker on candle
    const maxP = maxPrice(), minP = minPrice();
    const pr = maxP - minP;
    const y = 28 + ((maxP - c.close) / pr) * priceHeight();
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = c.close >= c.open ? '#10b981' : '#ef4444';
    ctx.fill();

    // tooltip content
    const r = rsiArr(closes), m = macdArr(closes);
    let html = '<div style="font-weight:800;margin-bottom:4px">' + new Date(c.openTime).toUTCString() + '</div>' +
      'O <b>' + fmtP(c.open) + '</b>  H <b>' + fmtP(c.high) + '</b><br>' +
      'L <b>' + fmtP(c.low) + '</b>  C <b>' + fmtP(c.close) + '</b><br>' +
      'Vol <b>' + c.volume.toLocaleString('en-US', { maximumFractionDigits: 0 }) + '</b>';
    if (state.show.rsi && r[i] !== null) html += '<br>RSI(14) <b>' + r[i].toFixed(1) + '</b>';
    if (state.show.macd && m.hist[i] !== null) html += ' · MACD <b>' + m.hist[i].toFixed(2) + '</b>';
    tooltip.innerHTML = html;

    // position tooltip near cursor (stored from mousemove)
    const evt = lastMouse;
    if (evt) {
      tooltip.style.left = Math.min(evt.clientX - wrapRect().left + 18, wrapRect().width - 230) + 'px';
      tooltip.style.top = Math.max(8, evt.clientY - wrapRect().top - 90) + 'px';
    }
  }

  let lastMouse = null;
  function wrapRect() { return wrap.getBoundingClientRect(); }
  function maxPrice() { return Math.max(...state.candles.map(c => c.high)); }
  function minPrice() { return Math.min(...state.candles.map(c => c.low)); }
  function priceHeight() { return Math.round(canvas.height * 0.52); }
  function rsiValsVisible() { return state.show.rsi; }
  function macdValsVisible() { return state.show.macd; }

  // ------------------------------------------------ resize / events
  function resize() {
    const rect = wrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    draw();
  }

  function setupEvents() {
    canvas.addEventListener('mousemove', (e) => {
      const rect = wrapRect();
      lastMouse = e;
      const x = (e.clientX - rect.left) * (canvas.width / rect.width / (window.devicePixelRatio || 1));
      const x0 = 64;
      const spacing = (canvas.width / (window.devicePixelRatio || 1) - 128) / state.candles.length;
      const idx = Math.floor((x - x0) / spacing);
      state.hover = (idx >= 0 && idx < state.candles.length) ? idx : -1;
      tooltip.classList.toggle('hidden', state.hover < 0);
      draw();
    });
    canvas.addEventListener('mouseleave', () => {
      state.hover = -1;
      tooltip.classList.add('hidden');
      draw();
    });
    window.addEventListener('resize', resize);

    // symbol selector
    const sel = document.getElementById('chartSymbol');
    if (sel) sel.addEventListener('change', () => { state.symbol = sel.value; loadCandles(); });

    // timeframe buttons
    document.querySelectorAll('#chartTimeframes button').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#chartTimeframes button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        state.tf = b.dataset.tf;
        loadCandles();
      });
    });

    // indicator toggles
    document.querySelectorAll('#chartIndicators button').forEach(b => {
      b.addEventListener('click', () => {
        const key = { ema: 'ema', bb: 'bb', vol: 'vol', rsi: 'rsi', macd: 'macd' }[b.dataset.ind];
        state.show[key] = !state.show[key];
        b.classList.toggle('active');
        draw();
      });
    });
  }

  // ------------------------------------------------ init / export
  function init() {
    canvas = document.getElementById('chart');
    wrap = document.getElementById('chart') ? canvas.parentElement : null;
    tooltip = document.getElementById('chartTooltip');
    if (!canvas || !tooltip) return;
    ctx = canvas.getContext('2d');
    resize();
    setupEvents();
    // initial symbol selection from server config (app.js passes symbols)
    if (window.MI && MI.config && MI.config.symbols) populateSymbols(MI.config.symbols);
    loadCandles();
  }

  function populateSymbols(symbols) {
    const sel = document.getElementById('chartSymbol');
    const alertSel = document.getElementById('alertSymbol');
    const addSel = document.getElementById('addSymbol');
    const calcSel = document.getElementById('calcSymbol');
    const opts = symbols.map(s =>
      '<option value="' + s + '">' + s.replace(/USDT$/, '/USDT') + '</option>').join('');
    if (sel) sel.innerHTML = opts;
    if (alertSel) alertSel.innerHTML = opts;
    if (addSel) { addSel.innerHTML = opts; }
    if (calcSel) { calcSel.innerHTML = opts; }
  }

  window.MIChart = {
    init, populateSymbols, loadCandles, onMarket,
    setSymbol: function (s) { state.symbol = s; loadCandles(); },
    getSymbol: function () { return state.symbol; },
  };
})();