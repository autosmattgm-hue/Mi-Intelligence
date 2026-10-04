/* MIBrokers v6 part 2: Forex hub UI (step1 broker -> step2 MT5/MT4 -> activated) */
(function () {
  'use strict';
  function hub() { return document.getElementById('brokerHub'); }
  function step1Html(st) {
    return '<div class="brk-title">Forex: choose your broker</div><div class="brk-grid">'
      + '<button class="brk-card' + (st.broker === 'pocket' ? ' sel' : '') + '" data-brk="pocket"><div class="brk-ico">Pocket</div><div class="brk-name">Pocket Option</div></button>'
      + '<button class="brk-card' + (st.broker === 'mt5' ? ' sel' : '') + '" data-brk="mt5"><div class="brk-ico">MT5</div><div class="brk-name">MT5</div></button>'
      + '<button class="brk-card' + (st.broker === 'exness' ? ' sel' : '') + '" data-brk="exness"><div class="brk-ico">EX</div><div class="brk-name">Exness</div></button>'
      + '</div><div class="brk-hint">Next: confirm Forex MT5 Real or MT4 Real.</div>';
  }
  function render() {
    var box = hub(); if (!box || !window.MIBrokers) return;
    var st = window.MIBrokers.get();
    var step = box.dataset.step || 'step1';
    if (step === 'step1') { box.innerHTML = step1Html(st); }
    else if (step === 'step2') {
      var bn = st.broker === 'pocket' ? 'Pocket Option' : st.broker === 'exness' ? 'Exness' : 'MT5';
      box.innerHTML = '<div class="brk-title">' + bn + ' selected</div><div class="brk-grid">'
        + '<button class="brk-card big' + (st.fxAccount === 'mt5' ? ' sel' : '') + '" data-fxacc="mt5"><div class="brk-name">Forex MT5 Real</div></button>'
        + '<button class="brk-card big' + (st.fxAccount === 'mt4' ? ' sel' : '') + '" data-fxacc="mt4"><div class="brk-name">Forex MT4 Real</div></button>'
        + '</div><button class="link-btn" id="brkBack">Back</button>';
    } else {
      box.innerHTML = '<div class="brk-done">Activated for ' + (st.fxAccount === 'mt4' ? 'MT4 Real' : 'MT5 Real') + '</div>'
        + '<div class="brk-row"><button class="btn ghost" id="brkChange">Change</button>'
        + '<button class="btn primary" id="brkOpen">Open broker</button></div>';
    }
    box.querySelectorAll('[data-brk]').forEach(function (b) {
      b.addEventListener('click', function () { window.MIBrokers._state.broker = b.dataset.brk; window.MIBrokers._save(); box.dataset.step = 'step2'; render(); });
    });
    box.querySelectorAll('[data-fxacc]').forEach(function (b) {
      b.addEventListener('click', function () {
        window.MIBrokers._state.fxAccount = b.dataset.fxacc; window.MIBrokers._save();
        box.dataset.step = 'done'; render();
        if (window.MI && MI.toast) MI.toast('success', window.MIBrokers.label(), 'BUY/SELL now routes to your terminal.');
      });
    });
    var back = document.getElementById('brkBack');
    if (back) back.addEventListener('click', function () { box.dataset.step = 'step1'; render(); });
    var ch = document.getElementById('brkChange');
    if (ch) ch.addEventListener('click', function () { box.dataset.step = 'step1'; render(); });
    var op = document.getElementById('brkOpen');
    if (op) op.addEventListener('click', function () {
      var mode = (window.MI && MI.mode) || 'forex';
      var sym = (window.MITrade && MITrade.state && MITrade.state.symbol) || 'EURUSD';
      try { window.open(window.MIBrokers.url(mode === 'forex' ? 'forex' : mode, sym), '_blank', 'noopener'); } catch (e) {}
    });
  }
  function ensure() {
    // v6.1: broker hub NO LONGER lives in the Signals view (user request).
    // It lives ONLY in Settings (see #settingsBroker). Clean up any old hub.
    try { var old = document.getElementById('brokerHub'); if (old) old.remove(); } catch (e) {}
    var box = settingsBox();
    if (box) renderSettings();
  }
  function settingsBox() { return document.getElementById('settingsBroker'); }
  // Render the broker changer inside the Settings page.
  function renderSettings() {
    var box = settingsBox(); if (!box || !window.MIBrokers) return;
    var st = window.MIBrokers.get();
    box.innerHTML = '<div class="brk-done">' + window.MIBrokers.label() + '</div>'
      + '<div class="brk-hint">BUY / SELL buttons route here. Change any time — saved on this phone.</div>'
      + '<div class="brk-row"><button class="btn ghost" id="setBrkChange">Change broker</button>'
      + '<button class="btn primary" id="setBrkOpen">Open broker ↗</button></div>';
    var ch = document.getElementById('setBrkChange');
    if (ch) ch.addEventListener('click', function () { ask().then(function () { renderSettings(); }); });
    var op = document.getElementById('setBrkOpen');
    if (op) op.addEventListener('click', function () {
      var mode = (window.MI && MI.mode) || 'forex';
      var sym = (window.MITrade && MITrade.state && MITrade.state.symbol) || 'EURUSD';
      try { window.open(window.MIBrokers.url(mode === 'forex' ? 'forex' : mode, sym), '_blank', 'noopener'); } catch (e) {}
    });
  }
  // Hub only matters in Forex mode — hide elsewhere to stay professional.
  function applyVisibility() {
    var box = hub(); if (!box) return;
    var mode = (window.MI && MI.mode) || 'crypto';
    box.classList.toggle('hidden', mode !== 'forex');
  }
  document.addEventListener('mi:mode', function () { applyVisibility(); });
  // v6.1: popup ONLY at user sign-up (called from auth afterLogin) or from
  // Settings. Never on mode switch, never on BUY/SELL.
  function ask(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var st = window.MIBrokers ? window.MIBrokers.get() : { broker: 'pocket', fxAccount: 'mt5' };
      // If already activated before, still show quick confirm (no friction).
      var ov = document.createElement('div');
      ov.className = 'modal-backdrop'; ov.id = 'brokerAsk';
      ov.innerHTML = '<div class="modal brk-ask">'
        + '<div class="brk-title">💱 Forex — choose your broker</div>'
        + '<div class="brk-grid">'
        + '<button class="brk-card' + (st.broker === 'pocket' ? ' sel' : '') + '" data-ask-brk="pocket"><div class="brk-ico">⏱️</div><div class="brk-name">Pocket Option</div><div class="brk-sub">Digital + Forex</div></button>'
        + '<button class="brk-card' + (st.broker === 'mt5' ? ' sel' : '') + '" data-ask-brk="mt5"><div class="brk-ico">📈</div><div class="brk-name">MT5</div><div class="brk-sub">MetaTrader 5</div></button>'
        + '<button class="brk-card' + (st.broker === 'exness' ? ' sel' : '') + '" data-ask-brk="exness"><div class="brk-ico">🌍</div><div class="brk-name">Exness</div><div class="brk-sub">MT4 / MT5</div></button>'
        + '</div>'
        + '<div class="brk-title" style="margin-top:10px">Real account?</div>'
        + '<div class="brk-grid">'
        + '<button class="brk-card big' + (st.fxAccount === 'mt5' ? ' sel' : '') + '" data-ask-acc="mt5"><div class="brk-name">Forex MT5 Real</div></button>'
        + '<button class="brk-card big' + (st.fxAccount === 'mt4' ? ' sel' : '') + '" data-ask-acc="mt4"><div class="brk-name">Forex MT4 Real</div></button>'
        + '</div>'
        + '<div class="brk-hint" id="askHint">Select a broker, then MT5 Real or MT4 Real.</div>'
        + '<div class="modal-actions"><button class="btn primary" id="askGo" disabled>Activate</button></div>'
        + '</div>';
      document.body.appendChild(ov);
      var pickB = st.broker, pickA = st.fxAccount;
      function paint() {
        ov.querySelectorAll('[data-ask-brk]').forEach(function (b) { b.classList.toggle('sel', b.dataset.askBrk === pickB); });
        ov.querySelectorAll('[data-ask-acc]').forEach(function (b) { b.classList.toggle('sel', b.dataset.askAcc === pickA); });
        var go = document.getElementById('askGo');
        if (go) go.disabled = !(pickB && pickA);
        var hint = document.getElementById('askHint');
        if (hint && pickB && pickA) {
          var bn = pickB === 'pocket' ? 'Pocket Option' : pickB === 'exness' ? 'Exness' : 'MT5';
          hint.textContent = bn + ' + Forex ' + (pickA === 'mt4' ? 'MT4 Real' : 'MT5 Real') + ' — tap Activate.';
        }
      }
      ov.querySelectorAll('[data-ask-brk]').forEach(function (b) { b.addEventListener('click', function () { pickB = b.dataset.askBrk; paint(); }); });
      ov.querySelectorAll('[data-ask-acc]').forEach(function (b) { b.addEventListener('click', function () { pickA = b.dataset.askAcc; paint(); }); });
      paint();
      document.getElementById('askGo').addEventListener('click', function () {
        if (window.MIBrokers) { window.MIBrokers._state.broker = pickB; window.MIBrokers._state.fxAccount = pickA; window.MIBrokers._save(); }
        try { localStorage.setItem('mi.broker.asked.v1', '1'); } catch (e) {}
        renderSettings();
        try { ov.remove(); } catch (e) {}
        if (window.MI && MI.toast) MI.toast('success', window.MIBrokers ? window.MIBrokers.label() : 'Broker activated', 'BUY/SELL now routes to your terminal.');
        resolve({ broker: pickB, fxAccount: pickA });
      });
      ov.addEventListener('click', function (e) {
        // Signup flow should not be skippable by accident — but allow close;
        // choice can be changed later in Settings.
        if (e.target === ov) { try { ov.remove(); } catch (x) {} resolve(null); }
      });
    });
  }
  document.addEventListener('DOMContentLoaded', function () { ensure(); setTimeout(ensure, 1200); });
  window.MIBrokersHub = { render: renderSettings, renderSettings: renderSettings, ensure: ensure, ask: ask };
})();
