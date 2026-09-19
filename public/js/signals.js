/* ============ MI signals — stats bar, primary signal panel, signals table ============ */
(function () {
  'use strict';

  const state = {
    signals: [],
    summary: null,
    selected: 'BTCUSDT',
    paperStats: null,
    history: [],
    accuracy: null,
    accuracyHistory: [],
    watchOnly: false,
    newsZone: null,
  };

  function $id(id) { return document.getElementById(id); }
  function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---- signal freshness / validity (how long a signal stays actionable) ----
  function signalValidMs(sig) {
    if (sig && sig.mode === 'pocket') {
      const e = String((sig && sig.expiry) || '5m');
      if (e === '1m') return 6 * 60 * 1000;
      if (e === '15m') return 45 * 60 * 1000;
      return 18 * 60 * 1000;
    }
    return 3 * 3600 * 1000;
  }
  function signalAge(sig) { return Date.now() - new Date((sig && sig.time) || Date.now()).getTime(); }
  function isStale(sig) { return sig && sig.time ? signalAge(sig) > signalValidMs(sig) : false; }
  function remainingLabel(sig) {
    const left = signalValidMs(sig) - signalAge(sig);
    if (left <= 0) return 'STALE — re-evaluate';
    const m = Math.ceil(left / 60000);
    return m <= 60 ? (m + 'm left') : (Math.floor(m / 60) + 'h ' + (m % 60) + 'm left');
  }

  // ---- volatility regime label from ATR% ----
  function regimeLabel(sig) {
    const a = sig && sig.atrPct;
    if (a === null || a === undefined || isNaN(a)) return null;
    if (a < 0.5) return { label: 'LOW vol', cls: 'regime-low' };
    if (a < 1.5) return { label: 'Normal vol', cls: 'regime-med' };
    return { label: 'HIGH vol', cls: 'regime-high' };
  }

  // ---- watchlist (localStorage stars) ----
  function getWatch() { try { return JSON.parse(localStorage.getItem('mi.watch') || '[]'); } catch { return []; } }
  function saveWatch(w) { localStorage.setItem('mi.watch', JSON.stringify(w)); }
  function isWatched(sym) { return getWatch().indexOf(sym) !== -1; }
  function toggleWatch(sym) {
    const w = getWatch();
    const i = w.indexOf(sym);
    if (i === -1) w.push(sym); else w.splice(i, 1);
    saveWatch(w);
    renderTable();
  }

  // ---- coin-gated signal reveal: users see blurred signals until they pay 1 coin.
  // Revealed symbols persist per-device (localStorage) so you don't pay twice.
  const revealed = (() => { try { return JSON.parse(localStorage.getItem('mi.revealed') || '{}'); } catch { return {}; } })();
  function saveRevealed() { try { localStorage.setItem('mi.revealed', JSON.stringify(revealed)); } catch {} }
  function isLocked(sym) { return (window.MI && MI.role === 'user') && !revealed[sym]; }
  function lockVeilHtml(sym) {
    const coins = (window.MI && MI.coins != null) ? MI.coins : 0;
    return '<div class="signal-lock-veil">' +
      '<div class="lock-title">🔒 Signal locked</div>' +
      '<div class="lock-sub">Reveal the full plan for <b>1 🪙</b> — balance: <b>' + coins + '</b></div>' +
      '<button class="login-btn sm" data-unlock="' + esc(sym) + '">' + (coins > 0 ? '🔓 Show signal · 1 coin' : '🪙 Buy coins to reveal') + '</button>' +
      '</div>';
  }
  async function unlockSignal(sym) {
    if (window.MIAuth && window.MIAuth.role && window.MIAuth.role() === 'user') {
      const ok = await window.MIAuth.spend('signal');
      if (!ok) return;
    }
    revealed[sym] = true;
    saveRevealed();
    renderSignalPanel();
    renderTable();
  }

  // ---- economic-news zone (from /api/calendar) ----
  function loadNewsZone() {
    try {
      MI.api.get('/api/calendar').then(c => {
        const now = Date.now();
        state.newsZone = ((c && c.high) || []).find(e => e.time && e.time > now && e.time - now < 30 * 60 * 1000) || null;
        renderSignalPanel();
      }).catch(() => {});
    } catch { /* optional */ }
  }

// ---- timing cache: when to place a trade (from the MI timing engine) ----
  const timingCache = {};   // symbol -> { data, at }
  const timingPending = {};
  function mtLoadTiming(symbol) {
    if (!window.MI || !MI.api) return;
    if (timingPending[symbol]) return;
    const c = timingCache[symbol];
    if (c && Date.now() - c.at < 10 * 60 * 1000) return;
    timingPending[symbol] = true;
    try {
      MI.api.get('/api/timing?symbol=' + encodeURIComponent(symbol)).then(t => {
        timingPending[symbol] = false;
        timingCache[symbol] = { data: t, at: Date.now() };
        renderSignalPanel();
      }).catch(() => { timingPending[symbol] = false; });
    } catch { timingPending[symbol] = false; }
  }
  function entryWindowLabel(symbol) {
    const c = timingCache[symbol] && timingCache[symbol].data;
    if (!c || !c.bestHours || !c.bestHours.length) return 'now — ideal within the current session';
    const b = c.bestHours[0];
    const bLabel = b.label || (b.hour + ':00 UTC');
    const quiet = (c.quietHours || []).slice(0, 2).map(q => q.label || (q.hour + ':00')).join(', ');
    return 'best ' + bLabel + (quiet ? ' · avoid ' + quiet : '');
  }

  // ---- TRADE CLOCK: concrete place-your-trade times in the user's LOCAL time ----
  // The timing engine reports the best *hours* (UTC) from real volatility. We turn
  // those into the next upcoming wall-clock moments + a live countdown so the user
  // always sees an exact "place trade at 2:00 PM" style instruction.
  function nextOccurrenceUtc(hour) {
    const now = new Date();
    const d = new Date(now);
    d.setUTCSeconds(0, 0);
    d.setUTCHours(hour, 0, 0, 0);
    if (d.getTime() <= now.getTime()) d.setUTCDate(d.getUTCDate() + 1);
    return d;
  }
  function fmtClock(d) {
    if (!d) return '';
    let h = d.getHours();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    return h + ':' + String(d.getMinutes()).padStart(2, '0') + ' ' + ampm;
  }
  function tradeSchedule(symbol) {
    const c = timingCache[symbol] && timingCache[symbol].data;
    if (!c || !c.bestHours || !c.bestHours.length) return null;
    const now = Date.now();
    const nexts = c.bestHours.slice(0, 5).map(b => {
      const d = nextOccurrenceUtc(b.hour);
      return { hour: b.hour, clock: fmtClock(d), at: d.getTime(), inMin: Math.max(0, Math.round((d.getTime() - now) / 60000)) };
    });
    nexts.sort((a, b) => a.inMin - b.inMin);
    const primary = nexts[0];
    const inWindow = !primary || primary.inMin <= 0;
    const avoid = ((c.quietHours || []).slice(0, 3).map(q => {
      const hh = parseInt(String(q).split(':')[0], 10);
      return isNaN(hh) ? null : fmtClock(nextOccurrenceUtc(hh));
    }) || []).filter(Boolean);
    let tzName = 'your time zone';
    try { tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || tzName; } catch { /* keep default */ }
    return { primary, inWindow, nexts, avoid, tzName };
  }
  function tradeClockHtml(sig, sched) {
    const upd = '⏱ Signal updated <b>' + esc(MI.fmt.time(sig.time)) + '</b> UTC';
    const valid = '<b class="' + (isStale(sig) ? 'sell-text' : '') + '">⏳ ' + esc(remainingLabel(sig)) + '</b>';
    if (!sched) {
      return '<div class="pb-time">' + upd + ' · ⌛ Place your trade: <b>' + esc(entryWindowLabel(sig.symbol)) + '</b> · ' + valid + '</div>';
    }
    const p = sched.primary;
    const nowLine = sched.inWindow
      ? '<div class="tc-status now">● <b>NOW</b> — you are inside the optimal window — place your trade promptly</div>'
      : '<div class="tc-status soon">⏳ Next placement: <b>' + p.clock + '</b> <em id="tcCount" data-until="' + p.at + '">in ' + p.inMin + 'm</em></div>';
    const chips = sched.nexts.slice(0, 3).map((w, i) =>
      '<span class="tc-w' + (i === 0 ? ' top' : '') + '">' + (i === 0 ? '▶ ' : '') + '<b>' + w.clock + '</b><i>' + (i === 0 ? 'ideal' : (w.inMin <= 0 ? 'now' : w.inMin + 'm')) + '</i></span>').join('');
    const pct = Math.max(4, Math.min(100, 100 - (p.inMin / 60) * 100));
    return '<div class="trade-clock">' +
      '<div class="tc-head"><span class="tc-title">⏰ Trade Placement Schedule</span>' +
      '<span class="tc-tz">' + esc(sched.tzName) + ' · local time</span></div>' +
      nowLine +
      '<div class="tc-windows">' + chips + '</div>' +
      (sched.avoid && sched.avoid.length ? '<div class="tc-avoid">✕ Weak windows (avoid): <b>' + sched.avoid.join(' · ') + '</b></div>' : '') +
      '<div class="tc-bar"><div class="tc-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="tc-foot">' + upd + ' · ' + valid + '</div>' +
      '</div>';
  }

  // FX/indices keep their own decimals and no $ sign; crypto uses MI.fmt.
  function fmtPrice(p, sig) {
    if (p === null || p === undefined || isNaN(p)) return '—';
    if (sig && (sig.mode === 'forex' || (sig.mode === 'pocket' && sig.precision))) return Number(p).toFixed(sig.precision || 5);
    return MI.fmt.price(p);
  }
  function isBuyAction(a) { return a === 'BUY' || a === 'CALL'; }
  function isSellAction(a) { return a === 'SELL' || a === 'PUT'; }
  function tagClass(a) { return isBuyAction(a) ? 'buy' : isSellAction(a) ? 'sell' : 'hold'; }

  function getPrices() { return (window.MINotify && MINotify.getPrices()) || {}; }
  function getStats() { return (window.MINotify && MINotify.getStats()) || {}; }

  function findSignal(sym) { return state.signals.find(s => s.symbol === sym) || null; }

  // ------------------------------------------------ signal tape (overview marquee)
  function renderTape() {
    const tape = $id('signalTape');
    if (!tape) return;
    const sigs = state.signals;
    if (!sigs || !sigs.length) { tape.innerHTML = '<span class="tape-item muted">Loading live signals…</span>'; return; }
    tape.innerHTML = sigs.slice(0, 24).map(s =>
      '<span class="tape-item ' + tagClass(s.action) + '">' + esc(s.asset) + ' ' + s.action + ' ' + s.confidence + '%' +
      (s.quality === 'HIGH' ? ' 🔥' : '') + '</span>').join('');
  }

  // ------------------------------------------------ stats bar
  function renderStatsBar() {
    const el = $id('statsBar');
    if (!el) return;
    const prices = getPrices();
    const stats = getStats();
    const sum = state.summary || {};
    const paper = state.paperStats;
    const mode = (window.MI && MI.mode) || 'crypto';
    const isFx = mode === 'forex';

    // Watch price — mode-aware so FX/Pocket show a real currency rate.
    const prefer = isFx ? 'EURUSD' : 'BTCUSDT';
    const watch = (prices[prefer] != null) ? prefer
      : (state.signals.find(s => prices[s.symbol] != null) || {}).symbol;
    const wv = watch ? prices[watch] : undefined;
    const ws = watch ? stats[watch] : undefined;
    const watchSig = watch && state.signals.find(s => s.symbol === watch) || {};
    const watchLabel = isFx
      ? String(watch).replace(/^(.{3})(.{3})$/, '$1/$2')
      : String(watch).replace(/USDT$/, '/USDT');
    const fxPrec = isFx ? (watchSig.precision || 5) : 0;
    const watchValue = wv != null
      ? (isFx ? Number(wv).toFixed(fxPrec) : MI.fmt.price(wv))
      : '—';

    const cards = [
      { label: isFx ? ('💱 ' + watchLabel) : (mode === 'pocket' ? '⏱️ ' + watchLabel : 'Bitcoin'),
        value: watchValue,
        sub: ws && ws.priceChangePercent != null
          ? MI.fmt.pct(ws.priceChangePercent) + ' (24h)'
          : (isFx ? 'FX · Yahoo Finance' : '—'),
        cls: ws && ws.priceChangePercent != null ? (ws.priceChangePercent >= 0 ? 'stat-up' : 'stat-down') : '' },
      { label: 'Market Sentiment', value: sum.sentiment || '—',
        sub: sum.directional > 0 ? sum.bullishPct + '% of ' + sum.directional + ' active signals bullish' : 'waiting for signals' },
      { label: 'Active Signals', value: (sum.buys || 0) + ' / ' + (sum.sells || 0),
        sub: (window.MI && MI.mode === 'pocket')
          ? (sum.buys || 0) + ' CALL · ' + (sum.sells || 0) + ' PUT · ' + (sum.holds || 0) + ' NEUTRAL' + (sum.highConviction ? ' · ' + sum.highConviction + ' 🔥' : '')
          : (sum.buys || 0) + ' BUY · ' + (sum.sells || 0) + ' SELL · ' + (sum.holds || 0) + ' HOLD' + (sum.highConviction ? ' · ' + sum.highConviction + ' 🔥 high conviction' : '') },
      { label: 'Avg Confidence', value: sum.avgConfidence ? sum.avgConfidence + '%' : '—', sub: (isFx ? 'on live FX data' : (mode === 'pocket' ? 'on 5m momentum' : 'across live signals')) },
      { label: 'Avg R/R', value: sum.avgRiskReward !== undefined && sum.avgRiskReward !== null ? sum.avgRiskReward : '—', sub: isFx ? 'in pips' : 'reward : risk' },
      { label: (isFx || mode === 'pocket') ? 'Asset Count' : 'Paper Win Rate',
        value: isFx ? (sum.total || 0) : (paper && paper.winRate ? paper.winRate + '%' : '—'),
        sub: isFx ? 'pairs tracked live' : (paper ? paper.closedTrades + ' closed trades' : 'crypto mode only') },
      { label: 'Last Updated', value: MI.fmt.time(sum.generatedAt), sub: (mode === 'pocket' ? '5m candles · ' : '15m candles · ') + (state.signals.length || 0) + ' assets' },
    ];

    el.innerHTML = cards.map(c =>
      '<div class="stat-card"><div class="stat-label">' + c.label + '</div>' +
      '<div class="stat-value ' + (c.cls || '') + '">' + c.value + '</div>' +
      '<div class="stat-sub">' + c.sub + '</div></div>').join('');
  }
// ------------------------------------------------ primary signal panel
  function renderSignalPanel() {
    const el = $id('signalPanel');
    if (!el) return;
    const sig = findSignal(state.selected) || state.signals[0] || null;
    if (!sig) {
      el.innerHTML = '<div class="empty">Signal engine warming up…</div>';
      return;
    }
    state.selected = sig.symbol;
    const subEl = $id('signalSub');
    if (subEl) subEl.textContent = sig.asset + ' · updated ' + MI.fmt.shortTime(sig.time);

    const cls = sig.action.toLowerCase();
    const colorClass = isBuyAction(sig.action) ? 'green' : isSellAction(sig.action) ? 'red' : 'gold';
    const regime = regimeLabel(sig);

    const inner =
      (state.newsZone ? '<div class="ribbon news">🕐 NEWS ZONE — ' + esc(state.newsZone.title) + ' in ~' + Math.max(1, Math.round((state.newsZone.time - Date.now()) / 60000)) + ' min — consider smaller size or waiting</div>' : '') +
      ((state.paperStats && state.paperStats.protection && state.paperStats.protection.active)
        ? '<div class="ribbon cool">🔒 MI cooldown — ' + state.paperStats.protection.streak + ' straight losses; pausing new paper trades for ' + Math.max(1, Math.ceil(state.paperStats.protection.leftMs / 60000)) + 'm (protect the bankroll)</div>'
        : '') +
      '<div class="signal-top">' +
      '<div class="signal-big ' + cls + '">' + sig.action + '</div>' +
      '<div class="signal-price"><div class="label">Live price</div><div class="val">' + fmtPrice(sig.price, sig) + '</div>' +
      '<div class="lvl">S ' + fmtPrice(sig.support, sig) + ' · R ' + fmtPrice(sig.resistance, sig) + '</div></div>' +
      '</div>' +
      '<div class="conf"><span class="conf-label">' + (sig.mode === 'pocket' ? 'Win Probability' : 'MI Confidence') + '</span>' +
      '<div class="conf-bar"><div class="conf-fill ' + cls + '" style="width:' + sig.confidence + '%"></div></div>' +
      '<span class="conf-pct">' + sig.confidence + '%</span></div>' +
      tradeClockHtml(sig, tradeSchedule(sig.symbol)) +
      '<div class="signal-grid">' +
      '<div class="sig-item"><div class="k">Entry</div><div class="v ' + colorClass + '">' + fmtPrice(sig.entry, sig) + '</div></div>' +
      '<div class="sig-item"><div class="k">Take Profit</div><div class="v green">' + (sig.takeProfit ? fmtPrice(sig.takeProfit, sig) : '—') + '</div></div>' +
      '<div class="sig-item"><div class="k">Stop Loss</div><div class="v red">' + (sig.stopLoss ? fmtPrice(sig.stopLoss, sig) : '—') + '</div></div>' +
      '<div class="sig-item"><div class="k">Risk / Reward</div><div class="v gold">' + (sig.riskReward ? '1 : ' + sig.riskReward : '—') + '</div></div>' +
      (sig.mode === 'pocket'
        ? '<div class="sig-item"><div class="k">Expiry</div><div class="v gold">' + esc(sig.expiry || '5m') + '</div></div>' +
          '<div class="sig-item"><div class="k">Payout (est.)</div><div class="v green">' + (sig.payout ? sig.payout + '%' : '—') + '</div></div>'
        : '') +
      (sig.mode === 'forex'
        ? '<div class="sig-item"><div class="k">TP / SL (pips)</div><div class="v">' + (sig.tpPips != null ? sig.tpPips : '—') + ' / ' + (sig.slPips != null ? sig.slPips : '—') + '</div></div>' +
          '<div class="sig-item"><div class="k">Sessions</div><div class="v cyan">' + esc(sig.sessionLabel || '—') + '</div></div>'
        : '') +
      '<div class="sig-item"><div class="k">Conviction</div><div class="v ' + (sig.quality === 'HIGH' ? 'gold' : sig.quality === 'MEDIUM' ? 'cyan' : '') + '">' + (sig.quality === 'HIGH' ? '🔥 HIGH' : sig.quality === 'MEDIUM' ? '⚡ MEDIUM' : (sig.action === 'HOLD' || sig.action === 'NEUTRAL') ? '—' : '○ LOW') + '</div></div>' +
      '<div class="sig-item"><div class="k">Timeframe</div><div class="v">' + esc(sig.timeframe || '15m + 1h') + '</div></div>' +
      '<div class="sig-item"><div class="k">Confluence</div><div class="v">' + esc(sig.confluence || '—') + '</div></div>' +
      '<div class="sig-item"><div class="k">Trend</div><div class="v cyan">' + esc(sig.trend) + '</div></div>' +
      '<div class="sig-item"><div class="k">RSI (14)</div><div class="v">' + (sig.rsi !== null ? sig.rsi : '—') + '</div></div>' +
      '<div class="sig-item"><div class="k">MACD</div><div class="v">' + esc(sig.macdState) + '</div></div>' +
      '<div class="sig-item"><div class="k">Vol vs avg</div><div class="v">' + (sig.volRatio ? sig.volRatio.toFixed(2) + 'x' : '—') + '</div></div>' +
      '<div class="sig-item"><div class="k">ADX</div><div class="v">' + (sig.adx != null ? sig.adx + ' · ' + (sig.adx >= 22 ? 'strong' : sig.adx <= 14 ? 'weak' : 'developing') : '—') + '</div></div>' +
      (regime ? '<div class="sig-item"><div class="k">Regime</div><div class="v ' + (regime.cls === 'regime-high' ? 'gold' : regime.cls === 'regime-low' ? 'cyan' : '') + '">' + regime.label + '</div></div>' : '') +
      (sig.divergence ? '<div class="sig-item"><div class="k">Divergence</div><div class="v ' + (sig.divergence === 'bullish' ? 'green' : 'red') + '">' + esc(sig.divergence) + '</div></div>' : '') +
      '</div>' +
      '<div class="factors">' + sig.factors.map(f =>
        '<span class="factor ' + f.impact + '" title="' + esc(f.name) + ' — ' + esc(f.value) + '">' + esc(f.name) + ': ' + esc(f.value) + '</span>').join('') +
      '</div>' +
      playbookHtml(sig) +
      '<div class="signal-actions">' +
      '<button class="btn ghost sm" id="sigCopy">📋 Copy plan</button>' +
      '<button class="btn ghost sm" id="sigGoChart">📈 Show chart</button>' +
      (sig.mode !== 'pocket' && sig.action !== 'HOLD' && sig.action !== 'NEUTRAL' ? '<button class="btn ghost sm" id="sigPaper">📥 Paper trade</button>' : '') +
      '</div>';

    // Users see blurred signals until they pay 1 coin to reveal the plan.
    if (isLocked(sig.symbol)) {
      el.innerHTML = '<div class="signal-locked"><div class="blur-inner">' + inner + '</div>' +
        lockVeilHtml(sig.symbol) + '</div>';
      const ub = el.querySelector('[data-unlock]');
      if (ub) ub.addEventListener('click', () => unlockSignal(sig.symbol));
      return;
    }
    el.innerHTML = inner;

    $id('sigCopy').addEventListener('click', () => copySignal(sig));
    $id('sigGoChart').addEventListener('click', () => {
      if (window.MIChart) MIChart.setSymbol(sig.symbol);
      switchView('overview');
    });
    // one-tap TP / SL alerts from the playbook
    const pbTp = $id('pbTpBtn');
    if (pbTp) pbTp.addEventListener('click', () => setQuickAlert(sig.symbol, sig.takeProfit, sig.action + ' take-profit'));
    const pbSl = $id('pbSlBtn');
    if (pbSl) pbSl.addEventListener('click', () => setQuickAlert(sig.symbol, sig.stopLoss, sig.action + ' stop-loss'));
    const sigPaper = $id('sigPaper');
    if (sigPaper) {
      sigPaper.disabled = !!(state.paperStats && state.paperStats.protection && state.paperStats.protection.active);
      sigPaper.addEventListener('click', async () => {
        try {
          const r = await MI.api.post('/api/paper', { symbol: sig.symbol });
          if (r && r.ok) {
            MI.toast('success', 'Paper trade opened', sig.asset + ' ' + sig.action + ' @ ' + fmtPrice(sig.entry, sig) + ' — tracked with TP/SL.');
            loadPaper();
          } else {
            MI.toast('error', 'Could not open paper trade', r && r.error ? r.error : 'unknown');
          }
        } catch (e) { MI.toast('error', 'Paper trade failed', e.message); }
      });
    }
    el.classList.toggle('stale', isStale(sig));
    // Load (cached) best entry window for the selected symbol.
    mtLoadTiming(sig.symbol);
  }

  function copySignal(sig) {
    const text =
      'MI SIGNAL — ' + sig.asset + '\n' +
      'Action: ' + sig.action + ' (confidence ' + sig.confidence + '%)\n' +
      'Entry: ' + fmtPrice(sig.entry, sig) + '\n' +
      'Take Profit: ' + fmtPrice(sig.takeProfit, sig) + '\n' +
      'Stop Loss: ' + fmtPrice(sig.stopLoss, sig) + '\n' +
      'Risk/Reward: 1:' + sig.riskReward +
      (sig.mode === 'pocket' ? '\nExpiry: ' + (sig.expiry || '5m') + ' · Est. payout: ' + (sig.payout || '—') + '%' : '') +
      (sig.mode === 'forex' ? '\nSessions: ' + esc(sig.sessionLabel || '—') : '') +
      '\nTrend: ' + sig.trend + ' | RSI: ' + (sig.rsi !== null ? sig.rsi : '—') + ' | MACD: ' + sig.macdState +
      '\nGenerated by MI Master Intelligence — not financial advice.';
    try {
      navigator.clipboard.writeText(text);
      MI.toast('success', 'Signal copied', sig.asset + ' plan copied to clipboard.');
    } catch {
      MI.toast('info', 'Copy manually', text);
    }
  }
// ------------------------------------------------ actionable playbook
  // Turns the signal into concrete next steps: entry → stop-loss → take-profit
  // → position size, plus one-tap TP/SL alert buttons. Mode-aware.
  function playbookHtml(sig) {
    const isHold = sig.action === 'HOLD' || sig.action === 'NEUTRAL';
    const sideWord = isBuyAction(sig.action) ? (sig.mode === 'pocket' ? 'CALL' : 'BUY') : isSellAction(sig.action) ? (sig.mode === 'pocket' ? 'PUT' : 'SELL') : 'WAIT';

    if (isHold) {
      return '<div class="playbook playbook-wait">' +
        '<div class="pb-title">🎯 What to do now — <span class="hold-text">WAIT</span></div>' +
        '<div class="pb-body">No directional edge on <b>' + esc(sig.asset) + '</b> right now. The engine sees <b>' + esc(sig.trend || 'mixed') + '</b>, confluence <b>' + esc(sig.confluence || '—') + '</b> and ADX <b>' + (sig.adx != null ? sig.adx : '—') + '</b>. ' +
        'Stay on the sidelines, protect any open position, and re-check in ~30–60 min — or after the next high-impact news passes.</div>' +
        (sig.support && sig.resistance
          ? '<div class="pb-body">Meanwhile, if price approaches <b>S ' + fmtPrice(sig.support, sig) + '</b> watch for a bounce; at <b>R ' + fmtPrice(sig.resistance, sig) + '</b> watch for rejection.</div>'
          : '') +
        '</div>';
    }

    const entry = fmtPrice(sig.entry, sig);
    const tp = sig.takeProfit ? fmtPrice(sig.takeProfit, sig) : '—';
    const sl = sig.stopLoss ? fmtPrice(sig.stopLoss, sig) : '—';
    const riskUsd = 20; // 2% risk on a $1,000 reference
    let units = null;
    let halfTarget = null;
    if (sig.stopLoss && !isHold) {
      const dist = Math.abs(sig.price - sig.stopLoss);
      if (dist > 0) units = (riskUsd / dist);
      halfTarget = isBuyAction(sig.action) ? (sig.entry + dist) : (sig.entry - dist);
    }
    let steps = [];

    if (sig.mode === 'pocket') {
      const up = sig.action === 'CALL';
      const justify = sig.confidence >= (sig.payout || 80);
      steps = [
        'Buy the <b>' + sideWord + '</b> binary option expiring in <b>' + esc(sig.expiry || '5m') + '</b> — it wins if <b>' + esc(sig.asset) + '</b> closes ' + (up ? '<b class="buy-text">ABOVE</b>' : '<b class="sell-text">BELOW</b>') + ' the strike near <b>' + entry + '</b>.',
        'Payout ≈ <b>' + (sig.payout || '—') + '%</b> vs <b>' + sig.confidence + '%</b> win probability — a play only when probability comfortably beats the payout (' + (justify ? '<b class="buy-text">justified ✅</b>' : '<b class="sell-text">not justified ❌ — skip</b>') + ').',
        'Keep the stake small: reference risk ≤ <b>$' + riskUsd + '</b>. One strong read is not a system — protect your bankroll.',
      ];
    } else {
      steps = [
        '<b>Enter</b> near <b>' + entry + '</b> — ' + esc(sig.trend || '') + ' with <b>' + sig.confidence + '%</b> confidence (tier: <b>' + esc(sig.quality) + '</b>)' +
          (sig.riskReward ? ', risking 1 to win <b>' + sig.riskReward + '</b>.' : '.'),
        '<b>Protect it:</b> place the <b class="sell-text">Stop-Loss at ' + sl + '</b>' + (sig.mode === 'forex' && sig.slPips != null ? ' (' + sig.slPips + ' pips)' : '') + '. If price gets here, the idea is wrong — take the loss, don’t argue with the market.',
        '<b>Secure the profit:</b> place the <b class="buy-text">Take-Profit at ' + tp + '</b>' + (sig.mode === 'forex' && sig.tpPips != null ? ' (' + sig.tpPips + ' pips)' : '') + '. Let it run to the target — exiting early on a retrace is how wins become tiny.',
        (halfTarget ? '<b>Ladder it:</b> consider taking half near <b>' + fmtPrice(halfTarget, sig) + '</b> (1R) and letting the rest run to TP — locks in profit while keeping upside.' : ''),
        '<b>Size it:</b> with 2% risk ($' + riskUsd + ' on a $1,000 reference) trade ≈ <b>' + (units && units > 0 ? units.toFixed(4) : '—') + '</b> units at this stop distance.',
        (sig.mode === 'forex' && sig.sessionLabel ? 'Act during <b>' + esc(sig.sessionLabel) + '</b> for the deepest liquidity. ' : '') +
          'ADX <b>' + (sig.adx != null ? (sig.adx >= 22 ? 'strong — act promptly' : 'developing — keep size modest') : '—') + '</b>.',
      ];
    }
    steps.push('⚠ Analytical guidance, not financial advice — manage your own risk.');

    return '<div class="playbook">' +
      '<div class="pb-title">🎯 What to do now — <span class="' + (isBuyAction(sig.action) ? 'buy-text' : 'sell-text') + '">' + sideWord + '</span></div>' +
      '<ol class="pb-steps">' + steps.map(s => '<li>' + s + '</li>').join('') + '</ol>' +
      (sig.takeProfit || sig.stopLoss
        ? '<div class="pb-alerts"><span class="pb-alerts-label">One-tap alerts:</span>' +
          (sig.takeProfit ? '<button class="btn ghost sm" id="pbTpBtn">🔔 At TP ' + tp + '</button>' : '') +
          (sig.stopLoss ? '<button class="btn ghost sm" id="pbSlBtn">🔔 At SL ' + sl + '</button>' : '') +
          '</div>'
        : '') +
      '</div>';
  }

  function setQuickAlert(symbol, target, label) {
    if (!target) return;
    const price = (window.MINotify && MINotify.getPrices()) ? MINotify.getPrices()[symbol] : null;
    const condition = (price !== undefined && price !== null && target > price) ? 'above' : 'below';
    try {
      MI.api.post('/api/alerts', { symbol, condition, target, note: 'auto: ' + label }).then(() => {
        if (window.MINotify && MINotify.refreshAlerts) MINotify.refreshAlerts();
        MI.toast('success', 'Alert created', esc(symbol) + ' — notify me at ' + MI.fmt.price(target));
      }).catch(err => MI.toast('error', 'Alert failed', err.message));
    } catch (e) { /* alert optional */ }
  }

// ------------------------------------------------ signals table
  function renderTable() {
    const body = $id('signalsBody');
    if (!body) return;
    const updated = $id('signalsUpdated');
    if (updated && state.summary) updated.textContent = 'MI engine · refreshed ' + MI.fmt.shortTime(state.summary.generatedAt);

    body.innerHTML = '';
    if (!state.signals.length) {
      body.innerHTML = '<tr><td colspan="12"><div class="empty">Loading live signals…</div></td></tr>';
      return;
    }
    state.signals.forEach(s => {
      if (state.watchOnly && !isWatched(s.symbol)) return;
      const clsTag = tagClass(s.action);
      const tr = document.createElement('tr');
      tr.style.cursor = 'pointer';
      if (isStale(s)) tr.classList.add('stale');
      tr.innerHTML =
        '<td class="mono" style="font-weight:800">' + esc(s.asset) +
        ' <button class="row-btn star' + (isWatched(s.symbol) ? ' on' : '') + '" data-star="' + s.symbol + '" title="Add/remove from watchlist">' + (isWatched(s.symbol) ? '★' : '☆') + '</button></td>' +
        '<td><span class="tag ' + clsTag + '" title="Conviction: ' + (s.quality || 'LOW') + ' · valid ' + remainingLabel(s) + '">' + s.action + (s.quality === 'HIGH' ? ' 🔥' : s.quality === 'MEDIUM' ? ' ⚡' : '') + '</span></td>' +
        '<td>' + s.confidence + '%</td>' +
        '<td class="mono">' + fmtPrice(s.price, s) + '</td>' +
        '<td class="mono">' + fmtPrice(s.entry, s) + '</td>' +
        '<td class="mono" style="color:var(--green)">' + (s.takeProfit ? fmtPrice(s.takeProfit, s) : '—') + '</td>' +
        '<td class="mono" style="color:var(--red)">' + (s.stopLoss ? fmtPrice(s.stopLoss, s) : '—') + '</td>' +
        '<td class="mono">' + (s.riskReward ? '1:' + s.riskReward : '—') + '</td>' +
        '<td>' + esc(s.trend) + '</td>' +
        '<td class="mono">' + (s.rsi !== null ? s.rsi : '—') + '</td>' +
        '<td>' + esc(s.macdState) + '</td>' +
        '<td>' + esc(s.rating) + '</td>';
      tr.addEventListener('click', () => {
        state.selected = s.symbol;
        renderSignalPanel();
        switchView('overview');
        if (window.MIChart) MIChart.setSymbol(s.symbol);
      });
      const starBtn = tr.querySelector('[data-star]');
      if (starBtn) starBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleWatch(s.symbol); });
      // Users: locked rows are blurred until 1 coin unlocks them.
      if (isLocked(s.symbol)) {
        tr.classList.add('row-locked');
        tr.innerHTML += '<td class="row-lock-cell"><button class="btn ghost sm" data-unlock="' + esc(s.symbol) + '">🔓 Show · 1 coin</button></td>';
        const ub = tr.querySelector('[data-unlock]');
        if (ub) ub.addEventListener('click', (e) => { e.stopPropagation(); unlockSignal(s.symbol); });
      }
      body.appendChild(tr);
    });
  }

  function switchView(name) {
    const tabs = document.querySelectorAll('.nav-tab');
    tabs.forEach(t => t.classList.toggle('active', t.dataset.view === name));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.dataset.view === name));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ------------------------------------------------ paper trading UI
  async function loadPaper() {
    try {
      const res = await MI.api.get('/api/paper');
      state.paperStats = res.stats || null;
      renderPaper(res);
    } catch { /* ignore */ }
  }

  function renderPaper(res) {
    if (state.paperStats) {
      const p = state.paperStats;
      const el = $id('paperStats');
      if (el) el.innerHTML =
        '<div class="stat-card"><div class="stat-label">Closed Trades</div><div class="stat-value">' + p.closedTrades + '</div><div class="stat-sub">' + p.wins + 'W / ' + p.losses + 'L</div></div>' +
        '<div class="stat-card"><div class="stat-label">Win Rate</div><div class="stat-value ' + (p.winRate >= 50 ? 'stat-up' : 'stat-down') + '">' + p.winRate + '%</div><div class="stat-sub">measured on live prices</div></div>' +
        '<div class="stat-card"><div class="stat-label">Realized PnL</div><div class="stat-value ' + (p.realizedPnl >= 0 ? 'stat-up' : 'stat-down') + '">' + (p.realizedPnl >= 0 ? '+' : '') + '$' + p.realizedPnl.toFixed(2) + '</div><div class="stat-sub">' + p.closedTrades + ' trades · $1,000 notional each</div></div>' +
        '<div class="stat-card"><div class="stat-label">Open Positions</div><div class="stat-value">' + p.openPositions + '</div><div class="stat-sub">floating ' + (p.floatingPnl >= 0 ? '+' : '') + '$' + p.floatingPnl.toFixed(2) + '</div></div>';
    }
    const pos = $id('paperPositions');
    if (pos) {
      pos.innerHTML = '';
      const positions = res.positions || [];
      if (!positions.length) pos.innerHTML = '<tr><td colspan="8"><div class="empty">No open paper positions yet — MI opens one when a high-confidence signal appears.</div></td></tr>';
      positions.forEach(p => {
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td class="mono" style="font-weight:700">' + esc(p.symbol) + '</td>' +
          '<td class="' + (p.side === 'BUY' ? 'buy-text' : 'sell-text') + '">' + p.side + '</td>' +
          '<td class="mono">' + MI.fmt.price(p.entry) + '</td>' +
          '<td class="mono">' + MI.fmt.price(p.takeProfit) + '</td>' +
          '<td class="mono">' + MI.fmt.price(p.stopLoss) + '</td>' +
          '<td>' + p.confidence + '%</td>' +
          '<td class="mono">1:' + (p.rr || '—') + '</td>' +
          '<td class="hold-text">● open · ' + Math.round((Date.now() - p.openedAt) / 60000) + 'm</td>';
        pos.appendChild(tr);
      });
    }
    const hist = $id('paperHistory');
    if (hist) {
      hist.innerHTML = '';
      const history = (res.history || []).slice();
      if (!history.length) hist.innerHTML = '<tr><td colspan="7"><div class="empty">No closed paper trades yet.</div></td></tr>';
      history.reverse().forEach(h => {
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td class="mono" style="font-weight:700">' + esc(h.symbol) + '</td>' +
          '<td class="' + (h.side === 'BUY' ? 'buy-text' : 'sell-text') + '">' + h.side + '</td>' +
          '<td class="mono">' + MI.fmt.price(h.entry) + '</td>' +
          '<td class="mono">' + MI.fmt.price(h.exit) + '</td>' +
          '<td class="mono ' + (h.pnl >= 0 ? 'stat-up' : 'stat-down') + '">' + (h.pnl >= 0 ? '+' : '') + '$' + h.pnl.toFixed(2) + ' (' + h.pnlPct + '%)</td>' +
          '<td><span class="tag ' + (h.pnl >= 0 ? 'buy' : 'sell') + '">' + h.reason + '</span></td>' +
          '<td class="mono">' + MI.fmt.shortTime(h.closedAt) + '</td>';
        hist.appendChild(tr);
      });
    }
  }
// ------------------------------------------------ saved signal history
  async function refreshHistory() {
    try {
      const res = await MI.api.get('/api/signals/history');
      state.history = res.history || [];
      renderHistory();
    } catch { /* ignore */ }
  }

  function renderHistory() {
    const body = $id('signalsHistoryBody');
    if (!body) return;
    body.innerHTML = '';
    if (!state.history.length) {
      body.innerHTML = '<tr><td colspan="9"><div class="empty">No saved signals yet — every new BUY/SELL verdict is stored here automatically and stays until you delete it.</div></td></tr>';
      return;
    }
    state.history.slice(0, 60).forEach(h => {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="mono">' + MI.fmt.shortTime(h.ts) + '</td>' +
        '<td class="mono" style="font-weight:700">' + esc(h.asset || h.symbol) + '</td>' +
        '<td><span class="tag ' + (h.action === 'BUY' ? 'buy' : 'sell') + '">' + h.action + '</span></td>' +
        '<td>' + h.confidence + '%</td>' +
        '<td class="mono">' + MI.fmt.price(h.price) + '</td>' +
        '<td class="mono" style="color:var(--green)">' + (h.takeProfit ? MI.fmt.price(h.takeProfit) : '—') + '</td>' +
        '<td class="mono" style="color:var(--red)">' + (h.stopLoss ? MI.fmt.price(h.stopLoss) : '—') + '</td>' +
        '<td class="mono">' + (h.riskReward ? '1:' + h.riskReward : '—') + '</td>' +
        '<td>' + (h.quality === 'HIGH' ? '🔥 HIGH' : h.quality === 'MEDIUM' ? '⚡ MEDIUM' : '○ LOW') + '</td>';
      body.appendChild(tr);
    });
  }

// ------------------------------------------------ signal accuracy & backtest
  async function refreshAccuracy() {
    try {
      const res = await MI.api.get('/api/accuracy');
      state.accuracy = res.stats || null;
      state.accuracyHistory = res.history || [];
      renderAccuracy();
    } catch { /* ignore */ }
  }

  function renderAccuracy() {
    const el = $id('accuracyStats');
    if (!el) return;
    const s = state.accuracy;
    if (!s) { el.innerHTML = '<div class="stat-card"><div class="stat-value">…</div><div class="stat-sub">grading signals…</div></div>'; return; }
    const cards = [
      { label: 'Graded', value: s.graded, sub: s.wins + 'W · ' + s.losses + 'L' },
      { label: 'Win Rate', value: s.winRate + '%', sub: 'real TP/SL hits', cls: s.winRate >= 50 ? 'stat-up' : 'stat-down' },
      { label: 'Expectancy', value: (s.expectancy > 0 ? '+' : '') + s.expectancy + 'R', sub: 'per trade', cls: s.expectancy >= 0 ? 'stat-up' : 'stat-down' },
      { label: 'Avg R (win/loss)', value: s.avgWin + ' / ' + s.avgLoss, sub: 'reward vs risk' },
      { label: 'Open / Expired', value: s.open + ' / ' + s.expired, sub: 'grading / timed out' },
      { label: '30d projection', value: (s.projected30d > 0 ? '+' : '') + s.projected30d + '%', sub: '@2% risk · 2 trades/day', cls: s.projected30d >= 0 ? 'stat-up' : 'stat-down' },
    ];
    el.innerHTML = cards.map(c =>
      '<div class="stat-card"><div class="stat-label">' + c.label + '</div>' +
      '<div class="stat-value ' + (c.cls || '') + '">' + c.value + '</div>' +
      '<div class="stat-sub">' + c.sub + '</div></div>').join('');

    const t = $id('accuracyTiers');
    if (t) {
      const byTier = s.byTier || {};
      const keys = (s.byTier ? Object.keys(s.byTier) : []).sort();
      const tierHtml = keys.map(k => {
        const v = byTier[k] || { wins: 0, losses: 0 };
        const grad = v.wins + v.losses;
        const wr = grad ? Math.round((v.wins / grad) * 100) : 0;
        return '<div class="acc-tier"><b>' + esc(k) + '</b> — ' + v.wins + 'W / ' + v.losses + 'L · <span class="' + (wr >= 50 ? 'ok' : '') + '">' + wr + '%</span></div>';
      }).join('') || '<div class="empty">No graded signals yet — MI grades every emitted signal automatically.</div>';
      const bs = s.bySymbol || {};
      const bsKeys = Object.keys(bs).sort((a, b) => ((bs[b].wins + bs[b].losses) - (bs[a].wins + bs[a].losses))).slice(0, 8);
      const bySymHtml = bsKeys.length
        ? '<div class="acc-sub">By asset — graded:</div>' +
          bsKeys.map(k => {
            const v = bs[k]; const g = v.wins + v.losses;
            const wr = g ? Math.round((v.wins / g) * 100) : 0;
            return '<div class="acc-tier"><b>' + esc(k) + '</b> — ' + v.wins + 'W/' + v.losses + 'L · <span class="' + (wr >= 50 ? 'ok' : '') + '">' + wr + '%</span></div>';
          }).join('')
        : '';
      t.innerHTML = tierHtml + bySymHtml;
    }

    const body = $id('accuracyBody');
    if (body) {
      body.innerHTML = '';
      const items = state.accuracyHistory || [];
      if (!items.length) {
        body.innerHTML = '<tr><td colspan="9"><div class="empty">No graded signals yet. Every BUY/SELL MI emits is graded against live prices (TP hit = WIN, SL hit = LOSS).</div></td></tr>';
        return;
      }
      items.slice(0, 40).forEach(r => {
        const tr = document.createElement('tr');
        const resHtml = r.result === 'win' ? '<span class="tag buy">WIN</span>'
          : r.result === 'loss' ? '<span class="tag sell">LOSS</span>'
          : '<span class="tag hold">' + esc(r.status) + '</span>';
        tr.innerHTML =
          '<td class="mono">' + MI.fmt.shortTime(r.ts) + '</td>' +
          '<td class="mono" style="font-weight:700">' + esc(r.symbol) + '</td>' +
          '<td><span class="tag ' + tagClass(r.action) + '">' + r.action + '</span></td>' +
          '<td>' + r.confidence + '%</td>' +
          '<td>' + esc(r.quality || '—') + '</td>' +
          '<td class="mono">' + MI.fmt.price(r.entry) + '</td>' +
          '<td class="mono">' + MI.fmt.price(r.takeProfit) + '</td>' +
          '<td class="mono">' + MI.fmt.price(r.stopLoss) + '</td>' +
          '<td>' + resHtml + '</td>';
        body.appendChild(tr);
      });
    }
  }

  async function runBacktest() {
    const sym = ($id('btSymbol').value || 'BTCUSDT').trim().toUpperCase();
    const interval = $id('btInterval').value;
    const bars = $id('btBars').value;
    const mode = (window.MI && MI.mode) || 'crypto';
    const box = $id('backtestResult');
    if (!box) return;
    box.innerHTML = '<div class="empty">⏳ Running no-look-ahead backtest on ' + esc(sym) + ' (' + esc(interval) + ' · ' + esc(bars) + ' bars)…</div>';
    try {
      const r = await MI.api.get('/api/backtest?symbol=' + encodeURIComponent(sym) + '&interval=' + encodeURIComponent(interval) + '&bars=' + encodeURIComponent(bars) + '&mode=' + encodeURIComponent(mode));
      const rows = [
        '<div class="bt-line">📊 Signals generated: <b>' + r.signals + '</b> across ' + r.candles + ' candles (' + esc(sym) + ' · ' + esc(interval) + ')</div>',
        '<div class="bt-line">Win / Loss / Expired: <b>' + r.wins + ' / ' + r.losses + ' / ' + r.expired + '</b></div>',
        '<div class="bt-line">Win rate (graded): <b class="' + (r.winRate >= 50 ? 'ok' : '') + '">' + r.winRate + '%</b></div>',
        '<div class="bt-line">Expectancy: <b>' + (r.expectancy >= 0 ? '+' : '') + r.expectancy + 'R</b> per trade</div>',
        '<div class="bt-line">30-day projection (@2% risk, 2/day): <b>' + (r.projection30d >= 0 ? '+' : '') + r.projection30d + '%</b></div>',
      ];
      if (r.recent && r.recent.length) {
        rows.push('<div class="bt-line sub">Recent ' + r.recent.length + ' graded:</div><div class="bt-recents">' +
          r.recent.map(x => '<span class="bt-chip ' + (x.result === 'win' ? 'buy' : x.result === 'loss' ? 'sell' : 'hold') + '">' + esc(x.action) + ' ' + (x.result === 'win' ? '✓' : x.result === 'loss' ? '✗' : '·') + '</span>').join('') + '</div>');
      }
      box.innerHTML = '<div class="bt-result-inner">' + rows.join('') + '</div>';
      MI.toast('success', 'Backtest complete', esc(sym) + ' · ' + r.winRate + '% win rate · ' + (r.expectancy >= 0 ? '+' : '') + r.expectancy + 'R expectancy.');
    } catch (err) {
      box.innerHTML = '<div class="empty">Backtest error: ' + esc(err.message) + '</div>';
    }
  }

// ------------------------------------------------ refresh / events / init
  async function refreshSignals() {
    try {
      const res = await MI.api.get('/api/signals');
      state.signals = res.signals || [];
      state.summary = res.summary;
      renderStatsBar();
      renderSignalPanel();
      renderTable();
      renderTape();
      loadPaper();
    } catch { /* ignore */ }
  }

  // Live countdown to the next trade-placement window (updates every second).
  let clockT = null;
  function startClockTicker() {
    if (clockT) return;
    clockT = setInterval(() => {
      const el = document.getElementById('tcCount');
      if (!el) return;
      const until = parseInt(el.dataset.until || '0', 10);
      if (!until) return;
      const left = Math.max(0, until - Date.now());
      const m = Math.floor(left / 60000);
      const s = Math.floor((left % 60000) / 1000);
      el.textContent = m > 0
        ? 'in ' + m + 'm ' + String(s).padStart(2, '0') + 's'
        : (s > 0 ? 'in ' + s + 's' : 'now — place it');
    }, 1000);
  }

  function init() {
    const sr = $id('signalsRefresh');
    if (sr) sr.addEventListener('click', async () => {
      // Users pay 1 coin per manual signal analysis run.
      if (window.MIAuth && window.MIAuth.role && window.MIAuth.role() === 'user') {
        const ok = await window.MIAuth.spend('signal');
        if (!ok) return;
      }
      refreshSignals();
    });
    const accRefresh = $id('accuracyRefresh');
    if (accRefresh) accRefresh.addEventListener('click', () => refreshAccuracy());
    const accClear = $id('accuracyClear');
    if (accClear) accClear.addEventListener('click', async () => {
      if (!confirm('Delete all graded signal history?')) return;
      try {
        await MI.api.del('/api/accuracy');
        state.accuracy = null; state.accuracyHistory = [];
        renderAccuracy();
        MI.toast('success', 'Accuracy reset', 'All saved grades were deleted.');
      } catch (err) { MI.toast('error', 'Could not reset', err.message); }
    });
    const btForm = $id('backtestForm');
    if (btForm) btForm.addEventListener('submit', (e) => { e.preventDefault(); runBacktest(); });
    const histClear = $id('signalsHistoryClear');
    if (histClear) histClear.addEventListener('click', async () => {
      if (!confirm('Delete all saved signal history? This cannot be undone.')) return;
      try {
        await MI.api.del('/api/signals/history');
        state.history = [];
        renderHistory();
        MI.toast('success', 'Signal history cleared', 'All saved signals have been deleted from this machine.');
      } catch (err) {
        MI.toast('error', 'Could not clear history', err.message);
      }
    });
    $id('signalSetAlert').addEventListener('click', () => {
      const sig = findSignal(state.selected) || state.signals[0];
      const target = document.getElementById('alertTarget');
      const symbolSel = document.getElementById('alertSymbol');
      if (sig && target && symbolSel) {
        symbolSel.value = sig.symbol;
        target.value = sig.takeProfit ? sig.takeProfit : sig.price;
        target.focus();
      }
      switchView('alerts');
    });
    startClockTicker();
    refreshSignals();
    refreshHistory();
    refreshAccuracy();
    loadNewsZone();
    setInterval(loadNewsZone, 5 * 60 * 1000);
    const wt = $id('watchToggle');
    if (wt) wt.addEventListener('click', () => {
      state.watchOnly = !state.watchOnly;
      wt.classList.toggle('active', state.watchOnly);
      wt.textContent = state.watchOnly ? '★ Watchlist ON' : '☆ Watchlist';
      renderTable();
    });
    MINotify.onEvent('signals', () => {
      state.signals = MINotify.getSignals();
      state.summary = MINotify.getSummary();
      followChart();
      renderStatsBar();
      renderSignalPanel();
      renderTable();
      renderTape();
      loadPaper();
    });
    MINotify.onEvent('market', () => { followChart(); renderStatsBar(); renderSignalPanel(); });
    MINotify.onEvent('paper', () => loadPaper());
  }

  // Follow the currency chosen in the live chart so the primary signal panel
  // always reflects the symbol currently on screen.
  function followChart(sym) {
    const cs = sym || ((window.MIChart && typeof MIChart.getSymbol === 'function') ? MIChart.getSymbol() : null);
    if (cs && cs !== state.selected) {
      state.selected = cs;
      renderSignalPanel();
    }
  }

  // User-driven symbol reveal — users pay 1 coin per new analysis. Called by
  // the chart symbol dropdown (not by auto SSE refreshes) so background live
  // updates never drain coins.
  async function revealSymbol(v) {
    if (!v) return;
    if (v === state.selected) { renderSignalPanel(); return; }
    if (window.MIAuth && window.MIAuth.role && window.MIAuth.role() === 'user') {
      const ok = await window.MIAuth.spend('signal');
      if (!ok) return;
    }
    state.selected = v;
    renderSignalPanel();
  }

  // Runs on market-mode switch: pull fresh signals for the new mode.
  function handleModeChange() {
    refreshSignals();
    refreshHistory();
  }

  window.MISignals = {
    state, init, refreshSignals, handleModeChange, followChart, revealSymbol, refreshAccuracy, renderStatsBar, renderSignalPanel, renderTable, switchView,
  };
})();