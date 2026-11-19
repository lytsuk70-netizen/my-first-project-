/**
 * SMS forwarding endpoint: POST /api/hooks/ingest/<token> with the message text.
 * Works with Android SMS-forwarder apps and iPhone Shortcuts "Message" automations.
 */
import { randomBytes } from 'node:crypto';
import { pool } from '../db.js';
import { sha256 } from '../secrets.js';
import { getIntegration, upsertIntegration } from './store.js';

export async function createWebhookToken(userId: string) {
  const token = randomBytes(24).toString('base64url');
  await upsertIntegration(userId, 'webhook', { tokenHash: sha256(token), enabled: true, status: 'ok', config: { createdAt: new Date().toISOString(), hint: token.slice(0, 4) } });
  return token; // shown once
}

export async function webhookStatus(userId: string) {
  const row = await getIntegration(userId, 'webhook');
  if (!row) return { configured: false };
  const received = (await pool.query("SELECT count(*)::int AS n, max(created_at) AS last FROM imported_messages WHERE user_id=$1 AND source='webhook'", [userId])).rows[0];
  return { configured: true, enabled: row.enabled, hint: row.config.hint, createdAt: row.config.createdAt, received: received.n, lastReceivedAt: received.last };
}

export async function userForWebhookToken(token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const r = await pool.query("SELECT user_id FROM integrations WHERE kind='webhook' AND enabled AND token_hash=$1", [sha256(token)]);
  return r.rows[0]?.user_id ?? null;
}

const hits = new Map<string, { n: number; reset: number }>();
export function rateLimited(key: string, perMinute = 60) {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) { hits.set(key, { n: 1, reset: now + 60000 }); return false; }
  h.n++;
  return h.n > perMinute;
}
