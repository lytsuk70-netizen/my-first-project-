/**
 * Ledger service: every operation that changes money goes through here.
 * Each operation runs in a single database transaction and writes an audit record.
 */
import type pg from 'pg';
import { pool, withTx, audit, type Db } from '../db.js';
import { parseAmount, formatMinor, parseRate, impliedRate, convertMinor, MoneyError, Decimal } from '../engine/money.js';
import { RateBook, type RateRow } from '../engine/rates.js';

export class NotFound extends Error {}
export class Invalid extends Error {}

// ---------- reference data ----------

let currencyCache: Record<string, { decimals: number; symbol: string; name_uk: string; name_en: string }> | null = null;
export async function currencies() {
  if (!currencyCache) {
    const rows = (await pool.query('SELECT code, decimals, symbol, name_uk, name_en FROM currencies ORDER BY code')).rows;
    currencyCache = Object.fromEntries(rows.map((r) => [r.code, { decimals: r.decimals, symbol: r.symbol, name_uk: r.name_uk, name_en: r.name_en }]));
  }
  return currencyCache!;
}
export async function dec(code: string): Promise<number> {
  const c = (await currencies())[code];
  if (!c) throw new Invalid(`Unknown currency ${code}`);
  return c.decimals;
}

export async function getSettings(userId: string) {
  const r = await pool.query('SELECT base_currency, language, timezone FROM settings WHERE user_id = $1', [userId]);
  return (r.rows[0] ?? { base_currency: 'UAH', language: 'uk', timezone: 'Europe/Kyiv' }) as { base_currency: string; language: 'uk' | 'en'; timezone: string };
}

async function loadAccount(c: Db, userId: string, id: string, lock = false) {
  const r = await c.query(`SELECT * FROM accounts WHERE id = $1 AND user_id = $2 ${lock ? 'FOR UPDATE' : ''}`, [id, userId]);
  if (!r.rows[0]) throw new NotFound('Account not found');
  return r.rows[0];
}

export async function rateBook(userId: string, c: Db = pool): Promise<RateBook> {
  const rows = (await c.query(
    `SELECT to_char(rate_date, 'YYYY-MM-DD') AS rate_date, base, quote, rate, source, created_at::text FROM exchange_rates WHERE user_id = $1`,
    [userId],
  )).rows as RateRow[];
  return new RateBook(rows);
}

const today = () => new Date().toISOString().slice(0, 10);

// ---------- accounts ----------

export async function listAccounts(userId: string, includeArchived = true) {
  const settings = await getSettings(userId);
  const book = await rateBook(userId);
  const cur = await currencies();
  const rows = (await pool.query(
    `SELECT a.*, b.balance_minor,
            (SELECT count(*) FROM transactions t WHERE t.account_id = a.id AND t.deleted_at IS NULL)::int AS tx_count
       FROM accounts a JOIN account_balances b ON b.account_id = a.id
      WHERE a.user_id = $1 ${includeArchived ? '' : 'AND NOT a.is_archived'}
      ORDER BY a.is_archived, a.sort_order, a.created_at`,
    [userId],
  )).rows;
  const base = settings.base_currency;
  return rows.map((a) => {
    const d = cur[a.currency].decimals;
    const conv = book.convert(a.balance_minor, a.currency, d, base, cur[base].decimals, today());
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      currency: a.currency,
      balance: formatMinor(a.balance_minor, d),
      initialBalance: formatMinor(a.initial_balance_minor, d),
      baseValue: conv ? formatMinor(conv.minor, cur[base].decimals) : null,
      baseRate: conv ? conv.rate.rate.toDecimalPlaces(6).toString() : null,
      baseRateDate: conv?.rate.date ?? null,
      baseRateApproximate: conv?.rate.approximate ?? false,
      description: a.description,
      smsKeywords: a.sms_keywords,
      isArchived: a.is_archived,
      sortOrder: a.sort_order,
      txCount: a.tx_count,
      createdAt: a.created_at,
      updatedAt: a.updated_at,
    };
  });
}

export async function createAccount(userId: string, input: { name: string; type: string; currency: string; initialBalance: string; description?: string; smsKeywords?: string }) {
  const d = await dec(input.currency);
  const initial = parseAmount(input.initialBalance || '0', d, { allowNegative: true, allowZero: true });
  return withTx(async (c) => {
    const order = (await c.query('SELECT COALESCE(max(sort_order), 0) + 1 AS n FROM accounts WHERE user_id = $1', [userId])).rows[0].n;
    const r = await c.query(
      `INSERT INTO accounts (user_id, name, type, currency, initial_balance_minor, description, sms_keywords, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [userId, input.name.trim(), input.type, input.currency, initial, input.description ?? '', input.smsKeywords ?? '', order],
    );
    await audit(c, userId, 'account', r.rows[0].id, 'create', null, r.rows[0]);
    return r.rows[0].id as string;
  });
}

export async function updateAccount(userId: string, id: string, input: { name?: string; type?: string; currency?: string; initialBalance?: string; description?: string; smsKeywords?: string; isArchived?: boolean; sortOrder?: number }) {
  return withTx(async (c) => {
    const before = await loadAccount(c, userId, id, true);
    const currency = input.currency ?? before.currency;
    const d = await dec(currency);
    const initial = input.initialBalance !== undefined ? parseAmount(input.initialBalance || '0', d, { allowNegative: true, allowZero: true }) : before.initial_balance_minor;
    const r = await c.query(
      `UPDATE accounts SET name = $3, type = $4, currency = $5, initial_balance_minor = $6, description = $7, sms_keywords = $8, is_archived = $9, sort_order = $10
        WHERE id = $1 AND user_id = $2 RETURNING *`,
      [id, userId, (input.name ?? before.name).trim(), input.type ?? before.type, currency, initial, input.description ?? before.description,
        input.smsKeywords ?? before.sms_keywords, input.isArchived ?? before.is_archived, input.sortOrder ?? before.sort_order],
    );
    await audit(c, userId, 'account', id, 'update', before, r.rows[0]);
  });
}

/** Set the account to an actual balance by recording a correction transaction for the difference. */
export async function correctBalance(userId: string, id: string, actualBalance: string, comment = '') {
  return withTx(async (c) => {
    const acc = await loadAccount(c, userId, id, true);
    const d = await dec(acc.currency);
    const target = parseAmount(actualBalance, d, { allowNegative: true, allowZero: true });
    const current = (await c.query('SELECT balance_minor FROM account_balances WHERE account_id = $1', [id])).rows[0].balance_minor as bigint;
    const delta = target - current;
    if (delta === 0n) return null;
    const r = await c.query(
      `INSERT INTO transactions (user_id, type, account_id, amount_minor, currency, occurred_at, comment)
       VALUES ($1, 'correction', $2, $3, $4, now(), $5) RETURNING *`,
      [userId, id, delta, acc.currency, comment || 'Коригування балансу'],
    );
    await audit(c, userId, 'transaction', r.rows[0].id, 'balance_correction', { balance: formatMinor(current, d) }, { balance: formatMinor(target, d), delta: formatMinor(delta, d) });
    return r.rows[0].id as string;
  });
}

// ---------- income / expense transactions ----------

export interface TxInput {
  type: 'income' | 'expense';
  accountId: string;
  amount: string;
  categoryId: string;
  projectId?: string | null;
  occurredAt?: string;
  comment?: string;
  details?: string;
  source?: 'manual' | 'voice' | 'sms' | 'duplicate' | 'telegram' | 'webhook' | 'monobank' | 'claude';
}

async function checkCategory(c: Db, userId: string, categoryId: string, type: string) {
  const r = await c.query('SELECT type FROM categories WHERE id = $1 AND user_id = $2', [categoryId, userId]);
  if (!r.rows[0]) throw new NotFound('Category not found');
  if (r.rows[0].type !== type) throw new Invalid('Category type does not match the transaction type');
}

export async function createTransaction(userId: string, input: TxInput, c?: pg.PoolClient): Promise<string> {
  const run = async (cl: pg.PoolClient) => {
    const acc = await loadAccount(cl, userId, input.accountId, true);
    if (acc.is_archived) throw new Invalid('Account is archived');
    await checkCategory(cl, userId, input.categoryId, input.type);
    const minor = parseAmount(input.amount, await dec(acc.currency));
    const r = await cl.query(
      `INSERT INTO transactions (user_id, type, account_id, amount_minor, currency, category_id, project_id, occurred_at, comment, details, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [userId, input.type, acc.id, minor, acc.currency, input.categoryId, input.projectId || null,
        input.occurredAt ? new Date(input.occurredAt) : new Date(), (input.comment ?? '').trim(), (input.details ?? '').trim(), input.source ?? 'manual'],
    );
    await audit(cl, userId, 'transaction', r.rows[0].id, 'create', null, r.rows[0]);
    return r.rows[0].id as string;
  };
  return c ? run(c) : withTx(run);
}

export async function updateTransaction(userId: string, id: string, input: Partial<TxInput>) {
  return withTx(async (c) => {
    const before = (await c.query('SELECT * FROM transactions WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE', [id, userId])).rows[0];
    if (!before) throw new NotFound('Transaction not found');
    if (before.type === 'transfer_in' || before.type === 'transfer_out') throw new Invalid('Edit transfers through the transfer endpoint');
    if (before.type === 'correction') throw new Invalid('Balance corrections cannot be edited; delete and create a new correction');
    const type = input.type ?? before.type;
    const accountId = input.accountId ?? before.account_id;
    const acc = await loadAccount(c, userId, accountId, true);
    const categoryId = input.categoryId ?? before.category_id;
    await checkCategory(c, userId, categoryId, type);
    const minor = input.amount !== undefined ? parseAmount(input.amount, await dec(acc.currency)) : before.amount_minor;
    if (input.amount === undefined && acc.currency !== before.currency) throw new Invalid('Changing to an account in another currency requires re-entering the amount');
    const r = await c.query(
      `UPDATE transactions SET type=$3, account_id=$4, amount_minor=$5, currency=$6, category_id=$7, project_id=$8, occurred_at=$9, comment=$10, details=$11
        WHERE id=$1 AND user_id=$2 RETURNING *`,
      [id, userId, type, acc.id, minor, acc.currency, categoryId, input.projectId === undefined ? before.project_id : input.projectId || null,
        input.occurredAt ? new Date(input.occurredAt) : before.occurred_at, input.comment ?? before.comment, input.details ?? before.details],
    );
    await audit(c, userId, 'transaction', id, 'update', before, r.rows[0]);
  });
}

/** Soft delete: the record is kept (deleted_at) for audit and can be restored. */
export async function deleteTransaction(userId: string, id: string) {
  return withTx(async (c) => {
    const before = (await c.query('SELECT * FROM transactions WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE', [id, userId])).rows[0];
    if (!before) throw new NotFound('Transaction not found');
    if (before.transfer_id) throw new Invalid('Delete transfers through the transfer endpoint');
    await c.query('UPDATE transactions SET deleted_at = now() WHERE id = $1', [id]);
    await audit(c, userId, 'transaction', id, 'delete', before, null);
  });
}

export async function restoreTransaction(userId: string, id: string) {
  return withTx(async (c) => {
    const before = (await c.query('SELECT * FROM transactions WHERE id = $1 AND user_id = $2 AND deleted_at IS NOT NULL AND transfer_id IS NULL', [id, userId])).rows[0];
    if (!before) throw new NotFound('Deleted transaction not found');
    await c.query('UPDATE transactions SET deleted_at = NULL WHERE id = $1', [id]);
    await audit(c, userId, 'transaction', id, 'restore', before, { ...before, deleted_at: null });
  });
}

export async function duplicateTransaction(userId: string, id: string) {
  const t = (await pool.query('SELECT * FROM transactions WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [id, userId])).rows[0];
  if (!t) throw new NotFound('Transaction not found');
  if (t.type !== 'income' && t.type !== 'expense') throw new Invalid('Only income and expenses can be duplicated');
  return createTransaction(userId, {
    type: t.type, accountId: t.account_id, amount: formatMinor(t.amount_minor, await dec(t.currency)), categoryId: t.category_id,
    projectId: t.project_id, comment: t.comment, details: t.details, occurredAt: new Date().toISOString(), source: 'duplicate',
  });
}

// ---------- transfers ----------

export interface TransferInput {
  fromAccountId: string;
  toAccountId: string;
  amountSent: string;
  amountReceived?: string; // if omitted it is calculated from the rate
  rate?: string;
  rateBase?: string; // currency for "1 base = rate quote"
  occurredAt?: string;
  comment?: string;
}

async function resolveTransfer(c: pg.PoolClient, userId: string, input: TransferInput) {
  if (input.fromAccountId === input.toAccountId) throw new Invalid('Source and destination accounts must differ');
  // lock in a stable order to avoid deadlocks
  const [a1, a2] = [input.fromAccountId, input.toAccountId].sort();
  await loadAccount(c, userId, a1, true);
  await loadAccount(c, userId, a2, true);
  const from = await loadAccount(c, userId, input.fromAccountId);
  const to = await loadAccount(c, userId, input.toAccountId);
  const fd = await dec(from.currency);
  const td = await dec(to.currency);
  const sent = parseAmount(input.amountSent, fd);
  let received: bigint;
  let rate: Decimal;
  let base: string;
  let quote: string;
  if (from.currency === to.currency) {
    base = from.currency; quote = to.currency; rate = new Decimal(1);
    received = input.amountReceived ? parseAmount(input.amountReceived, td) : sent;
    if (received !== sent) throw new Invalid('Same-currency transfer must receive the amount sent (rate 1)');
  } else {
    base = input.rateBase && [from.currency, to.currency].includes(input.rateBase) ? input.rateBase : from.currency;
    quote = base === from.currency ? to.currency : from.currency;
    if (input.amountReceived) {
      received = parseAmount(input.amountReceived, td);
      rate = input.rate ? parseRate(input.rate) : impliedRate({ minor: sent, currency: from.currency, decimals: fd }, { minor: received, currency: to.currency, decimals: td }, base);
    } else if (input.rate) {
      rate = parseRate(input.rate);
      received = convertMinor(sent, { currency: from.currency, decimals: fd }, { currency: to.currency, decimals: td }, { base, quote, rate });
      if (received <= 0n) throw new Invalid('Received amount rounds to zero');
    } else throw new Invalid('Exchange rate or received amount is required for a currency exchange');
  }
  return { from, to, sent, received, rate, base, quote };
}

async function writeTransferLegs(c: pg.PoolClient, userId: string, transferId: string, r: Awaited<ReturnType<typeof resolveTransfer>>, occurredAt: Date, comment: string) {
  await c.query(
    `INSERT INTO transactions (user_id, type, account_id, amount_minor, currency, transfer_id, occurred_at, comment)
     VALUES ($1,'transfer_out',$2,$3,$4,$5,$6,$7), ($1,'transfer_in',$8,$9,$10,$5,$6,$7)`,
    [userId, r.from.id, r.sent, r.from.currency, transferId, occurredAt, comment, r.to.id, r.received, r.to.currency],
  );
  if (r.from.currency !== r.to.currency) {
    await c.query(
      `INSERT INTO exchange_rates (user_id, rate_date, base, quote, rate, source, transfer_id) VALUES ($1, $2::date, $3, $4, $5, 'transfer', $6)`,
      [userId, occurredAt.toISOString().slice(0, 10), r.base, r.quote, r.rate.toFixed(), transferId],
    );
  }
}

export async function createTransfer(userId: string, input: TransferInput) {
  return withTx(async (c) => {
    const r = await resolveTransfer(c, userId, input);
    if (r.from.is_archived || r.to.is_archived) throw new Invalid('Account is archived');
    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
    const comment = (input.comment ?? '').trim();
    const t = await c.query(
      `INSERT INTO transfers (user_id, from_account_id, to_account_id, amount_sent_minor, amount_received_minor, rate, rate_base, rate_quote, occurred_at, comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [userId, r.from.id, r.to.id, r.sent, r.received, r.rate.toFixed(), r.base, r.quote, occurredAt, comment],
    );
    await writeTransferLegs(c, userId, t.rows[0].id, r, occurredAt, comment);
    await audit(c, userId, 'transfer', t.rows[0].id, 'create', null, t.rows[0]);
    return t.rows[0].id as string;
  });
}

/** Edits a transfer as one logical operation: both legs are replaced atomically. */
export async function updateTransfer(userId: string, id: string, input: TransferInput) {
  return withTx(async (c) => {
    const before = (await c.query('SELECT * FROM transfers WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE', [id, userId])).rows[0];
    if (!before) throw new NotFound('Transfer not found');
    const r = await resolveTransfer(c, userId, input);
    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : before.occurred_at;
    const comment = (input.comment ?? before.comment).trim();
    await c.query('DELETE FROM exchange_rates WHERE transfer_id = $1', [id]);
    await c.query('DELETE FROM transactions WHERE transfer_id = $1', [id]);
    const t = await c.query(
      `UPDATE transfers SET from_account_id=$3, to_account_id=$4, amount_sent_minor=$5, amount_received_minor=$6, rate=$7, rate_base=$8, rate_quote=$9,
              occurred_at=$10, comment=$11, updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *`,
      [id, userId, r.from.id, r.to.id, r.sent, r.received, r.rate.toFixed(), r.base, r.quote, occurredAt, comment],
    );
    await writeTransferLegs(c, userId, id, r, occurredAt, comment);
    await audit(c, userId, 'transfer', id, 'update', before, t.rows[0]);
  });
}

export async function deleteTransfer(userId: string, id: string) {
  return withTx(async (c) => {
    const before = (await c.query('SELECT * FROM transfers WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE', [id, userId])).rows[0];
    if (!before) throw new NotFound('Transfer not found');
    await c.query('UPDATE transfers SET deleted_at = now() WHERE id = $1', [id]);
    await c.query('UPDATE transactions SET deleted_at = now() WHERE transfer_id = $1', [id]);
    await c.query('DELETE FROM exchange_rates WHERE transfer_id = $1', [id]);
    await audit(c, userId, 'transfer', id, 'delete', before, null);
  });
}

export async function listTransfers(userId: string, opts: { deleted?: boolean; limit?: number } = {}) {
  const cur = await currencies();
  const rows = (await pool.query(
    `SELECT tr.*, fa.name AS from_name, fa.currency AS from_currency, ta.name AS to_name, ta.currency AS to_currency
       FROM transfers tr JOIN accounts fa ON fa.id = tr.from_account_id JOIN accounts ta ON ta.id = tr.to_account_id
      WHERE tr.user_id = $1 AND (tr.deleted_at IS ${opts.deleted ? 'NOT ' : ''}NULL)
      ORDER BY tr.occurred_at DESC LIMIT $2`,
    [userId, opts.limit ?? 200],
  )).rows;
  return rows.map((t) => transferDto(t, cur));
}

export function transferDto(t: any, cur: Record<string, { decimals: number }>) {
  return {
    id: t.id,
    fromAccountId: t.from_account_id,
    fromAccountName: t.from_name,
    fromCurrency: t.from_currency,
    toAccountId: t.to_account_id,
    toAccountName: t.to_name,
    toCurrency: t.to_currency,
    amountSent: formatMinor(t.amount_sent_minor, cur[t.from_currency].decimals),
    amountReceived: formatMinor(t.amount_received_minor, cur[t.to_currency].decimals),
    rate: new Decimal(t.rate).toString(),
    rateBase: t.rate_base,
    rateQuote: t.rate_quote,
    occurredAt: t.occurred_at,
    comment: t.comment,
    deletedAt: t.deleted_at,
  };
}

// ---------- net worth ----------

export async function netWorth(userId: string, date = today()) {
  const settings = await getSettings(userId);
  const base = settings.base_currency as string;
  const cur = await currencies();
  const book = await rateBook(userId);
  const rows = (await pool.query(
    `SELECT a.currency, sum(b.balance_minor)::bigint AS total
       FROM accounts a JOIN account_balances b ON b.account_id = a.id
      WHERE a.user_id = $1 AND NOT a.is_archived GROUP BY a.currency ORDER BY a.currency`,
    [userId],
  )).rows;
  let total = 0n;
  const missing: string[] = [];
  const byCurrency = rows.map((r) => {
    const conv = book.convert(BigInt(r.total), r.currency, cur[r.currency].decimals, base, cur[base].decimals, date);
    if (conv) total += conv.minor; else missing.push(r.currency);
    return {
      currency: r.currency,
      balance: formatMinor(BigInt(r.total), cur[r.currency].decimals),
      baseValue: conv ? formatMinor(conv.minor, cur[base].decimals) : null,
      rate: conv ? conv.rate.rate.toDecimalPlaces(6).toString() : null,
      rateDate: conv?.rate.date ?? null,
      approximate: conv?.rate.approximate ?? false,
    };
  });
  return { baseCurrency: base, total: formatMinor(total, cur[base].decimals), complete: missing.length === 0, missingRates: missing, byCurrency, date };
}

export { MoneyError };
