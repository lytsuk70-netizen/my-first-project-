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
