/*
 * «Гроші ОК» offline shell: the app opens at once from the phone's cache, even while the free
 * server is asleep or there is no network. The cached copy is refreshed in the background.
 * API calls (/api/…) are never cached here — the app keeps its own data cache and sync queue.
 *
 * A page is put into the cache only together with every /assets/ file it needs, and the page is
 * served from the cache only when all of them are there — otherwise a new version could open
 * without its styles (v1 had that bug).
 */
const CACHE = 'gok-shell-v2';
const STATIC = ['/manifest.webmanifest', '/icon-192.png', '/apple-touch-icon.png'];

const assetsOf = (html) => [...new Set(html.match(/\/assets\/[^"'\s)>]+/g) || [])];

async function hasAll(cache, html) {
  for (const u of assetsOf(html)) if (!(await cache.match(u))) return false;
  return true;
}

/** Cache a fresh page together with its assets; the page goes in last. */
async function storePage(cache, resp) {
  const html = await resp.clone().text();
  await Promise.all(assetsOf(html).map(async (u) => {
    if (await cache.match(u)) return;
    const r = await fetch(u);
    if (!r.ok) throw new Error('asset ' + u);
    await cache.put(u, r);
  }));
  await cache.put('/', new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(STATIC).catch(() => {});
    const r = await fetch('/', { cache: 'no-store' }).catch(() => null);
    if (r && r.ok) await storePage(cache, r).catch(() => {});
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match('/');
      const fresh = fetch('/', { cache: 'no-store' }).then(async (r) => { if (r.ok) await storePage(cache, r.clone()).catch(() => {}); return r; }).catch(() => null);
      if (cached && await hasAll(cache, await cached.clone().text())) { e.waitUntil(fresh); return cached; }
      return (await fresh) || cached || new Response('Немає зв’язку', { status: 503 });
    })());
    return;
  }
  // built files have content hashes in their names: cache forever
  if (url.pathname.startsWith('/assets/') || STATIC.includes(url.pathname)) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(url.pathname);
      if (cached) return cached;
      const r = await fetch(req);
      if (r.ok) cache.put(url.pathname, r.clone());
      return r;
    })());
  }
});
