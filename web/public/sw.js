/*
 * «Гроші ОК» offline shell: the app opens at once from the phone's cache, even while the free
 * server is asleep or there is no network. The cached copy is refreshed in the background.
 * API calls (/api/…) are never cached here — the app keeps its own data cache and sync queue.
 */
const CACHE = 'gok-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  // the page itself: cached copy now, fresh copy for the next start
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match('/');
      const fresh = fetch(req).then((r) => { if (r.ok) cache.put('/', r.clone()); return r; }).catch(() => null);
      if (cached) { e.waitUntil(fresh); return cached; }
      return (await fresh) || new Response('Немає зв’язку', { status: 503 });
    })());
    return;
  }
  // built files have content hashes in their names: cache forever
  if (url.pathname.startsWith('/assets/') || SHELL.includes(url.pathname) || /\.(png|svg|webmanifest)$/.test(url.pathname)) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      const r = await fetch(req);
      if (r.ok) cache.put(req, r.clone());
      return r;
    })());
  }
});
