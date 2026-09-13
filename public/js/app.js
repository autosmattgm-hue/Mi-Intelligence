/* ============ MI app shell — clock, nav, status, module bootstrap ============ */
(function () {
  'use strict';

  function $id(id) { return document.getElementById(id); }
  let healthTimer = null;

  // ------------------------------------------------ live clock
  function tickClock() {
    const el = $id('clock');
    if (el) {
      const now = new Date();
      el.textContent = now.toUTCString().split(' ')[4] + ' UTC';
    }
    const ft = $id('footerTime');
    if (ft) ft.textContent = new Date().toISOString().split('T')[0];
  }

  // ------------------------------------------------ nav tabs
  function showView(name) {
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.dataset.view === name));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function initNav() {
    document.querySelectorAll('.nav-tab').forEach(tab => {
      tab.addEventListener('click', () => showView(tab.dataset.view));
    });
    // Support PWA shortcuts & deep links: /?view=signals|market|ai|...
    const urlView = new URLSearchParams(window.location.search).get('view');
    if (urlView && document.querySelector('.nav-tab[data-view="' + urlView + '"]')) {
      showView(urlView);
    }
  }

  // ------------------------------------------------ status / health
  function setStatus(online, text) {
    const pill = $id('statusPill');
    const st = $id('statusText');
    if (!pill || !st) return;
    if (online) {
      pill.classList.remove('offline');
      pill.classList.add('online');
      st.textContent = text || 'Live · Binance + OpenRouter';
    } else {
      pill.classList.remove('online');
      pill.classList.add('offline');
      st.textContent = text || 'Reconnecting…';
    }
  }

  function showBanner(msg, persist) {
    const b = $id('banner');
    const t = $id('bannerText');
    if (!b || !t) return;
    t.textContent = msg;
    b.classList.remove('hidden');
    if (!persist) setTimeout(() => b.classList.add('hidden'), 8000);
  }

  async function checkHealth() {
    try {
      const h = await MI.api.get('/api/health');
      const ds = h.market && h.market.dataSource;
      if (ds && ds !== 'error' && ds !== 'starting') {
        setStatus(true, ds === 'coinmarketcap' ? 'Live · CoinMarketCap' : 'Live · market data');
        $id('banner').classList.add('hidden');
      } else {
        setStatus(false, 'Live data provider unreachable');
        if (ds === 'error') showBanner('The market data provider is temporarily unreachable. MI is retrying automatically…');
      }
    } catch {
      setStatus(false, 'Server offline');
      showBanner('Cannot reach the MI server. Make sure you started it with: npm start');
    }
  }

  // ------------------------------------------------ banner close
  $id('bannerClose') && $id('bannerClose').addEventListener('click', () => $id('banner').classList.add('hidden'));

  // ------------------------------------------------ boot
  async function boot() {
    tickClock();
    setInterval(tickClock, 1000);
    initNav();

    // load server config first (symbols, model)
    try {
      MI.config = await MI.api.get('/api/config');
    } catch {
      MI.config = { symbols: [], aiModel: '—', aiEnabled: false };
      setStatus(false, 'Server offline');
      showBanner('Cannot reach the MI server. Start it with "npm start" in the project folder, then refresh.', true);
    }

    // init modules in dependency order
    if (window.MINotify) MINotify.init();
    if (window.MINotify) MINotify.onEvent('connection', (online) => {
      if (online) setStatus(true, 'Live · CoinMarketCap + OpenRouter');
      else setStatus(false, 'Live feed reconnecting…');
    });
    if (window.MIChart) MIChart.init();
    if (window.MISignals) MISignals.init();
    if (window.MIMarket) MIMarket.init();
    if (window.MIPortfolio) MIPortfolio.init();
    if (window.MIChat) MIChat.init();

    // SSE signal graph → chart live updates
    if (window.MINotify && window.MIChart) {
      MINotify.onEvent('market', m => MIChart.onMarket(m));
    }

    checkHealth();
    healthTimer = setInterval(checkHealth, 30000);
  }

  document.addEventListener('DOMContentLoaded', boot);
})();