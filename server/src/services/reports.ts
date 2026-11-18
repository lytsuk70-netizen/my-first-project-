/**
 * Feed (unified history) and analytics. Everything is computed from stored transactions.
 * Transfers and balance corrections are never counted as income or expenses.
 * Cross-currency totals are converted to the base currency with the rate valid on each
 * transaction's date (historical value); original amounts are never modified.
 */
import { pool } from '../db.js';
import { formatMinor } from '../engine/money.js';
import { currencies, getSettings, rateBook, Invalid } from './ledger.js';

// ---------- feed ----------

export interface FeedFilter {
  kinds?: Array<'income' | 'expense' | 'transfer' | 'correction'>;
  accountId?: string;
  categoryId?: string;
  projectId?: string;
  currency?: string;
  from?: string;
  to?: string;
  q?: string;
  limit?: number;
  offset?: number;
  deleted?: boolean;
}

export async function feed(userId: string, f: FeedFilter) {
  const settings = await getSettings(userId);
  const cur = await currencies();
  const params: unknown[] = [userId, settings.timezone];
  const where: string[] = ['t.user_id = $1', "t.type <> 'transfer_in'", f.deleted ? 't.deleted_at IS NOT NULL' : 't.deleted_at IS NULL'];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };

  if (f.kinds?.length) {
    const types = f.kinds.flatMap((k) => (k === 'transfer' ? ['transfer_out'] : [k]));
    where.push(`t.type = ANY(${p(types)})`);
  }
  if (f.accountId) { const a = p(f.accountId); where.push(`(t.account_id = ${a} OR tr.to_account_id = ${a})`); }
  if (f.categoryId) {
    const c = p(f.categoryId);
    where.push(`(t.category_id = ${c} OR cat.parent_id = ${c})`);
  }
  if (f.projectId) where.push(`t.project_id = ${p(f.projectId)}`);
  if (f.currency) { const c = p(f.currency); where.push(`(t.currency = ${c} OR ta.currency = ${c})`); }
  if (f.from) where.push(`(t.occurred_at AT TIME ZONE $2)::date >= ${p(f.from)}::date`);
  if (f.to) where.push(`(t.occurred_at AT TIME ZONE $2)::date <= ${p(f.to)}::date`);
  if (f.q?.trim()) {
    const raw = f.q.trim();
    const like = p(`%${raw.replace(/[%_\\]/g, (m) => '\\' + m)}%`);
    const conds = [`t.comment ILIKE ${like}`, `t.details ILIKE ${like}`, `cat.name ILIKE ${like}`, `a.name ILIKE ${like}`, `ta.name ILIKE ${like}`, `pr.name ILIKE ${like}`];
    const num = raw.replace(/\s/g, '').replace(',', '.');
    if (/^\d+(\.\d+)?$/.test(num)) {
      conds.push(`(t.amount_minor::numeric / power(10, cu.decimals))::text LIKE ${p(num + '%')}`);
    }
    where.push(`(${conds.join(' OR ')})`);
  }
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
  const rows = (await pool.query(
    `SELECT t.*, a.name AS account_name, cat.name AS category_name, cat.icon AS category_icon, cat.color AS category_color,
            cat.is_archived AS category_archived, pr.name AS project_name,
            tr.amount_received_minor, tr.rate, tr.rate_base, tr.rate_quote, tr.to_account_id, ta.name AS to_account_name, ta.currency AS to_currency,
            (SELECT count(*) FROM attachments at WHERE at.transaction_id = t.id)::int AS attachment_count,
            to_char(t.occurred_at AT TIME ZONE $2, 'YYYY-MM-DD') AS local_date
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       JOIN currencies cu ON cu.code = t.currency
       LEFT JOIN categories cat ON cat.id = t.category_id
       LEFT JOIN projects pr ON pr.id = t.project_id
       LEFT JOIN transfers tr ON tr.id = t.transfer_id
       LEFT JOIN accounts ta ON ta.id = tr.to_account_id
      WHERE ${where.join(' AND ')}
      ORDER BY t.occurred_at DESC, t.created_at DESC
      LIMIT ${limit + 1} OFFSET ${Math.max(f.offset ?? 0, 0)}`,
    params,
  )).rows;
  const hasMore = rows.length > limit;
  return {
    items: rows.slice(0, limit).map((t) => ({
      id: t.id,
      kind: t.type === 'transfer_out' ? 'transfer' : t.type,
      type: t.type,
      accountId: t.account_id,
      accountName: t.account_name,
      amount: formatMinor(t.amount_minor, cur[t.currency].decimals),
      currency: t.currency,
      categoryId: t.category_id,
      categoryName: t.category_name,
      categoryIcon: t.category_icon,
      categoryColor: t.category_color,
      projectId: t.project_id,
      projectName: t.project_name,
      transferId: t.transfer_id,
      toAccountId: t.to_account_id,
      toAccountName: t.to_account_name,
      amountReceived: t.transfer_id ? formatMinor(t.amount_received_minor, cur[t.to_currency].decimals) : null,
      toCurrency: t.to_currency,
      rate: t.rate,
      rateBase: t.rate_base,
      rateQuote: t.rate_quote,
      occurredAt: t.occurred_at,
      localDate: t.local_date,
      comment: t.comment,
      details: t.details,
      source: t.source,
      attachmentCount: t.attachment_count,
      deletedAt: t.deleted_at,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    })),
    hasMore,
  };
}

// ---------- analytics ----------

const DAY = 86400000;
function addDays(d: string, n: number) { return new Date(Date.parse(d + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10); }
function daysBetween(a: string, b: string) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY) + 1; }
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface Row { id: string; type: 'income' | 'expense'; amount_minor: bigint; currency: string; local_date: string; local_month: string; local_hour: number;
  account_id: string; account_name: string; category_id: string; category_name: string; category_icon: string; category_color: string; category_archived: boolean;
  parent_id: string | null; project_id: string | null; project_name: string | null; comment: string; occurred_at: string }

async function loadRows(userId: string, tz: string, from: string, to: string): Promise<Row[]> {
  return (await pool.query(
    `SELECT t.id, t.type, t.amount_minor, t.currency, t.account_id, a.name AS account_name, t.category_id, c.name AS category_name, c.icon AS category_icon,
            c.color AS category_color, c.is_archived AS category_archived, c.parent_id, t.project_id, p.name AS project_name, t.comment, t.occurred_at,
            to_char(t.occurred_at AT TIME ZONE $2, 'YYYY-MM-DD') AS local_date,
            to_char(t.occurred_at AT TIME ZONE $2, 'YYYY-MM') AS local_month,
            extract(hour FROM t.occurred_at AT TIME ZONE $2)::int AS local_hour
       FROM transactions t JOIN accounts a ON a.id = t.account_id JOIN categories c ON c.id = t.category_id
       LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.user_id = $1 AND t.deleted_at IS NULL AND t.type IN ('income','expense')
        AND (t.occurred_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date`,
    [userId, tz, from, to],
  )).rows;
}

export async function report(userId: string, from: string, to: string) {
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) throw new Invalid('Invalid date range');
  const days = daysBetween(from, to);
  if (days > 3700) throw new Invalid('Date range too long');
  const settings = await getSettings(userId);
  const tz = settings.timezone;
  const base = settings.base_currency as string;
  const cur = await currencies();
  const bd = cur[base].decimals;
  const book = await rateBook(userId);
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(from, -days);
  const [rows, prevRows] = await Promise.all([loadRows(userId, tz, from, to), loadRows(userId, tz, prevFrom, prevTo)]);

  const missingRates = new Set<string>();
  let approximate = false;
  const toBase = (r: Row): bigint | null => {
    const conv = book.convert(r.amount_minor, r.currency, cur[r.currency].decimals, base, bd, r.local_date);
    if (!conv) { missingRates.add(r.currency); return null; }
    if (conv.rate.approximate) approximate = true;
    return conv.minor;
  };
  const fmt = (m: bigint) => formatMinor(m, bd);
  const pct = (part: bigint, total: bigint) => (total === 0n ? 0 : Number((part * 10000n) / total) / 100);

  // Days elapsed for averages: do not count future days of the current period.
  const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  const effectiveTo = to > todayLocal && from <= todayLocal ? todayLocal : to;
  const elapsedDays = Math.max(daysBetween(from, effectiveTo), 1);

  // trend granularity
  const granularity: 'hour' | 'day' | 'month' = days <= 1 ? 'hour' : days <= 92 ? 'day' : 'month';
  const buckets: string[] = [];
  if (granularity === 'hour') for (let h = 0; h < 24; h++) buckets.push(String(h).padStart(2, '0'));
  else if (granularity === 'day') for (let i = 0; i < days; i++) buckets.push(addDays(from, i));
  else { let m = from.slice(0, 7); while (m <= to.slice(0, 7)) { buckets.push(m); const [y, mo] = m.split('-').map(Number); m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; } }
  const bucketOf = (r: Row) => (granularity === 'hour' ? String(r.local_hour).padStart(2, '0') : granularity === 'day' ? r.local_date : r.local_month);

  const section = (type: 'income' | 'expense') => {
    const list = rows.filter((r) => r.type === type).map((r) => ({ r, base: toBase(r) }));
    const total = list.reduce((s, x) => s + (x.base ?? 0n), 0n);
    const group = <K extends string>(key: (r: Row) => K | null, meta: (r: Row) => Record<string, unknown>) => {
      const m = new Map<string, { total: bigint; count: number; meta: Record<string, unknown>; original: Map<string, bigint> }>();
      for (const { r, base: b } of list) {
        const k = key(r) ?? '__none__';
        if (!m.has(k)) m.set(k, { total: 0n, count: 0, meta: meta(r), original: new Map() });
        const g = m.get(k)!;
        g.total += b ?? 0n; g.count++;
        g.original.set(r.currency, (g.original.get(r.currency) ?? 0n) + r.amount_minor);
      }
      return [...m.entries()].sort((a, b) => (b[1].total > a[1].total ? 1 : b[1].total < a[1].total ? -1 : 0)).map(([id, g]) => ({
        id: id === '__none__' ? null : id, ...g.meta, total: fmt(g.total), percent: pct(g.total, total), count: g.count,
        original: [...g.original.entries()].map(([c, v]) => ({ currency: c, amount: formatMinor(v, cur[c].decimals) })),
      }));
    };
    const prevTotal = prevRows.filter((r) => r.type === type).reduce((s, r) => s + (toBase(r) ?? 0n), 0n);
    const trend = new Map(buckets.map((b) => [b, 0n]));
    for (const { r, base: b } of list) trend.set(bucketOf(r), (trend.get(bucketOf(r)) ?? 0n) + (b ?? 0n));
    return {
      total: fmt(total),
      count: list.length,
      avgDaily: fmt(total / BigInt(elapsedDays)),
      byCategory: group((r) => r.category_id, (r) => ({ name: r.category_name, icon: r.category_icon, color: r.category_color, archived: r.category_archived, parentId: r.parent_id })),
      byAccount: group((r) => r.account_id, (r) => ({ name: r.account_name, currency: r.currency })),
      byProject: group((r) => r.project_id, (r) => ({ name: r.project_name })),
      largest: list
        .sort((a, b) => ((b.base ?? 0n) > (a.base ?? 0n) ? 1 : (b.base ?? 0n) < (a.base ?? 0n) ? -1 : 0))
        .slice(0, 10)
        .map(({ r, base: b }) => ({
          id: r.id, amount: formatMinor(r.amount_minor, cur[r.currency].decimals), currency: r.currency, baseValue: b === null ? null : fmt(b),
          categoryName: r.category_name, categoryIcon: r.category_icon, accountName: r.account_name, comment: r.comment, occurredAt: r.occurred_at,
        })),
      previous: { from: prevFrom, to: prevTo, total: fmt(prevTotal), changePercent: prevTotal === 0n ? null : Number(((total - prevTotal) * 10000n) / prevTotal) / 100 },
      trend: buckets.map((b) => ({ bucket: b, total: fmt(trend.get(b) ?? 0n) })),
    };
  };

  const expense = section('expense');
  const income = section('income');
  return {
    baseCurrency: base, from, to, days, elapsedDays, granularity, timezone: tz,
    expense, income,
    net: fmt(rows.reduce((s, r) => s + (toBase(r) ?? 0n) * (r.type === 'income' ? 1n : -1n), 0n)),
    missingRates: [...missingRates], approximateRates: approximate,
  };
}

/** Totals for quick stats: today, yesterday, this month, previous month (base currency). */
export async function quickSummary(userId: string, type: 'income' | 'expense') {
  const settings = await getSettings(userId);
  const tz = settings.timezone;
  const base = settings.base_currency as string;
  const cur = await currencies();
  const book = await rateBook(userId);
  const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  const monthStart = todayLocal.slice(0, 8) + '01';
  const prevMonthStart = (() => { const [y, m] = todayLocal.split('-').map(Number); return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`; })();
  const rows = (await loadRows(userId, tz, prevMonthStart, todayLocal)).filter((r) => r.type === type);
  const yesterday = addDays(todayLocal, -1);
  const sums = { today: 0n, yesterday: 0n, month: 0n, prevMonth: 0n };
  const todayByCurrency = new Map<string, bigint>();
  const missing = new Set<string>();
  for (const r of rows) {
    const conv = book.convert(r.amount_minor, r.currency, cur[r.currency].decimals, base, cur[base].decimals, r.local_date);
    if (!conv) missing.add(r.currency);
    const v = conv?.minor ?? 0n;
    if (r.local_date === todayLocal) { sums.today += v; todayByCurrency.set(r.currency, (todayByCurrency.get(r.currency) ?? 0n) + r.amount_minor); }
    if (r.local_date === yesterday) sums.yesterday += v;
    if (r.local_date >= monthStart) sums.month += v; else sums.prevMonth += v;
  }
  const f = (m: bigint) => formatMinor(m, cur[base].decimals);
  return {
    baseCurrency: base,
    today: f(sums.today), yesterday: f(sums.yesterday), month: f(sums.month), prevMonth: f(sums.prevMonth),
    todayByCurrency: [...todayByCurrency.entries()].map(([c, v]) => ({ currency: c, amount: formatMinor(v, cur[c].decimals) })),
    missingRates: [...missing],
  };
}

/** Income vs expense per month for the last N months (base currency). */
export async function monthly(userId: string, months = 12) {
  const settings = await getSettings(userId);
  const tz = settings.timezone;
  const base = settings.base_currency as string;
  const cur = await currencies();
  const book = await rateBook(userId);
  const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  let [y, m] = todayLocal.split('-').map(Number);
  const list: string[] = [];
  for (let i = 0; i < months; i++) { list.unshift(`${y}-${String(m).padStart(2, '0')}`); m--; if (m === 0) { m = 12; y--; } }
  const rows = await loadRows(userId, tz, list[0] + '-01', todayLocal);
  const out = new Map(list.map((k) => [k, { income: 0n, expense: 0n }]));
  for (const r of rows) {
    const conv = book.convert(r.amount_minor, r.currency, cur[r.currency].decimals, base, cur[base].decimals, r.local_date);
    const g = out.get(r.local_month);
    if (g && conv) g[r.type] += conv.minor;
  }
  const f = (v: bigint) => formatMinor(v, cur[base].decimals);
  return { baseCurrency: base, months: list.map((k) => ({ month: k, income: f(out.get(k)!.income), expense: f(out.get(k)!.expense) })) };
}
