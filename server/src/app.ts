import express, { type Request, type Response, type NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z, ZodError } from 'zod';
import { pool } from './db.js';
import { MoneyError } from './engine/money.js';
import { parseVoice } from './engine/parser.js';
import * as auth from './auth.js';
import * as L from './services/ledger.js';
import * as C from './services/catalog.js';
import * as R from './services/reports.js';

type H = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: H) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };
const uid = (req: Request) => (req as any).user.id as string;

// ---------- validation schemas ----------
const uuid = z.string().uuid();
const amount = z.union([z.string(), z.number()]).transform(String);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const dateTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date');
const currency = z.string().regex(/^[A-Z]{3}$/);
const accountType = z.enum(['cash', 'bank', 'card', 'savings', 'debt', 'other']);
const text = (max: number) => z.string().max(max);

const txSchema = z.object({
  type: z.enum(['income', 'expense']),
  accountId: uuid,
  amount,
  categoryId: uuid,
  projectId: uuid.nullable().optional(),
  occurredAt: dateTime.optional(),
  comment: text(500).optional(),
  details: text(2000).optional(),
  source: z.enum(['manual', 'voice', 'sms']).optional(),
});
const transferSchema = z.object({
  fromAccountId: uuid,
  toAccountId: uuid,
  amountSent: amount,
  amountReceived: amount.optional().nullable().transform((v) => v || undefined),
  rate: amount.optional().nullable().transform((v) => v || undefined),
  rateBase: currency.optional(),
  occurredAt: dateTime.optional(),
  comment: text(500).optional(),
});
const accountSchema = z.object({
  name: text(60).min(1),
  type: accountType,
  currency,
  initialBalance: amount.optional().default('0'),
  description: text(500).optional(),
  smsKeywords: text(200).optional(),
});

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'microphone=(self), camera=(self)');
    next();
  });
  app.use(express.json({ limit: '12mb' }));
  app.use(cookieParser());

  const api = express.Router();
  api.use(auth.requireJson);

  api.get('/health', h(async (_req, res) => { await pool.query('SELECT 1'); res.json({ ok: true }); }));

  // ---------- auth ----------
  api.get('/auth/me', h(async (req, res) => {
    const user = await auth.sessionUser(req);
    const users = (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
    res.json({ user, needsSetup: users === 0, registrationOpen: users === 0 || process.env.ALLOW_REGISTRATION === 'true', settings: user ? await L.getSettings(user.id) : null });
  }));
  const credentials = z.object({ email: z.string().email().max(200), password: z.string().min(8).max(200), language: z.enum(['uk', 'en']).optional(), timezone: text(64).optional(), baseCurrency: currency.optional() });
  api.post('/auth/register', h(async (req, res) => {
    const body = credentials.parse(req.body);
    const users = (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
    if (users > 0 && process.env.ALLOW_REGISTRATION !== 'true') return res.status(403).json({ error: 'forbidden', message: 'Реєстрацію закрито' });
    const exists = (await pool.query('SELECT 1 FROM users WHERE email=$1', [body.email.toLowerCase()])).rowCount;
    if (exists) return res.status(409).json({ error: 'conflict', message: 'Такий користувач уже існує' });
    const id = await auth.registerUser(body.email, body.password, body);
    await auth.createSession(res, id);
    res.status(201).json({ ok: true });
  }));
  api.post('/auth/login', h(async (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (!auth.throttle(ip)) return res.status(429).json({ error: 'too_many', message: 'Забагато спроб. Спробуйте за 15 хвилин.' });
    const body = z.object({ email: z.string(), password: z.string() }).parse(req.body);
    const u = (await pool.query('SELECT id, password_hash FROM users WHERE email=$1', [body.email.toLowerCase().trim()])).rows[0];
    if (!u || !(await auth.verifyPassword(body.password, u.password_hash))) {
      auth.recordFailure(ip);
      return res.status(401).json({ error: 'unauthorized', message: 'Невірний email або пароль' });
    }
    auth.clearFailures(ip);
    await auth.createSession(res, u.id);
    res.json({ ok: true });
  }));
  api.post('/auth/logout', h(async (req, res) => { await auth.destroySession(req, res); res.json({ ok: true }); }));

  // everything below requires a session
  api.use(auth.requireAuth);

  api.post('/auth/password', h(async (req, res) => {
    const body = z.object({ current: z.string(), next: z.string().min(8).max(200) }).parse(req.body);
    const u = (await pool.query('SELECT password_hash FROM users WHERE id=$1', [uid(req)])).rows[0];
    if (!(await auth.verifyPassword(body.current, u.password_hash))) return res.status(400).json({ error: 'invalid', message: 'Поточний пароль невірний' });
    await pool.query('UPDATE users SET password_hash=$2, updated_at=now() WHERE id=$1', [uid(req), await auth.hashPassword(body.next)]);
    res.json({ ok: true });
  }));

  // ---------- settings & reference ----------
  api.get('/currencies', h(async (_req, res) => {
    const c = await L.currencies();
    res.json(Object.entries(c).map(([code, v]) => ({ code, ...v })));
  }));
  api.get('/settings', h(async (req, res) => res.json(await L.getSettings(uid(req)))));
  api.put('/settings', h(async (req, res) => {
    const body = z.object({ baseCurrency: currency.optional(), language: z.enum(['uk', 'en']).optional(), timezone: text(64).optional() }).parse(req.body);
    if (body.timezone) {
      const tz = await auth.normalizeTimezone(body.timezone);
      if (!tz) return res.status(400).json({ error: 'invalid', message: 'Unknown timezone' });
      body.timezone = tz;
    }
    if (body.baseCurrency) await L.dec(body.baseCurrency);
    const s = await L.getSettings(uid(req));
    await pool.query('UPDATE settings SET base_currency=$2, language=$3, timezone=$4, updated_at=now() WHERE user_id=$1',
      [uid(req), body.baseCurrency ?? s.base_currency, body.language ?? s.language, body.timezone ?? s.timezone]);
    res.json(await L.getSettings(uid(req)));
  }));

  // ---------- accounts ----------
  api.get('/accounts', h(async (req, res) => res.json(await L.listAccounts(uid(req)))));
  api.post('/accounts', h(async (req, res) => res.status(201).json({ id: await L.createAccount(uid(req), accountSchema.parse(req.body)) })));
  api.put('/accounts/:id', h(async (req, res) => {
    await L.updateAccount(uid(req), uuid.parse(req.params.id), accountSchema.partial().extend({ isArchived: z.boolean().optional(), sortOrder: z.number().int().optional() }).parse(req.body));
    res.json({ ok: true });
  }));
  api.post('/accounts/:id/correct', h(async (req, res) => {
    const body = z.object({ actualBalance: amount, comment: text(500).optional() }).parse(req.body);
    res.json({ transactionId: await L.correctBalance(uid(req), uuid.parse(req.params.id), body.actualBalance, body.comment) });
  }));
  api.get('/net-worth', h(async (req, res) => res.json(await L.netWorth(uid(req), typeof req.query.date === 'string' ? isoDate.parse(req.query.date) : undefined))));

  // ---------- transactions ----------
  api.get('/transactions', h(async (req, res) => {
    const q = z.object({
      kinds: z.string().optional(), accountId: uuid.optional(), categoryId: uuid.optional(), projectId: uuid.optional(), currency: currency.optional(),
      from: isoDate.optional(), to: isoDate.optional(), q: text(100).optional(), limit: z.coerce.number().int().optional(), offset: z.coerce.number().int().optional(),
      deleted: z.enum(['true', 'false']).optional(),
    }).parse(req.query);
    const kinds = q.kinds ? z.array(z.enum(['income', 'expense', 'transfer', 'correction'])).parse(q.kinds.split(',')) : undefined;
    res.json(await R.feed(uid(req), { ...q, kinds, deleted: q.deleted === 'true' }));
  }));
  api.post('/transactions', h(async (req, res) => res.status(201).json({ id: await L.createTransaction(uid(req), txSchema.parse(req.body)) })));
  api.put('/transactions/:id', h(async (req, res) => { await L.updateTransaction(uid(req), uuid.parse(req.params.id), txSchema.partial().parse(req.body)); res.json({ ok: true }); }));
  api.delete('/transactions/:id', h(async (req, res) => { await L.deleteTransaction(uid(req), uuid.parse(req.params.id)); res.json({ ok: true }); }));
  api.post('/transactions/:id/restore', h(async (req, res) => { await L.restoreTransaction(uid(req), uuid.parse(req.params.id)); res.json({ ok: true }); }));
  api.post('/transactions/:id/duplicate', h(async (req, res) => res.status(201).json({ id: await L.duplicateTransaction(uid(req), uuid.parse(req.params.id)) })));
  api.get('/transactions/:id/attachments', h(async (req, res) => res.json(await C.listAttachments(uid(req), uuid.parse(req.params.id)))));
  api.post('/transactions/:id/attachments', h(async (req, res) => {
    const body = z.object({ filename: text(200).min(1), mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']), dataBase64: z.string().min(4) }).parse(req.body);
    res.status(201).json({ id: await C.addAttachment(uid(req), uuid.parse(req.params.id), body) });
  }));
  api.get('/attachments/:id', h(async (req, res) => {
    const a = await C.getAttachment(uid(req), uuid.parse(req.params.id));
    res.setHeader('Content-Type', a.mime_type);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(a.data);
  }));
  api.delete('/attachments/:id', h(async (req, res) => { await C.deleteAttachment(uid(req), uuid.parse(req.params.id)); res.json({ ok: true }); }));

  // ---------- transfers ----------
  api.get('/transfers', h(async (req, res) => res.json(await L.listTransfers(uid(req), { deleted: req.query.deleted === 'true' }))));
  api.post('/transfers', h(async (req, res) => res.status(201).json({ id: await L.createTransfer(uid(req), transferSchema.parse(req.body)) })));
  api.put('/transfers/:id', h(async (req, res) => { await L.updateTransfer(uid(req), uuid.parse(req.params.id), transferSchema.parse(req.body)); res.json({ ok: true }); }));
  api.delete('/transfers/:id', h(async (req, res) => { await L.deleteTransfer(uid(req), uuid.parse(req.params.id)); res.json({ ok: true }); }));

  // ---------- categories & projects ----------
  api.get('/categories', h(async (req, res) => res.json(await C.listCategories(uid(req)))));
  const catSchema = z.object({ name: text(60).min(1), type: z.enum(['income', 'expense']), icon: text(16).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), parentId: uuid.nullable().optional() });
  api.post('/categories', h(async (req, res) => res.status(201).json({ id: await C.createCategory(uid(req), catSchema.parse(req.body)) })));
  api.put('/categories/:id', h(async (req, res) => {
    await C.updateCategory(uid(req), uuid.parse(req.params.id), catSchema.omit({ type: true }).partial().extend({ isArchived: z.boolean().optional() }).parse(req.body));
    res.json({ ok: true });
  }));
  api.delete('/categories/:id', h(async (req, res) => res.json({ result: await C.deleteCategory(uid(req), uuid.parse(req.params.id)) })));
  api.post('/categories/reorder', h(async (req, res) => { await C.reorderCategories(uid(req), z.object({ ids: z.array(uuid).max(500) }).parse(req.body).ids); res.json({ ok: true }); }));
  api.get('/projects', h(async (req, res) => res.json(await C.listProjects(uid(req)))));
  const projSchema = z.object({ name: text(80).min(1), description: text(500).optional(), isArchived: z.boolean().optional() });
  api.post('/projects', h(async (req, res) => res.status(201).json({ id: await C.upsertProject(uid(req), null, projSchema.parse(req.body)) })));
  api.put('/projects/:id', h(async (req, res) => res.json({ id: await C.upsertProject(uid(req), uuid.parse(req.params.id), projSchema.partial().parse(req.body)) })));

  // ---------- exchange rates ----------
  api.get('/rates', h(async (req, res) => res.json(await C.listRates(uid(req)))));
  api.post('/rates', h(async (req, res) => res.status(201).json({ id: await C.addRate(uid(req), z.object({ date: isoDate, base: currency, quote: currency, rate: amount }).parse(req.body)) })));
  api.delete('/rates/:id', h(async (req, res) => { await C.deleteRate(uid(req), uuid.parse(req.params.id)); res.json({ ok: true }); }));

  // ---------- reports ----------
  api.get('/reports', h(async (req, res) => {
    const q = z.object({ from: isoDate, to: isoDate }).parse(req.query);
    res.json(await R.report(uid(req), q.from, q.to));
  }));
  api.get('/reports/monthly', h(async (req, res) => res.json(await R.monthly(uid(req), z.coerce.number().int().min(1).max(60).default(12).parse(req.query.months ?? 12)))));
  api.get('/summary', h(async (req, res) => res.json(await R.quickSummary(uid(req), z.enum(['income', 'expense']).parse(req.query.type)))));

  // ---------- voice & SMS ----------
  api.post('/parse/voice', h(async (req, res) => {
    const body = z.object({ text: text(500).min(1), defaultType: z.enum(['income', 'expense']).optional() }).parse(req.body);
    const ctx = await C.parseContext(uid(req));
    const s = await L.getSettings(uid(req));
    res.json(parseVoice(body.text, ctx.accounts, ctx.categories, { defaultType: body.defaultType, lang: s.language }));
  }));
  api.post('/import/messages', h(async (req, res) => {
    const body = z.object({ text: text(50000).min(1), source: z.enum(['sms', 'share', 'paste']).optional(), tzOffsetMinutes: z.number().int().min(-900).max(900).optional() }).parse(req.body);
    res.json(await C.importMessages(uid(req), body.text, body));
  }));
  api.get('/import/messages', h(async (req, res) => res.json(await C.listImported(uid(req), typeof req.query.status === 'string' ? req.query.status : undefined))));
  api.post('/import/messages/:id/confirm', h(async (req, res) => res.status(201).json({ id: await C.confirmImported(uid(req), uuid.parse(req.params.id), txSchema.parse(req.body)) })));
  api.post('/import/messages/:id/ignore', h(async (req, res) => { await C.ignoreImported(uid(req), uuid.parse(req.params.id)); res.json({ ok: true }); }));

  // ---------- export & audit ----------
  api.get('/export/json', h(async (req, res) => {
    res.setHeader('Content-Disposition', `attachment; filename="groshi-ok-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(await C.exportAll(uid(req)));
  }));
  api.get('/export/csv', h(async (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="groshi-ok-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(await C.exportCsv(uid(req)));
  }));
  api.get('/audit', h(async (req, res) => res.json(await C.auditLog(uid(req)))));

  app.use('/api', api);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found', message: 'Not found' }));

  // ---------- static web app ----------
  const here = dirname(fileURLToPath(import.meta.url));
  const webDist = [join(here, '..', '..', 'web', 'dist'), join(here, '..', '..', '..', 'web', 'dist')].find((p) => existsSync(p));
  if (webDist) {
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(join(webDist, 'index.html')));
  }

  // ---------- errors ----------
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) return res.status(400).json({ error: 'invalid', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (err instanceof MoneyError || err instanceof L.Invalid) return res.status(400).json({ error: 'invalid', message: err.message });
    if (err instanceof L.NotFound) return res.status(404).json({ error: 'not_found', message: err.message });
    if (err?.code === '23505') return res.status(409).json({ error: 'conflict', message: 'Запис з такою назвою вже існує' });
    if (err?.code === '23514' || err?.code === '23503' || err?.code === 'P0001') return res.status(400).json({ error: 'invalid', message: err.message });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'too_large', message: 'Request too large' });
    console.error(err);
    res.status(500).json({ error: 'server_error', message: 'Внутрішня помилка сервера' });
  });
  return app;
}
