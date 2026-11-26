import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

// open instantly from the phone's cache, even when the server is asleep (see public/sw.js)
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => {
    // safety net: if the page came without its styles (stale cache), drop the cache and load fresh once
    const styled = [...document.styleSheets].some((s) => { try { return s.cssRules.length > 20; } catch { return true; } });
    if (!styled && !sessionStorage.getItem('gok.fix')) {
      sessionStorage.setItem('gok.fix', '1');
      Promise.all([caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k)))), navigator.serviceWorker.getRegistrations().then((rs) => Promise.all(rs.map((r) => r.unregister())))])
        .finally(() => location.reload());
      return;
    }
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

/**
 * New version check: the app opens from the cache, so after an update it would show the old version once more.
 * On start and whenever the app comes back to the screen, compare the page on the server with the running one;
 * if it changed, drop the cached page and reload — the new version appears right away.
 */
const runningScript = (document.querySelector('script[type="module"][src*="/assets/"]') as HTMLScriptElement | null)?.getAttribute('src') ?? '';
let lastCheck = 0;
async function checkForUpdate() {
  if (!runningScript || Date.now() - lastCheck < 30_000) return;
  lastCheck = Date.now();
  try {
    const html = await (await fetch('/?v=' + Date.now(), { cache: 'no-store' })).text();
    const fresh = html.match(/\/assets\/index-[^"']+\.js/)?.[0];
    if (!fresh || fresh === runningScript) return;
    if (sessionStorage.getItem('gok.updated') === fresh) return; // reload at most once per version
    sessionStorage.setItem('gok.updated', fresh);
    await caches.open('gok-shell-v2').then((c) => c.delete('/')).catch(() => {});
    location.reload();
  } catch { /* offline: keep the cached version */ }
}
if (location.protocol === 'https:') {
  window.addEventListener('load', () => { setTimeout(checkForUpdate, 1500); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(); });
}
