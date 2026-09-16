/* ============ MI Market — CoinMarketCap live rankings & global metrics ============ */
(function () {
  'use strict';

  const state = {
    global: null,
    listings: [],
  };

  function $id(id) { return document.getElementById(id); }
  function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function fmtBig(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    if (v >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T';
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    return '$' + v.toFixed(0);
  }

  function fmtPrice(p) {
    if (p === null || p === undefined || isNaN(p)) return '—';
    if (p >= 1000) return '$' + p.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (p >= 1) return '$' + p.toFixed(2);
    return '$' + p.toFixed(5);
  }

  function pctClass(v) { return v >= 0 ? 'stat-up' : 'stat-down'; }
  function fmtPct(v) { return v === null || v === undefined || isNaN(v) ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + '%'; }

  // Global market metrics bar
  function renderStats() {
    const el = $id('marketStats');
    if (!el) return;
    const g = state.global;
    if (!g) {
      el.innerHTML = '<div class="stat-card"><div class="stat-label">Global Market</div><div class="stat-value">Loading…</div><div class="stat-sub">CoinMarketCap global metrics</div></div>';
      return;
    }
    const mcapChg = g.marketCapChange24h != null ? g.marketCapChange24h : (
      g.totalMarketCap && g.totalMarketCapYesterday
        ? ((g.totalMarketCap - g.totalMarketCapYesterday) / g.totalMarketCapYesterday) * 100
        : null
    );
    const volChg = g.volumeChange24h != null ? g.volumeChange24h : null;
    const cards = [
      { label: 'Global Market Cap', value: fmtBig(g.totalMarketCap),
        sub: mcapChg !== null ? fmtPct(mcapChg) + ' (24h)' : '24h market movement', cls: pctClass(mcapChg) },
      { label: '24h Volume', value: fmtBig(g.totalVolume24h),
        sub: volChg !== null ? fmtPct(volChg) + ' vs yesterday' : 'Across all assets · CoinMarketCap', cls: pctClass(volChg) },
      { label: 'BTC Dominance', value: g.btcDominance != null ? g.btcDominance.toFixed(2) + '%' : '—',
        sub: 'Bitcoin share of market cap' },
      { label: 'ETH Dominance', value: g.ethDominance != null ? g.ethDominance.toFixed(2) + '%' : '—',
        sub: 'Ethereum share of market cap' },
    ];
    el.innerHTML = cards.map(c =>
      '<div class="stat-card"><div class="stat-label">' + c.label + '</div>' +
      '<div class="stat-value ' + (c.cls || '') + '">' + c.value + '</div>' +
      '<div class="stat-sub">' + c.sub + '</div></div>').join('');
  }

  // Top-100 ranking table
  function renderTable() {
    const body = $id('marketBody');
    if (!body) return;
    const updated = $id('marketUpdated');

    body.innerHTML = '';
    if (!state.listings || state.listings.length === 0) {
      body.innerHTML = '<tr><td colspan="11"><div class="empty">Loading CoinMarketCap rankings…</div></td></tr>';
      return;
    }
    if (updated) updated.textContent = 'Top ' + state.listings.length + ' coins · refreshed ' + MI.fmt.shortTime(new Date(state.global && state.global.lastUpdated || Date.now()));

    state.listings.slice(0, 100).forEach((c, i) => {
      const tr = document.createElement('tr');
      const supply = c.circulatingSupply != null
        ? c.circulatingSupply.toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' ' + esc(c.symbol)
        : '—';
      tr.innerHTML =
        '<td class="mono">' + c.rank + '</td>' +
        '<td><span style="font-weight:800;font-family:var(--mono)">' + esc(c.symbol) + '</span>' +
        ' <span class="sub" style="color:var(--muted);font-size:.68rem">' + esc(c.name) + '</span></td>' +
        '<td class="mono">' + fmtPrice(c.price) + '</td>' +
        '<td class="mono ' + pctClass(c.percentChange1h) + '">' + fmtPct(c.percentChange1h) + '</td>' +
        '<td class="mono ' + pctClass(c.percentChange24h) + '">' + fmtPct(c.percentChange24h) + '</td>' +
        '<td class="mono ' + pctClass(c.percentChange7d) + '">' + fmtPct(c.percentChange7d) + '</td>' +
        '<td class="mono ' + pctClass(c.percentChange30d) + '">' + fmtPct(c.percentChange30d) + '</td>' +
        '<td class="mono">' + fmtBig(c.marketCap) + '</td>' +
        '<td class="mono">' + fmtBig(c.volume24h) + '</td>' +
        '<td class="mono">' + (c.dominance != null ? c.dominance.toFixed(2) + '%' : '—') + '</td>' +
        '<td class="mono">' + supply + '</td>';
      body.appendChild(tr);
    });
  }

  function pullFromState() {
    state.global = (window.MINotify && MINotify.getGlobal()) || state.global;
    state.listings = (window.MINotify && MINotify.getListings()) || state.listings;
  }

  // Fx / Pocket modes have no CoinMarketCap ranking — show a mode note instead.
  function handleModeChange(mode) {
    const body = $id('marketBody');
    const statsEl = $id('marketStats');
    if (mode && mode !== 'crypto') {
      if (body) body.innerHTML = '<tr><td colspan="11"><div class="empty">📉 CoinMarketCap rankings are only available in 💠 Crypto mode. Switch modes in the top bar to see live FX / binary-option assets here.</div></td></tr>';
      if (statsEl) statsEl.innerHTML = '<div class="stat-card"><div class="stat-label">Market Mode</div><div class="stat-value">' + (mode === 'forex' ? '💱 Forex' : '⏱️ Pocket Option') + '</div><div class="stat-sub">CoinMarketCap global metrics are crypto-only. Signals & chart are live for this mode above.</div></div>';
      refreshPulse();
      return;
    }
    refreshPulse();
    refresh();
  }

  // ------------------------------------------------ market pulse (sentiment + calendar)
  async function refreshPulse() {
    try {
      const s = await MI.api.get('/api/sentiment');
      let c = null;
      try { c = await MI.api.get('/api/calendar'); } catch { /* optional */ }
      renderPulse(s, c);
    } catch { /* ignore */ }
  }

  function renderPulse(s, c) {
    const el = $id('pulseStats');
    if (el) {
      const fg = s && s.fearGreed;
      const cards = [];
      if (fg) cards.push({ label: 'Fear & Greed', value: fg.value + ' — ' + esc(fg.classification),
        sub: 'alternative.me · market sentiment', cls: fg.value >= 55 ? 'stat-up' : fg.value <= 45 ? 'stat-down' : '' });
      cards.push({ label: 'BTC Funding (perp)', value: s && s.funding != null ? (s.funding >= 0 ? '+' : '') + (s.funding * 100).toFixed(4) + '%' : '—',
        sub: 'Binance USDⓈ-M · long/short bias' });
      el.innerHTML = cards.map(card =>
        '<div class="stat-card"><div class="stat-label">' + card.label + '</div>' +
        '<div class="stat-value ' + (card.cls || '') + '">' + card.value + '</div>' +
        '<div class="stat-sub">' + card.sub + '</div></div>').join('');
    }
    const ev = $id('pulseEvents');
    if (!ev) return;
    ev.innerHTML = '';
    const list = (c && c.upcoming) || [];
    if (!list.length) { ev.innerHTML = '<div class="empty">No confirmed high-impact events in the current window.</div>'; return; }
    list.slice(0, 14).forEach(e => {
      const d = document.createElement('div');
      d.className = 'cal-item';
      const hm = e.time ? new Date(e.time).toUTCString().split(' ')[4] + ' UTC' : '—';
      d.innerHTML = '<span class="cal-badge ' + (e.isHigh ? 'high' : 'med') + '">' + (e.isHigh ? 'HIGH' : 'MED') + '</span>' +
        '<span class="cal-time">' + esc(hm) + '</span>' +
        '<span class="cal-title">' + esc(e.title) + (e.country ? ' <span class="cal-cc">' + esc(e.country) + '</span>' : '') + '</span>' +
        (e.forecast != null ? '<span class="cal-fc">fc ' + esc(String(e.forecast)) + '</span>' : '') +
        (e.previous != null ? '<span class="cal-pv">prv ' + esc(String(e.previous)) + '</span>' : '');
      ev.appendChild(d);
    });
  }

  async function refresh() {
    try {
      const res = await MI.api.get('/api/market/ranking?limit=100');
      state.global = res.global;
      state.listings = res.listings || [];
      renderStats();
      renderTable();
    } catch { /* rely on SSE */ }
    pullFromState();
    renderStats();
    renderTable();
  }

  function init() {
    const ref = $id('marketRefresh');
    if (ref) ref.addEventListener('click', refresh);
    const pulse = $id('pulseRefresh');
    if (pulse) pulse.addEventListener('click', refreshPulse);
    if (window.MINotify) MINotify.onEvent('market', () => {
      pullFromState();
      renderStats();
      renderTable();
    });
    refresh();
    refreshPulse();
  }

  window.MIMarket = { init, refresh, renderStats, renderTable, handleModeChange, refreshPulse };
})();