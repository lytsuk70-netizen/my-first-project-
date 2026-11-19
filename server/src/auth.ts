import { randomBytes, scrypt as _scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { Request, Response, NextFunction } from 'express';
import { pool, withTx } from './db.js';
import { seedDefaults } from './services/catalog.js';

const scrypt = promisify(_scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const COOKIE = 'gok_session';
const SESSION_DAYS = 30;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, s, k] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const key = await scrypt(pw, Buffer.from(s, 'base64'), 64, SCRYPT);
  const expected = Buffer.from(k, 'base64');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

const sha = (t: string) => createHash('sha256').update(t).digest('hex');

export async function createSession(res: Response, userId: string) {
  const token = randomBytes(32).toString('base64url');
  await pool.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`, [sha(token), userId]);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_DAYS * 86400000,
    path: '/',
  });
}

export async function destroySession(req: Request, res: Response) {
  const token = req.cookies?.[COOKIE];
  if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha(token)]);
  res.clearCookie(COOKIE, { path: '/' });
}

export async function sessionUser(req: Request): Promise<{ id: string; email: string } | null> {
  const token = req.cookies?.[COOKIE];
  if (!token) return null;
  const r = await pool.query(
    'SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()',
    [sha(token)],
  );
  return r.rows[0] ?? null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  sessionUser(req)
    .then((u) => {
      if (!u) return res.status(401).json({ error: 'unauthorized', message: 'Потрібно увійти' });
      (req as any).user = u;
      next();
    })
    .catch(next);
}

/** CSRF defence: state-changing requests must be JSON (cross-site forms cannot send it without CORS preflight). */
export function requireJson(req: Request, res: Response, next: NextFunction) {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const ct = req.headers['content-type'] ?? '';
    if (!ct.startsWith('application/json') || req.headers['x-requested-with'] !== 'groshi-ok') {
      return res.status(415).json({ error: 'bad_request', message: 'JSON request with X-Requested-With header required' });
    }
  }
  next();
}

// naive login throttling (per IP)
const attempts = new Map<string, { n: number; until: number }>();
export function throttle(ip: string): boolean {
  const now = Date.now();
  const a = attempts.get(ip);
  if (a && a.until > now && a.n >= 8) return false;
  return true;
}
export function recordFailure(ip: string) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.until < now) attempts.set(ip, { n: 1, until: now + 15 * 60000 });
  else a.n++;
}
export function clearFailures(ip: string) { attempts.delete(ip); }

const TZ_ALIASES: Record<string, string> = { 'Europe/Kiev': 'Europe/Kyiv', 'Europe/Uzhgorod': 'Europe/Kyiv', 'Europe/Zaporozhye': 'Europe/Kyiv' };

/** Returns a time zone name PostgreSQL understands, or null. Browsers may report legacy names. */
export async function normalizeTimezone(tz: string | undefined): Promise<string | null> {
  if (!tz) return null;
  for (const name of [tz, TZ_ALIASES[tz]].filter(Boolean)) {
    if ((await pool.query('SELECT 1 FROM pg_timezone_names WHERE name = $1', [name])).rowCount) return name as string;
  }
  return null;
}

export async function registerUser(email: string, password: string, opts: { language?: 'uk' | 'en'; timezone?: string; baseCurrency?: string }) {
  const hash = await hashPassword(password);
  const timezone = (await normalizeTimezone(opts.timezone)) ?? 'Europe/Kyiv';
  return withTx(async (c) => {
    const u = await c.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [email.toLowerCase().trim(), hash]);
    const id = u.rows[0].id as string;
    await c.query('INSERT INTO settings (user_id, language, timezone, base_currency) VALUES ($1, $2, $3, $4)', [
      id, opts.language ?? 'uk', timezone, opts.baseCurrency ?? 'UAH',
    ]);
    await seedDefaults(c, id, opts.language ?? 'uk');
    return id;
  });
}
