// Development only: a fake TALKO MCP server (port 4100, key "test-talko-key-123456") to try TALKO mode without touching real CRM data.
// Run from the server folder: node scripts/dev-fake-talko.mjs
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
const accounts = [
  { id: 'a1', name: 'Приват', type: 'card', currency: 'UAH', balance: 20021, openingBalance: 22419 },
  { id: 'a2', name: 'Моно', type: 'card', currency: 'UAH', balance: 43189, openingBalance: 93535 },
  { id: 'a3', name: 'Дом', type: 'cash', currency: 'UAH', balance: 17800, openingBalance: 17800 },
  { id: 'a4', name: 'БанкА', type: 'bank', currency: 'USD', balance: 264825.56, openingBalance: 264825.56 },
];
const cats = [
  { id: 'pers', name: 'Особисті витрати', type: 'expense', parentId: '' }, { id: 'food', name: 'Продукти', type: 'expense', parentId: 'pers' },
  { id: 'cafe', name: 'Кафе-ресторан', type: 'expense', parentId: 'pers' }, { id: 'health', name: "Здоров'я", type: 'expense', parentId: 'pers' },
  { id: 'pv5', name: 'Витрати ПВ-5', type: 'expense', parentId: '' }, { id: 'inc', name: 'Особисті доходи', type: 'income', parentId: '' },
];
const today = new Date().toISOString().slice(0, 10);
const txs = [
  { id: 't1', type: 'expense', amount: 560, currency: 'UAH', amountBase: 560, baseCurrency: 'UAH', description: 'Mastak — свердло та піна', accountId: 'a1', categoryId: 'pv5', categoryName: 'Витрати ПВ-5', date: today + 'T00:00:00Z', counterparty: 'Mastak' },
  { id: 't2', type: 'expense', amount: 1250, currency: 'UAH', amountBase: 1250, baseCurrency: 'UAH', description: 'Подолог 800 + засіб 450', accountId: 'a2', categoryId: 'health', categoryName: "Здоров'я", date: today + 'T00:00:00Z' },
  { id: 't3', type: 'expense', amount: 110, currency: 'UAH', amountBase: 110, baseCurrency: 'UAH', description: 'Kaviarnia 1616', accountId: 'a1', categoryId: 'cafe', categoryName: 'Кафе-ресторан', date: '2026-11-10T00:00:00Z' },
];
const pendingTokens = new Set();
const json = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o) }] });
function build() {
  const s = new McpServer({ name: 'fake-talko', version: '1' });
  const reg = s.registerTool.bind(s);
  reg('talko_whoami', { inputSchema: {} }, async () => json({ companyId: 'c', companyName: 'Правильний вибір (тест)', baseCurrency: 'UAH', role: 'owner' }));
  reg('talko_list_finance_accounts', { inputSchema: { activeOnly: z.boolean().optional() } }, async () => json({ accounts, baseCurrency: 'UAH', totalsByCurrency: { UAH: accounts.filter((a) => a.currency === 'UAH').reduce((x, a) => x + a.balance, 0), USD: 264825.56 }, totalBase: 11000000 }));
  reg('talko_list_finance_categories', { inputSchema: {} }, async () => json({ categories: cats }));
  reg('talko_list_projects', { inputSchema: { mode: z.string().optional(), rawList: z.boolean().optional(), status: z.string().optional(), limit: z.number().optional() } }, async () => json({ projects: [{ id: 'p5', name: 'ПВ-5' }, { id: 'p3', name: 'ПВ-3' }] }));
  reg('talko_list_finance_transactions', { inputSchema: { dateFrom: z.string().optional(), dateTo: z.string().optional(), type: z.string().optional(), query: z.string().optional(), limit: z.number().optional(), cursor: z.string().optional(), accountId: z.string().optional(), categoryId: z.string().optional(), projectId: z.string().optional() } },
    async (a) => json({ transactions: txs.filter((t) => (!a.dateFrom || t.date.slice(0, 10) >= a.dateFrom) && (!a.dateTo || t.date.slice(0, 10) <= a.dateTo) && (!a.type || t.type === a.type) && (!a.query || t.description.toLowerCase().includes(a.query.toLowerCase()))), hasMore: false }));
  reg('talko_add_transaction', { inputSchema: { type: z.string(), amount: z.number(), accountId: z.string(), categoryId: z.string(), description: z.string(), date: z.string().optional(), projectId: z.string().optional(), confirmationToken: z.string().optional() } }, async (a) => {
    if (!a.confirmationToken) { const tok = 'tok' + Math.random(); pendingTokens.add(tok); return json({ needsConfirmation: true, confirmationToken: tok, preview: `Записати ${a.type === 'expense' ? 'витрату' : 'дохід'} ${a.amount} грн, рахунок ${accounts.find((x) => x.id === a.accountId).name}, стаття ${cats.find((c) => c.id === a.categoryId).name}?` }); }
    if (!pendingTokens.delete(a.confirmationToken)) return { ...json({ ok: false, code: 'BAD_TOKEN', message: 'invalid token' }), isError: true };
    const acc = accounts.find((x) => x.id === a.accountId); acc.balance = Math.round((acc.balance + (a.type === 'expense' ? -a.amount : a.amount)) * 100) / 100;
    const c = cats.find((x) => x.id === a.categoryId);
    txs.unshift({ id: 't' + Date.now(), type: a.type, amount: a.amount, currency: acc.currency, amountBase: a.amount, baseCurrency: 'UAH', description: a.description, accountId: a.accountId, categoryId: a.categoryId, categoryName: c.name, date: (a.date ?? today) + 'T00:00:00Z' });
    return json({ ok: true, id: txs[0].id });
  });
  reg('talko_transfer_between_accounts', { inputSchema: { fromAccountId: z.string(), toAccountId: z.string(), amount: z.number(), amountTo: z.number().optional(), description: z.string().optional(), dryRun: z.boolean().optional(), confirmationToken: z.string().optional() } }, async (a) => {
    if (a.dryRun) return json({ dryRun: true });
    const f = accounts.find((x) => x.id === a.fromAccountId), t = accounts.find((x) => x.id === a.toAccountId);
    f.balance -= a.amount; t.balance += a.amountTo ?? a.amount; return json({ ok: true, transferId: 'tr' + Date.now() });
  });
  return s;
}
const app = express(); app.use(express.json());
app.post('/mcp', async (req, res) => {
  if (req.headers.authorization !== 'Bearer test-talko-key-123456') return res.status(401).json({ error: 'unauthorized' });
  const s = build(); const tr = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { tr.close(); s.close(); }); await s.connect(tr); await tr.handleRequest(req, res, req.body);
});
app.listen(4100, () => console.log('fake TALKO on 4100'));
