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

  function isIOS() {
    return /iPhone|iPad|iPod|Macintosh|Mac OS X/.test(navigator.userAgent) && /Safari/.test(navigator.userAgent) && !/Chrome|Edg/.test(navigator.userAgent);
  }

  function isStandalone() {
    try { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch { return false; }
  }

  // Web Push needs a service worker + PushManager. The Notification API is
  // optional (Safari exposes it only in installed PWAs) — never hard-block on it.
  function isSupported() {
    return ('serviceWorker' in navigator) && ('PushManager' in window);
  }

  async function getRegistration() {
    try {
      if (!navigator.serviceWorker.controller) await navigator.serviceWorker.ready;
    } catch { /* ignore */ }
    const reg = await navigator.serviceWorker.getRegistration();
    return reg || navigator.serviceWorker.ready;
  }

  async function getVapidKey() {
    try { const r = await MI.api.get('/api/push/vapid'); return r.publicKey || null; }
    catch { return null; }
  }

  // Ask for OS-level notification permission IF the platform exposes it.
  async function ensureOsPermission() {
    if (typeof Notification === 'undefined') return true; // Safari/iOS: install is the permission
    try {
      const perm = await Notification.requestPermission();
      return perm !== 'denied';
    } catch { return true; }
  }

  async function enable() {
    if (!isSupported()) {
      toast('info', 'Device notifications unsupported', 'This browser has no Web Push — use Chrome, Edge, Android, or an iPhone with MI added to the Home Screen.');
      return false;
    }
    // On iPhones, Web Push only works after the app is installed to Home Screen.
    if (isIOS() && !isStandalone()) {
      toast('info', '📱 Almost there (iPhone)',
        'To enable alerts on your iPhone: tap ⬇️ (or ⋯) in the address bar → “Add to Home Screen” → open MI from Home Screen → then enable device notifications again.');
      return false;
    }

    const pub = await getVapidKey();
    if (!pub) {
      toast('error', 'Push not configured', 'The MI server did not provide a push key — check the server is running.');
      return false;
    }
    try {
      await ensureOsPermission();
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
      renderToggle();
      const msg = String((e && e.message) || e).toLowerCase();
      let hint = 'Could not enable: ' + ((e && e.message) || 'unknown error');
      if (msg.includes('permission')) hint = 'Permission is blocked here. Allow notifications in your browser/app (🔒 icon in the address bar), then try again.';
      else if (isIOS()) hint = 'On iPhone: add MI to your Home Screen first, then come back and enable device notifications.';
      else if (msg.includes('invalid') || msg.includes('argument')) hint = 'The push subscription was rejected — reload the page and try again.';
      toast('error', 'Device notification failed', hint);
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

  // Send a test push so the user can verify delivery while OUTSIDE the app.
  async function sendTest() {
    if (!state.enabled || !isSupported()) {
      toast('info', 'Enable first', 'Turn on “Device / OS notifications” above, then test it here.');
      return;
    }
    try {
      const r = await MI.api.post('/api/push/test', {});
      if (r && r.ok) {
        if (r.delivered > 0) toast('success', '📡 Test push sent', 'Check your device for “MI test push” — if it arrives, everything works.');
        else toast('info', 'Test push queued', 'No device subscription found yet — make sure you tapped ON above, then try again.');
      } else {
        toast('error', 'Test push failed', r && r.error ? r.error : 'Server could not send the push.');
      }
    } catch (e) {
      toast('error', 'Test push failed', e.message);
    }
  }

  function isOn() {
    return state.enabled && (typeof Notification === 'undefined' || Notification.permission !== 'denied');
  }

  function renderToggle() {
    const btn = $('noticeOs');
    if (!btn) return;
    const on = isOn();
    btn.textContent = on ? 'ON' : 'OFF';
    btn.classList.toggle('os-on', on);
    btn.title = on ? 'Tap to turn off device notifications' : 'Tap to get MI notifications outside the app';
    const sub = $('noticeOsSub');
    if (sub) sub.textContent = on ? 'Active — pings arrive even when MI is closed' : 'Not active — notifications stop at this app';
    const tb = $('noticeTest');
    if (tb) tb.disabled = !on;
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
    if (btn) btn.addEventListener('click', () => { if (isOn()) disable(); else enable(); });
    const tb = $('noticeTest');
    if (tb) tb.addEventListener('click', sendTest);
    renderToggle();
    resync();
  }

  window.MIPush = { isSupported, enable, disable, sendTest, getState: () => ({ enabled: state.enabled, supported: state.supported }) };
  document.addEventListener('DOMContentLoaded', init);
})();