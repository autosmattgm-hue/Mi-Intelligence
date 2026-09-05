/* ============ MI signals — stats bar, primary signal panel, signals table ============ */
(function () {
  'use strict';

  const state = {
    signals: [],
    summary: null,
    selected: 'BTCUSDT',
    paperStats: null,
  };

  function $id(id) { return document.getElementById(id); }
  function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function getPrices() { return (window.MINotify && MINotify.getPrices()) || {}; }
  function getStats() { return (window.MINotify && MINotify.getStats()) || {}; }

  function findSignal(sym) { return state.signals.find(s => s.symbol === sym) || null; }

  // ------------------------------------------------ stats bar
  function renderStatsBar() {
    const el = $id('statsBar');
    if (!el) return;
    const prices = getPrices();
    const stats = getStats();
    const sum = state.summary || {};
    const paper = state.paperStats;
    const btc = prices['BTCUSDT'];
    const btcStats = stats['BTCUSDT'];

    const cards = [
      { label: 'Bitcoin', value: btc ? MI.fmt.price(btc) : '—',
        sub: btcStats ? MI.fmt.pct(btcStats.priceChangePercent) + ' (24h)' : '—',
        cls: btcStats && btcStats.priceChangePercent >= 0 ? 'stat-up' : 'stat-down' },
      { label: 'Market Sentiment', value: sum.sentiment || '—',
        sub: sum.bullishPct >= 0 ? sum.bullishPct + '% of ' + (sum.total || 0) + ' assets bullish' : 'scoring…' },
      { label: 'Active Signals', value: (sum.buys || 0) + ' / ' + (sum.sells || 0),
        sub: (sum.buys || 0) + ' BUY · ' + (sum.sells || 0) + ' SELL · ' + (sum.holds || 0) + ' HOLD' },
      { label: 'Avg Confidence', value: sum.avgConfidence ? sum.avgConfidence + '%' : '—', sub: 'across live signals' },
      { label: 'Avg R/R', value: sum.avgRiskReward !== undefined && sum.avgRiskReward !== null ? sum.avgRiskReward : '—', sub: 'reward : risk' },
      { label: 'Paper Win Rate', value: paper && paper.winRate ? paper.winRate + '%' : '—',
        sub: paper ? paper.closedTrades + ' closed trades' : 'waiting for data' },
      { label: 'Paper PnL', value: paper ? (paper.totalPnl >= 0 ? '+' : '') + '$' + paper.totalPnl.toFixed(0) : '—',
        sub: paper ? paper.openPositions + ' open · ' + (paper.realizedPnl >= 0 ? '+' : '') + '$' + paper.realizedPnl.toFixed(0) + ' realized' : '—',
        cls: paper && paper.totalPnl >= 0 ? 'stat-up' : paper && paper.totalPnl < 0 ? 'stat-down' : '' },
      { label: 'Last Updated', value: MI.fmt.time(sum.generatedAt), sub: '15m candles · ' + (state.signals.length || 0) + ' assets' },
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
    const colorClass = sig.action === 'BUY' ? 'green' : sig.action === 'SELL' ? 'red' : 'gold';

    el.innerHTML =
      '<div class="signal-top">' +
      '<div class="signal-big ' + cls + '">' + sig.action + '</div>' +
      '<div class="signal-price"><div class="label">Live price</div><div class="val">' + MI.fmt.price(sig.price) + '</div>' +
      '<div class="lvl">S ' + MI.fmt.price(sig.support) + ' · R ' + MI.fmt.price(sig.resistance) + '</div></div>' +
      '</div>' +
      '<div class="conf"><span class="conf-label">MI Confidence</span>' +
      '<div class="conf-bar"><div class="conf-fill ' + cls + '" style="width:' + sig.confidence + '%"></div></div>' +
      '<span class="conf-pct">' + sig.confidence + '%</span></div>' +
      '<div class="signal-grid">' +
      '<div class="sig-item"><div class="k">Entry</div><div class="v ' + colorClass + '">' + MI.fmt.price(sig.entry) + '</div></div>' +
      '<div class="sig-item"><div class="k">Take Profit</div><div class="v green">' + (sig.takeProfit ? MI.fmt.price(sig.takeProfit) : '—') + '</div></div>' +
      '<div class="sig-item"><div class="k">Stop Loss</div><div class="v red">' + (sig.stopLoss ? MI.fmt.price(sig.stopLoss) : '—') + '</div></div>' +
      '<div class="sig-item"><div class="k">Risk / Reward</div><div class="v gold">' + (sig.riskReward ? '1 : ' + sig.riskReward : '—') + '</div></div>' +
      '<div class="sig-item"><div class="k">Trend</div><div class="v cyan">' + esc(sig.trend) + '</div></div>' +
      '<div class="sig-item"><div class="k">RSI (14)</div><div class="v">' + (sig.rsi !== null ? sig.rsi : '—') + '</div></div>' +
      '<div class="sig-item"><div class="k">MACD</div><div class="v">' + esc(sig.macdState) + '</div></div>' +
      '<div class="sig-item"><div class="k">Vol vs avg</div><div class="v">' + (sig.volRatio ? sig.volRatio.toFixed(2) + 'x' : '—') + '</div></div>' +
      '</div>' +
      '<div class="factors">' + sig.factors.map(f =>
        '<span class="factor ' + f.impact + '" title="' + esc(f.name) + ' — ' + esc(f.value) + '">' + esc(f.name) + ': ' + esc(f.value) + '</span>').join('') +
      '</div>' +
      '<div class="signal-actions">' +
      '<button class="btn ghost sm" id="sigCopy">📋 Copy plan</button>' +
      '<button class="btn ghost sm" id="sigGoChart">📈 Show chart</button>' +
      '</div>';

    $id('sigCopy').addEventListener('click', () => copySignal(sig));
    $id('sigGoChart').addEventListener('click', () => {
      if (window.MIChart) MIChart.setSymbol(sig.symbol);
      switchView('overview');
    });
  }

  function copySignal(sig) {
    const text =
      'MI SIGNAL — ' + sig.asset + '\n' +
      'Action: ' + sig.action + ' (confidence ' + sig.confidence + '%)\n' +
      'Entry: ' + MI.fmt.price(sig.entry) + '\n' +
      'Take Profit: ' + MI.fmt.price(sig.takeProfit) + '\n' +
      'Stop Loss: ' + MI.fmt.price(sig.stopLoss) + '\n' +
      'Risk/Reward: 1:' + sig.riskReward + '\n' +
      'Trend: ' + sig.trend + ' | RSI: ' + (sig.rsi !== null ? sig.rsi : '—') + ' | MACD: ' + sig.macdState +
      '\nGenerated by MI Master Intelligence — not financial advice.';
    try {
      navigator.clipboard.writeText(text);
      MI.toast('success', 'Signal copied', sig.asset + ' plan copied to clipboard.');
    } catch {
      MI.toast('info', 'Copy manually', text);
    }
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
      const clsTag = s.action === 'BUY' ? 'buy' : s.action === 'SELL' ? 'sell' : 'hold';
      const tr = document.createElement('tr');
      tr.style.cursor = 'pointer';
      tr.innerHTML =
        '<td class="mono" style="font-weight:800">' + esc(s.asset) + '</td>' +
        '<td><span class="tag ' + clsTag + '">' + s.action + '</span></td>' +
        '<td>' + s.confidence + '%</td>' +
        '<td class="mono">' + MI.fmt.price(s.price) + '</td>' +
        '<td class="mono">' + MI.fmt.price(s.entry) + '</td>' +
        '<td class="mono" style="color:var(--green)">' + (s.takeProfit ? MI.fmt.price(s.takeProfit) : '—') + '</td>' +
        '<td class="mono" style="color:var(--red)">' + (s.stopLoss ? MI.fmt.price(s.stopLoss) : '—') + '</td>' +
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
// ------------------------------------------------ refresh / events / init
  async function refreshSignals() {
    try {
      const res = await MI.api.get('/api/signals');
      state.signals = res.signals || [];
      state.summary = res.summary;
      renderStatsBar();
      renderSignalPanel();
      renderTable();
      loadPaper();
    } catch { /* ignore */ }
  }

  function init() {
    $id('signalsRefresh').addEventListener('click', () => refreshSignals());
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
    refreshSignals();
    MINotify.onEvent('signals', () => {
      state.signals = MINotify.getSignals();
      state.summary = MINotify.getSummary();
      renderStatsBar();
      renderSignalPanel();
      renderTable();
      loadPaper();
    });
    MINotify.onEvent('market', () => { renderStatsBar(); renderSignalPanel(); });
    MINotify.onEvent('paper', () => loadPaper());
  }

  window.MISignals = {
    state, init, refreshSignals, renderStatsBar, renderSignalPanel, renderTable, switchView,
  };
})();