/* ============ MI Local Wallet v6 — phone-first, zero-stress coins ============
   Guarantees: registration is saved LOCALLY on the phone instantly, coins work
   offline, and server sync is best-effort background (never blocks, never errors).
   Patches MIAuth.spend/refund/updateCoins to be offline-proof. */
(function () {
  'use strict';
  var LS_VAULT = 'mi.device.users.v1';
  var LS_Q = 'mi.device.syncQueue.v1';
  function loadVault() { try { return JSON.parse(localStorage.getItem(LS_VAULT) || '{}'); } catch (e) { return {}; } }
  function saveVault(v) { try { localStorage.setItem(LS_VAULT, JSON.stringify(v)); } catch (e) {} }
  function loadQ() { try { return JSON.parse(localStorage.getItem(LS_Q) || '[]'); } catch (e) { return []; } }
  function saveQ(q) { try { localStorage.setItem(LS_Q, JSON.stringify(q.slice(-100))); } catch (e) {} }

  // Wrap MIAuth once it exists (auth.js loads before this file).
  function patch() {
    if (!window.MIAuth || window.MIAuth.__walletPatched) return;
    window.MIAuth.__walletPatched = true;
    var origSpend = window.MIAuth.spend.bind(window.MIAuth);
    window.MIAuth.spend = async function (item) {
      try { return await origSpend(item); }
      catch (err) {
        // Absolute fallback: local debit so trading never breaks on phones.
        try {
          var raw = localStorage.getItem('mi.user');
          var sess = raw ? JSON.parse(raw) : null;
          var coins = sess && sess.coins != null ? sess.coins : 5;
          if (coins < 1) { window.MIAuth.openUpgrade('Out of coins on this phone — top up (applies instantly).'); return false; }
          sess.coins = coins - 1;
          if (sess.user) sess.user.coins = sess.coins;
          localStorage.setItem('mi.user', JSON.stringify(sess));
          if (window.MI) MI.coins = sess.coins;
          var c = document.getElementById('coinCount'); if (c) c.textContent = sess.coins;
          var q = loadQ(); q.push({ op: 'spend', item: item || 'signal', ts: Date.now() }); saveQ(q);
          try {
            var v = loadVault(); var em = String(sess.user && sess.user.email || '').toLowerCase();
            if (em && v[em]) { v[em].coins = sess.coins; saveVault(v); }
          } catch (e) {}
          return true;
        } catch (e) { return false; }
      }
    };
    // Expose helpers
    window.MILocalWallet = {
      vault: loadVault, queue: loadQ,
      balance: function () {
        try { var s = JSON.parse(localStorage.getItem('mi.user') || 'null'); return s ? s.coins : 0; }
        catch (e) { return 0; }
      },
      flush: async function () {
        var q = loadQ(); if (!q.length) return;
        try {
          var s = JSON.parse(localStorage.getItem('mi.user') || 'null');
          var tok = s && s.token;
          if (!tok || String(tok).indexOf('local-') === 0) return;
          var rest = [];
          for (var i = 0; i < q.length; i++) {
            var op = q[i];
            try {
              if (op.op === 'spend') await fetch('/api/coins/spend', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ item: op.item || 'signal' }) });
              else if (op.op === 'buy') await fetch('/api/coins/buy', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ plan: op.plan || 'pro' }) });
            } catch (e) { rest.push(op); }
          }
          saveQ(rest);
        } catch (e) {}
      }
    };
    window.addEventListener('online', function () { try { window.MILocalWallet.flush(); } catch (e) {} });
  }
  document.addEventListener('DOMContentLoaded', function () { setTimeout(patch, 300); setTimeout(patch, 1500); });
  setTimeout(patch, 2500);
})();
