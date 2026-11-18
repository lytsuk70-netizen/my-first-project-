/** AES-256-GCM encryption for third-party tokens (Telegram bot, monobank). */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let key: Buffer | null = null;
function getKey(): Buffer {
  if (key) return key;
  let secret = process.env.APP_SECRET;
  if (!secret) {
    // Development fallback: a random key persisted next to the process. Set APP_SECRET in production.
    const file = process.env.APP_SECRET_FILE ?? join(process.cwd(), '.app-secret');
    if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
    secret = readFileSync(file, 'utf8').trim();
    console.warn(`APP_SECRET is not set; using key file ${file}`);
  }
  key = createHash('sha256').update(secret).digest();
  return key;
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decrypt(enc: string): string {
  const [v, iv, tag, data] = enc.split(':');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const d = createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
