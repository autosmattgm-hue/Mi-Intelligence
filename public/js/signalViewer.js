/* ============ MI signal viewer v6 — 35s focused view + broker execution ============
   When the user clicks SHOW it opens a focused overlay that counts down
   35s then closes itself ("waits for 35 secs before it closes back again").
   Includes: entry/TP/SL, live TP-countdown timer, BUY/SELL buttons routed via
   MIBrokers (Pocket/MT5/MT4/Exness + Binance for crypto). */
(function () {
  'use strict';
  var timer = null, left = 35, cur = null, srcBtn = null;
  var SHOW_SECS = 35;
  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmtP(v, sig) {
    if (v == null || isNaN(v)) return '-';
    var p = (sig && sig.precision != null) ? sig.precision : (sig && sig.mode === 'forex' ? 5 : 2);
    return Number(v).toFixed(p);
  }
  function tpLeft(sig) {
    if (!sig) return null;
    var total = sig.tpTimerSec || (sig.mode === 'pocket' ? (sig.expiry === '1m' ? 60 : sig.expiry === '15m' ? 900 : 300) : 45 * 60);
    var age = Date.now() - new Date(sig.time || Date.now()).getTime();
    var l = Math.max(0, total - Math.floor(age / 1000));
    return { total: total, left: l, txt: Math.floor(l / 60) + 'm ' + String(l % 60).padStart(2, '0') };
  }
  function open(sig, btn) {
    // SHOW button: fixed 35s countdown, then closes back again.
    // (Settings auto-close still overrides if the user changed it.)
    left = SHOW_SECS;
    try {
      var pref = localStorage.getItem('mi.viewer.autoclose');
      if (pref !== null && pref !== undefined && String(pref) !== '35') {
        var n = Number(pref) || 0;
        left = n > 0 ? n : (String(pref) === '0' ? 3600 : SHOW_SECS);
      }
    } catch (e) { left = SHOW_SECS; }
    cur = sig; var total = left;
    // countdown lives IN the clicked button: disable + live label + bar
    if (btn && btn.isConnected) {
      srcBtn = btn;
      if (!srcBtn.dataset.orig) srcBtn.dataset.orig = srcBtn.innerHTML;
      srcBtn.disabled = true;
      srcBtn.classList.add('counting');
    }
    var ov = el('signalViewer'); if (!ov) return;
    ov.classList.remove('hidden');
    paint();
    if (timer) clearInterval(timer);
    timer = setInterval(function () {
      left -= 1;
      var n = el('svCount'); if (n) n.textContent = left + 's';
      var bar = el('svBar'); if (bar) bar.style.width = (left / total * 100) + '%';
      paintBtn();
      if (left <= 0) close();
    }, 1000);
    paintBtn();
  }
  function paintBtn() {
    if (!srcBtn || !srcBtn.isConnected) return;
    // countdown INSIDE the clicked SHOW button, synced with the modal
    var pct = Math.max(0, Math.round(left / SHOW_SECS * 100));
    srcBtn.innerHTML = '<span class="show-cd">⏳ ' + left + 's closing…</span><span class="show-bar"><span style="width:' + pct + '%"></span></span>';
  }
  function restoreBtn() {
    if (srcBtn && srcBtn.isConnected) {
      srcBtn.disabled = false;
      srcBtn.classList.remove('counting');
      if (srcBtn.dataset.orig) srcBtn.innerHTML = srcBtn.dataset.orig;
    }
    srcBtn = null;
  }
  function close() {
    if (timer) clearInterval(timer); timer = null;
    var ov = el('signalViewer'); if (ov) ov.classList.add('hidden');
    cur = null;
    restoreBtn();
  }
  function paint() {
    if (!cur) return;
    var t = tpLeft(cur);
    el('svTitle').textContent = (cur.asset || cur.symbol) + ' ' + cur.action;
    el('svTitle').className = 'sv-title ' + (String(cur.action).indexOf('BUY') === 0 || cur.action === 'CALL' ? 'buy' : String(cur.action).indexOf('SELL') === 0 || cur.action === 'PUT' ? 'sell' : 'hold');
    el('svMeta').textContent = 'Conf ' + cur.confidence + '% | ' + (cur.quality || '') + ' | Entry ' + fmtP(cur.entry || cur.price, cur);
    el('svLevels').innerHTML = '<div><span>Entry</span><b>' + fmtP(cur.entry || cur.price, cur) + '</b></div>'
      + '<div><span>Take profit</span><b class="g">' + fmtP(cur.takeProfit, cur) + '</b></div>'
      + '<div><span>Stop loss</span><b class="r">' + fmtP(cur.stopLoss, cur) + '</b></div>'
      + '<div><span>TP timer</span><b class="c">' + (t ? t.txt + ' left' : '-') + '</b></div>';
    el('svCount').textContent = left + 's';
    var brk = (window.MIBrokers && window.MIBrokers.label) ? window.MIBrokers.label() : '';
    el('svBroker').textContent = brk;
    var buyB = el('svBuy'), sellB = el('svSell');
    var isBuy = cur.action === 'BUY' || cur.action === 'CALL';
    if (buyB) buyB.classList.toggle('hot', isBuy);
    if (sellB) sellB.classList.toggle('hot', !isBuy && (cur.action === 'SELL' || cur.action === 'PUT'));
  }
  document.addEventListener('DOMContentLoaded', function () {
    var c = el('svClose'); if (c) c.addEventListener('click', close);
    var ov = el('signalViewer');
    if (ov) ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    var buyB = el('svBuy');
    if (buyB) buyB.addEventListener('click', function () {
      if (!cur) return;
      var side = (cur.mode === 'pocket') ? 'CALL' : 'BUY';
      if (window.MIBrokers) window.MIBrokers.execute(cur, side);
      close();
    });
    var sellB = el('svSell');
    if (sellB) sellB.addEventListener('click', function () {
      if (!cur) return;
      var side = (cur.mode === 'pocket') ? 'PUT' : 'SELL';
      if (window.MIBrokers) window.MIBrokers.execute(cur, side);
      close();
    });
    // refresh TP countdown each second while open
    setInterval(function () { if (cur && !el('signalViewer').classList.contains('hidden')) paint(); }, 5000);
  });
  window.MISignalViewer = { open: open, close: close };
})();
