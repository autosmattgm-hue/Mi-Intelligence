/* ============ MI portfolio — editable holdings valued at live prices + risk calculator ============ */
(function () {
  'use strict';

  const LS_KEY = 'mi.holdings.v1';
  let holdings = [];
  try { holdings = JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch { holdings = []; }

  function $id(id) { return document.getElementById(id); }
  function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function save() { localStorage.setItem(LS_KEY, JSON.stringify(holdings)); }

  function getPrices() { return (window.MINotify && MINotify.getPrices()) || {}; }
  function getStats() { return (window.MINotify && MINotify.getStats()) || {}; }

  // ------------------------------------------------ holdings UI
  function render() {
    const body = $id('holdingsBody');
    const prices = getPrices();
    const stats = getStats();
    if (!body) return;

    body.innerHTML = '';
    if (!holdings.length) {
      body.innerHTML = '<tr><td colspan="8"><div class="empty">No holdings yet — add an asset above to track it against live prices.</div></td></tr>';
      renderTotals(null);
      return;
    }

    let totalValue = 0, totalCost = 0, totalChange24 = 0;
    holdings.forEach((h, idx) => {
      const px = prices[h.symbol];
      const st = stats[h.symbol];
      const value = h.amount * px;
      const cost = h.amount * h.entry;
      const pnl = value - cost;
      const pnlPct = cost ? (pnl / cost) * 100 : 0;
      const chg24 = st ? st.priceChangePercent : null;
      totalValue += value || 0;
      totalCost += cost;
      totalChange24 += (value || 0) * (chg24 || 0);

      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="mono" style="font-weight:800">' + esc(h.symbol.replace(/USDT$/, '/USDT')) + '</td>' +
        '<td class="mono">' + h.amount + '</td>' +
        '<td class="mono">' + MI.fmt.price(h.entry) + '</td>' +
        '<td class="mono">' + MI.fmt.price(px) + '</td>' +
        '<td class="mono">' + MI.fmt.price(value) + '</td>' +
        '<td class="mono ' + (pnl >= 0 ? 'stat-up' : 'stat-down') + '">' + (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2) + ' (' + MI.fmt.pct(pnlPct) + ')</td>' +
        '<td class="mono ' + (chg24 !== null && chg24 >= 0 ? 'stat-up' : 'stat-down') + '">' + (chg24 !== null ? MI.fmt.pct(chg24) : '—') + '</td>' +
        '<td><button class="row-btn" data-i="' + idx + '" title="Remove">✕</button></td>';
      tr.querySelector('[data-i]').addEventListener('click', () => { holdings.splice(idx, 1); save(); render(); });
      body.appendChild(tr);
    });

    const weightedChange = totalValue ? (totalChange24 / totalValue) : 0;
    renderTotals({
      holdings: holdings.length, totalValue, totalCost,
      totalPnl: totalValue - totalCost,
      totalPnlPct: totalCost ? ((totalValue - totalCost) / totalCost) * 100 : 0,
      chg24: weightedChange,
    });
  }

  function renderTotals(t) {
    const el = $id('portfolioTotals');
    if (!el) return;
    if (!t) { el.innerHTML = '<div class="t"><div class="l">Total Value</div><div class="n">$0</div></div>'; return; }
    el.innerHTML =
      '<div class="t"><div class="l">Total Value</div><div class="n">' + MI.fmt.price(t.totalValue) + '</div></div>' +
      '<div class="t"><div class="l">Invested</div><div class="n">' + MI.fmt.price(t.totalCost) + '</div></div>' +
      '<div class="t"><div class="l">Total PnL</div><div class="n ' + (t.totalPnl >= 0 ? 'stat-up' : 'stat-down') + '">' + (t.totalPnl >= 0 ? '+' : '') + '$' + t.totalPnl.toFixed(2) + '</div></div>' +
      '<div class="t"><div class="l">Portfolio 24h</div><div class="n ' + (t.chg24 >= 0 ? 'stat-up' : 'stat-down') + '">' + MI.fmt.pct(t.chg24) + '</div></div>' +
      '<div class="t"><div class="l">Assets</div><div class="n">' + t.holdings + '</div></div>';
  }
// ------------------------------------------------ add holdings form
  function initForm() {
    const form = $id('addForm');
    if (!form) return;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const symbol = $id('addSymbol').value;
      const amount = parseFloat($id('addAmount').value);
      const entry = parseFloat($id('addEntry').value);
      if (!symbol || isNaN(amount) || amount <= 0) { MI.toast('error', 'Invalid amount', 'Amount must be a positive number.'); return; }
      const existing = holdings.find(h => h.symbol === symbol);
      if (existing) {
        const totalAmt = existing.amount + amount;
        existing.entry = (existing.amount * existing.entry + amount * entry) / totalAmt;
        existing.amount = totalAmt;
      } else {
        holdings.push({ symbol, amount, entry: isNaN(entry) || entry <= 0 ? (getPrices()[symbol] || 0) : entry });
      }
      save();
      $id('addAmount').value = '';
      $id('addEntry').value = '';
      render();
      MI.toast('success', 'Holding added', symbol.replace(/USDT$/, '/USDT') + ' tracked in your portfolio.');
    });
  }

  // ------------------------------------------------ risk calculator
  function initCalc() {
    const form = $id('calcForm');
    if (!form) return;
    const calc = () => {
      const account = parseFloat($id('calcAccount').value) || 0;
      const riskPct = parseFloat($id('calcRisk').value) || 0;
      const symbol = $id('calcSymbol').value;
      const stop = parseFloat($id('calcStop').value) || 0;
      const px = getPrices()[symbol];
      const stopPct = px && stop > 0 ? (stop / px) * 100 : 0;
      const riskUsd = account * (riskPct / 100);
      let size = '—';
      if (stop > 0 && riskUsd > 0) size = (riskUsd / stop).toFixed(4) + ' ' + symbol.replace(/USDT$/, '');
      $id('calcSize').textContent = size;
      $id('calcRiskUsd').textContent = '$' + riskUsd.toFixed(2);
      $id('calcStopPct').textContent = stopPct ? stopPct.toFixed(2) + '%' : '—';
    };
    form.addEventListener('submit', e => { e.preventDefault(); calc(); });
    form.addEventListener('input', calc);
    $id('calcSymbol').addEventListener('change', () => {
      const sym = $id('calcSymbol').value;
      const sig = (window.MISignals && MISignals.state.signals.find(s => s.symbol === sym)) || null;
      const px = getPrices()[sym];
      if (sig && sig.stopLoss) $id('calcStop').value = (Math.abs(px - sig.stopLoss)).toFixed(px >= 1000 ? 0 : 2);
    });
    calc();
  }

  function init() {
    initForm();
    initCalc();
    render();
    if (window.MINotify) MINotify.onEvent('market', render);
  }

  window.MIPortfolio = { init, render };
})();