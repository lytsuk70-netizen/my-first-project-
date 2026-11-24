import { createApp } from './app.js';
import { migrate } from './migrate.js';
import { pool } from './db.js';
import { startAllTelegram } from './integrations/telegram.js';
import { startMonobankScheduler } from './integrations/monobank.js';

const port = Number(process.env.PORT ?? 3000);

await migrate();
if (process.env.DISABLE_INTEGRATIONS !== 'true') {
  startAllTelegram().catch((e) => console.error('telegram start failed', e));
  startMonobankScheduler();
}
const server = createApp().listen(port, () => console.log(`Гроші ОК: http://localhost:${port}`));

const shutdown = () => server.close(() => pool.end().then(() => process.exit(0)));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Render's free plan sleeps after 15 idle minutes and then needs ~50 s to wake. While running, the
// server visits its own public page every 10 minutes so it stays awake (one service fits the free 750 h).
// Only the static page is requested, so the database is not woken.
const selfUrl = process.env.RENDER_EXTERNAL_URL;
if (selfUrl && process.env.KEEP_AWAKE !== 'off') {
  setInterval(() => { fetch(selfUrl + '/manifest.webmanifest', { signal: AbortSignal.timeout(30_000) }).catch(() => {}); }, 10 * 60_000).unref();
}
