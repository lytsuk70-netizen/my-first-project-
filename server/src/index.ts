import { createApp } from './app.js';
import { migrate } from './migrate.js';
import { pool } from './db.js';

const port = Number(process.env.PORT ?? 3000);

await migrate();
const server = createApp().listen(port, () => console.log(`Гроші ОК: http://localhost:${port}`));

const shutdown = () => server.close(() => pool.end().then(() => process.exit(0)));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
