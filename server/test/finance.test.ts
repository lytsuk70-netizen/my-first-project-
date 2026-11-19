/**
 * End-to-end financial validation against a real PostgreSQL database (TEST_DATABASE_URL).
 * Every scenario goes through the HTTP API exactly like the web app does.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://finance:finance@localhost:5432/finance_test';
const { pool } = await import('../src/db.ts');
const { migrate } = await import('../src/migrate.ts');
const { createApp } = await import('../src/app.ts');

let base = '';
let cookie = '';
let server: ReturnType<ReturnType<typeof createApp>['listen']>;

async function api(method: string, path: string, body?: unknown, opts: { raw?: boolean; noHeader?: boolean } = {}) {
  const res = await fetch(base + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(opts.noHeader ? {} : { 'X-Requested-With': 'groshi-ok' }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data: data as any };
}
const ok = async (method: string, path: string, body?: unknown) => {
  const r = await api(method, path, body);
  assert.ok(r.status < 300, `${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};
const balances = async () => Object.fromEntries((await ok('GET', '/accounts')).map((a: any) => [a.name, a.balance]));
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

let acc: Record<string, string> = {};
let cat: Record<string, string> = {};

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(false);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { server.close(); await pool.end(); });

test('auth: setup, CSRF guard and session', async () => {
  assert.equal((await api('GET', '/accounts')).status, 401);
  const me = await ok('GET', '/auth/me');
  assert.equal(me.needsSetup, true);
  assert.equal((await api('POST', '/auth/register', { email: 'me@example.com', password: 'secret123' }, { noHeader: true })).status, 415);
  await ok('POST', '/auth/register', { email: 'me@example.com', password: 'secret123', timezone: 'UTC' });
  assert.equal((await api('POST', '/auth/register', { email: 'x@example.com', password: 'secret123' })).status, 403);
  const cats = await ok('GET', '/categories');
  assert.ok(cats.length >= 10);
  for (const c of cats) cat[`${c.type}:${c.name}`] = c.id;
});

test('accounts with own currency and initial balance', async () => {
  for (const [name, type, currency, initialBalance] of [
    ['Privat UAH', 'card', 'UAH', '10000'], ['Mono UAH', 'card', 'UAH', '5000'], ['Bank USD', 'bank', 'USD', '2000'], ['Bank EUR', 'bank', 'EUR', '0'], ['Cash UAH', 'cash', 'UAH', '0'],
  ]) acc[name] = (await ok('POST', '/accounts', { name, type, currency, initialBalance })).id;
  assert.deepEqual(await balances(), { 'Privat UAH': '10000.00', 'Mono UAH': '5000.00', 'Bank USD': '2000.00', 'Bank EUR': '0.00', 'Cash UAH': '0.00' });
  assert.equal((await api('POST', '/accounts', { name: 'Privat UAH', type: 'card', currency: 'UAH' })).status, 409);
});

let expenseId = '';
test('expense subtracts, income adds', async () => {
  expenseId = (await ok('POST', '/transactions', { type: 'expense', accountId: acc['Mono UAH'], amount: '1250.50', categoryId: cat['expense:Ресторани'], comment: 'Вечеря' })).id;
  await ok('POST', '/transactions', { type: 'income', accountId: acc['Privat UAH'], amount: '20000', categoryId: cat['income:Зарплата'] });
  const b = await balances();
  assert.equal(b['Mono UAH'], '3749.50');
  assert.equal(b['Privat UAH'], '30000.00');
});

test('validation: precision, category type, unknown account', async () => {
  assert.equal((await api('POST', '/transactions', { type: 'expense', accountId: acc['Mono UAH'], amount: '1.234', categoryId: cat['expense:Їжа'] })).status, 400);
  assert.equal((await api('POST', '/transactions', { type: 'expense', accountId: acc['Mono UAH'], amount: '10', categoryId: cat['income:Зарплата'] })).status, 400);
  assert.equal((await api('POST', '/transactions', { type: 'expense', accountId: '00000000-0000-4000-8000-000000000000', amount: '10', categoryId: cat['expense:Їжа'] })).status, 404);
  assert.equal((await api('POST', '/transactions', { type: 'expense', accountId: acc['Mono UAH'], amount: '-5', categoryId: cat['expense:Їжа'] })).status, 400);
  assert.equal((await balances())['Mono UAH'], '3749.50');
});

test('decimal precision: 0.10 + 0.20 = 0.30 exactly', async () => {
  await ok('POST', '/transactions', { type: 'expense', accountId: acc['Cash UAH'], amount: '0.10', categoryId: cat['expense:Їжа'] });
  await ok('POST', '/transactions', { type: 'expense', accountId: acc['Cash UAH'], amount: '0.20', categoryId: cat['expense:Їжа'] });
  assert.equal((await balances())['Cash UAH'], '-0.30');
});

let usdTransfer = '';
test('transfer $1,000 USD -> UAH at 41.50 = 41,500 UAH, one linked record', async () => {
  usdTransfer = (await ok('POST', '/transfers', { fromAccountId: acc['Bank USD'], toAccountId: acc['Privat UAH'], amountSent: '1000', rate: '41.50', rateBase: 'USD' })).id;
  const b = await balances();
  assert.equal(b['Bank USD'], '1000.00');
  assert.equal(b['Privat UAH'], '71500.00');
  const t = (await ok('GET', '/transfers')).find((x: any) => x.id === usdTransfer);
  assert.equal(t.amountSent, '1000.00');
  assert.equal(t.amountReceived, '41500.00');
  assert.equal(t.rate, '41.5');
  // one item in the feed, recorded as the transfer's exchange rate
  const feed = await ok('GET', '/transactions?kinds=transfer');
  assert.equal(feed.items.length, 1);
  const rates = await ok('GET', '/rates');
  assert.ok(rates.some((r: any) => r.source === 'transfer' && r.base === 'USD' && r.rate === '41.5'));
});

test('transfer UAH -> EUR with actual received amount; implied rate stored', async () => {
  const id = (await ok('POST', '/transfers', { fromAccountId: acc['Privat UAH'], toAccountId: acc['Bank EUR'], amountSent: '45000', amountReceived: '1000', rateBase: 'EUR' })).id;
  const t = (await ok('GET', '/transfers')).find((x: any) => x.id === id);
  assert.equal(t.rate, '45');
  const b = await balances();
  assert.equal(b['Privat UAH'], '26500.00');
  assert.equal(b['Bank EUR'], '1000.00');
});

test('same-currency transfer uses rate 1; same account is rejected', async () => {
  await ok('POST', '/transfers', { fromAccountId: acc['Privat UAH'], toAccountId: acc['Cash UAH'], amountSent: '500' });
  const b = await balances();
  assert.equal(b['Privat UAH'], '26000.00');
  assert.equal(b['Cash UAH'], '499.70');
  assert.equal((await api('POST', '/transfers', { fromAccountId: acc['Cash UAH'], toAccountId: acc['Cash UAH'], amountSent: '1' })).status, 400);
  assert.equal((await api('POST', '/transfers', { fromAccountId: acc['Bank USD'], toAccountId: acc['Cash UAH'], amountSent: '1' })).status, 400); // rate required
});

test('transfers are never counted as income or expenses', async () => {
  const r = await ok('GET', `/reports?from=${today}&to=${today}`);
  assert.equal(r.expense.total, '1250.80');
  assert.equal(r.income.total, '20000.00');
});

test('editing a transfer updates both sides atomically', async () => {
  await ok('PUT', `/transfers/${usdTransfer}`, { fromAccountId: acc['Bank USD'], toAccountId: acc['Privat UAH'], amountSent: '1000', rate: '42', rateBase: 'USD' });
  const b = await balances();
  assert.equal(b['Bank USD'], '1000.00');
  assert.equal(b['Privat UAH'], '26500.00'); // +500 UAH difference
  // failed edit (same account) leaves everything unchanged
  assert.equal((await api('PUT', `/transfers/${usdTransfer}`, { fromAccountId: acc['Bank USD'], toAccountId: acc['Bank USD'], amountSent: '1' })).status, 400);
  assert.equal((await balances())['Privat UAH'], '26500.00');
});

test('editing and deleting transactions recalculates balances', async () => {
  await ok('PUT', `/transactions/${expenseId}`, { amount: '1000' });
  assert.equal((await balances())['Mono UAH'], '4000.00');
  await ok('PUT', `/transactions/${expenseId}`, { accountId: acc['Privat UAH'] });
  let b = await balances();
  assert.equal(b['Mono UAH'], '5000.00');
  assert.equal(b['Privat UAH'], '25500.00');
  // moving to a USD account without re-entering amount is refused
  assert.equal((await api('PUT', `/transactions/${expenseId}`, { accountId: acc['Bank USD'] })).status, 400);
  await ok('DELETE', `/transactions/${expenseId}`);
  assert.equal((await balances())['Privat UAH'], '26500.00');
  await ok('POST', `/transactions/${expenseId}/restore`);
  assert.equal((await balances())['Privat UAH'], '25500.00');
  const dupe = await ok('POST', `/transactions/${expenseId}/duplicate`);
  assert.ok(dupe.id);
  assert.equal((await balances())['Privat UAH'], '24500.00');
  await ok('DELETE', `/transactions/${dupe.id}`);
});

test('deleting a transfer reverses both accounts', async () => {
  await ok('DELETE', `/transfers/${usdTransfer}`);
  const b = await balances();
  assert.equal(b['Bank USD'], '2000.00');
  assert.equal(b['Privat UAH'], '-16500.00');
  assert.equal((await ok('GET', '/transfers?deleted=true')).length, 1);
});

test('balance correction is recorded and excluded from reports', async () => {
  const { transactionId } = await ok('POST', `/accounts/${acc['Mono UAH']}/correct`, { actualBalance: '4800' });
  assert.ok(transactionId);
  assert.equal((await balances())['Mono UAH'], '4800.00');
  const r = await ok('GET', `/reports?from=${today}&to=${today}`);
  assert.equal(r.expense.total, '1000.30');
  const feed = await ok('GET', '/transactions?kinds=correction');
  assert.equal(feed.items[0].amount, '-200.00');
});

test('net worth converts each currency explicitly and flags missing rates', async () => {
  let nw = await ok('GET', '/net-worth');
  assert.equal(nw.complete, false);
  assert.deepEqual(nw.missingRates.sort(), ['USD']); // EUR has a transfer rate; deleted USD transfer rate is gone
  await ok('POST', '/rates', { date: today, base: 'USD', quote: 'UAH', rate: '41.80' });
  nw = await ok('GET', '/net-worth');
  assert.equal(nw.complete, true);
  // UAH: -16500 + 4800 + 499.70 = -11200.30 ; USD 2000*41.80 = 83600 ; EUR 1000*45 = 45000
  assert.equal(nw.total, '117399.70');
});

test('historical values use the rate of the transaction date and never change', async () => {
  const yesterday = daysAgo(1).slice(0, 10);
  await ok('POST', '/rates', { date: yesterday, base: 'USD', quote: 'UAH', rate: '40' });
  await ok('POST', '/transactions', { type: 'expense', accountId: acc['Bank USD'], amount: '10', categoryId: cat['expense:Транспорт'], occurredAt: daysAgo(1) });
  const r1 = await ok('GET', `/reports?from=${yesterday}&to=${yesterday}`);
  assert.equal(r1.expense.total, '400.00');
  await ok('POST', '/rates', { date: today, base: 'USD', quote: 'UAH', rate: '50' });
  const r2 = await ok('GET', `/reports?from=${yesterday}&to=${yesterday}`);
  assert.equal(r2.expense.total, '400.00');
  const feed = await ok('GET', `/transactions?currency=USD&kinds=expense`);
  assert.equal(feed.items[0].amount, '10.00');
  assert.equal(r2.expense.byAccount[0].original[0].amount, '10.00');
});

test('archived category stays in historical reports; unused one is deleted', async () => {
  const res = await ok('DELETE', `/categories/${cat['expense:Транспорт']}`);
  assert.equal(res.result, 'archived');
  const yesterday = daysAgo(1).slice(0, 10);
  const r = await ok('GET', `/reports?from=${yesterday}&to=${yesterday}`);
  assert.equal(r.expense.byCategory[0].archived, true);
  const fresh = (await ok('POST', '/categories', { name: 'Тест', type: 'expense' })).id;
  assert.equal((await ok('DELETE', `/categories/${fresh}`)).result, 'deleted');
});

test('reports: categories, percentages, averages, comparison', async () => {
  const from = daysAgo(1).slice(0, 10);
  const r = await ok('GET', `/reports?from=${from}&to=${today}`);
  assert.equal(r.expense.total, '1400.30'); // 1000.30 today + 400 yesterday
  const sum = r.expense.byCategory.reduce((s: number, c: any) => s + c.percent, 0);
  assert.ok(Math.abs(sum - 100) < 0.05);
  assert.equal(r.expense.avgDaily, '700.15');
  assert.ok(r.expense.largest.length > 0);
  const m = await ok('GET', '/reports/monthly?months=3');
  assert.equal(m.months.length, 3);
  const s = await ok('GET', '/summary?type=expense');
  assert.equal(s.today, '1000.30');
  assert.equal(s.yesterday, '400.00');
});

test('feed filters and search', async () => {
  const byComment = await ok('GET', '/transactions?q=' + encodeURIComponent('Вечеря'));
  assert.equal(byComment.items.length, 1);
  const byAmount = await ok('GET', '/transactions?q=1000');
  assert.ok(byAmount.items.some((i: any) => i.amount === '1000.00'));
  const byAccount = await ok('GET', `/transactions?accountId=${acc['Bank EUR']}`);
  assert.equal(byAccount.items.length, 1); // the incoming transfer
  assert.equal(byAccount.items[0].kind, 'transfer');
});

test('archived account rejects new operations but keeps balance', async () => {
  await ok('PUT', `/accounts/${acc['Bank EUR']}`, { isArchived: true });
  assert.equal((await api('POST', '/transfers', { fromAccountId: acc['Privat UAH'], toAccountId: acc['Bank EUR'], amountSent: '100', rate: '45', rateBase: 'EUR' })).status, 400);
  assert.equal((await balances())['Bank EUR'], '1000.00');
  await ok('PUT', `/accounts/${acc['Bank EUR']}`, { isArchived: false });
});

test('voice parsing never saves; it returns a draft', async () => {
  const before = (await ok('GET', '/transactions')).items.length;
  const d = await ok('POST', '/parse/voice', { text: 'Spent 1,250 hryvnias at a restaurant using Mono' });
  assert.equal(d.type, 'expense');
  assert.equal(d.amount, '1250');
  assert.equal(d.currency, 'UAH');
  assert.equal(d.accountId, acc['Mono UAH']);
  assert.equal(d.categoryId, cat['expense:Ресторани']);
  assert.deepEqual(d.missing, []);
  const amb = await ok('POST', '/parse/voice', { text: 'заплатив 100 і 200' });
  assert.ok(amb.missing.includes('amount'));
  assert.equal((await ok('GET', '/transactions')).items.length, before);
});

test('SMS import: parse, duplicate detection, confirm once', async () => {
  await ok('PUT', `/accounts/${acc['Privat UAH']}`, { smsKeywords: '*4321' });
  const sms = 'Сплата 250.00UAH Картка *4321 SILPO KYIV 18.11.2026 14:32 Бал. 2285.00UAH';
  const [m] = await ok('POST', '/import/messages', { text: sms, tzOffsetMinutes: 0 });
  assert.equal(m.draft.amount, '250.00');
  assert.equal(m.draft.accountId, acc['Privat UAH']);
  assert.equal(m.draft.balance, '2285.00');
  assert.equal(m.duplicates.length, 0);
  await ok('POST', `/import/messages/${m.id}/confirm`, { type: 'expense', accountId: m.draft.accountId, amount: m.draft.amount, categoryId: m.draft.categoryId, occurredAt: m.draft.occurredAt, comment: m.draft.comment });
  assert.equal((await api('POST', `/import/messages/${m.id}/confirm`, { type: 'expense', accountId: m.draft.accountId, amount: m.draft.amount, categoryId: m.draft.categoryId })).status, 400);
  const [again] = await ok('POST', '/import/messages', { text: sms, tzOffsetMinutes: 0 });
  assert.equal(again.alreadyImported, true);
  assert.equal(again.status, 'imported');
  const [similar] = await ok('POST', '/import/messages', { text: 'Card payment 250.00 UAH *4321 at 18.11.2026 14:35. Balance 2035 UAH', tzOffsetMinutes: 0 });
  assert.equal(similar.duplicates.length, 1);
});

test('audit trail and export', async () => {
  const log = await ok('GET', '/audit');
  assert.ok(log.some((e: any) => e.entity === 'transfer' && e.action === 'update'));
  assert.ok(log.some((e: any) => e.action === 'balance_correction'));
  const backup = await ok('GET', '/export/json');
  assert.equal(backup.format, 'groshi-ok-backup');
  assert.ok(backup.transactions.length > 5);
  const csv = await api('GET', '/export/csv');
  assert.match(csv.data, /date;type;account;amount/);
});

test('balance formula holds for every account', async () => {
  const accounts = await ok('GET', '/accounts');
  const { rows } = await pool.query(`
    SELECT a.id, a.initial_balance_minor
      + COALESCE((SELECT sum(amount_minor) FROM transactions WHERE account_id=a.id AND deleted_at IS NULL AND type='income'),0)
      - COALESCE((SELECT sum(amount_minor) FROM transactions WHERE account_id=a.id AND deleted_at IS NULL AND type='expense'),0)
      + COALESCE((SELECT sum(amount_received_minor) FROM transfers WHERE to_account_id=a.id AND deleted_at IS NULL),0)
      - COALESCE((SELECT sum(amount_sent_minor) FROM transfers WHERE from_account_id=a.id AND deleted_at IS NULL),0)
      + COALESCE((SELECT sum(amount_minor) FROM transactions WHERE account_id=a.id AND deleted_at IS NULL AND type='correction'),0) AS expected
    FROM accounts a`);
  for (const r of rows) {
    const a = accounts.find((x: any) => x.id === r.id);
    assert.equal(BigInt(a.balance.replace('.', '')), BigInt(r.expected), a.name);
  }
});

test('legacy browser time zone names are normalised', async () => {
  const s = await ok('PUT', '/settings', { timezone: 'Europe/Kiev' });
  assert.equal(s.timezone, 'Europe/Kyiv');
  assert.equal((await api('PUT', '/settings', { timezone: 'Mars/Olympus' })).status, 400);
  await ok('GET', '/summary?type=expense');
});
