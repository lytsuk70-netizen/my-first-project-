/** TALKO mode: the app reads and writes through TALKO's MCP API (here an in-memory fake TALKO). */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL_3 ?? 'postgres://finance:finance@localhost:5432/finance_test3';
process.env.APP_SECRET = 'test-secret-talko';
const { pool } = await import('../src/db.ts');
const { migrate } = await import('../src/migrate.ts');
const { createApp } = await import('../src/app.ts');
const TK = await import('../src/integrations/talko.ts');

// ---- fake TALKO ----
const calls: Array<{ name: string; args: any }> = [];
const accounts = [
  { id: 'acc_privat', name: 'Приват', type: 'card', currency: 'UAH', balance: 20021, openingBalance: 22419 },
  { id: 'acc_usd', name: 'БанкА', type: 'bank', currency: 'USD', balance: 264825.56, openingBalance: 264825.56 },
];
const txs = Array.from({ length: 250 }, (_, i) => ({ id: `t${String(i).padStart(3, '0')}`, type: i % 10 === 0 ? 'income' : 'expense', amount: 10.1, currency: 'UAH', amountBase: 10.1, baseCurrency: 'UAH', description: `op ${i}`, accountId: 'acc_privat', categoryId: i % 10 === 0 ? 'inc' : 'food', categoryName: i % 10 === 0 ? 'Особисті доходи' : 'Продукти', date: `2026-11-${String(1 + (i % 17)).padStart(2, '0')}T00:00:00Z` }));
const reply = (o: any, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(o) }], isError });
TK.setTalkoFactory(async (_url, key) => ({
  close: async () => {},
  callTool: async (name, args) => {
    calls.push({ name, args });
    if (key !== 'talko-key-1234567890') return reply({ ok: false, code: 'UNAUTHORIZED', message: 'Невірний ключ' }, true);
    switch (name) {
      case 'talko_whoami': return reply({ companyId: 'c1', companyName: 'Правильний вибір', baseCurrency: 'UAH', role: 'owner' });
      case 'talko_list_finance_accounts': return reply({ accounts, baseCurrency: 'UAH', totalsByCurrency: { UAH: 20021, USD: 264825.56 }, totalBase: 11000000 });
      case 'talko_list_finance_categories': return reply({ categories: [{ id: 'food', name: 'Продукти', type: 'expense', parentId: 'pers' }, { id: 'inc', name: 'Особисті доходи', type: 'income', parentId: '' }] });
      case 'talko_list_projects': return reply({ projects: [{ id: 'pv5', name: 'ПВ-5' }] });
      case 'talko_list_finance_transactions': {
        const start = args.cursor ? Number(args.cursor) : 0;
        const page = txs.slice(start, start + (args.limit ?? 100));
        return reply({ transactions: page, hasMore: start + page.length < txs.length, nextCursor: String(start + page.length) });
      }
      case 'talko_add_transaction':
        if (!args.confirmationToken) return reply({ needsConfirmation: true, confirmationToken: 'tok-1', preview: `Витрата ${args.amount} UAH` });
        assert.equal(args.confirmationToken, 'tok-1');
        return reply({ ok: true, id: 'new-tx' });
      case 'talko_transfer_between_accounts':
        if (args.dryRun) return reply({ dryRun: true, before: 20021, after: 19021 });
        return reply({ ok: true, transferId: 'tr-1' });
      default: return reply({ ok: false, code: 'UNKNOWN', message: 'unknown tool' }, true);
    }
  },
}));

let base = ''; let cookie = ''; let server: any;
async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'groshi-ok', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
  return { status: res.status, data: await res.json() } as any;
}
const ok = async (m: string, p: string, b?: unknown) => { const r = await api(m, p, b); assert.ok(r.status < 300, `${m} ${p} -> ${r.status} ${JSON.stringify(r.data)}`); return r.data; };

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(false);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await ok('POST', '/auth/register', { email: 'me@example.com', password: 'secret123' });
});
after(async () => { server.close(); await pool.end(); });

test('connect: bad key rejected, good key switches the app to TALKO and hides the key', async () => {
  assert.equal((await api('POST', '/talko/connect', { url: 'http://evil.example.com/mcp', apiKey: 'talko-key-1234567890' })).status, 400); // https only
  assert.equal((await api('POST', '/talko/connect', { url: 'https://talko.example.com/mcp', apiKey: 'wrong-key-1234567890' })).status, 400);
  const st = await ok('POST', '/talko/connect', { url: 'https://talko.example.com/mcp', apiKey: 'talko-key-1234567890' });
  assert.equal(st.companyName, 'Правильний вибір');
  assert.equal((await ok('GET', '/settings')).data_source, 'talko');
  const raw = (await pool.query("SELECT secret_enc FROM integrations WHERE kind='talko'")).rows[0].secret_enc;
  assert.ok(!raw.includes('talko-key'));
  assert.ok(!JSON.stringify(await ok('GET', '/talko/status')).includes('talko-key'));
});

test('reads: accounts with exact decimals, all pages of operations newest first, report', async () => {
  const a = await ok('GET', '/talko/accounts');
  assert.deepEqual(a.accounts.map((x: any) => x.balance), ['20021.00', '264825.56']);
  assert.deepEqual(a.totalsByCurrency, { UAH: '20021.00', USD: '264825.56' });
  const t = await ok('GET', '/talko/transactions?from=2026-11-01&to=2026-11-30');
  assert.equal(t.items.length, 250); // two pages merged
  assert.ok(t.items[0].occurredAt >= t.items[249].occurredAt);
  const r = await ok('GET', '/talko/report?from=2026-11-01&to=2026-11-30');
  assert.equal(r.expense.total, '2272.50'); // 225 × 10.10 exactly
  assert.equal(r.income.total, '252.50');
  assert.equal(r.expense.byCategory[0].name, 'Продукти');
});

test('writes: nothing is recorded in TALKO without the second, confirmed call', async () => {
  calls.length = 0;
  const p = await ok('POST', '/talko/transactions', { type: 'expense', amount: '560', accountId: 'acc_privat', categoryId: 'food', description: 'Mastak' });
  assert.equal(p.status, 'needs_confirmation');
  assert.equal(p.confirmationToken, 'tok-1');
  const s = await ok('POST', '/talko/transactions', { type: 'expense', amount: '560', accountId: 'acc_privat', categoryId: 'food', description: 'Mastak', confirmationToken: p.confirmationToken });
  assert.equal(s.status, 'saved');
  assert.equal(calls.filter((c) => c.name === 'talko_add_transaction').length, 2);
  const tp = await ok('POST', '/talko/transfers', { fromAccountId: 'acc_privat', toAccountId: 'acc_usd', amount: '1000', amountTo: '23.80' });
  assert.equal(tp.status, 'needs_confirmation');
  assert.equal(calls.at(-1)!.args.dryRun, true);
  const ts = await ok('POST', '/talko/transfers', { fromAccountId: 'acc_privat', toAccountId: 'acc_usd', amount: '1000', amountTo: '23.80', confirmationToken: tp.confirmationToken });
  assert.equal(ts.status, 'saved');
  assert.equal(calls.at(-1)!.args.amountTo, 23.8);
  assert.equal((await api('POST', '/talko/transactions', { type: 'expense', amount: '-5', accountId: 'acc_privat', categoryId: 'food' })).status, 400);
});

test('disconnect returns the app to local mode', async () => {
  await ok('DELETE', '/talko');
  assert.equal((await ok('GET', '/settings')).data_source, 'local');
  assert.equal((await api('GET', '/talko/accounts')).status, 400);
});
