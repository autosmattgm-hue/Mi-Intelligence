/* ============ MI Settings v6.3 — bind-once (fixes dead buttons) ============
   Bug: init() ran on every Settings visit and stacked duplicate listeners,
   so toggles flipped twice = looked dead. Fix: dataset.bound guards. */
(function () {
  'use strict';
  function gid(id) { return document.getElementById(id); }
  function get(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function paintToggle(btn, on) { if (btn) { btn.textContent = on ? 'ON' : 'OFF'; btn.classList.toggle('active', !!on); } }
  function once(el, fn) {
    if (!el || el.dataset.bound) return;
    el.dataset.bound = '1';
    el.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); fn(e); });
  }
  function onceChange(el, fn) {
    if (!el || el.dataset.bound) return;
    el.dataset.bound = '1';
    el.addEventListener('change', fn);
  }
  function applyTheme() { try { document.body.classList.toggle('light', get('mi.theme', 'dark') === 'light'); } catch (e) {} }
  function applyCompact() { try { document.body.classList.toggle('pro-layout', get('mi.pro', '0') === '1'); } catch (e) {} }
  function hero() {
    try {
      var user = (window.MI && MI.user) || null;
      var role = (window.MIAuth && MIAuth.role && MIAuth.role()) || ((window.MI && MI.role) || '');
      var n = gid('setHeroName'); if (n) n.textContent = role === 'owner' ? 'Owner' : (user && (user.name || user.email) || 'Trader');
      var coins = (window.MI && MI.coins != null) ? MI.coins : null;
      var c = gid('setCoinCount'); if (c) c.textContent = coins != null ? coins : '—';
      var acc = gid('settingsAccount');
      if (acc) acc.textContent = role === 'owner' ? 'Owner · full access (no coins needed)' :
        user ? (user.name || user.email || 'User') + ' · ' + (user.email || '') + ' · coins ' + (coins != null ? coins : '—') : 'Not signed in';
    } catch (e) {}
  }
  function toast(t, a, b) { if (window.MI && MI.toast) MI.toast(t, a, b); }
  function refreshSignals() { if (window.MISignals) { try { window.MISignals.renderTable(); window.MISignals.renderSignalPanel(); } catch (e) {} } }
  function paintAll() {
    paintToggle(gid('setVoice'), get('mi.voice', 'on') !== 'off');
    paintToggle(gid('setNews'), get('mi.news.block', 'on') !== 'off');
    paintToggle(gid('setSound'), get('mi.notif.sound', 'on') !== 'off');
    paintToggle(gid('setOtc'), get('mi.show.otc', 'on') !== 'off');
    paintToggle(gid('setHold'), get('mi.show.hold', 'on') !== 'off');
    paintToggle(gid('setRiskNote'), get('mi.risk.note', 'on') !== 'off');
    paintToggle(gid('setVibrate'), get('mi.vibrate', 'on') !== 'off');
    paintToggle(gid('setCompact'), get('mi.pro', '0') === '1');
    paintToggle(gid('setBanner'), get('mi.banner', 'on') !== 'off');
    paintToggle(gid('setTrend'), get('mi.only.trend', 'off') === 'on');
    paintToggle(gid('setHigh'), get('mi.only.high', 'off') === 'on');
    try { paintToggle(gid('setPush'), localStorage.getItem('mi.os.push') === 'on' || localStorage.getItem('mi.push.enabled') === '1'); } catch (e) {}
    try { if (window.MISignals && window.MISignals.state) paintToggle(gid('setWatchOnly'), !!window.MISignals.state.watchOnly); } catch (e) {}
    var vals = { setTpWarn: ['mi.tp.warn', '60'], setMinConf: ['mi.min.conf', '0'], setMode: ['mi.mode', 'crypto'], setTf: ['mi.tf', '15m'], setRisk: ['mi.risk.pct', '2'], setTheme: ['mi.theme', 'dark'], setLang: ['mi.lang', 'en'], setClock: ['mi.clock', 'utc'], setCur: ['mi.cur', 'USD'], setRefresh: ['mi.refresh', '60'] };
    Object.keys(vals).forEach(function (id) { var el = gid(id); if (el) el.value = get(vals[id][0], vals[id][1]); });
    hero();
  }
  function init() {
    var voice = gid('setVoice');
    if (!voice) return;
    paintAll();
    applyTheme(); applyCompact(); hero();
    once(voice, function () {
      var on = get('mi.voice', 'on') !== 'off';
      set('mi.voice', on ? 'off' : 'on');
      if (window.MIVoice && window.MIVoice.setEnabled) { try { window.MIVoice.setEnabled(!on); } catch (e) {} }
      paintToggle(voice, !on);
      toast('info', 'Voice ' + (!on ? 'ON' : 'OFF'), !on ? 'MI will speak TP alerts.' : 'MI stays silent.');
    });
    once(gid('setNews'), function () {
      var on = get('mi.news.block', 'on') !== 'off';
      set('mi.news.block', on ? 'off' : 'on');
      paintToggle(gid('setNews'), !on);
      toast('info', 'News block ' + (!on ? 'ON' : 'OFF'), '');
    });
    once(gid('setPush'), function () {
      try {
        var cur = get('mi.os.push', 'off') === 'on';
        if (!cur && window.MIPush) { window.MIPush.enable(); }
        else if (cur && window.MIPush) { window.MIPush.disable(); }
        else { set('mi.os.push', 'off'); }
        setTimeout(function () {
          var on = get('mi.os.push', 'off') === 'on' || get('mi.push.enabled', '0') === '1';
          paintToggle(gid('setPush'), !!on);
        }, 600);
        toast('info', 'Device push', 'Follow the popup, then use Test in the bell panel.');
      } catch (e) {}
    });
    once(gid('setInstallPush'), function () {
      try {
        if (window.MIPush) { window.MIPush.enable(); if (window.MIPush.sendTest) setTimeout(function () { try { window.MIPush.sendTest(); } catch (e) {} }, 1200); }
        toast('info', 'Install & enable', 'Close the app and check — the ping arrives as a phone notification.');
      } catch (e) {}
    });
    var toggles = [['setSound', 'mi.notif.sound', 'on', false], ['setOtc', 'mi.show.otc', 'on', true],
      ['setHold', 'mi.show.hold', 'on', true], ['setRiskNote', 'mi.risk.note', 'on', true],
      ['setVibrate', 'mi.vibrate', 'on', false], ['setBanner', 'mi.banner', 'on', false],
      ['setTrend', 'mi.only.trend', 'off', true], ['setHigh', 'mi.only.high', 'off', true]];
    toggles.forEach(function (cfg) {
      var btn = gid(cfg[0]); if (!btn) return;
      once(btn, function () {
        var on = get(cfg[1], cfg[2]) !== 'off';
        set(cfg[1], on ? 'off' : 'on');
        paintToggle(btn, !on);
        if (cfg[3]) refreshSignals();
      });
    });
    once(gid('setCompact'), function () {
      var on = get('mi.pro', '0') !== '1';
      set('mi.pro', on ? '1' : '0'); applyCompact(); paintToggle(gid('setCompact'), on);
      if (window.MIChart && MIChart.resize) { try { MIChart.resize(); } catch (e) {} }
    });
    once(gid('setWatchOnly'), function () {
      try {
        var st = window.MISignals && window.MISignals.state;
        var on = !(st && st.watchOnly);
        if (st) st.watchOnly = on;
        paintToggle(gid('setWatchOnly'), on);
        if (window.MISignals) window.MISignals.renderTable();
      } catch (e) {}
    });
    once(gid('setLogout'), function () { if (window.MIAuth) window.MIAuth.logout(); });
    once(gid('setLogoutTop'), function () { if (window.MIAuth) window.MIAuth.logout(); });
    once(gid('setBuyCoins'), function () { if (window.MIAuth) window.MIAuth.openUpgrade(); });
    once(gid('setNameSave'), function () {
      var inp = gid('setName'); var v = inp ? (inp.value || '').trim() : '';
      if (!v) { toast('info', 'Name', 'Type a display name first.'); return; }
      try {
        var raw = localStorage.getItem('mi.user'); var sess = raw ? JSON.parse(raw) : null;
        if (sess && sess.user) { sess.user.name = v; localStorage.setItem('mi.user', JSON.stringify(sess)); }
        if (window.MI && sess) MI.user = sess.user;
        hero(); toast('success', 'Name saved', v);
      } catch (e) {}
    });
    once(gid('setPwSave'), function () {
      toast('info', 'Password', 'Server accounts: change it from the login screen. Phone accounts use the saved password.');
    });
    once(gid('setLedger'), function () {
      var box = gid('setLedgerList'); if (!box) return;
      if (box.innerHTML && !box.classList.contains('hidden')) { box.classList.add('hidden'); box.innerHTML = ''; return; }
      box.classList.remove('hidden');
      var q = []; try { q = JSON.parse(localStorage.getItem('mi.device.syncQueue.v1') || '[]'); } catch (e) {}
      box.innerHTML = q.length ? q.slice(-8).reverse().map(function (o) {
        return '<div class="tl-item"><span class="tl-time">' + new Date(o.ts || Date.now()).toLocaleString() + '</span><span class="tl-text">' + (o.op || '') + '</span></div>';
      }).join('') : '<div class="login-hint">No local coin activity yet.</div>';
    });
    once(gid('setClearWatch'), function () {
      try { localStorage.removeItem('mi.watch'); localStorage.removeItem('mi.solo.v1'); } catch (e) {}
      if (window.MISignals) { try { window.MISignals.state.solo = null; window.MISignals.state.watchOnly = false; paintToggle(gid('setWatchOnly'), false); window.MISignals.renderTable(); window.MISignals.renderSignalPanel(); } catch (e2) {} }
      toast('info', 'Cleared', 'Watchlist and solo focus cleared.');
    });
    once(gid('setClearHist'), function () {
      try { if (window.MI && MI.api) MI.api.del('/api/signals/history'); } catch (e) {}
      try { if (window.MISignals && window.MISignals.state) { window.MISignals.state.history = []; if (window.MISignals.renderHistory) window.MISignals.renderHistory(); } } catch (e) {}
      toast('info', 'History deleted', 'Signal history cleared.');
    });
    once(gid('setExport'), function () {
      try {
        var dump = { user: localStorage.getItem('mi.user'), broker: localStorage.getItem('mi.broker.v1'), watch: localStorage.getItem('mi.watch'), exportedAt: new Date().toISOString() };
        var blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
        var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'mi-backup.json'; a.click();
        toast('success', 'Exported', 'mi-backup.json downloaded.');
      } catch (e) {}
    });
    once(gid('setWipe'), function () {
      if (!confirm('Delete this account from THIS phone?')) return;
      ['mi.user', 'mi.device.users.v1', 'mi.solo.v1', 'mi.revealed'].forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
      if (window.MIAuth) window.MIAuth.logout();
    });
    once(gid('setClearRevealed'), function () {
      try { localStorage.removeItem('mi.revealed'); } catch (e) {}
      toast('info', 'Revealed signals cleared', 'Signals are locked again — 1 coin per reveal.');
      refreshSignals();
    });
    onceChange(gid('setTpWarn'), function (e) { set('mi.tp.warn', e.target.value); toast('info', 'TP warning saved', e.target.value + 's before TP.'); });
    onceChange(gid('setMinConf'), function (e) { set('mi.min.conf', e.target.value); refreshSignals(); });
    onceChange(gid('setMode'), function (e) { set('mi.mode', e.target.value); if (window.MIMode) window.MIMode.switchTo(e.target.value); });
    onceChange(gid('setTf'), function (e) {
      set('mi.tf', e.target.value);
      try { document.querySelectorAll('#chartTf button, #chartTimeframes button').forEach(function (b) { b.classList.toggle('active', b.dataset.tf === e.target.value); }); } catch (ex) {}
      toast('info', 'Chart interval', e.target.value);
    });
    onceChange(gid('setRisk'), function (e) { set('mi.risk.pct', e.target.value); toast('info', 'Risk set to ' + e.target.value + '%', 'Position sizes now use ' + e.target.value + '% risk per trade.'); });
    onceChange(gid('setTheme'), function (e) { set('mi.theme', e.target.value); applyTheme(); });
    onceChange(gid('setLang'), function (e) { set('mi.lang', e.target.value); toast('info', 'Language saved', e.target.value); });
    onceChange(gid('setClock'), function (e) { set('mi.clock', e.target.value); });
    onceChange(gid('setCur'), function (e) { set('mi.cur', e.target.value); });
    onceChange(gid('setRefresh'), function (e) {
      set('mi.refresh', e.target.value);
      if (window.MISignals && window.MISignals.setRefresh) { try { window.MISignals.setRefresh(e.target.value); } catch (ex) {} }
    });
    applyTheme(); applyCompact(); hero();
    try { document.addEventListener('mi:coins', hero); } catch (e) {}
  }
  document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 600); });
  window.MISettings = { init: init, paintAll: paintAll };
})();
