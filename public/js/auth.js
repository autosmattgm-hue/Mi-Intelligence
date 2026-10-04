/* ============ MI auth — two pages in one gate ============
   - OWNER page: password gate (POST /api/login) — full access, no coin limits.
   - USER page: register / sign-in (POST /api/auth/*). New users get 5 free
     coins. 1 coin = 1 signal analysis reveal OR 1 AI question. Running out
     opens the upgrade/pay screen (mock checkout — wire Stripe/PayPal later).
   Sessions persist in localStorage (7d for owner, 30d for users). */
(function () {
  'use strict';

  const LS_OWNER = 'mi.auth';
  const LS_USER = 'mi.user';
  const EXPIRE_MS = 7 * 24 * 60 * 60 * 1000;

  function $id(id) { return document.getElementById(id); }

  function isOwner() {
    try { const d = JSON.parse(localStorage.getItem(LS_OWNER) || 'null'); return !!(d && d.ok && (Date.now() - d.at) < EXPIRE_MS); }
    catch { return false; }
  }
  function current() {
    try { return JSON.parse(localStorage.getItem(LS_USER) || 'null'); }
    catch { return null; }
  }

  function isAuthed() { return isOwner() || !!(current() && current().token); }
  function userToken() { const u = current(); return (u && u.token) || null; }
  function role() { return isOwner() ? 'owner' : (userToken() ? 'user' : null); }

  // Sync MI.role / MI.user / MI.coins + the coin pill visibility.
  function setRole() {
    if (!window.MI) window.MI = {};
    MI.role = role();
    MI.user = isOwner() ? null : (current() ? current().user : null);
    MI.coins = (MI.role === 'user' && current()) ? current().coins : null;
    const pill = $id('coinBtn');
    if (pill) pill.hidden = (MI.role !== 'user');
    const c = $id('coinCount');
    if (c && MI.coins != null) c.textContent = MI.coins;
    syncSignalChip();
  }

  function syncSignalChip() {
    const chip = $id('signalsCoinChip');
    if (!chip) return;
    chip.classList.toggle('hidden', (MI.role !== 'user'));
    const b = chip.querySelector('b');
    if (b && MI.coins != null) b.textContent = MI.coins;
  }
  function updateCoins(n) {
    const u = current();
    if (u) { u.coins = n; localStorage.setItem(LS_USER, JSON.stringify(u)); }
    if (window.MI) MI.coins = n;
    const c = $id('coinCount');
    if (c) c.textContent = n;
    syncSignalChip();
  }

   function persistUser(session) {
    localStorage.setItem(LS_USER, JSON.stringify({ token: session.token, user: session.user, coins: session.user.coins, at: Date.now() }));
    // v6: mirror account into on-phone vault so sign-in + coins survive offline
    try {
      var em = String((session.user && session.user.email) || '').toLowerCase();
      if (em) {
        var v = {};
        try { v = JSON.parse(localStorage.getItem('mi.device.users.v1') || '{}'); } catch (e) {}
        v[em] = v[em] || {};
        v[em].name = session.user.name; v[em].email = em;
        v[em].coins = session.user.coins; v[em].updatedAt = Date.now();
        try { localStorage.setItem('mi.device.users.v1', JSON.stringify(v)); } catch (e) {}
      }
    } catch (e) {}
    setRole();
  }

  async function apiPost(path, body, token) {
    const h = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    const r = await fetch(path, { method: 'POST', headers: h, body: JSON.stringify(body || {}) });
    let j = null;
    try { j = await r.json(); } catch { /* ignore */ }
    if (!r.ok) {
      const e = new Error((j && j.error) || ('HTTP ' + r.status));
      e.status = r.status; if (j && j.code) e.code = j.code;
      throw e;
    }
    return j;
  }

  // ---------------------------------------------------------------- owner
  async function ownerLogin(password) {
    await apiPost('/api/login', { password });
    localStorage.setItem(LS_OWNER, JSON.stringify({ ok: true, at: Date.now() }));
    localStorage.removeItem(LS_USER);
    setRole();
    afterLogin('owner');
  }

  // ---------------------------------------------------------------- Google Sign-In
  // Official Google Identity Services button-less flow (zero extra deps).
  // Needs GOOGLE_CLIENT_ID in server .env (see .env.example). Verified
  // server-side via RS256 (server/googleAuth.js) — never trust client claims.
  let googleClientId = null, googleReady = false;
  function loadGoogleScript() {
    return new Promise((resolve) => {
      if (window.google && window.google.accounts && window.google.accounts.id) return resolve(true);
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true; s.defer = true;
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
  }
  async function initGoogle() {
    const btn = $id('googleBtn');
    if (!btn) return;
    let status = null;
    try {
      const r = await fetch('/api/auth/google/status');
      status = await r.json();
    } catch { status = null; }
    googleClientId = status && status.clientId ? status.clientId : null;
    if (!googleClientId) {
      btn.disabled = true;
      btn.title = 'Ask the site owner to set GOOGLE_CLIENT_ID (see .env.example)';
      btn.innerHTML = 'G&nbsp;&nbsp;Google sign-in not configured';
      return;
    }
    const ok = await loadGoogleScript();
    if (!ok || !window.google || !window.google.accounts) return;
    try {
      window.google.accounts.id.initialize({
        client_id: googleClientId,
        callback: onGoogleCredential,
        auto_select: false,
        ux_mode: 'popup',
      });
      googleReady = true;
    } catch { /* leave button; click will retry */ }
  }
  async function onGoogleCredential(resp) {
    const err = $id('userError');
    const btn = $id('googleBtn');
    if (err) err.textContent = '';
    const idToken = resp && resp.credential ? resp.credential : null;
    if (!idToken) { if (err) err.textContent = 'Google sign-in failed — try again.'; return; }
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Signing in with Google…'; }
    try {
      const r = await apiPost('/api/auth/google', { idToken });
      persistUser(r);
      afterLogin('user', r.freeCoins || null);
    } catch (x) {
      if (err) err.textContent = x.message || 'Google sign-in failed.';
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = 'G&nbsp;&nbsp;Continue with Google'; }
    }
  }
  function googleClick() {
    if (googleReady && window.google && window.google.accounts) {
      try { window.google.accounts.id.prompt(); return; } catch { /* fall through */ }
    }
    // Fallback: OAuth2 redirect flow works everywhere (phones included).
    if (googleClientId) {
      const redir = location.origin + location.pathname;
      const url = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=' + encodeURIComponent(googleClientId) +
        '&redirect_uri=' + encodeURIComponent(redir) +
        '&response_type=id_token&scope=' + encodeURIComponent('openid email profile') +
        '&nonce=' + Math.random().toString(36).slice(2) + '&prompt=select_account';
      location.href = url;
    }
  }

  // ---------------------------------------------------------------- users
  async function userRegister(fields) {
    // v6 local-first: validate, then try server; on ANY network failure create
    // the account instantly on the phone (5 free coins, zero errors).
    var email = String((fields && fields.email) || '').trim();
    var name = String((fields && fields.name) || '').trim();
    var password = String((fields && fields.password) || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
    if (password.length < 6) throw new Error('Password must be at least 6 characters.');
    try {
      var ctl = new AbortController();
      var to = setTimeout(function () { try { ctl.abort(); } catch (e) {} }, 9000);
      var r = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, email: email, password: password }), signal: ctl.signal });
      clearTimeout(to);
      var j = null; try { j = await r.json(); } catch (e) {}
      if (!r.ok) {
        var ee = new Error((j && j.error) || ('HTTP ' + r.status));
        ee.status = r.status; if (j && j.code) ee.code = j.code;
        throw ee;
      }
      persistUser(j);
      afterLogin('user', j.freeCoins || 5);
      return;
    } catch (e) {
      if (e && e.status === 409) throw new Error('That email is already registered — sign in instead.');
      if (e && (e.status === 400 || e.status === 401)) throw e;
      // network/server down → local registration on this phone
      var sess = { token: 'local-' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36), user: { id: 'local-' + email, name: name || email.split('@')[0], email: email, coins: 5, spent: 0, createdAt: Date.now() } };
      persistUser(sess);
      try {
        var q = []; try { q = JSON.parse(localStorage.getItem('mi.device.syncQueue.v1') || '[]'); } catch (eq) {}
        q.push({ op: 'register', name: sess.user.name, email: email, ts: Date.now() });
        try { localStorage.setItem('mi.device.syncQueue.v1', JSON.stringify(q.slice(-100))); } catch (eq) {}
      } catch (eq) {}
      afterLogin('user', 5);
      if (window.MI && MI.toast) MI.toast('info', '📱 Saved on this phone', 'No connection — account + 5 coins stored locally. Will sync when online.');
    }
  }
  async function userLogin(fields) {
    var em = String((fields && fields.email) || '').trim().toLowerCase();
    try {
      const r = await apiPost('/api/auth/login', fields);
      persistUser(r);
      afterLogin('user');
    } catch (e) {
      // v6: offline unlock from the on-phone vault (same email, any state)
      if (e && e.status === 401) throw new Error('Incorrect email or password.');
      try {
        var v = {}; try { v = JSON.parse(localStorage.getItem('mi.device.users.v1') || '{}'); } catch (ev) {}
        var rec = v[em] || v[String((fields && fields.email) || '').trim()];
        if (rec) {
          persistUser({ token: 'local-' + Date.now().toString(36), user: { id: 'local-' + em, name: rec.name || em.split('@')[0], email: em, coins: rec.coins != null ? rec.coins : 5 } });
          afterLogin('user');
          if (window.MI && MI.toast) MI.toast('info', '📱 Offline sign-in', 'Unlocked from this phone. Coins work offline.');
          return;
        }
      } catch (ev) {}
      throw new Error('No connection — connect once to sync, then you can use MI offline.');
    }
  }

  function afterLogin(which, freeCoins) {
    showOverlay(false);
    if (window.MINotify && MINotify.switchMode) MINotify.switchMode((window.MI && MI.mode) || 'crypto');
    if (window.MI && MI.toast) {
      if (which === 'owner') MI.toast('success', 'Welcome back, MI', 'Trading terminal unlocked.');
      else MI.toast('success', 'Welcome, ' + ((MI.user && MI.user.name) || 'trader'),
        freeCoins ? ('You got ' + freeCoins + ' free coins — 1 signal or 1 AI question = 1 coin.') : ('You have ' + MI.coins + ' coins left.'));
    }
    // v6.1: broker popup ONLY at user sign-up (fresh register). Never on
    // mode switch, never on BUY/SELL. Change later in Settings.
    try {
      if (which === 'user' && freeCoins && window.MIBrokersHub && typeof window.MIBrokersHub.ask === 'function') {
        let asked = null;
        try { asked = localStorage.getItem('mi.broker.asked.v1'); } catch (e) {}
        if (!asked) setTimeout(() => { try { window.MIBrokersHub.ask({ source: 'signup' }); } catch (e) {} }, 900);
      }
      if (window.MIBrokersHub && typeof window.MIBrokersHub.ensure === 'function') {
        setTimeout(() => { try { window.MIBrokersHub.ensure(); } catch (e) {} }, 1200);
      }
    } catch (e) {}
  }

  function logout() {
    const tok = userToken();
    if (tok) { try { fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + tok } }); } catch { /* ignore */ } }
    localStorage.removeItem(LS_USER);
    localStorage.removeItem(LS_OWNER);
    setRole();
    showOverlay(true);
    if (window.MI && MI.toast) MI.toast('info', 'Logged out', 'Session closed. Choose Owner or User to continue.');
  }// ---------------------------------------------------------------- coins
  // trySpend returns true if the coin was charged (or owner), false if blocked.
  async function trySpend(item) {
    if (role() !== 'user') return true;
    const tok = userToken();
    // v6: local-token accounts debit the phone instantly, never error
    if (!tok || String(tok).indexOf('local-') === 0) {
      var sess = current();
      var coins = sess && sess.coins != null ? sess.coins : 5;
      if (coins < 1) { openUpgrade('You are out of coins on this phone — top up (instant, works offline).'); return false; }
      updateCoins(coins - 1);
      try {
        var em2 = String(sess && sess.user && sess.user.email || '').toLowerCase();
        var vv = {}; try { vv = JSON.parse(localStorage.getItem('mi.device.users.v1') || '{}'); } catch (e) {}
        if (em2 && vv[em2]) { vv[em2].coins = coins - 1; try { localStorage.setItem('mi.device.users.v1', JSON.stringify(vv)); } catch (e) {} }
        var qq = []; try { qq = JSON.parse(localStorage.getItem('mi.device.syncQueue.v1') || '[]'); } catch (e) {}
        qq.push({ op: 'spend', item: item || 'signal', ts: Date.now() });
        try { localStorage.setItem('mi.device.syncQueue.v1', JSON.stringify(qq.slice(-100))); } catch (e) {}
      } catch (e) {}
      return true;
    }
    let r;
    try {
      r = await apiPost('/api/coins/spend', { item }, tok);
    } catch (e) {
      if (e.status === 402 || e.code === 'insufficient_coins') {
        openUpgrade(item === 'ai' ? 'You are out of coins — top up to keep asking MI.' : 'You are out of coins — top up to keep reading signals.');
      } else if (e.status === 401) {
        // Session/account was invalidated server-side — cleanly return to login.
        expireSession();
      } else {
        if (window.MI && MI.toast) MI.toast('error', 'Cannot reach MI server',
          (e.status ? (e.message || ('HTTP ' + e.status)) : 'Check that the server is running, then refresh the page.'));
      }
      return false;
    }
    updateCoins(r.coins);
    if (window.MI && MI.toast) {
      MI.toast('info', '🪙 ' + (r.cost || 1) + ' coin used', (item === 'ai' ? 'AI question' : 'Signal analysis') + ' · ' + r.coins + ' coins left.');
    }
    return true;
  }
  // User session is no longer valid on the server — drop it and show the login screen.
  function expireSession() {
    localStorage.removeItem(LS_USER);
    setRole();
    showOverlay(true);
    if (window.MI && MI.toast) MI.toast('error', 'Session expired', 'Please sign in again to continue.');
  }
  async function refund(item) {
    if (role() !== 'user') return;
    const tok = userToken();
    if (!tok) return;
    try {
      const r = await apiPost('/api/coins/refund', { item }, tok);
      updateCoins(r.coins);
    } catch { /* best-effort */ }
  }

  // ---------------------------------------------------------------- upgrade modal
  function openUpgrade(message) {
    const ov = $id('upgradeOverlay');
    if (!ov) return;
    const line = $id('coinBalanceLine');
    if (line) line.textContent = message || 'Choose a coin package:';
    renderPlans();
    ov.classList.remove('hidden');
  }
  function closeUpgrade() {
    const ov = $id('upgradeOverlay');
    if (ov) ov.classList.add('hidden');
  }
  async function renderPlans() {
    const wrap = $id('coinPlans');
    if (!wrap) return;
    try {
      const p = await MI.api.get('/api/coins/plans');
      const plans = p && p.plans ? Object.values(p.plans) : [];
      wrap.innerHTML = plans.length
        ? plans.map(pl =>
          '<div class="plan-card"><div><div class="plan-name">' + pl.name + '</div>' +
          '<div class="plan-coins">' + pl.coins + ' coins · $' + pl.price + '</div></div>' +
          '<button class="login-btn sm" data-plan="' + pl.id + '">Buy · $' + pl.price + '</button></div>').join('')
        : '<div class="login-error">No plans available.</div>';
      wrap.querySelectorAll('button[data-plan]').forEach(b => b.addEventListener('click', async () => {
        b.disabled = true; b.textContent = 'Processing…';
        try {
          const r = await apiPost('/api/coins/buy', { plan: b.dataset.plan }, userToken());
          updateCoins(r.coins);
          closeUpgrade();
          if (window.MI && MI.toast) MI.toast('success', '🪙 Coins added', r.order.planName + ' — balance ' + r.coins + ' coins.');
        } catch (e) {
          if (window.MI && MI.toast) MI.toast('error', 'Payment failed', e.message);
          b.disabled = false; b.textContent = 'Buy now';
        }
      }));
    } catch (e) {
      wrap.innerHTML = '<div class="login-error">' + e.message + '</div>';
    }
  }// ---------------------------------------------------------------- overlay & tabs
  function showOverlay(show) {
    const o = $id('loginOverlay');
    if (o) o.classList.toggle('hidden', !show);
    const lo = $id('logoutBtn');
    if (lo) lo.hidden = !!show;
    setRole();
    if (show) {
      const p = $id('loginPass');
      if (p) setTimeout(() => p.focus(), 80);
    }
  }

  function setTab(which) {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('active', t.dataset.role === which));
    const ownerF = $id('ownerForm');
    const userF = $id('userForm');
    if (ownerF) ownerF.classList.toggle('hidden', which !== 'owner');
    if (userF) userF.classList.toggle('hidden', which !== 'user');
  }

  function init() {
    // Owner / User tab switch
    document.querySelectorAll('.auth-tab').forEach(t => t.addEventListener('click', () => setTab(t.dataset.role)));

    // Owner form
    const ownerForm = $id('ownerForm');
    if (ownerForm) ownerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $id('ownerError');
      if (err) err.textContent = '';
      try { await ownerLogin($id('loginPass').value); }
      catch (x) { if (err) err.textContent = (x.status === 401 ? 'Incorrect password.' : 'Cannot reach MI server — ' + (x.message || 'offline')); }
    });

    // User form — register / sign-in toggle
    let userMode = 'register';
    const userForm = $id('userForm');
    const sw = $id('userSwitch');
    const submitBtn = $id('userSubmitBtn');
    const nameField = $id('regName');
    function setUserMode(m) {
      userMode = m;
      if (nameField) nameField.classList.toggle('hidden', m === 'login');
      if (submitBtn) submitBtn.textContent = m === 'register' ? '✍️ Register · get 5 free coins' : '🔓 Sign in';
      if (sw) sw.textContent = m === 'register' ? 'Already registered? Sign in' : 'New here? Register (5 free coins)';
      const pp = $id('userPass');
      if (pp) pp.placeholder = m === 'register' ? 'Password (min 6 chars)' : 'Password';
    }
    if (sw) sw.addEventListener('click', () => setUserMode(userMode === 'register' ? 'login' : 'register'));
    if (userForm) userForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $id('userError');
      if (err) err.textContent = '';
      const email = ($id('userEmail').value || '').trim();
      const pass = $id('userPass').value;
      if (!email || !pass) { if (err) err.textContent = 'Enter your email and password.'; return; }
      try {
        if (userMode === 'register') await userRegister({ name: ($id('regName').value || '').trim(), email, password: pass });
        else await userLogin({ email, password });
      } catch (x) { if (err) err.textContent = x.message || 'Authentication failed.'; }
    });

    // Logout + coin pill + upgrade modal + Google button
    const lo = $id('logoutBtn');
    if (lo) lo.addEventListener('click', logout);
    const pill = $id('coinBtn');
    if (pill) pill.addEventListener('click', () => openUpgrade());
    const uc = $id('upgradeClose');
    if (uc) uc.addEventListener('click', closeUpgrade);
    const gb = $id('googleBtn');
    if (gb) gb.addEventListener('click', googleClick);

    setRole();
    showOverlay(!isAuthed());
    initGoogle();
    // OAuth2 redirect fallback: token arrives in the URL hash.
    try {
      if (location.hash && location.hash.includes('id_token=')) {
        const m = location.hash.match(/id_token=([^&]+)/);
        if (m && m[1]) { onGoogleCredential({ credential: decodeURIComponent(m[1]) }); }
        history.replaceState(null, '', location.pathname + location.search);
      }
    } catch { /* ignore */ }
  }

  document.addEventListener('DOMContentLoaded', init);
  window.MIAuth = { isAuthed, logout, role, spend: trySpend, refund, openUpgrade, updateCoins, userToken };
})();