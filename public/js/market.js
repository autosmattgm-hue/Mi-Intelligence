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
    if (window.MINotify) MINotify.onEvent('market', () => {
      pullFromState();
      renderStats();
      renderTable();
    });
    refresh();
  }

  window.MIMarket = { init, refresh, renderStats, renderTable };
})();