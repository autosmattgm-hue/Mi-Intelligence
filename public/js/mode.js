/* ============ MI market modes — Crypto · Pocket Option · Forex ============
   Builds the mode switcher, keeps MI.mode up to date, tells the server which
   mode is active, and re-wires chart / signals / market modules on switch.
   On Vercel (stateless) the mode is passed with every API request instead. */
(function () {
  'use strict';

  const LS = 'mi.mode';
  const state = { current: localStorage.getItem(LS) || 'crypto', modes: [] };

  function $(id) { return document.getElementById(id); }

  function setMode(mode) {
    if (mode && mode !== state.current) {
      state.current = mode;
      localStorage.setItem(LS, mode);
    }
    if (window.MI) window.MI.mode = state.current;
    highlight();
    updateStatusText();
  }

  function highlight() {
    document.querySelectorAll('.mode-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.mode === state.current));
  }

  function updateStatusText() {
    const st = $('statusText');
    if (st && state.modes.length) {
      const m = state.modes.find(x => x.id === state.current);
      if (m && st.textContent.indexOf('·') === -1) st.textContent = st.textContent + ' · ' + m.label;
    }
  }

  // Make every existing API GET carry the active mode (?mode=…) — this is what
  // makes the app work on Vercel, where there is no server-side mode state.
  function patchApi() {
    if (!window.MI || !MI.api || MI.api.__modePatched) return;
    const origGet = MI.api.get.bind(MI.api);
    MI.api.get = async (path) => {
      const sep = String(path).includes('?') ? '&' : '?';
      const mode = encodeURIComponent(state.current);
      const withMode = String(path) + (String(path).includes('mode=') ? '' : sep + 'mode=' + mode);
      return origGet(withMode);
    };
    MI.api.__modePatched = true;
  }

  function buildSwitcher(cfg) {
    const wrap = $('modeSwitcher');
    if (!wrap) return;
    state.modes = (cfg.modes && cfg.modes.length) ? cfg.modes : [
      { id: 'crypto', label: 'Crypto', icon: '💠' },
      { id: 'pocket', label: 'Pocket Option', icon: '⏱️' },
      { id: 'forex', label: 'Forex', icon: '💱' },
    ];
    wrap.innerHTML = state.modes.map(m =>
      '<button class="mode-btn" data-mode="' + m.id + '" title="' + (m.description || m.label) + '">' +
      (m.icon || '') + ' ' + m.label + '</button>').join('');
    wrap.querySelectorAll('.mode-btn').forEach(b => {
      b.addEventListener('click', () => switchTo(b.dataset.mode));
    });
    // Server-reported mode wins (local server actually switched).
    if (cfg.mode && cfg.modes) setMode(cfg.mode);
    highlight();
  }

  async function switchTo(mode) {
    if (!mode || !state.modes.some(m => m.id === mode)) return;
    if (state.current === mode && window.MI && MI.mode === mode) return;
    setMode(mode);
    // Tell the local server (Vercel ignores this endpoint).
    try { if (window.MI && MI.api) await MI.api.post('/api/mode', { mode }); } catch { /* Vercel */ }
    // Reconnect the live feed on the new mode and force a full refresh.
    if (window.MINotify && typeof MINotify.switchMode === 'function') MINotify.switchMode(mode);
    if (window.MISignals && typeof MISignals.handleModeChange === 'function') MISignals.handleModeChange(mode);
    if (window.MIChart && typeof MIChart.handleModeChange === 'function') MIChart.handleModeChange(mode);
    if (window.MIMarket && typeof MIMarket.handleModeChange === 'function') MIMarket.handleModeChange(mode);
    if (window.MIPortfolio && typeof MIPortfolio.handleModeChange === 'function') MIPortfolio.handleModeChange(mode);
    if (window.MI && MI.toast) MI.toast('info', 'Mode switched', 'Now showing ' + (state.modes.find(m => m.id === mode) || {}).label + ' market data.');
  }

  async function init() {
    patchApi();
    try {
      const cfg = await MI.api.get('/api/config');
      buildSwitcher(cfg);
      if (window.MINotify && typeof MINotify.switchMode === 'function') MINotify.switchMode(state.current);
      if (window.MIChart && typeof MIChart.handleModeChange === 'function') MIChart.handleModeChange(state.current);
    } catch { /* server offline — switcher shows fallback labels */ }
  }

  document.addEventListener('DOMContentLoaded', init);
  window.MIMode = { get current() { return state.current; }, get: () => state.current, switchTo, init };
})();