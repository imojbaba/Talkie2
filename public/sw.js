/* Talkie service worker — offline app shell. Audio itself needs the network. */
const CACHE = 'talkie-v24';
const ASSETS = [
  '/',
  '/style.css',
  '/app.js',
  '/worklet.js',
  '/manifest.webmanifest',
  '/icons/favicon-32.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      // cache:'reload' skips the HTTP cache so a new SW never precaches stale files
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Background notifications: the phone can't play the channel while locked,
// but it can buzz — "X is talking", "X pinged", "photo shared".
self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {}
  e.waitUntil(
    self.registration.showNotification(d.title || 'Talkie', {
      body: d.body || '',
      tag: d.tag || 'talkie',
      icon: '/icons/icon-192.png',
      badge: '/icons/favicon-32.png',
      data: { room: d.room || '' },
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const room = (e.notification.data && e.notification.data.room) || '';
  e.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((list) => {
        for (const c of list) {
          if ('focus' in c) return c.focus(); // the app is open — bring it up
        }
        return clients.openWindow('/' + room);
      })
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Channel share links (/mango) all resolve to the app shell.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/')));
    return;
  }

  // Network-first keeps every asset in lockstep with the deployed app;
  // the cache is only an offline fallback.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
