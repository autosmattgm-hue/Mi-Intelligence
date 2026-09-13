/* ============ MI device push — notifications OUTSIDE the app (Web Push) ============
   Gives MI its OWN permission toggle for OS-level notifications so alerts &
   signals still pop up on your device even when the app is closed.
   Falls back silently on browsers that don't support Web Push (FCM/autopush). */
(function () {
  'use strict';

  const LS = 'mi.push.enabled';
  const state = { supported: false, enabled: localStorage.getItem(LS) === '1' };

  function $(id) { return document.getElementById(id); }
  function toast(type, title, body) { if (window.MI && MI.toast) MI.toast(type, title, body); }

  function urlBase64ToUint8Array(b64) {
    const padding = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function isSupported() {
    return ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window);
  }

  async function getRegistration() {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg || navigator.serviceWorker.ready;
  }

  async function getVapidKey() {
    try {
      const r = await MI.api.get('/api/push/vapid');
      return r.publicKey || null;
    } catch { return null; }
  }

  async function enable() {
    if (!isSupported()) {
      toast('info', 'Device notifications unsupported', 'This browser does not support Web Push — use Chrome, Edge or Android for notifications outside the app.');
      return false;
    }
    let perm = Notification.permission;
    if (perm !== 'granted') perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      toast('error', 'Permission needed', 'MI needs your permission to show notifications outside the app.');
      return false;
    }
    const pub = await getVapidKey();
    if (!pub) {
      toast('error', 'Push not configured', 'The MI server did not provide a push key — check the server is running.');
      return false;
    }
    try {
      const reg = await getRegistration();
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(pub),
        });
      }
      const json = sub.toJSON();
      await MI.api.post('/api/push/subscribe', {
        endpoint: json.endpoint,
        keys: json.keys,
        userAgent: navigator.userAgent,
      });
      state.enabled = true;
      localStorage.setItem(LS, '1');
      renderToggle();
      toast('success', '📳 Device notifications ON', 'MI will now notify you even when the app is closed — alerts, signals and paper trades.');
      return true;
    } catch (e) {
      toast('error', 'Could not enable device notifications', e.message);
      return false;
    }
  }

  async function disable() {
    try {
      const reg = await getRegistration();
      const sub = reg && await reg.pushManager.getSubscription();
      if (sub) {
        try { await MI.api.post('/api/push/unsubscribe', { endpoint: sub.endpoint }); } catch { /* ignore */ }
        await sub.unsubscribe();
      }
    } catch { /* ignore */ }
    state.enabled = false;
    localStorage.removeItem(LS);
    renderToggle();
    toast('info', '📴 Device notifications OFF', 'MI will only notify you inside the app from now on.');
  }

  function renderToggle() {
    const btn = $('noticeOs');
    if (!btn) return;
    const on = state.enabled && (typeof Notification === 'undefined' || Notification.permission === 'granted');
    btn.textContent = on ? 'ON' : 'OFF';
    btn.classList.toggle('os-on', on);
    btn.title = on ? 'Tap to turn off device notifications' : 'Tap to get MI notifications outside the app';
    const sub = $('noticeOsSub');
    if (sub) sub.textContent = on ? 'Active — pings arrive even when MI is closed' : 'Not active — notifications stop at this app';
  }

  // Re-sync after losing a subscription (e.g. browser cleared site data).
  async function resync() {
    if (!state.enabled || !isSupported()) return;
    try {
      const reg = await getRegistration();
      const sub = await reg.pushManager.getSubscription();
      if (!sub) await enable();
    } catch { /* ignore */ }
  }

  async function init() {
    state.supported = isSupported();
    const row = $('noticeOsRow');
    if (row) row.classList.toggle('hidden', !state.supported);
    const btn = $('noticeOs');
    if (btn) btn.addEventListener('click', () => {
      if (state.enabled && Notification.permission === 'granted') disable();
      else enable();
    });
    renderToggle();
    resync();
  }

  window.MIPush = { isSupported, enable, disable, getState: () => ({ enabled: state.enabled, supported: state.supported }) };
  document.addEventListener('DOMContentLoaded', init);
})();