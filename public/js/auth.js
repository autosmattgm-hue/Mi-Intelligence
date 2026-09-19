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

  // ---------------------------------------------------------------- users
  async function userRegister(fields) {
    const r = await apiPost('/api/auth/register', fields);
    persistUser(r);
    afterLogin('user', r.freeCoins || 5);
  }
  async function userLogin(fields) {
    const r = await apiPost('/api/auth/login', fields);
    persistUser(r);
    afterLogin('user');
  }

  function afterLogin(which, freeCoins) {
    showOverlay(false);
    if (window.MINotify && MINotify.switchMode) MINotify.switchMode((window.MI && MI.mode) || 'crypto');
    if (window.MI && MI.toast) {
      if (which === 'owner') MI.toast('success', 'Welcome back, MI', 'Trading terminal unlocked.');
      else MI.toast('success', 'Welcome, ' + ((MI.user && MI.user.name) || 'trader'),
        freeCoins ? ('You got ' + freeCoins + ' free coins — 1 signal or 1 AI question = 1 coin.') : ('You have ' + MI.coins + ' coins left.'));
    }
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
    let r;
    try {
      r = await apiPost('/api/coins/spend', { item }, tok);
    } catch (e) {
      if (e.status === 402 || e.code === 'insufficient_coins') {
        openUpgrade(item === 'ai' ? 'You are out of coins — top up to keep asking MI.' : 'You are out of coins — top up to keep reading signals.');
      } else {
        if (window.MI && MI.toast) MI.toast('error', 'Coin error', e.message);
      }
      return false;
    }
    updateCoins(r.coins);
    if (window.MI && MI.toast) {
      MI.toast('info', '🪙 ' + (r.cost || 1) + ' coin used', (item === 'ai' ? 'AI question' : 'Signal analysis') + ' · ' + r.coins + ' coins left.');
    }
    return true;
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

    // Logout + coin pill + upgrade modal
    const lo = $id('logoutBtn');
    if (lo) lo.addEventListener('click', logout);
    const pill = $id('coinBtn');
    if (pill) pill.addEventListener('click', () => openUpgrade());
    const uc = $id('upgradeClose');
    if (uc) uc.addEventListener('click', closeUpgrade);

    setRole();
    showOverlay(!isAuthed());
  }

  document.addEventListener('DOMContentLoaded', init);
  window.MIAuth = { isAuthed, logout, role, spend: trySpend, refund, openUpgrade, updateCoins, userToken };
})();