/* ============ MI Trade Console — guided trade + live monitor + alarms ============
   Flow
   ----
   1) Pick the currency/pair you want to trade (dropdown — defaults to the chart).
   2) Tap 🚀 TRADE. MI computes a full plan from the LIVE signal engine + the
      real-data timing engine and tells you:
         • WHEN to place the trade (now, or the exact local clock time + countdown)
         • WHEN to stop / close it  (expiry for digital options, time-stop otherwise)
         • Entry / Take-Profit / Stop-Loss and how "SURE" the setup is (conviction).
   3) MI then watches the chart tick-by-tick. When the trade is in profit and the
      chart starts acting suspicious (momentum flip, profit giving back, slippage
      toward the stop) it fires a VOICE alarm and runs an on-screen COUNTDOWN
      telling you to take the profit.
   All prices come from real market data (live SSE + /api/signals + /api/timing). */
(function () {
  'use strict';

  const LS_VOICE = 'mi.voice';
  const MAX_LOG = 60;
  const TP_COUNTDOWN_SEC = 15;   // take-profit countdown once suspicion fires
  const STOP_COUNTDOWN_SEC = 10;

  const state = {
    symbol: null,
    price: null,
    prevPrice: null,
    plan: null,          // prepared plan (armed, not placed)
    trade: null,         // active trade (placed & monitored)
    watching: false,     // HOLD symbol — waiting for the setup to turn sure
    timing: null,
    timingAt: 0,
    timingPending: false,
    peakR: 0,
    lastR: 0,
    prevSig: null,
    fired: {},           // one-shot event flags
    log: [],
    alarm: { kind: null, title: '', msg: '', until: 0, lastNum: 0, fired: false, action: null },
    timer: null,
  };

  // ------------------------------------------------ tiny helpers
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function safe(v) { return (v === null || v === undefined || isNaN(v)) ? null : Number(v); }
  function dirOf(a) { return (a === 'BUY' || a === 'CALL') ? 1 : (a === 'SELL' || a === 'PUT') ? -1 : 0; }
  function isUp(a) { return dirOf(a) > 0; }
  function isActive(action) { return action === 'BUY' || action === 'SELL' || action === 'CALL' || action === 'PUT'; }

  function sigFor(sym) {
    const list = (window.MINotify && MINotify.getSignals) ? MINotify.getSignals() : ((window.MISignals && MISignals.state.signals) || []);
    return (list || []).find(s => s.symbol === sym) || null;
  }
  function priceFor(sym) {
    const p = (window.MINotify && MINotify.getPrices) ? MINotify.getPrices() : {};
    return safe(p[sym]);
  }
  function assetLabel(sym) {
    if (!sym) return '—';
    const s = String(sym).toUpperCase();
    if (s.endsWith('_OTC')) return s.replace(/_OTC$/, '').replace(/^(.{3})(.{3})$/, '$1/$2') + ' OTC';
    return s.endsWith('USDT') ? s.replace(/USDT$/, '/USDT')
      : (/^[A-Z]{6}$/.test(s) ? s.replace(/^(.{3})(.{3})$/, '$1/$2') : sym);
  }
  function precOf(sig) {
    if (!sig) return null;
    if (sig.mode === 'forex' || (sig.mode === 'pocket' && sig.precision)) return sig.precision || 5;
    return null;
  }
  function fprice(v, sig) {
    const n = safe(v);
    if (n === null) return '—';
    const p = precOf(sig);
    if (p !== null) return n.toFixed(p);
    if (window.MI && MI.fmt) return MI.fmt.price(n);
    return '$' + n;
  }
  function clockLabel(ms) {
    const d = new Date(ms);
    let h = d.getHours();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    return h + ':' + String(d.getMinutes()).padStart(2, '0') + ' ' + ampm;
  }
  function durLabel(ms) {
    const m = Math.max(0, Math.round(ms / 60000));
    if (m < 60) return m + 'm';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }
  function say(text, tone, opts) {
    if (window.MIVoice) {
      if (tone) MIVoice.alarm(tone);
      MIVoice.say(text, opts);
    }
  }
  function logLine(kind, text) {
    state.log.unshift({ ts: Date.now(), kind, text });
    if (state.log.length > MAX_LOG) state.log.length = MAX_LOG;
    renderLog();
  }

  // ------------------------------------------------ paywall consistency
  // "user" accounts reveal signals with MI coins (shared with the Signals view
  // via localStorage 'mi.revealed'); the Trade Console respects the same gate.
  function revealedMap() { try { return JSON.parse(localStorage.getItem('mi.revealed') || '{}'); } catch { return {}; } }
  function isLocked(sym) { return (window.MI && MI.role === 'user') && !revealedMap()[sym]; }
  function lockHtml() {
    const coins = (window.MI && MI.coins != null) ? MI.coins : 0;
    return '<div class="trade-lock">' +
      '<div class="tl-lock-title">🔒 Trade plan locked</div>' +
      '<div class="tl-lock-sub">Reveal the full plan (entry, TP, SL, schedule &amp; voice) for <b>1 🪙</b> — balance: <b>' + coins + '</b></div>' +
      '<button class="btn primary sm" id="tradeUnlock">' + (coins > 0 ? '🔓 Unlock plan · 1 coin' : '🪙 Buy coins to unlock') + '</button>' +
      '</div>';
  }
  async function unlockForTrade() {
    const sym = state.symbol;
    if (window.MIAuth && MIAuth.role && MIAuth.role() === 'user') {
      const ok = await MIAuth.spend('signal');
      if (!ok) return;
    }
    const m = revealedMap(); m[sym] = true;
    try { localStorage.setItem('mi.revealed', JSON.stringify(m)); } catch { /* ignore */ }
    render();
  }

  // ------------------------------------------------ timing engine (WHEN to place)
  function nextOccurrenceUtc(hour) {
    const now = new Date();
    const d = new Date(now);
    d.setUTCSeconds(0, 0);
    d.setUTCHours(hour, 0, 0, 0);
    if (d.getTime() <= now.getTime()) d.setUTCDate(d.getUTCDate() + 1);
    return d;
  }
  function loadTiming(sym) {
    if (state.timingPending) return;
    const cached = state.timing && state.timing.__symbol === sym;
    if (cached && Date.now() - state.timingAt < 10 * 60 * 1000) return;
    state.timingPending = true;
    try {
      MI.api.get('/api/timing?symbol=' + encodeURIComponent(sym)).then(t => {
        state.timingPending = false;
        t.__symbol = sym;
        state.timing = t;
        state.timingAt = Date.now();
        if (state.symbol === sym) render();
      }).catch(() => { state.timingPending = false; });
    } catch { state.timingPending = false; }
  }
  // Returns when the trade should ideally be placed, in the user's LOCAL time.
  function placeTime(sig) {
    const t = state.timing && state.timing.__symbol === sig.symbol ? state.timing : null;
    const nowUtcHour = new Date().getUTCHours();
    const bestHours = (t && t.bestHours) || [];
    const inWindow = bestHours.some(b => b.hour === nowUtcHour);
    if (inWindow) return { at: Date.now(), label: 'NOW', inWindow: true, mins: 0 };
    if (bestHours.length) {
      const d = nextOccurrenceUtc(bestHours[0].hour);
      const mins = Math.max(0, Math.round((d.getTime() - Date.now()) / 60000));
      return { at: d.getTime(), label: clockLabel(d.getTime()), inWindow: false, mins };
    }
    // No timing data yet → the signal itself is actionable right now.
    return { at: Date.now(), label: 'NOW', inWindow: true, mins: 0 };
  }
  // How long the trade is planned to run before the time-stop.
  function exitMinutes(sig) {
    const d = String(sig.duration || '');
    if (sig.mode === 'pocket') {
      if (d.indexOf('1m') !== -1) return 1;
      if (d.indexOf('15m') !== -1) return 15;
      return 5;
    }
    const adx = safe(sig.adx);
    const atr = safe(sig.atrPct) || 0;
    let m = 90;
    if (adx !== null && adx >= 25) m = 150;
    else if (adx !== null && adx >= 20) m = 120;
    else if (adx !== null && adx <= 14) m = 60;
    if (atr >= 2) m = Math.min(m, 90);          // high volatility → shorter leash
    if (atr > 0 && atr < 0.4) m = Math.max(m, 120); // calm market → let it breathe
    return m;
  }

  // ------------------------------------------------ plan building
  function conviction(sig) {
    if (!sig || !isActive(sig.action)) return { tier: 'WAIT', label: '⏳ WAIT', sure: false };
    if (sig.quality === 'HIGH' && sig.confidence >= 78) return { tier: 'SURE', label: '✅ SURE — high conviction', sure: true };
    if (sig.quality === 'HIGH') return { tier: 'HIGH', label: '🔥 High conviction', sure: true };
    if (sig.quality === 'MEDIUM') return { tier: 'GOOD', label: '⚡ Good setup', sure: false };
    return { tier: 'WEAK', label: '○ Weak / speculative', sure: false };
  }

  function buildPlan(sig) {
    if (!sig) return null;
    const mode = sig.mode || (window.MI && MI.mode) || 'crypto';
    const expMin = exitMinutes(sig);
    const pt = placeTime(sig);
    const conv = conviction(sig);
    const entry = safe(sig.entry) != null ? sig.entry : (priceFor(sig.symbol) || sig.price);
    return {
      symbol: sig.symbol, asset: sig.asset || assetLabel(sig.symbol), mode,
      action: sig.action, dir: dirOf(sig.action), confidence: sig.confidence,
      quality: sig.quality, conv,
      entry, takeProfit: sig.takeProfit, stopLoss: sig.stopLoss,
      rr: sig.riskReward, atrPct: sig.atrPct, adx: sig.adx,
      precision: sig.precision || null,
      expiry: sig.expiry || null, payout: sig.payout || null,
      expMin, placeAt: pt.at, placeLabel: pt.label, inWindow: pt.inWindow,
      placeMins: pt.mins, builtAt: Date.now(), sigTime: sig.time,
    };
  }

  function actionWord(a) { return a === 'CALL' ? 'CALL' : a === 'PUT' ? 'PUT' : a === 'BUY' ? 'BUY' : a === 'SELL' ? 'SELL' : (a || '—'); }
  function sideWord(p) { return p.mode === 'pocket' ? (p.dir > 0 ? 'CALL ▲' : 'PUT ▼') : (p.dir > 0 ? 'BUY ▲' : 'SELL ▼'); }

  function armPlan(silent) {
    const sig = sigFor(state.symbol);
    if (!sig) { if (!silent) MI.toast('error', 'Not ready', 'MI is still loading the live signal for ' + assetLabel(state.symbol) + '.'); return null; }
    if (isLocked(state.symbol)) { unlockForTrade(); return null; }
    state.plan = buildPlan(sig);
    state.watching = !isActive(sig.action);
    state.fired = {};
    render();
    if (!silent) {
      if (state.watching) {
        say('No directional edge on ' + state.plan.asset + ' right now. The best window to trade is ' +
          (state.plan.inWindow ? 'now' : state.plan.placeLabel + ', in about ' + state.plan.placeMins + ' minutes') +
          '. I will alert you the moment the setup turns sure.');
        MI.toast('info', 'MI says: WAIT', state.plan.asset + ' has no edge yet — best window ' + state.plan.placeLabel + '.');
      } else {
        say(state.plan.asset + ' ' + actionWord(state.plan.action) + ' setup, ' + state.plan.confidence +
          ' percent confidence. ' + (state.plan.conv.sure ? 'This one looks sure. ' : '') +
          'Place your trade ' + (state.plan.inWindow ? 'now' : 'at ' + state.plan.placeLabel) +
          '. Plan to exit within ' + state.plan.expMin + ' minutes, at ' + clockLabel(state.plan.placeAt + state.plan.expMin * 60000) + '.', 'alert');
      }
    }
    return state.plan;
  }
// ------------------------------------------------ place / close
  function placeTrade() {
    const sym = state.symbol;
    if (!sym) { MI.toast('error', 'No asset', 'Pick the currency you want to trade first.'); return; }
    const sig = sigFor(sym);
    if (!sig) { MI.toast('error', 'Not ready', 'MI has no live signal for ' + assetLabel(sym) + ' yet.'); return; }
    if (isLocked(sym)) { MI.toast('info', 'Plan locked', 'Reveal the plan for ' + assetLabel(sym) + ' first (1 coin).'); unlockForTrade(); return; }

    if (!isActive(sig.action)) { armPlan(false); return; } // HOLD → explain + arm watcher

    if (state.trade && state.trade.symbol === sym) {
      say('You already have an open ' + actionWord(state.trade.plan.action) + ' trade on ' + assetLabel(sym) + '. Monitoring it now.');
      MI.toast('info', 'Trade already open', assetLabel(sym) + ' is already being monitored.');
      return;
    }

    state.plan = buildPlan(sig);
    const plan = state.plan;
    const now = Date.now();
    const entry = safe(plan.entry) != null ? plan.entry : priceFor(sym);
    const sl = safe(plan.stopLoss);
    const risk = (sl !== null && entry !== null) ? Math.abs(entry - sl) : null;
    state.trade = {
      id: 'T' + now.toString(36),
      symbol: sym, asset: plan.asset, plan,
      entry, takeProfit: safe(plan.takeProfit), stopLoss: sl, risk,
      dir: plan.dir, mode: plan.mode,
      placedAt: now,
      stopAt: now + plan.expMin * 60000,
      status: 'OPEN',
      closedAt: null, exitPrice: null, exitReason: null,
    };
    state.watching = false;
    state.peakR = 0; state.lastR = 0;
    state.fired = {};

    const entryTxt = fprice(entry, sig);
    const stopClock = clockLabel(state.trade.stopAt);
    logLine('place', '🚀 ' + actionWord(plan.action) + ' ' + plan.asset + ' @ ' + entryTxt +
      ' · exit by ' + stopClock + ' (' + plan.expMin + 'm)');
    MI.toast('success', 'Trade placed — monitoring live', plan.asset + ' ' + actionWord(plan.action) + ' @ ' + entryTxt +
      ' · stop by ' + stopClock);

    say('Trade placed on ' + plan.asset + '. ' + actionWord(plan.action) + ' near ' + entryTxt +
      '. Take profit ' + fprice(plan.takeProfit, sig) + ', stop loss ' + fprice(plan.stopLoss, sig) +
      '. ' + (plan.conv.sure ? 'This is a high conviction setup. ' : '') +
      'I will watch the chart and alarm you if it turns suspicious. Planned exit at ' + stopClock + '.',
      plan.conv.sure ? 'success' : 'alert');
    if (!state.timer) startTicker();
    render();
  }

  function tradeR(px) {
    const t = state.trade;
    if (!t || !t.risk) return 0;
    const move = t.dir > 0 ? (px - t.entry) : (t.entry - px);
    return move / t.risk;
  }

  function closeTrade(reason, exitPrice, silent) {
    const t = state.trade;
    if (!t) return;
    const px = exitPrice != null ? exitPrice : (priceFor(t.symbol) || t.entry);
    t.status = 'CLOSED';
    t.closedAt = Date.now();
    t.exitPrice = px;
    t.exitReason = reason;
    const r = tradeR(px);
    const pct = t.entry ? ((t.dir > 0 ? px - t.entry : t.entry - px) / t.entry) * 100 : 0;
    logLine(r >= 0 ? 'win' : 'loss', (r >= 0 ? '✅' : '🛑') + ' Closed ' + t.asset + ' via ' + reason +
      ' @ ' + fprice(px, t.plan) + ' · ' + (r >= 0 ? '+' : '') + r.toFixed(2) + 'R (' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%)');
    if (!silent) {
      MI.toast(r >= 0 ? 'success' : 'error', 'Trade closed — ' + reason,
        t.asset + ' closed @ ' + fprice(px, t.plan) + ' · result ' + (r >= 0 ? '+' : '') + r.toFixed(2) + 'R');
      say(r >= 0 ? 'Trade closed. ' + (r >= 0.9 ? 'Target reached, excellent.' : 'Profit secured.') :
        'Trade closed. Result ' + r.toFixed(1) + ' R. Stick to the plan and move on.', r >= 0 ? 'success' : 'warn');
    }
    clearAlarm();
    state.trade = null;
    state.plan = null;
    state.watching = false;
    render();
  }
// ------------------------------------------------ alarm + countdown
  function startAlarm(kind, title, msg, sec, action, voiceMsg) {
    state.alarm = { kind, title, msg, until: Date.now() + sec * 1000, lastNum: sec, fired: false, action: action || kind };
    const ov = $('tradeAlarm');
    if (ov) ov.classList.remove('hidden');
    const icon = $('taIcon'); if (icon) icon.textContent = kind === 'entry' ? '🎯' : kind === 'exit' ? '🛑' : '🔔';
    const t = $('taTitle'); if (t) t.textContent = title;
    const m = $('taMsg'); if (m) m.textContent = msg;
    const c = $('taCount'); if (c) { c.textContent = String(sec); c.classList.remove('hidden'); }
    const p = $('taPrimary');
    if (p) {
      p.textContent = action === 'tp' ? '✅ TAKE PROFIT NOW' : action === 'exit' ? '🛑 EXIT NOW' : '👍 Got it';
      p.classList.toggle('hidden', !action || action === 'entry');
    }
    const card = $('tradeAlarmCard');
    if (card) card.className = 'ta-card ' + (kind === 'tp' ? 'ta-tp' : kind === 'exit' ? 'ta-exit' : 'ta-entry');
    say(voiceMsg || msg, kind === 'tp' ? 'warn' : kind === 'exit' ? 'danger' : 'alert', { interrupt: true });
  }
  function clearAlarm() {
    state.alarm = { kind: null, title: '', msg: '', until: 0, lastNum: 0, fired: false, action: null };
    const ov = $('tradeAlarm'); if (ov) ov.classList.add('hidden');
  }
  function alarmTick() {
    const a = state.alarm;
    if (!a.kind || !a.until) return;
    const left = Math.max(0, Math.ceil((a.until - Date.now()) / 1000));
    const c = $('taCount');
    if (left > 0) {
      if (c) c.textContent = String(left);
      if (left !== a.lastNum) {
        a.lastNum = left;
        // Speak the countdown — the last 10 every second, earlier every 5s.
        if (left <= 10 || left % 5 === 0) {
          if (window.MIVoice) {
            MIVoice.say(String(left), { interrupt: true, rate: 1.2, pitch: 1.05 });
            if (left <= 5) MIVoice.tone([{ f: 1050, d: .05, v: .07, gap: 0 }]);
          }
        }
      }
    } else if (!a.fired) {
      a.fired = true;
      if (c) c.textContent = 'NOW';
      const t = $('taTitle');
      if (t) t.textContent = a.action === 'tp' ? '⏰ TAKE PROFIT NOW' : a.action === 'exit' ? '🛑 EXIT NOW' : a.title;
      say(a.action === 'tp' ? 'Time is up. Take your profit now — lock it in.' :
        a.action === 'exit' ? 'Exit your trade now.' : a.title,
        a.action === 'exit' ? 'danger' : 'success', { interrupt: true });
      logLine('alarm', '⏰ Alarm fired: ' + (a.title || a.kind));
    }
  }

  // ------------------------------------------------ suspicion detection
  // Decides whether an OPEN, in-profit trade is "acting suspicious" — the moment
  // MI should alarm you to bank the profit.
  function suspicion(sig, r) {
    const t = state.trade;
    const reasons = [];
    if (!t) return reasons;
    // 1) Profit giving back sharply from the best level seen.
    if (state.peakR >= 0.5 && (state.peakR - r) >= 0.35) {
      reasons.push('Profit is giving back — peaked at +' + state.peakR.toFixed(2) + 'R, now +' + r.toFixed(2) + 'R.');
    }
    // 2) The live signal flipped against your position.
    if (sig && isActive(sig.action) && dirOf(sig.action) !== t.dir && sig.confidence >= 55) {
      reasons.push('The live signal flipped to ' + sig.action + ' (' + sig.confidence + '% confidence).');
    }
    // 3) Momentum stalled: was meaningfully green, has slipped back to ~breakeven.
    if (state.peakR >= 0.6 && r <= 0.15) {
      reasons.push('Momentum stalled — the move ran out near ' + state.peakR.toFixed(2) + 'R.');
    }
    // 4) MACD rotation against the trade (non-option modes).
    if (sig && t.mode !== 'pocket' && r > 0.25 && sig.macdState && sig.macdState !== '—') {
      const bull = sig.macdState === 'Bullish';
      if (t.dir > 0 && !bull) reasons.push('MACD rotated bearish on the chart.');
      if (t.dir < 0 && bull) reasons.push('MACD rotated bullish on the chart.');
    }
    return reasons;
  }

  // ------------------------------------------------ ticker (runs every second)
  function tick() {
    const px = priceFor(state.symbol);
    if (px !== null) { state.prevPrice = state.price; state.price = px; }
    const sig = sigFor(state.symbol);

    if (state.trade) {
      const t = state.trade;
      const cur = priceFor(t.symbol);
      const r = cur !== null ? tradeR(cur) : state.lastR;
      state.lastR = r;
      if (r > state.peakR) state.peakR = r;

      // Take-profit reached.
      if (cur !== null && !state.fired.tpHit && t.takeProfit &&
        ((t.dir > 0 && cur >= t.takeProfit) || (t.dir < 0 && cur <= t.takeProfit))) {
        state.fired.tpHit = true;
        closeTrade('TAKE PROFIT', t.takeProfit, false);
        return;
      }
      // Stop-loss hit.
      if (cur !== null && t.stopLoss && !state.fired.slHit &&
        ((t.dir > 0 && cur <= t.stopLoss) || (t.dir < 0 && cur >= t.stopLoss))) {
        state.fired.slHit = true;
        startAlarm('exit', '🛑 STOP-LOSS HIT', 'Price reached your stop-loss at ' + fprice(t.stopLoss, t.plan) +
          '. Exit the trade and protect your capital.', STOP_COUNTDOWN_SEC, 'exit');
        logLine('alarm', '🛑 Stop-loss touched @ ' + fprice(t.stopLoss, t.plan));
      }
      // Time-stop reached.
      if (!state.fired.timeStop && Date.now() >= t.stopAt) {
        state.fired.timeStop = true;
        startAlarm('exit', '⌛ TIME TO CLOSE', 'Your planned trade window has ended (' + clockLabel(t.stopAt) +
          '). Close the trade and re-assess.', STOP_COUNTDOWN_SEC, 'exit');
      }
      // Suspicion → take-profit countdown.
      const reasons = suspicion(sig, r);
      if (reasons.length && !state.alarm.kind && r > 0.2) {
        state.fired.suspect = true;
        startAlarm('tp', '⚠️ CHART ACTING SUSPICIOUS', reasons[0] + ' Take your profit before it disappears.',
          TP_COUNTDOWN_SEC, 'tp',
          'Warning. The chart is acting suspicious. ' + reasons[0] + ' Take your profit in ' + TP_COUNTDOWN_SEC + ' seconds.');
        logLine('alarm', '⚠️ Suspicion: ' + reasons[0]);
      }
      // Approaching target advisory (only if nothing else is alarming).
      if (!state.alarm.kind && !state.fired.approach && t.takeProfit && cur !== null) {
        const dist = Math.abs(cur - t.takeProfit);
        const range = Math.abs(t.takeProfit - t.entry) || 1;
        if (dist / range <= 0.12 && r >= 0.75) {
          state.fired.approach = true;
          startAlarm('tp', '🎯 APPROACHING TARGET', 'Price is within striking distance of your take-profit at ' +
            fprice(t.takeProfit, t.plan) + '. Get ready to bank it.', Math.min(TP_COUNTDOWN_SEC, 10), 'tp');
        }
      }
    } else if (state.watching && state.plan) {
      // Armed on a HOLD symbol — announce when the ideal window arrives.
      if (!state.plan.inWindow && Date.now() >= state.plan.placeAt && !state.fired.entryWindow) {
        state.fired.entryWindow = true;
        startAlarm('entry', '🎯 TIME TO PLACE', 'The best window to trade ' + state.plan.asset +
          ' is now. Re-check the signal before entering.', 12, 'entry',
          'Now is the best time to place a trade on ' + state.plan.asset + '. Re-check the setup before entering.');
      }
    }

    alarmTick();
    render();
  }

  function startTicker() {
    if (state.timer) return;
    state.timer = setInterval(tick, 1000);
  }

  // ------------------------------------------------ rendering
  function currentPlan() {
    if (state.trade) return state.trade.plan;
    if (state.plan) return state.plan;
    const sig = sigFor(state.symbol);
    return sig ? buildPlan(sig) : null;
  }

  function setSymbol(sym) {
    if (!sym) return;
    state.symbol = sym;
    const sel = $('tradeSymbol'); if (sel && sel.value !== sym) sel.value = sym;
    const lbl = $('tradeSymLabel'); if (lbl) lbl.textContent = assetLabel(sym);
    if (state.trade && state.trade.symbol === sym) { render(); return; }
    // New symbol → fresh plan (an open trade on another pair keeps monitoring).
    state.plan = null; state.watching = false; state.fired = {};
    loadTiming(sym);
    render();
  }

  function render() {
    renderReadiness();
    renderPlan();
    renderMonitor();
    const cb = $('tradeCancelBtn');
    if (cb) cb.hidden = !state.trade;
    const pb = $('tradePlaceBtn');
    if (pb) {
      const p = currentPlan();
      if (state.trade) { pb.textContent = '📡 Monitoring ' + (state.trade.asset || ''); pb.classList.add('busy'); }
      else { pb.textContent = p && isActive(p.action) ? '🚀 TRADE ' + actionWord(p.action) : '🚀 TRADE'; pb.classList.remove('busy'); }
    }
  }

  function renderReadiness() {
    const el = $('tradeReadiness');
    if (!el) return;
    const plan = currentPlan();
    if (!plan) {
      el.className = 'trade-ready';
      el.innerHTML = '<div class="empty">⏳ MI is warming up — waiting for the live signal on <b>' + esc(assetLabel(state.symbol)) + '</b>…</div>';
      return;
    }
    const c = plan.conv;
    const cls = c.tier === 'SURE' ? 'ready-sure' : c.tier === 'WAIT' ? 'ready-wait' : (c.tier === 'GOOD' || c.tier === 'HIGH') ? 'ready-good' : 'ready-weak';
    el.className = 'trade-ready ' + cls;
    el.innerHTML =
      '<div class="rd-top"><span class="rd-verdict">' + c.label + '</span>' +
      (state.trade ? '<span class="rd-tag live">📡 LIVE — monitoring</span>' : (state.watching ? '<span class="rd-tag watch">👀 watching for entry</span>' : '')) +
      '</div>' +
      '<div class="rd-sub">' + esc(plan.asset) + ' · ' + esc(actionWord(plan.action)) + ' · <b>' + plan.confidence + '%</b> confidence' +
      (plan.quality ? ' · ' + esc(plan.quality) + ' tier' : '') + (plan.adx != null ? ' · ADX ' + plan.adx : '') +
      (plan.atrPct != null ? ' · ATR ' + plan.atrPct + '%' : '') + '</div>' +
      (c.tier === 'WAIT' ? '<div class="rd-note">No directional edge yet — MI will alert you (with voice) the moment the setup turns sure.</div>' : '') +
      (c.sure ? '<div class="rd-note">High-conviction setup — MI considers this trade <b>sure</b>. Follow the schedule below.</div>' : '');
  }

  function renderPlan() {
    const el = $('tradePlan');
    if (!el) return;
    if (isLocked(state.symbol)) { el.innerHTML = lockHtml(); return; }
    const plan = currentPlan();
    if (!plan || !isActive(plan.action)) { el.innerHTML = ''; return; }
    const now = Date.now();
    const stopAt = state.trade ? state.trade.stopAt : plan.placeAt + plan.expMin * 60000;
    const placeVal = plan.inWindow ? 'NOW' : plan.placeLabel;
    const placeSub = plan.inWindow ? 'inside MI\'s optimal window' : 'in ' + durLabel(Math.max(0, plan.placeAt - now));
    const stopSub = state.trade ? 'time-stop in ' + durLabel(Math.max(0, stopAt - now)) : 'max ' + plan.expMin + 'm after entry';

    const cur = state.price;
    let progress = '';
    if (state.trade && cur !== null && plan.takeProfit && plan.stopLoss && plan.takeProfit !== plan.stopLoss) {
      const pct = Math.max(0, Math.min(100, ((cur - plan.stopLoss) / (plan.takeProfit - plan.stopLoss)) * 100));
      const r = tradeR(cur);
      progress =
        '<div class="tp-prog"><div class="tp-prog-head"><span>SL ' + fprice(plan.stopLoss, plan) + '</span>' +
        '<span>Now <b>' + fprice(cur, plan) + '</b> (' + (r >= 0 ? '+' : '') + r.toFixed(2) + 'R)</span>' +
        '<span>TP ' + fprice(plan.takeProfit, plan) + '</span></div>' +
        '<div class="tp-prog-bar"><div class="tp-prog-fill" style="width:' + pct + '%"></div>' +
        '<span class="tp-prog-dot" style="left:calc(' + pct + '% - 6px)"></span></div></div>';
    }

    el.innerHTML =
      '<div class="tp-grid">' +
      '<div class="tp-cell"><span class="k">Direction</span><span class="v ' + (plan.dir > 0 ? 'buy-text' : 'sell-text') + '">' + esc(sideWord(plan)) + '</span></div>' +
      '<div class="tp-cell time"><span class="k">⏰ Place your trade</span><span class="v">' + esc(placeVal) + '</span><small>' + esc(placeSub) + '</small></div>' +
      '<div class="tp-cell time"><span class="k">🛑 Stop / exit by</span><span class="v">' + clockLabel(stopAt) + '</span><small>' + esc(stopSub) + '</small></div>' +
      '<div class="tp-cell"><span class="k">Entry</span><span class="v">' + fprice(plan.entry, plan) + '</span></div>' +
      '<div class="tp-cell"><span class="k">Take profit</span><span class="v green">' + fprice(plan.takeProfit, plan) + '</span></div>' +
      '<div class="tp-cell"><span class="k">Stop loss</span><span class="v red">' + fprice(plan.stopLoss, plan) + '</span></div>' +
      '<div class="tp-cell"><span class="k">Risk / Reward</span><span class="v gold">' + (plan.rr ? '1 : ' + plan.rr : '—') + '</span></div>' +
      (plan.mode === 'pocket'
        ? '<div class="tp-cell"><span class="k">Expiry</span><span class="v gold">' + esc(plan.expiry || (plan.expMin + 'm')) + '</span></div>' +
          '<div class="tp-cell"><span class="k">Payout (est.)</span><span class="v green">' + (plan.payout ? plan.payout + '%' : '—') + '</span></div>'
        : '') +
      '</div>' + progress +
      '<div class="tp-note">🔊 Voice guidance is ' + (voiceOn() ? '<b class="green">ON</b>' : '<b>OFF</b>') +
      ' — MI speaks the place-time, the exit-time and counts down the profit alert. ' +
      '⚠️ Analytical guidance, not financial advice.</div>';
  }

  function pctAway(cur, target) {
    if (cur === null || target === null || !cur) return '';
    return Math.abs(((target - cur) / cur) * 100).toFixed(2) + '% away';
  }

  function renderMonitor() {
    const el = $('tradeMonitor');
    const sub = $('tradeMonSub');
    if (!el) return;
    const t = state.trade;
    if (!t) {
      if (sub) sub.textContent = 'No active trade. Tap 🚀 TRADE to start monitoring.';
      el.innerHTML = '<div class="empty">Place a trade and MI watches it here: live R-multiple, distance to TP/SL, a countdown to the exit-by time, and a suspicion monitor that alarms you (with voice) to bank your profit.</div>';
      return;
    }
    const plan = t.plan;
    const cur = priceFor(t.symbol);
    const r = cur !== null ? tradeR(cur) : state.lastR;
    const pct = t.entry ? ((t.dir > 0 ? (cur || t.entry) - t.entry : t.entry - (cur || t.entry)) / t.entry) * 100 : 0;
    if (sub) sub.textContent = t.asset + ' ' + actionWord(plan.action) + ' · opened ' + clockLabel(t.placedAt) + ' · auto-managed live';
    const leftStop = Math.max(0, t.stopAt - Date.now());
    const sus = state.alarm.kind === 'tp';
    el.innerHTML =
      '<div class="tm-head">' +
      '<div class="tm-side ' + (t.dir > 0 ? 'buy' : 'sell') + '">' + esc(sideWord(plan)) + '</div>' +
      '<div class="tm-r ' + (r >= 0 ? 'up' : 'down') + '"><span class="k">Open P/L</span><span class="v">' + (r >= 0 ? '+' : '') + r.toFixed(2) + 'R</span><small>' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%</small></div>' +
      '<div class="tm-cell"><span class="k">Live price</span><span class="v">' + fprice(cur, plan) + '</span></div>' +
      '<div class="tm-cell"><span class="k">Peak</span><span class="v">+' + state.peakR.toFixed(2) + 'R</span></div>' +
      '</div>' +
      '<div class="tm-rows">' +
      '<div class="tm-row">🎯 Take profit <b class="green">' + fprice(plan.takeProfit, plan) + '</b> <span class="muted">' + pctAway(cur, plan.takeProfit) + '</span></div>' +
      '<div class="tm-row">🛑 Stop loss <b class="red">' + fprice(plan.stopLoss, plan) + '</b> <span class="muted">' + pctAway(cur, plan.stopLoss) + '</span></div>' +
      '<div class="tm-row">⏰ Exit by <b>' + clockLabel(t.stopAt) + '</b> <span class="muted">closes in ' + durLabel(leftStop) + '</span></div>' +
      '<div class="tm-row ' + (sus ? 'warn' : 'ok') + '">' + (sus ? '⚠️ Chart acting suspicious — take your profit' : '✅ Chart looks normal — no reversal signals') + '</div>' +
      '</div>';
  }

  function renderLog() {
    const el = $('tradeLog');
    if (!el) return;
    if (!state.log.length) { el.innerHTML = '<div class="empty">MI\'s trade actions and alarms appear here.</div>'; return; }
    el.innerHTML = state.log.map(l =>
      '<div class="tl-item ' + esc(l.kind) + '"><span class="tl-time">' + MI.fmt.shortTime(l.ts) + '</span>' +
      '<span class="tl-text">' + esc(l.text) + '</span></div>').join('');
  }

  function voiceOn() { return !!(window.MIVoice && MIVoice.isEnabled()); }
  function refreshVoiceBtn() {
    const b = $('tradeVoice');
    if (b) { b.textContent = voiceOn() ? '🎙️ Voice: ON' : '🔇 Voice: OFF'; b.classList.toggle('active', voiceOn()); }
  }

  // ------------------------------------------------ events
  function onSignals() {
    const sig = sigFor(state.symbol);
    if (state.watching && !state.trade && sig && isActive(sig.action)) {
      state.plan = buildPlan(sig);
      state.watching = false;
      startAlarm('entry', '🎯 SETUP TURNED SURE', sig.asset + ' now shows ' + sig.action + ' at ' + sig.confidence +
        '% confidence. Time to place your trade.', 15, 'entry',
        'Good news. ' + sig.asset + ' now shows a ' + actionWord(sig.action) + ' setup at ' + sig.confidence +
        ' percent. Time to place your trade.');
      logLine('entry', '🎯 Setup turned ' + sig.action + ' on ' + sig.asset);
    }
    render();
  }

  function toggleVoice() {
    if (!window.MIVoice) { MI.toast('info', 'Voice unavailable', 'This browser does not support speech synthesis.'); return; }
    const on = MIVoice.toggle();
    refreshVoiceBtn();
    render();
    if (on) MIVoice.say('Voice guidance on. I will speak your trade instructions and count down profit alerts.', { interrupt: true });
    MI.toast(on ? 'success' : 'info', on ? 'Voice guidance ON' : 'Voice guidance OFF',
      on ? 'MI will speak your trade instructions and alarm you by voice.' : 'MI will stay silent.');
  }

  function init() {
    const sel = $('tradeSymbol');
    if (sel) sel.addEventListener('change', () => setSymbol(sel.value));

    const place = $('tradePlaceBtn');
    if (place) place.addEventListener('click', () => {
      if (state.trade) { say('Already monitoring ' + state.trade.asset + '.'); return; }
      placeTrade();
    });

    const arm = $('tradeArmBtn');
    if (arm) arm.addEventListener('click', () => armPlan(false));

    const cancel = $('tradeCancelBtn');
    if (cancel) cancel.addEventListener('click', () => {
      if (state.trade) { if (confirm('Close the active trade and stop monitoring?')) closeTrade('MANUAL', null, false); }
      else { state.plan = null; state.watching = false; state.fired = {}; clearAlarm(); render(); }
    });

    const vb = $('tradeVoice');
    if (vb) vb.addEventListener('click', toggleVoice);

    const clr = $('tradeLogClear');
    if (clr) clr.addEventListener('click', () => { state.log = []; renderLog(); });

    const planBox = $('tradePlan');
    if (planBox) planBox.addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('#tradeUnlock') : null;
      if (b) unlockForTrade();
    });

    const taPrimary = $('taPrimary');
    if (taPrimary) taPrimary.addEventListener('click', () => {
      const a = state.alarm;
      if (state.trade && (a.action === 'tp' || a.action === 'exit')) closeTrade(a.action === 'tp' ? 'TAKE PROFIT' : 'EXIT', null, false);
      else clearAlarm();
      render();
    });
    const taDismiss = $('taDismiss');
    if (taDismiss) taDismiss.addEventListener('click', () => { clearAlarm(); render(); });

    if (window.MINotify) {
      MINotify.onEvent('signals', onSignals);
      MINotify.onEvent('market', () => tick());
    }
    if (window.MIVoice) MIVoice.onEvent(refreshVoiceBtn);

    refreshVoiceBtn();
    startTicker();
    const cs = (window.MIChart && MIChart.getSymbol) ? MIChart.getSymbol() : null;
    setSymbol(cs || (MI.config && MI.config.symbols && MI.config.symbols[0]) || 'BTCUSDT');
  }

  window.MITrade = { init, setSymbol, placeTrade, closeTrade, armPlan, render, state, toggleVoice };
})();