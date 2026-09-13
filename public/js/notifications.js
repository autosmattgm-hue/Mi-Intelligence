/* ============ MI notifications — own permission system, toasts, SSE, alerts ============ */
(function () {
  'use strict';

  const LS_PERM = 'mi.notif.permission';
  const LS_SOUND = 'mi.notif.sound';
  const listeners = {};

  const state = {
    permission: localStorage.getItem(LS_PERM) || 'prompt', // 'granted' | 'denied' | 'prompt'
    sound: localStorage.getItem(LS_SOUND) !== 'off',
    unread: 0,
    notifications: [],
    alerts: [],
    sse: null,
    lastMarket: { prices: {}, stats24h: {} },
    lastSignals: { signals: [], summary: null },
  };

  function $(id) { return document.getElementById(id); }
  function on(id, evt, fn) { const el = $(id); if (el) el.addEventListener(evt, fn); }

  // ------------------------------------------------ permission
  function setPermission(p) {
    state.permission = p;
    localStorage.setItem(LS_PERM, p);
    refreshPermButtons();
    if (p === 'granted') {
      closeModal();
      MI.toast('success', 'MI Alerts enabled', 'You will now get pop-up notifications from MI for price alerts, signals and paper trades.');
      playSound();
    }
  }

  function refreshPermButtons() {
    const btn = $('noticePerm');
    if (btn) {
      btn.textContent = 'Permission: ' + (state.permission === 'granted' ? 'ON — click to revoke' : 'OFF — click to enable');
      btn.style.color = state.permission === 'granted' ? 'var(--green)' : 'var(--muted)';
    }
  }

  function openModal() { const m = $('permModal'); if (m) m.classList.remove('hidden'); }
  function closeModal() { const m = $('permModal'); if (m) m.classList.add('hidden'); }

  // ------------------------------------------------ sound
  let audioCtx = null;
  function playSound() {
    if (!state.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1320, audioCtx.currentTime + 0.12);
      gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.3);
      osc.connect(gain); gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.32);
    } catch { /* audio optional */ }
  }

  // ------------------------------------------------ toasts
  function toast(type, title, body, silent) {
    const wrap = $('toastWrap');
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.innerHTML = '<div class="t-title">' + escapeHtml(title) + '</div><div class="t-body">' + escapeHtml(body || '') + '</div>';
    el.addEventListener('click', () => { el.classList.add('out'); setTimeout(() => el.remove(), 400); });
    wrap.appendChild(el);
    if (!silent && state.sound) playSound();
    setTimeout(() => { if (el.parentNode) { el.classList.add('out'); setTimeout(() => el.remove(), 400); } }, 6500);
    while (wrap.children.length > 5) wrap.firstChild.remove();
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ------------------------------------------------ notification badge
  function updateBadge() {
    const b = $('bellBadge');
    if (b) {
      if (state.unread > 0) { b.textContent = state.unread > 99 ? '99+' : state.unread; b.classList.remove('hidden'); }
      else b.classList.add('hidden');
    }
  }

  // ------------------------------------------------ notification center panel
  function togglePanel() {
    const panel = $('noticePanel');
    const backdrop = $('noticeBackdrop');
    if (!panel) return;
    const isOpen = !panel.classList.contains('hidden');
    panel.classList.toggle('hidden', isOpen);
    backdrop.classList.toggle('hidden', isOpen);
    if (!isOpen) renderNoticeBody();
  }

  function renderNoticeBody() {
    const body = $('noticeBody');
    if (!body) return;
    body.innerHTML = '';
    if (state.notifications.length === 0) {
      body.innerHTML = '<div class="empty">No notifications yet. Enable alerts and MI will notify you here.</div>';
      return;
    }
    state.notifications.slice(0, 60).forEach(n => {
      const it = document.createElement('div');
      it.className = 'notif-item ' + (n.type || 'info') + (n.read ? '' : ' unread');
      it.innerHTML =
        '<div class="n-title"><span>' + escapeHtml(n.title) + '</span><span class="n-time">' + MI.fmt.shortTime(n.ts) + '</span></div>' +
        '<div class="n-body">' + escapeHtml(n.body) + '</div>';
      body.appendChild(it);
    });
  }

  async function refreshNotifications() {
    try {
      const res = await MI.api.get('/api/notifications');
      state.notifications = res.notifications || [];
      state.unread = state.notifications.filter(n => !n.read).length;
      updateBadge();
      if (!$('noticePanel').classList.contains('hidden')) renderNoticeBody();
    } catch { /* ignore */ }
  }
// ------------------------------------------------ SSE live feed
  function connectSSE(force) {
    if (state.sse && !force) return;
    if (state.sse) { try { state.sse.close(); } catch { /* ignore */ } state.sse = null; }
    const mode = (window.MI && MI.mode) || 'crypto';
    const src = new EventSource('/api/events?mode=' + encodeURIComponent(mode));
    src.onopen = () => setLiveStatus(true);
    src.onerror = () => setLiveStatus(false); // EventSource auto-reconnects
    src.addEventListener('hello', () => setLiveStatus(true));
    src.addEventListener('mode', (e) => {
      try { emit('mode', JSON.parse(e.data).mode); } catch { /* ignore */ }
    });
    src.addEventListener('market', (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.mode && window.MI && MI.mode && d.mode !== MI.mode) return;
        state.lastMarket = {
          prices: d.prices || {},
          stats24h: d.stats24h || {},
          global: d.global || null,
          listings: d.listings || [],
        };
        emit('market', state.lastMarket);
      } catch { /* ignore */ }
    });
    src.addEventListener('signals', (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.mode && window.MI && MI.mode && d.mode !== MI.mode) return;
        state.lastSignals = { signals: d.signals || [], summary: d.summary || null };
        emit('signals', state.lastSignals);
      } catch { /* ignore */ }
    });
    src.addEventListener('notification', (e) => {
      try {
        const n = JSON.parse(e.data);
        state.notifications.unshift(n);
        state.unread += 1;
        updateBadge();
        emit('notification', n);
        if (state.permission === 'granted') toast(n.type, n.title, n.body);
      } catch { /* ignore */ }
    });
    src.addEventListener('alert', (e) => {
      try {
        const a = JSON.parse(e.data);
        emit('alert', a);
        if (state.permission === 'granted') {
          toast('alert', a.symbol + ' price alert triggered', 'Price reached your target — check the Alerts view.');
        }
        refreshAlerts();
      } catch { /* ignore */ }
    });
    src.addEventListener('paper', (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.type === 'open' && state.permission === 'granted') {
          toast('paper-win', d.side + ' position opened — ' + d.symbol, 'Paper trade opened at ' + MI.fmt.price(d.entry) + ' by the MI engine.');
        } else if (d.type === 'close' && state.permission === 'granted') {
          const sign = d.pnl >= 0 ? '+' : '';
          toast(d.pnl >= 0 ? 'paper-win' : 'paper-loss', 'Paper trade closed — ' + d.symbol,
            'Exit reason: ' + d.reason + ' · PnL ' + sign + '$' + d.pnl.toFixed(2));
        }
      } catch { /* ignore */ }
    });
    state.sse = src;
  }

  function setLiveStatus(online) { emit('connection', online); }

  // Called by the mode switcher when the user changes market mode.
  function switchMode(mode) {
    // Force a fresh data pull for the new mode, then reconnect the live feed.
    try {
      MI.api.get('/api/market').then(r => {
        state.lastMarket = { prices: r.prices || {}, stats24h: r.stats24h || {}, global: r.global, listings: r.listings };
        emit('market', state.lastMarket);
      }).catch(() => {});
    } catch { /* ignore */ }
    try {
      MI.api.get('/api/signals').then(r => {
        state.lastSignals = { signals: r.signals || [], summary: r.summary || null };
        emit('signals', state.lastSignals);
        emit('mode', mode);
      }).catch(() => {});
    } catch { /* ignore */ }
    setTimeout(() => connectSSE(true), 400);
  }

  // ------------------------------------------------ alerts CRUD + render
  async function refreshAlerts() {
    try {
      const res = await MI.api.get('/api/alerts');
      state.alerts = res.alerts || [];
      renderAlerts();
    } catch { /* ignore */ }
  }

  function renderAlerts() {
    const list = $('activeAlerts');
    if (!list) return;
    list.innerHTML = '';
    const active = state.alerts.filter(a => !a.triggered);
    const done = state.alerts.filter(a => a.triggered);
    if (state.alerts.length === 0) {
      list.innerHTML = '<div class="empty">No alerts yet. Create one on the left to track a price target.</div>';
      return;
    }
    [...active, ...done].forEach(a => {
      const row = document.createElement('div');
      row.className = 'alert-row' + (a.triggered ? ' done' : '');
      row.innerHTML =
        '<div class="a-main"><span class="a-symbol">' + escapeHtml(a.symbol) + '</span>' +
        '<span class="tag ' + (a.condition === 'above' ? 'buy' : 'sell') + '">' + (a.condition === 'above' ? '▲ above' : '▼ below') + ' ' + MI.fmt.price(a.target) + '</span>' +
        (a.triggered ? '<span class="a-triggered">✔ triggered @ ' + MI.fmt.price(a.triggerPrice) + '</span>' : '<span class="a-triggered">watching…</span>') +
        (a.note ? '<span class="a-triggered">' + escapeHtml(a.note) + '</span>' : '') +
        '</div>' +
        '<button class="row-btn" data-del="' + a.id + '" title="Delete alert">✕</button>';
      row.querySelector('[data-del]').addEventListener('click', async () => {
        await MI.api.del('/api/alerts/' + a.id);
        refreshAlerts();
      });
      list.appendChild(row);
    });
  }

  async function createAlert(data) {
    await MI.api.post('/api/alerts', data);
    refreshAlerts();
  }
// ------------------------------------------------ listeners / emit
  function onEvent(name, fn) { (listeners[name] = listeners[name] || []).push(fn); }
  function emit(name, data) { (listeners[name] || []).forEach(fn => { try { fn(data); } catch { /* ignore */ } }); }

  // ------------------------------------------------ init
  function init() {
    on('permAllow', 'click', () => setPermission('granted'));
    on('permDeny', 'click', () => setPermission('denied'));
    on('bellBtn', 'click', togglePanel);
    on('noticeBackdrop', 'click', () => togglePanel());
    on('soundToggle', 'click', () => {
      state.sound = !state.sound;
      localStorage.setItem(LS_SOUND, state.sound ? 'on' : 'off');
      $('soundToggle').textContent = state.sound ? '🔊' : '🔇';
    });
    on('noticePerm', 'click', () => {
      if (state.permission === 'granted') setPermission('denied');
      else openModal();
    });
    on('notifReadAll', 'click', async () => {
      await MI.api.post('/api/notifications/read-all');
      refreshNotifications();
    });
    on('notifClear', 'click', async () => {
      await MI.api.del('/api/notifications');
      refreshNotifications();
    });
    on('alertsClear', 'click', async () => {
      for (const a of state.alerts.filter(al => al.triggered)) await MI.api.del('/api/alerts/' + a.id);
      refreshAlerts();
    });
    on('alertForm', 'submit', async (e) => {
      e.preventDefault();
      try {
        await createAlert({
          symbol: $('alertSymbol').value,
          condition: $('alertCondition').value,
          target: $('alertTarget').value,
          note: $('alertNote').value,
        });
        $('alertTarget').value = '';
        $('alertNote').value = '';
        toast('success', 'Alert created', 'MI will notify you when ' + $('alertSymbol').value + ' ' +
          ($('alertCondition').value === 'above' ? 'rises above' : 'falls below') + ' your target.');
      } catch (err) {
        toast('error', 'Could not create alert', err.message);
      }
    });

    $('soundToggle').textContent = state.sound ? '🔊' : '🔇';
    refreshPermButtons();
    if (state.permission === 'prompt') setTimeout(openModal, 900);
    refreshNotifications();
    refreshAlerts();
    connectSSE();
  }

  window.MINotify = {
    state, init, toast, playSound, refreshNotifications, refreshAlerts, renderAlerts, onEvent, connectSSE,
    switchMode,
    isGranted: () => state.permission === 'granted',
    getPrices: () => state.lastMarket.prices,
    getStats: () => state.lastMarket.stats24h,
    getGlobal: () => state.lastMarket.global,
    getListings: () => state.lastMarket.listings,
    getSignals: () => state.lastSignals.signals,
    getSummary: () => state.lastSignals.summary,
  };

  // Expose the toast helper globally so other modules can use MI.toast(...).
  window.MI = window.MI || {};
  window.MI.toast = toast;
  window.MI.playSound = playSound;
})();