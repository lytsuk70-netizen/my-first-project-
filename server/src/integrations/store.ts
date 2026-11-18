import { pool } from '../db.js';
import { decrypt, encrypt } from '../secrets.js';

export type Kind = 'telegram' | 'monobank' | 'webhook' | 'mcp' | 'talko';

export async function getIntegration(userId: string, kind: Kind) {
  return (await pool.query('SELECT * FROM integrations WHERE user_id=$1 AND kind=$2', [userId, kind])).rows[0] ?? null;
}
export async function upsertIntegration(userId: string, kind: Kind, patch: { config?: object; secret?: string | null; tokenHash?: string | null; enabled?: boolean; status?: string; lastError?: string | null }) {
  await pool.query(
    `INSERT INTO integrations (user_id, kind, config, secret_enc, token_hash, enabled, status, last_error)
     VALUES ($1, $2, COALESCE($3::jsonb, '{}'), $4, $5, COALESCE($6, true), COALESCE($7, 'ok'), $8)
     ON CONFLICT (user_id, kind) DO UPDATE SET
       config = COALESCE($3::jsonb, integrations.config),
       secret_enc = CASE WHEN $9 THEN $4 ELSE integrations.secret_enc END,
       token_hash = CASE WHEN $10 THEN $5 ELSE integrations.token_hash END,
       enabled = COALESCE($6, integrations.enabled),
       status = COALESCE($7, integrations.status),
       last_error = CASE WHEN $11 THEN $8 ELSE integrations.last_error END,
       updated_at = now()`,
    [userId, kind, patch.config ? JSON.stringify(patch.config) : null, patch.secret ? encrypt(patch.secret) : null, patch.tokenHash ?? null,
      patch.enabled ?? null, patch.status ?? null, patch.lastError ?? null, patch.secret !== undefined, patch.tokenHash !== undefined, patch.lastError !== undefined],
  );
}
export async function mergeConfig(userId: string, kind: Kind, patch: object) {
  await pool.query("UPDATE integrations SET config = config || $3::jsonb, updated_at=now() WHERE user_id=$1 AND kind=$2", [userId, kind, JSON.stringify(patch)]);
}
export async function setStatus(userId: string, kind: Kind, status: string, lastError: string | null, synced = false) {
  await pool.query(`UPDATE integrations SET status=$3, last_error=$4 ${synced ? ', last_sync_at=now()' : ''}, updated_at=now() WHERE user_id=$1 AND kind=$2`, [userId, kind, status, lastError]);
}
export function secretOf(row: any): string | null {
  return row?.secret_enc ? decrypt(row.secret_enc) : null;
}
export async function deleteIntegration(userId: string, kind: Kind) {
  await pool.query('DELETE FROM integrations WHERE user_id=$1 AND kind=$2', [userId, kind]);
  if (kind === 'telegram') await pool.query('DELETE FROM telegram_chats WHERE user_id=$1', [userId]);
}
