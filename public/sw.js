/* MI service worker — offline app shell + installable PWA.
   Precache the static shell; serve static assets stale-while-revalidate and
   the app shell network-first with an offline fallback. API calls always go
   to the network so live market data is never served stale from cache. */
'use strict';

const CACHE = 'mi-cache-v2';
const SHELL = [
  '/',
  '/index.html',
  '/css/style.css',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/js/api.js',
  '/js/notifications.js',
  '/js/chart.js',
  '/js/signals.js',
  '/js/market.js',
  '/js/portfolio.js',
  '/js/chat.js',
  '/js/pwa.js',
  '/js/push.js',
  '/js/app.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ---- Web Push: show a system notification when the app is closed. ----
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = {}; }
  const title = payload.title || 'MI — Master Intelligence';
  const options = {
    body: payload.body || 'New market update from MI.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: payload.tag || 'mi-default',
    renotify: !!payload.tag,
    data: { url: payload.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          try { client.navigate(url); } catch { /* ignore */ }
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

// ---- Static assets & app shell ----
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let browser handle cross-origin (APIs are same-origin behind our server)

  // Never cache API responses — live data must stay live.
  if (url.pathname.startsWith('/api/')) return;

  // App navigations: network first, fall back to the cached shell.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put('/index.html', copy));
        return res;
      }).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});