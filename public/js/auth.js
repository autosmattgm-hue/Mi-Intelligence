/* ============ MI auth gate — secure login page ============
   Validates the access password against the server (POST /api/login) and
   keeps the session in localStorage for 7 days. The app stays fully hidden
   behind the login screen until authentication succeeds. */
(function () {
  'use strict';

  const LS = 'mi.auth';
  const EXPIRE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  function $(id) { return document.getElementById(id); }

  function isAuthed() {
    try {
      const raw = localStorage.getItem(LS);
      if (!raw) return false;
      const d = JSON.parse(raw);
      return !!(d && d.ok && d.at && (Date.now() - d.at) < EXPIRE_MS);
    } catch { return false; }
  }

  function showOverlay(show) {
    const o = $('loginOverlay');
    if (o) o.classList.toggle('hidden', !show);
    const lo = $('logoutBtn');
    if (lo) lo.hidden = !!show;
    if (show) {
      const p = $('loginPass');
      if (p) setTimeout(() => p.focus(), 80);
    }
  }

  async function attempt() {
    const passEl = $('loginPass');
    const btn = $('loginBtn');
    const err = $('loginError');
    const password = passEl ? passEl.value : '';
    if (btn) btn.classList.add('login-loading');
    if (err) err.textContent = '';
    try {
      const r = await MI.api.post('/api/login', { password });
      if (r && r.ok) {
        localStorage.setItem(LS, JSON.stringify({ ok: true, at: Date.now() }));
        if (passEl) passEl.value = '';
        showOverlay(false);
        if (window.MINotify && typeof MINotify.switchMode === 'function') {
          MINotify.switchMode((window.MI && MI.mode) || 'crypto');
        }
        if (window.MI && MI.toast) MI.toast('success', 'Welcome, MI', 'Trading terminal unlocked.');
      } else if (err) {
        err.textContent = 'Incorrect password.';
      }
    } catch (e) {
      if (err) err.textContent = 'Cannot reach MI server — ' + (e.message || 'offline?') ;
    } finally {
      if (btn) btn.classList.remove('login-loading');
    }
  }

  function logout() {
    localStorage.removeItem(LS);
    showOverlay(true);
    if (window.MI && MI.toast) MI.toast('info', 'Logged out', 'Session closed. Enter the password to continue.');
  }

  function init() {
    const form = $('loginForm');
    if (form) {
      form.addEventListener('submit', (e) => { e.preventDefault(); attempt(); });
    }
    const lo = $('logoutBtn');
    if (lo) lo.addEventListener('click', logout);
    showOverlay(!isAuthed());
  }

  document.addEventListener('DOMContentLoaded', init);
  window.MIAuth = { isAuthed, logout };
})();