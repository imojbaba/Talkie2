/* Talkie service worker — offline app shell. Audio itself needs the network. */
const CACHE = 'talkie-v27';
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
// The OS owns the notification *sound* (web apps can't change it), but
// Android honors per-notification vibration, so each kind feels different.
const VIBES = {
  'talkie-ping': [300, 120, 300, 120, 600],
  'talkie-talk': [150, 90, 150],
  'talkie-roast': [90, 60, 90, 60, 240],
  'talkie-test': [200, 100, 200],
};

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
      vibrate: VIBES[d.tag] || [150, 80, 200],
      // pings and talk re-alert every time instead of replacing silently
      renotify: d.tag === 'talkie-ping' || d.tag === 'talkie-talk',
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
