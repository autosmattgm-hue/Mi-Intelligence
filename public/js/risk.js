/* ============ MI Risk Manager — analytics, journal & guardrails ============
   - Equity curve: cumulative paper-trading PnL drawn on a canvas.
   - Trade journal: private notes stored in this browser (localStorage).
   - Guardrails: your max risk % per trade + daily loss limit; MI warns when
     the paper account approaches or breaks them. */
(function () {
  'use strict';

  const LS_JOURNAL = 'mi.journal';
  const LS_GUARD = 'mi.guard';
  const NOTIONAL = 1000; // paper engine uses $1,000 notional per trade

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  let lastHistory = [];

  // ------------------------------------------------------- equity curve
  async function loadPaper() {
    try {
      const res = await MI.api.get('/api/paper');
      lastHistory = (res.history || []).slice();
      drawEquity(lastHistory);
      renderGuard(lastHistory);
    } catch { /* ignore */ }
  }

  function drawEquity(history) {
    const cv = $('equityChart');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    const sorted = history.slice().sort((a, b) => a.closedAt - b.closedAt);
    if (!sorted.length) {
      ctx.fillStyle = 'rgba(154,164,181,.8)';
      ctx.font = '13px Segoe UI';
      ctx.fillText('No closed paper trades yet — the curve appears after MI closes its first trades.', 24, H / 2);
      return;
    }
    let cum = 0;
    const pts = [];
    for (let i = 0; i < sorted.length; i++) { cum += sorted[i].pnl; pts.push({ i, y: cum }); }
    const minY = Math.min(0, ...pts.map(p => p.y));
    const maxY = Math.max(0, ...pts.map(p => p.y));
    const pad = 30, gw = W - 2 * pad, gh = H - 2 * pad - 16;
    const range = Math.max(1e-6, maxY - minY);
    const xFor = (i) => pts.length > 1 ? pad + gw * (i / (pts.length - 1)) : pad;
    const yFor = (v) => pad + gh * ((maxY - v) / range);

    ctx.fillStyle = 'rgba(9,13,22,1)';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(90,110,140,.18)';
    ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const y = pad + (gh / 4) * g;
      ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke();
    }
    if (minY < 0 && maxY > 0) {
      ctx.strokeStyle = 'rgba(255,255,255,.3)';
      ctx.beginPath(); ctx.moveTo(pad, yFor(0)); ctx.lineTo(W - pad, yFor(0)); ctx.stroke();
    }
    ctx.beginPath();
    pts.forEach((p, i) => { const X = xFor(i), Y = yFor(p.y); if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y); });
    ctx.lineTo(xFor(pts.length - 1), yFor(0)); ctx.closePath();
    const grad = ctx.createLinearGradient(0, pad, 0, pad + gh);
    if (cum >= 0) { grad.addColorStop(0, 'rgba(34,211,238,.35)'); grad.addColorStop(1, 'rgba(34,211,238,0)'); }
    else { grad.addColorStop(0, 'rgba(244,63,94,.30)'); grad.addColorStop(1, 'rgba(244,63,94,0)'); }
    ctx.fillStyle = grad; ctx.fill();
    ctx.strokeStyle = cum >= 0 ? '#22d3ee' : '#f43f5e';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    pts.forEach((p, i) => { const X = xFor(i), Y = yFor(p.y); if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y); });
    ctx.stroke();
    ctx.fillStyle = 'rgba(154,164,181,1)';
    ctx.font = '12px Segoe UI';
    ctx.fillText('Realized PnL: ' + (cum >= 0 ? '+' : '') + '$' + cum.toFixed(0) + ' · ' + pts.length + ' closed trades', pad, 18);
  }

// ------------------------------------------------------- trade journal
  function getJournal() { try { return JSON.parse(localStorage.getItem(LS_JOURNAL) || '[]'); } catch { return []; } }
  function saveJournal(j) { localStorage.setItem(LS_JOURNAL, JSON.stringify(j)); }

  function renderJournal() {
    const list = $('journalList');
    if (!list) return;
    const j = getJournal().slice().sort((a, b) => b.ts - a.ts);
    list.innerHTML = '';
    if (!j.length) { list.innerHTML = '<div class="empty">No journal entries yet. After a trade, note what you did and why — reviewing this is how you improve.</div>'; return; }
    j.forEach(e => {
      const d = document.createElement('div');
      d.className = 'journal-item';
      d.innerHTML = '<div class="j-head"><span class="j-tag">' + esc(e.tag || 'Other') + '</span>' +
        '<span class="n-time">' + MI.fmt.shortTime(e.ts) + '</span><button class="row-btn" data-id="' + e.id + '">✕</button></div>' +
        '<div class="j-body">' + esc(e.note) + '</div>';
      d.querySelector('[data-id]').addEventListener('click', () => {
        saveJournal(getJournal().filter(x => x.id !== e.id));
        renderJournal();
        if (window.MI && MI.toast) MI.toast('info', 'Entry deleted', 'Journal entry removed.');
      });
      list.appendChild(d);
    });
  }

  // ------------------------------------------------------- guardrails
  function loadGuard() { try { return JSON.parse(localStorage.getItem(LS_GUARD) || ''); } catch { return null; } }
  function saveGuard(g) { localStorage.setItem(LS_GUARD, JSON.stringify(g)); }

  function renderGuard(history) {
    const el = $('guardStatus');
    if (!el) return;
    const g = loadGuard();
    if (!g) { el.innerHTML = '<div class="empty">Set your limits — MI will warn you as the paper account approaches them.</div>'; return; }
    const start = new Date(); start.setUTCHours(0, 0, 0, 0);
    const t0 = start.getTime();
    const dayPnl = (history || []).filter(h => h.closedAt >= t0).reduce((a, h) => a + h.pnl, 0);
    const dayLimitUsd = (g.day / 100) * NOTIONAL;
    const dayHit = dayPnl <= -dayLimitUsd;
    const rows = [
      '<div class="gu-line">🎯 Max risk / trade: <b>' + g.risk + '%</b> — HIGH signals suggest ≤ ' + g.risk + '% per trade</div>',
      '<div class="gu-line">📅 Today: <b>' + (dayPnl >= 0 ? '+' : '') + '$' + dayPnl.toFixed(2) + '</b> realized · loss limit $' + dayLimitUsd.toFixed(0) + '</div>',
    ];
    if (dayHit) rows.push('<div class="gu-alert">🔴 DAILY LOSS LIMIT HIT — MI recommends stopping paper trading for today.</div>');
    el.innerHTML = rows.join('');
    const dayKey = 'mi.guard.warned.' + new Date().toISOString().slice(0, 10);
    if (dayHit && window.MI && MI.toast && !sessionStorage.getItem(dayKey)) {
      sessionStorage.setItem(dayKey, '1');
      MI.toast('error', 'Daily loss limit hit', 'Consider stopping for the day — guardrails are on.');
    }
  }

  // ------------------------------------------------------- init
  function init() {
    const eq = $('equityRefresh');
    if (eq) eq.addEventListener('click', loadPaper);

    const jf = $('journalForm');
    if (jf) jf.addEventListener('submit', (e) => {
      e.preventDefault();
      const tag = $('journalTag').value || 'Other';
      const note = $('journalNote').value.trim();
      if (!note) { if (window.MI && MI.toast) MI.toast('info', 'Add a note', 'Write what you did and why first.'); return; }
      const j = getJournal();
      j.push({ id: 'j' + Date.now() + Math.floor(Math.random() * 1e4), tag, note, ts: Date.now() });
      saveJournal(j);
      $('journalNote').value = '';
      renderJournal();
      if (window.MI && MI.toast) MI.toast('success', 'Journal saved', 'Entry stored in this browser.');
    });
    const jc = $('journalClear');
    if (jc) jc.addEventListener('click', () => {
      if (!confirm('Delete ALL journal entries?')) return;
      saveJournal([]);
      renderJournal();
    });
    renderJournal();

    const gf = $('guardForm');
    if (gf) gf.addEventListener('submit', (e) => {
      e.preventDefault();
      const risk = Math.max(0.1, Math.min(100, parseFloat($('guardRisk').value) || 2));
      const day = Math.max(0.5, Math.min(100, parseFloat($('guardDay').value) || 5));
      saveGuard({ risk, day });
      renderGuard(lastHistory);
      if (window.MI && MI.toast) MI.toast('success', 'Guardrails saved', 'Max risk ' + risk + '% per trade · daily loss limit ' + day + '%.');
    });
    const g = loadGuard();
    if (g) {
      if ($('guardRisk')) $('guardRisk').value = g.risk;
      if ($('guardDay')) $('guardDay').value = g.day;
    } else if ($('guardRisk') && $('guardDay')) {
      saveGuard({ risk: 2, day: 5 });
    }
    renderGuard(lastHistory);

    loadPaper();
    if (window.MINotify) MINotify.onEvent('paper', loadPaper);
  }

  window.MIRisk = { init, loadPaper };
  document.addEventListener('DOMContentLoaded', init);
})();