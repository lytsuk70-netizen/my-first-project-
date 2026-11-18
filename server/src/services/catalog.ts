/** Categories, projects, exchange rates, imported messages, attachments, export. */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { pool, withTx, audit, type Db } from '../db.js';
import { parseRate, formatMinor, Decimal, parseAmount } from '../engine/money.js';
import { parseSms, parseVoice, splitMessages, type Draft, type SmsDraft, type ParseAccount, type ParseCategory } from '../engine/parser.js';
import { NotFound, Invalid, currencies, dec, getSettings, createTransaction, type TxInput } from './ledger.js';

// ---------- defaults ----------

// First eight use the validated categorical palette (dark surface) in fixed order;
// the rest start neutral — charts fold small categories into a neutral "Other" slice.
const DEFAULT_EXPENSE: Array<[string, string, string, string]> = [
  // uk, en, icon, color
  ['Їжа', 'Food', '🛒', '#3987e5'],
  ['Ресторани', 'Restaurants', '🍽️', '#d95926'],
  ['Транспорт', 'Transport', '🚕', '#199e70'],
  ["Здоров'я", 'Health', '💊', '#c98500'],
  ["Сім'я", 'Family', '👨‍👩‍👧', '#d55181'],
  ['Дім', 'Home', '🏠', '#0ca30c'],
  ["Зв'язок", 'Phone & Internet', '📱', '#9085e9'],
  ['Одяг', 'Clothes', '👕', '#e66767'],
  ['Розваги', 'Entertainment', '🎬', '#8e8e93'],
  ['Освіта', 'Education', '📚', '#8e8e93'],
  ['Інвестиції', 'Investments', '📈', '#8e8e93'],
  ['Будівництво', 'Construction', '🏗️', '#8e8e93'],
  ['Благодійність', 'Charity', '💙', '#8e8e93'],
  ['Інше', 'Other', '•', '#8e8e93'],
];
const DEFAULT_INCOME: Array<[string, string, string, string]> = [
  ['Зарплата', 'Salary', '💼', '#3987e5'],
  ['Бізнес', 'Business', '🏢', '#d95926'],
  ['Фриланс', 'Freelance', '💻', '#199e70'],
  ['Відсотки та кешбек', 'Interest & cashback', '🏦', '#c98500'],
  ['Подарунки', 'Gifts', '🎁', '#d55181'],
  ['Інше', 'Other', '•', '#8e8e93'],
];

export async function seedDefaults(c: Db, userId: string, lang: 'uk' | 'en') {
  let i = 0;
  for (const [type, list] of [['expense', DEFAULT_EXPENSE], ['income', DEFAULT_INCOME]] as const) {
    for (const [uk, en, icon, color] of list) {
      await c.query('INSERT INTO categories (user_id, name, type, icon, color, sort_order) VALUES ($1,$2,$3,$4,$5,$6)', [userId, lang === 'en' ? en : uk, type, icon, color, i++]);
    }
  }
}

// ---------- categories ----------

export async function listCategories(userId: string) {
  const rows = (await pool.query(
    `SELECT c.*, (SELECT count(*) FROM transactions t WHERE t.category_id = c.id)::int AS usage
       FROM categories c WHERE c.user_id = $1 ORDER BY c.type, c.is_archived, c.sort_order, c.name`,
    [userId],
  )).rows;
  return rows.map((c) => ({
    id: c.id, name: c.name, type: c.type, icon: c.icon, color: c.color, parentId: c.parent_id,
    isArchived: c.is_archived, sortOrder: c.sort_order, usage: c.usage,
  }));
}

export async function createCategory(userId: string, input: { name: string; type: 'income' | 'expense'; icon?: string; color?: string; parentId?: string | null }) {
  return withTx(async (c) => {
    if (input.parentId) await checkParent(c, userId, input.parentId, input.type, null);
    const order = (await c.query('SELECT COALESCE(max(sort_order),0)+1 AS n FROM categories WHERE user_id=$1 AND type=$2', [userId, input.type])).rows[0].n;
    const r = await c.query(
      'INSERT INTO categories (user_id, name, type, icon, color, parent_id, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [userId, input.name.trim(), input.type, input.icon || '•', input.color || '#8e8e93', input.parentId || null, order],
    );
    await audit(c, userId, 'category', r.rows[0].id, 'create', null, r.rows[0]);
    return r.rows[0].id as string;
  });
}

async function checkParent(c: Db, userId: string, parentId: string, type: string, selfId: string | null) {
  const p = (await c.query('SELECT * FROM categories WHERE id = $1 AND user_id = $2', [parentId, userId])).rows[0];
  if (!p) throw new NotFound('Parent category not found');
  if (p.type !== type) throw new Invalid('Parent category must have the same type');
  if (p.parent_id) throw new Invalid('Only one level of nesting is supported');
  if (selfId && p.id === selfId) throw new Invalid('Category cannot be its own parent');
}

export async function updateCategory(userId: string, id: string, input: { name?: string; icon?: string; color?: string; parentId?: string | null; isArchived?: boolean }) {
  return withTx(async (c) => {
    const before = (await c.query('SELECT * FROM categories WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, userId])).rows[0];
    if (!before) throw new NotFound('Category not found');
    if (input.parentId) {
      await checkParent(c, userId, input.parentId, before.type, id);
      const hasChildren = (await c.query('SELECT 1 FROM categories WHERE parent_id = $1 LIMIT 1', [id])).rowCount;
      if (hasChildren) throw new Invalid('A category with subcategories cannot become a subcategory');
    }
    const r = await c.query(
      'UPDATE categories SET name=$3, icon=$4, color=$5, parent_id=$6, is_archived=$7, updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *',
      [id, userId, (input.name ?? before.name).trim(), input.icon ?? before.icon, input.color ?? before.color,
        input.parentId === undefined ? before.parent_id : input.parentId || null, input.isArchived ?? before.is_archived],
    );
    await audit(c, userId, 'category', id, 'update', before, r.rows[0]);
  });
}

/** Deletes an unused category; a category with history is archived instead so reports keep it. */
export async function deleteCategory(userId: string, id: string): Promise<'deleted' | 'archived'> {
  return withTx(async (c) => {
    const before = (await c.query('SELECT * FROM categories WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, userId])).rows[0];
    if (!before) throw new NotFound('Category not found');
    const used = (await c.query('SELECT 1 FROM transactions WHERE category_id = $1 LIMIT 1', [id])).rowCount;
    const children = (await c.query('SELECT 1 FROM categories WHERE parent_id = $1 LIMIT 1', [id])).rowCount;
    if (used || children) {
      await c.query('UPDATE categories SET is_archived = true, updated_at = now() WHERE id = $1', [id]);
      await audit(c, userId, 'category', id, 'archive', before, { ...before, is_archived: true });
      return 'archived';
    }
    await c.query('DELETE FROM categories WHERE id = $1', [id]);
    await audit(c, userId, 'category', id, 'delete', before, null);
    return 'deleted';
  });
}

export async function reorderCategories(userId: string, ids: string[]) {
  await withTx(async (c) => {
    for (let i = 0; i < ids.length; i++) await c.query('UPDATE categories SET sort_order=$3 WHERE id=$1 AND user_id=$2', [ids[i], userId, i]);
  });
}

// ---------- projects ----------

export async function listProjects(userId: string) {
  return (await pool.query(
    `SELECT p.id, p.name, p.description, p.is_archived AS "isArchived", p.created_at AS "createdAt",
            (SELECT count(*) FROM transactions t WHERE t.project_id = p.id AND t.deleted_at IS NULL)::int AS usage
       FROM projects p WHERE p.user_id = $1 ORDER BY p.is_archived, p.name`,
    [userId],
  )).rows;
}
export async function upsertProject(userId: string, id: string | null, input: { name?: string; description?: string; isArchived?: boolean }) {
  return withTx(async (c) => {
    if (!id) {
      const r = await c.query('INSERT INTO projects (user_id, name, description) VALUES ($1,$2,$3) RETURNING *', [userId, (input.name ?? '').trim(), input.description ?? '']);
      await audit(c, userId, 'project', r.rows[0].id, 'create', null, r.rows[0]);
      return r.rows[0].id as string;
    }
    const before = (await c.query('SELECT * FROM projects WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, userId])).rows[0];
    if (!before) throw new NotFound('Project not found');
    const r = await c.query('UPDATE projects SET name=$3, description=$4, is_archived=$5, updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *',
      [id, userId, (input.name ?? before.name).trim(), input.description ?? before.description, input.isArchived ?? before.is_archived]);
    await audit(c, userId, 'project', id, 'update', before, r.rows[0]);
    return id;
  });
}

// ---------- exchange rates ----------

export async function listRates(userId: string) {
  return (await pool.query(
    `SELECT id, to_char(rate_date,'YYYY-MM-DD') AS date, base, quote, rate, source, transfer_id AS "transferId", created_at AS "createdAt"
       FROM exchange_rates WHERE user_id = $1 ORDER BY rate_date DESC, created_at DESC LIMIT 500`,
    [userId],
  )).rows.map((r) => ({ ...r, rate: new Decimal(r.rate).toString() }));
}
export async function addRate(userId: string, input: { date: string; base: string; quote: string; rate: string }) {
  if (input.base === input.quote) throw new Invalid('Base and quote currencies must differ');
  await dec(input.base); await dec(input.quote);
  const rate = parseRate(input.rate);
  return withTx(async (c) => {
    // one manual rate per pair per day: replace
    await c.query("DELETE FROM exchange_rates WHERE user_id=$1 AND rate_date=$2 AND base=$3 AND quote=$4 AND source='manual'", [userId, input.date, input.base, input.quote]);
    const r = await c.query("INSERT INTO exchange_rates (user_id, rate_date, base, quote, rate, source) VALUES ($1,$2,$3,$4,$5,'manual') RETURNING *",
      [userId, input.date, input.base, input.quote, rate.toFixed()]);
    await audit(c, userId, 'exchange_rate', r.rows[0].id, 'create', null, r.rows[0]);
    return r.rows[0].id as string;
  });
}
export async function deleteRate(userId: string, id: string) {
  return withTx(async (c) => {
    const before = (await c.query('SELECT * FROM exchange_rates WHERE id=$1 AND user_id=$2', [id, userId])).rows[0];
    if (!before) throw new NotFound('Rate not found');
    if (before.source === 'transfer') throw new Invalid('This rate belongs to a transfer; edit the transfer instead');
    await c.query('DELETE FROM exchange_rates WHERE id=$1', [id]);
    await audit(c, userId, 'exchange_rate', id, 'delete', before, null);
  });
}

// ---------- SMS / notification import ----------

async function parseContext(userId: string) {
  const accounts = (await pool.query('SELECT id, name, currency, sms_keywords, is_archived FROM accounts WHERE user_id=$1', [userId])).rows as ParseAccount[];
  const categories = (await pool.query('SELECT id, name, type, is_archived FROM categories WHERE user_id=$1', [userId])).rows as ParseCategory[];
  return { accounts, categories };
}
export { parseContext };

const normHash = (text: string) => createHash('sha256').update(text.replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex');

/** Finds existing transactions that probably are the same operation. */
export async function findDuplicates(c: Db, userId: string, d: { type: string | null; amount: string | null; currency: string | null; accountId: string | null; occurredAt: string | null }) {
  if (!d.amount || !d.currency || !d.type) return [];
  const minor = parseAmount(d.amount, await dec(d.currency));
  const params: unknown[] = [userId, d.type, minor, d.currency, d.occurredAt ?? new Date().toISOString()];
  let sql = `SELECT t.id, t.occurred_at, t.comment, a.name AS account_name FROM transactions t JOIN accounts a ON a.id=t.account_id
              WHERE t.user_id=$1 AND t.deleted_at IS NULL AND t.type=$2 AND t.amount_minor=$3 AND t.currency=$4
                AND t.occurred_at BETWEEN $5::timestamptz - interval '36 hours' AND $5::timestamptz + interval '36 hours'`;
  if (d.accountId) { params.push(d.accountId); sql += ` AND t.account_id = $${params.length}`; }
  return (await c.query(sql + ' ORDER BY abs(extract(epoch FROM t.occurred_at - $5::timestamptz)) LIMIT 5', params)).rows;
}

export type InboxSource = 'sms' | 'share' | 'paste' | 'telegram' | 'webhook' | 'monobank';
const TX_SOURCE: Record<InboxSource, TxInput['source']> = { sms: 'sms', share: 'sms', paste: 'sms', telegram: 'telegram', webhook: 'webhook', monobank: 'monobank' };

/** Bank SMS / notification parser first; free text ("200 на таксі з моно") falls back to the voice parser. */
export function parseAny(text: string, ctx: { accounts: ParseAccount[]; categories: ParseCategory[] }, opts: { tzOffsetMinutes?: number; lang?: 'uk' | 'en' }): SmsDraft {
  const sms = parseSms(text, ctx.accounts, ctx.categories, opts);
  if (sms.amount) return sms;
  const v = parseVoice(text, ctx.accounts, ctx.categories, { lang: opts.lang, defaultType: 'expense' });
  return { ...v, balance: null, balanceCurrency: null, cardLast4: null, bank: null, merchant: '' };
}

export function draftReady(d: Draft) {
  return !!(d.type && d.amount && d.accountId && d.categoryId);
}

/**
 * Puts one incoming bank message into the inbox (status "pending"). Never creates a transaction.
 * Deduplicates by external id (e.g. monobank statement id) or by normalised text.
 */
export async function ingest(userId: string, text: string, opts: { source: InboxSource; tzOffsetMinutes?: number; externalId?: string; draft?: SmsDraft }) {
  const hash = normHash(opts.externalId ? `${opts.source}:${opts.externalId}` : text);
  const existing = (await pool.query(
    'SELECT * FROM imported_messages WHERE user_id=$1 AND (text_hash=$2 OR ($3::text IS NOT NULL AND external_id=$3))', [userId, hash, opts.externalId ?? null],
  )).rows[0];
  let draft: SmsDraft;
  if (existing) draft = existing.parsed;
  else if (opts.draft) draft = opts.draft;
  else {
    const settings = await getSettings(userId);
    draft = parseAny(text, await parseContext(userId), { tzOffsetMinutes: opts.tzOffsetMinutes ?? tzOffsetFor(settings.timezone), lang: settings.language });
  }
  const duplicates = existing?.status === 'imported' ? [] : await findDuplicates(pool, userId, draft);
  let row = existing;
  if (!row) {
    row = (await pool.query(
      `INSERT INTO imported_messages (user_id, source, raw_text, text_hash, parsed, external_id) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT DO NOTHING RETURNING *`,
      [userId, opts.source, text.slice(0, 4000), hash, JSON.stringify(draft), opts.externalId ?? null],
    )).rows[0];
    if (!row) row = (await pool.query('SELECT * FROM imported_messages WHERE user_id=$1 AND text_hash=$2', [userId, hash])).rows[0];
  }
  return { id: row.id as string, text, source: row.source as InboxSource, status: row.status as string, alreadyImported: !!existing, transactionId: row.transaction_id as string | null, draft, duplicates };
}

/** Offset in minutes (UTC - local) of an IANA zone right now; used to read local times in SMS. */
export function tzOffsetFor(tz: string): number {
  try {
    const now = new Date();
    const local = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    const utc = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
    return Math.round((utc.getTime() - local.getTime()) / 60000);
  } catch { return 0; }
}

export async function importMessages(userId: string, block: string, opts: { source?: 'sms' | 'share' | 'paste'; tzOffsetMinutes?: number }) {
  const out = [];
  for (const text of splitMessages(block).slice(0, 100)) out.push(await ingest(userId, text, { source: opts.source ?? 'paste', tzOffsetMinutes: opts.tzOffsetMinutes }));
  return out;
}

export async function listImported(userId: string, status?: string) {
  const rows = (await pool.query(
    `SELECT id, source, raw_text AS text, parsed AS draft, status, transaction_id AS "transactionId", created_at AS "createdAt"
       FROM imported_messages WHERE user_id=$1 ${status ? 'AND status=$2' : ''} ORDER BY created_at DESC LIMIT 200`,
    status ? [userId, status] : [userId],
  )).rows;
  for (const r of rows) r.duplicates = r.status === 'pending' ? await findDuplicates(pool, userId, r.draft) : [];
  return rows;
}

export async function pendingCount(userId: string): Promise<number> {
  return (await pool.query("SELECT count(*)::int AS n FROM imported_messages WHERE user_id=$1 AND status='pending'", [userId])).rows[0].n;
}

export async function getImported(userId: string, id: string) {
  const r = (await pool.query('SELECT * FROM imported_messages WHERE id=$1 AND user_id=$2', [id, userId])).rows[0];
  if (!r) throw new NotFound('Message not found');
  return r;
}

/** Updates the stored draft (e.g. account/category picked with Telegram buttons). */
export async function patchDraft(userId: string, id: string, patch: Partial<Draft>) {
  const r = await getImported(userId, id);
  const draft = { ...r.parsed, ...patch };
  draft.missing = (['type', 'amount', 'account', 'category'] as const).filter((k) => !draft[k === 'account' ? 'accountId' : k === 'category' ? 'categoryId' : k]);
  await pool.query('UPDATE imported_messages SET parsed=$3, updated_at=now() WHERE id=$1 AND user_id=$2', [id, userId, JSON.stringify(draft)]);
  return draft as SmsDraft;
}

export async function confirmImported(userId: string, messageId: string, tx: TxInput) {
  return withTx(async (c) => {
    const msg = (await c.query('SELECT * FROM imported_messages WHERE id=$1 AND user_id=$2 FOR UPDATE', [messageId, userId])).rows[0];
    if (!msg) throw new NotFound('Message not found');
    if (msg.status === 'imported') throw new Invalid('This message has already been imported');
    const id = await createTransaction(userId, { ...tx, source: TX_SOURCE[msg.source as InboxSource] }, c as pg.PoolClient);
    await c.query("UPDATE imported_messages SET status='imported', transaction_id=$2, updated_at=now() WHERE id=$1", [messageId, id]);
    return id;
  });
}

/** Confirms a pending message using its stored draft (the user pressed "save" in Telegram or "confirm all"). */
export async function confirmDraft(userId: string, messageId: string) {
  const msg = await getImported(userId, messageId);
  const d = msg.parsed as SmsDraft;
  if (!draftReady(d)) throw new Invalid('Draft is incomplete');
  return confirmImported(userId, messageId, { type: d.type!, amount: d.amount!, accountId: d.accountId!, categoryId: d.categoryId!, occurredAt: d.occurredAt ?? undefined, comment: d.comment });
}

/** Confirms every pending draft that is complete and has no possible duplicate. */
export async function confirmAllReady(userId: string) {
  const rows = (await pool.query("SELECT id, parsed FROM imported_messages WHERE user_id=$1 AND status='pending' ORDER BY created_at", [userId])).rows;
  let confirmed = 0; let skipped = 0;
  const created: Array<{ messageId: string; transactionId: string }> = [];
  for (const r of rows) {
    if (!draftReady(r.parsed) || (await findDuplicates(pool, userId, r.parsed)).length) { skipped++; continue; }
    try { created.push({ messageId: r.id, transactionId: await confirmDraft(userId, r.id) }); confirmed++; } catch { skipped++; }
  }
  return { confirmed, skipped, created };
}

export async function ignoreImported(userId: string, messageId: string) {
  const r = await pool.query("UPDATE imported_messages SET status='ignored', updated_at=now() WHERE id=$1 AND user_id=$2 AND status='pending'", [messageId, userId]);
  if (!r.rowCount) throw new NotFound('Pending message not found');
}

// ---------- attachments ----------

export async function addAttachment(userId: string, transactionId: string, input: { filename: string; mimeType: string; dataBase64: string }) {
  const t = (await pool.query('SELECT 1 FROM transactions WHERE id=$1 AND user_id=$2', [transactionId, userId])).rowCount;
  if (!t) throw new NotFound('Transaction not found');
  const data = Buffer.from(input.dataBase64, 'base64');
  if (data.length === 0 || data.length > 8 * 1024 * 1024) throw new Invalid('File must be between 1 byte and 8 MB');
  const r = await pool.query('INSERT INTO attachments (user_id, transaction_id, filename, mime_type, size_bytes, data) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [userId, transactionId, input.filename.slice(0, 200), input.mimeType, data.length, data]);
  return r.rows[0].id as string;
}
export async function listAttachments(userId: string, transactionId: string) {
  return (await pool.query('SELECT id, filename, mime_type AS "mimeType", size_bytes AS size, created_at AS "createdAt" FROM attachments WHERE transaction_id=$1 AND user_id=$2 ORDER BY created_at', [transactionId, userId])).rows;
}
export async function getAttachment(userId: string, id: string) {
  const r = (await pool.query('SELECT filename, mime_type, data FROM attachments WHERE id=$1 AND user_id=$2', [id, userId])).rows[0];
  if (!r) throw new NotFound('Attachment not found');
  return r as { filename: string; mime_type: string; data: Buffer };
}
export async function deleteAttachment(userId: string, id: string) {
  const r = await pool.query('DELETE FROM attachments WHERE id=$1 AND user_id=$2', [id, userId]);
  if (!r.rowCount) throw new NotFound('Attachment not found');
}

// ---------- export / backup ----------

export async function exportAll(userId: string) {
  const q = async (sql: string) => (await pool.query(sql, [userId])).rows;
  const serialize = (rows: any[]) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])));
  return {
    format: 'groshi-ok-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: serialize(await q('SELECT base_currency, language, timezone FROM settings WHERE user_id=$1')),
    accounts: serialize(await q('SELECT * FROM accounts WHERE user_id=$1 ORDER BY created_at')),
    categories: serialize(await q('SELECT * FROM categories WHERE user_id=$1 ORDER BY created_at')),
    projects: serialize(await q('SELECT * FROM projects WHERE user_id=$1 ORDER BY created_at')),
    transfers: serialize(await q('SELECT * FROM transfers WHERE user_id=$1 ORDER BY occurred_at')),
    transactions: serialize(await q('SELECT * FROM transactions WHERE user_id=$1 ORDER BY occurred_at')),
    exchangeRates: serialize(await q('SELECT * FROM exchange_rates WHERE user_id=$1 ORDER BY rate_date')),
    importedMessages: serialize(await q('SELECT * FROM imported_messages WHERE user_id=$1 ORDER BY created_at')),
    auditLog: serialize(await q('SELECT * FROM audit_log WHERE user_id=$1 ORDER BY id')),
  };
}

export async function exportCsv(userId: string) {
  const cur = await currencies();
  const rows = (await pool.query(
    `SELECT t.occurred_at, t.type, a.name AS account, t.amount_minor, t.currency, c.name AS category, p.name AS project, t.comment, t.details, t.id, t.transfer_id
       FROM transactions t JOIN accounts a ON a.id=t.account_id LEFT JOIN categories c ON c.id=t.category_id LEFT JOIN projects p ON p.id=t.project_id
      WHERE t.user_id=$1 AND t.deleted_at IS NULL ORDER BY t.occurred_at`,
    [userId],
  )).rows;
  const esc = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const sign = (t: string) => (t === 'expense' || t === 'transfer_out' ? -1n : 1n);
  const lines = ['date;type;account;amount;currency;category;project;comment;details;id;transfer_id'];
  for (const r of rows) {
    const amt = r.type === 'correction' ? r.amount_minor : r.amount_minor * sign(r.type);
    lines.push([new Date(r.occurred_at).toISOString(), r.type, r.account, formatMinor(amt, cur[r.currency].decimals), r.currency, r.category, r.project, r.comment, r.details, r.id, r.transfer_id].map(esc).join(';'));
  }
  return '﻿' + lines.join('\n') + '\n';
}

export async function auditLog(userId: string, limit = 200) {
  return (await pool.query('SELECT id, entity, entity_id AS "entityId", action, before, after, created_at AS "createdAt" FROM audit_log WHERE user_id=$1 ORDER BY id DESC LIMIT $2', [userId, limit])).rows
    .map((r) => ({ ...r, id: String(r.id) }));
}
