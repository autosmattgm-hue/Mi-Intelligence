/* ============ MI Settings page v6.2 — alerts, prefs, safety, account ============ */
(function () {
  'use strict';
  function gid(id) { return document.getElementById(id); }
  function get(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function paintToggle(btn, on) { if (btn) { btn.textContent = on ? 'ON' : 'OFF'; btn.classList.toggle('active', !!on); } }
  function applyTheme() {
    try { document.body.classList.toggle('light', (localStorage.getItem('mi.theme') || 'dark') === 'light'); } catch (e) {}
  }
  function applyCompact() {
    try { document.body.classList.toggle('pro-layout', (localStorage.getItem('mi.pro') || '0') === '1'); } catch (e) {}
  }
  function hero() {
    try {
      var user = (window.MI && MI.user) || null;
      var role = (window.MIAuth && MIAuth.role && MIAuth.role()) || ((window.MI && MI.role) || '');
      var name = role === 'owner' ? 'Owner' : (user && (user.name || user.email) || 'Trader');
      var n = gid('setHeroName'); if (n) n.textContent = name;
      var coins = (window.MI && MI.coins != null) ? MI.coins : null;
      var c = gid('setCoinCount'); if (c) c.textContent = coins != null ? coins : '—';
      var sub = gid('setHeroSub');
      if (sub) sub.textContent = role === 'owner' ? 'Owner · full access' : ('MI v6.2 · ' + (coins != null ? coins + ' coins' : 'set up your desk'));
    } catch (e) {}
  }
  function init() {
    var voice = gid('setVoice'), push = gid('setPush'), news = gid('setNews');
    var sound = gid('setSound'), otc = gid('setOtc'), hold = gid('setHold');
    var riskNote = gid('setRiskNote'), vibrate = gid('setVibrate'), logout = gid('setLogout');
    var tpWarn = gid('setTpWarn'), minConf = gid('setMinConf'), autoClose = gid('setAutoClose');
    var mode = gid('setMode'), tf = gid('setTf'), risk = gid('setRisk');
    if (!voice) return;
    paintToggle(voice, get('mi.voice', 'on') !== 'off');
    paintToggle(news, get('mi.news.block', 'on') !== 'off');
    paintToggle(sound, get('mi.notif.sound', 'on') !== 'off');
    paintToggle(otc, get('mi.show.otc', 'on') !== 'off');
    paintToggle(hold, get('mi.show.hold', 'on') !== 'off');
    paintToggle(riskNote, get('mi.risk.note', 'on') !== 'off');
    paintToggle(vibrate, get('mi.vibrate', 'on') !== 'off');
    try {
      var perm = localStorage.getItem('mi.notif.permission') || 'prompt';
      var osOn = localStorage.getItem('mi.os.push') === 'on' && perm === 'granted';
      paintToggle(push, osOn);
    } catch (e) {}
    if (tpWarn) tpWarn.value = get('mi.tp.warn', '60');
    if (minConf) minConf.value = get('mi.min.conf', '0');
    if (autoClose) autoClose.value = get('mi.viewer.autoclose', '35');
    if (mode) mode.value = get('mi.mode', 'crypto');
    if (tf) tf.value = get('mi.tf', '15m');
    if (risk) risk.value = get('mi.risk.pct', '2');
    voice.addEventListener('click', function () {
      var on = get('mi.voice', 'on') !== 'off';
      try { localStorage.setItem('mi.voice', on ? 'off' : 'on'); } catch (e) {}
      if (window.MIVoice && window.MIVoice.setEnabled) { try { window.MIVoice.setEnabled(!on); } catch (e) {} }
      paintToggle(voice, !on);
    });
    news.addEventListener('click', function () {
      var on = get('mi.news.block', 'on') !== 'off';
      set('mi.news.block', on ? 'off' : 'on');
      paintToggle(news, !on);
    });
    if (push) push.addEventListener('click', async function () {
      try {
        var cur = localStorage.getItem('mi.os.push') === 'on';
        if (!cur && window.MIPush) { await window.MIPush.enable(); }
        else if (cur && window.MIPush) { await window.MIPush.disable(); }
        else { localStorage.setItem('mi.os.push', cur ? 'off' : 'on'); }
        var on = localStorage.getItem('mi.os.push') === 'on';
        paintToggle(push, on);
        if (on && window.MI && MI.toast) MI.toast('success', '📳 Closed-app alarms ON', 'Install MI to your home screen — signals + TP alerts will ping even when the app is closed.');
      } catch (e) {}
    });
    var instPush = gid('setInstallPush');
    if (instPush) instPush.addEventListener('click', async function () {
      try {
        if (window.MIPush) await window.MIPush.enable();
        var on = localStorage.getItem('mi.os.push') === 'on' || (window.MIPush && window.MIPush.getState && window.MIPush.getState().enabled);
        paintToggle(push, !!on);
        if (window.MIPush) await window.MIPush.sendTest();
        if (window.MI && MI.toast) MI.toast('info', '📲 Installed-app alarms', 'Close the app now and tap Test — the ping arrives as a real phone notification.');
      } catch (e) {}
    });
    if (tpWarn) tpWarn.addEventListener('change', function () { set('mi.tp.warn', tpWarn.value); });
    if (minConf) minConf.addEventListener('change', function () {
      set('mi.min.conf', minConf.value);
      if (window.MISignals) { try { window.MISignals.renderTable(); } catch (e) {} }
    });
    if (autoClose) autoClose.addEventListener('change', function () { set('mi.viewer.autoclose', autoClose.value); });
    if (mode) mode.addEventListener('change', function () { set('mi.mode', mode.value); if (window.MIMode) window.MIMode.switchTo(mode.value); });
    if (tf) tf.addEventListener('change', function () {
      set('mi.tf', tf.value);
      try {
        document.querySelectorAll('#chartTf button').forEach(function (b) { b.classList.toggle('active', b.dataset.tf === tf.value); });
      } catch (e) {}
    });
    if (risk) risk.addEventListener('change', function () { set('mi.risk.pct', risk.value); if (window.MI && MI.toast) MI.toast('info', 'Risk set to ' + risk.value + '%', 'Position sizes now use ' + risk.value + '% risk per trade.'); });
    function bindToggle(btn, key, onRefresh) {
      if (!btn) return;
      btn.addEventListener('click', function () {
        var on = get(key, 'on') !== 'off';
        set(key, on ? 'off' : 'on');
        paintToggle(btn, !on);
        if (onRefresh && window.MISignals) { try { window.MISignals.renderTable(); window.MISignals.renderSignalPanel(); } catch (e) {} }
      });
    }
    bindToggle(sound, 'mi.notif.sound', false);
    try { if (sound) sound.addEventListener('click', function () { try { localStorage.setItem('mi.notif.sound', get('mi.notif.sound', 'on')); } catch (e) {} }); } catch (e) {}
    bindToggle(otc, 'mi.show.otc', true);
    bindToggle(hold, 'mi.show.hold', true);
    bindToggle(riskNote, 'mi.risk.note', true);
    bindToggle(vibrate, 'mi.vibrate', false);
    if (logout) logout.addEventListener('click', function () { if (window.MIAuth) window.MIAuth.logout(); });
    var logoutTop = gid('setLogoutTop');
    if (logoutTop) logoutTop.addEventListener('click', function () { if (window.MIAuth) window.MIAuth.logout(); });
    var buy = gid('setBuyCoins');
    if (buy) buy.addEventListener('click', function () { if (window.MIAuth) window.MIAuth.openUpgrade(); });
    var theme = gid('setTheme'), lang = gid('setLang'), clock = gid('setClock'), cur = gid('setCur');
    var compact = gid('setCompact'), banner = gid('setBanner'), trend = gid('setTrend'), high = gid('setHigh');
    var watchOnly = gid('setWatchOnly'), refresh = gid('setRefresh');
    if (theme) { theme.value = get('mi.theme', 'dark'); theme.addEventListener('change', function () { set('mi.theme', theme.value); applyTheme(); }); }
    if (lang) { lang.value = get('mi.lang', 'en'); lang.addEventListener('change', function () { set('mi.lang', lang.value); }); }
    if (clock) { clock.value = get('mi.clock', 'utc'); clock.addEventListener('change', function () { set('mi.clock', clock.value); }); }
    if (cur) { cur.value = get('mi.cur', 'USD'); cur.addEventListener('change', function () { set('mi.cur', cur.value); }); }
    paintToggle(compact, get('mi.pro', '0') === '1');
    paintToggle(banner, get('mi.banner', 'on') !== 'off');
    paintToggle(trend, get('mi.only.trend', 'off') === 'on');
    paintToggle(high, get('mi.only.high', 'off') === 'on');
    if (refresh) refresh.value = get('mi.refresh', '60');
    if (compact) compact.addEventListener('click', function () {
      var on = get('mi.pro', '0') !== '1';
      set('mi.pro', on ? '1' : '0'); applyCompact(); paintToggle(compact, on);
    });
    bindToggle(banner, 'mi.banner', false);
    bindToggle(trend, 'mi.only.trend', true);
    bindToggle(high, 'mi.only.high', true);
    if (watchOnly) {
      try { paintToggle(watchOnly, !!(window.MISignals && window.MISignals.state.watchOnly)); } catch (e) {}
      watchOnly.addEventListener('click', function () {
        try {
          var st = window.MISignals && window.MISignals.state;
          var on = !(st && st.watchOnly);
          if (st) st.watchOnly = on;
          paintToggle(watchOnly, on);
          if (window.MISignals) window.MISignals.renderTable();
        } catch (e) {}
      });
    }
    if (refresh) refresh.addEventListener('change', function () {
      set('mi.refresh', refresh.value);
      if (window.MISignals && window.MISignals.setRefresh) { try { window.MISignals.setRefresh(refresh.value); } catch (e) {} }
    });
    var nameSave = gid('setNameSave');
    if (nameSave) nameSave.addEventListener('click', function () {
      var v = (gid('setName').value || '').trim();
      if (!v) return;
      try {
        var raw = localStorage.getItem('mi.user'); var sess = raw ? JSON.parse(raw) : null;
        if (sess && sess.user) { sess.user.name = v; localStorage.setItem('mi.user', JSON.stringify(sess)); }
        if (window.MI && sess) MI.user = sess.user;
        hero(); if (window.MI && MI.toast) MI.toast('success', 'Name saved', v);
      } catch (e) {}
    });
    var ledgerBtn = gid('setLedger');
    if (ledgerBtn) ledgerBtn.addEventListener('click', function () {
      var box = gid('setLedgerList');
      if (!box) return;
      var q = []; try { q = JSON.parse(localStorage.getItem('mi.device.syncQueue.v1') || '[]'); } catch (e) {}
      box.innerHTML = q.length ? q.slice(-8).reverse().map(function (o) {
        return '<div class="tl-item"><span class="tl-time">' + new Date(o.ts || Date.now()).toLocaleString() + '</span><span class="tl-text">' + o.op + '</span></div>';
      }).join('') : '<div class="login-hint">No local coin activity yet.</div>';
    });
    var cw = gid('setClearWatch');
    if (cw) cw.addEventListener('click', function () {
      try { localStorage.removeItem('mi.watch'); localStorage.removeItem('mi.solo.v1'); } catch (e) {}
      if (window.MISignals) { try { window.MISignals.state.solo = null; window.MISignals.renderTable(); window.MISignals.renderSignalPanel(); } catch (e) {} }
      if (window.MI && MI.toast) MI.toast('info', 'Cleared', 'Watchlist and solo focus cleared.');
    });
    var ch = gid('setClearHist');
    if (ch) ch.addEventListener('click', function () {
      try { if (window.MI && MI.api) MI.api.del('/api/signals/history'); } catch (e) {}
      if (window.MI && MI.toast) MI.toast('info', 'History deleted', 'Signal history cleared.');
    });
    var ex = gid('setExport');
    if (ex) ex.addEventListener('click', function () {
      try {
        var dump = { user: localStorage.getItem('mi.user'), broker: localStorage.getItem('mi.broker.v1'), watch: localStorage.getItem('mi.watch'), exportedAt: new Date().toISOString() };
        var blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
        var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'mi-backup.json'; a.click();
      } catch (e) {}
    });
    var wipe = gid('setWipe');
    if (wipe) wipe.addEventListener('click', function () {
      if (!confirm('Delete this account from THIS phone?')) return;
      ['mi.user', 'mi.device.users.v1', 'mi.solo.v1', 'mi.revealed'].forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
      if (window.MIAuth) window.MIAuth.logout();
    });
    applyTheme(); applyCompact(); hero();
    document.addEventListener('mi:coins', hero);
    var clr = gid('setClearRevealed');
    if (clr) clr.addEventListener('click', function () {
      try { localStorage.removeItem('mi.revealed'); } catch (e) {}
      if (window.MI && MI.toast) MI.toast('info', 'Revealed signals cleared', 'Signals are locked again — 1 coin per reveal.');
      if (window.MISignals) { try { window.MISignals.renderSignalPanel(); window.MISignals.renderTable(); } catch (e) {} }
    });
  }
  document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 600); });
  window.MISettings = { init: init };
})();
