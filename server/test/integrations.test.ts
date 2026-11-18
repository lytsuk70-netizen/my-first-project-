/**
 * Voice commands, Telegram bot, monobank sync, SMS webhook and Excel import/export.
 * External APIs are replaced by an in-memory fake; everything else runs against PostgreSQL.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import ExcelJS from 'exceljs';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL_2 ?? 'postgres://finance:finance@localhost:5432/finance_test2';
process.env.APP_SECRET = 'test-secret-for-integrations';
const { pool } = await import('../src/db.ts');
const { migrate } = await import('../src/migrate.ts');
const { createApp } = await import('../src/app.ts');
const { setFetch } = await import('../src/integrations/http.ts');
const TG = await import('../src/integrations/telegram.ts');
const MONO = await import('../src/integrations/monobank.ts');

let base = ''; let cookie = '';
let server: any;
async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(base + '/api' + path, {
    method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'groshi-ok', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
  const ct = res.headers.get('content-type') ?? '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) } as any;
}
const ok = async (m: string, p: string, b?: unknown) => { const r = await api(m, p, b); assert.ok(r.status < 300, `${m} ${p} -> ${r.status} ${JSON.stringify(r.data)}`); return r.data; };
const balances = async () => Object.fromEntries((await ok('GET', '/accounts')).map((a: any) => [a.name, a.balance]));

// ---------- fake external APIs ----------
const sent: any[] = [];
const files: Record<string, Buffer> = { 'photo-1': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) };
const now = Math.floor(Date.now() / 1000);
const monoStatement = [
  { id: 'm1', time: now - 3600, description: 'Сільпо', mcc: 5411, amount: -45050, currencyCode: 980, balance: 1000000, comment: '' },
  { id: 'm2', time: now - 1800, description: 'Uklon', mcc: 4121, amount: -18900, currencyCode: 980, balance: 981100 },
  { id: 'm3', time: now - 600, description: 'Від: Іван П.', mcc: 4829, amount: 200000, currencyCode: 980, balance: 1181100 },
];
setFetch(async (url: string, init?: any) => {
  const json = (status: number, body: any) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0) });
  if (url.startsWith('https://api.telegram.org/file/')) {
    const buf = files['photo-1'];
    return { ok: true, status: 200, json: async () => ({}), text: async () => '', arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
  }
  if (url.startsWith('https://api.telegram.org/')) {
    const method = url.split('/').pop()!;
    const params = init?.body ? JSON.parse(init.body) : {};
    sent.push({ method, params });
    if (url.includes('/botBAD')) return json(401, { ok: false, description: 'Unauthorized' });
    if (method === 'getMe') return json(200, { ok: true, result: { id: 1, username: 'my_groshi_bot', first_name: 'Гроші' } });
    if (method === 'getUpdates') return new Promise(() => {}); // never resolves; poller idles
    if (method === 'getFile') return json(200, { ok: true, result: { file_id: params.file_id, file_path: 'photos/1.jpg', file_size: 7 } });
    return json(200, { ok: true, result: { message_id: 999 } });
  }
  if (url.startsWith('https://api.monobank.ua/personal/client-info')) {
    if (init?.headers?.['X-Token'] !== 'mono-token-123456789012345') return json(403, { errorDescription: 'Unknown X-Token' });
    return json(200, { name: 'Test User', accounts: [{ id: 'acc-uah', currencyCode: 980, maskedPan: ['537541******1234'], type: 'black', balance: 1181100, iban: 'UA00' }, { id: 'acc-usd', currencyCode: 840, maskedPan: ['537541******5678'], type: 'black', balance: 5000 }] });
  }
  if (url.startsWith('https://api.monobank.ua/personal/statement/acc-uah/')) return json(200, monoStatement);
  if (url.startsWith('https://api.monobank.ua/personal/statement/')) return json(200, []);
  return json(404, {});
});

let acc: Record<string, string> = {};
let cat: Record<string, string> = {};
const userId = async () => (await pool.query('SELECT id FROM users LIMIT 1')).rows[0].id as string;

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(false);
  MONO.setStatementGap(10);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await ok('POST', '/auth/register', { email: 'me@example.com', password: 'secret123', timezone: 'Europe/Kyiv' });
  for (const [name, currency, initialBalance] of [['Mono UAH', 'UAH', '1000'], ['Privat UAH', 'UAH', '5000'], ['Bank USD', 'USD', '2000']]) {
    acc[name] = (await ok('POST', '/accounts', { name, type: 'card', currency, initialBalance })).id;
  }
  for (const c of await ok('GET', '/categories')) cat[`${c.type}:${c.name}`] = c.id;
});
after(async () => { server.close(); TG.stopPoller(await userId()); await pool.end(); });

// ---------- voice ----------
test('voice: questions are answered from real data', async () => {
  await ok('POST', '/transactions', { type: 'expense', accountId: acc['Mono UAH'], amount: '120', categoryId: cat['expense:Ресторани'] });
  const r = await ok('POST', '/voice/command', { text: 'скільки я витратив сьогодні' });
  assert.equal(r.command.intent, 'total');
  assert.match(r.answer, /120 гривень/);
  const b = await ok('POST', '/voice/command', { text: 'який баланс на моно' });
  assert.equal(b.answer, 'На рахунку Mono UAH 880 гривень.');
  const cat2 = await ok('POST', '/voice/command', { text: 'скільки витратив на ресторани цього місяця?' });
  assert.match(cat2.answer, /«Ресторани» 120 гривень/);
});

test('voice: transfers, navigation and expenses are only drafts', async () => {
  const before = await balances();
  const t = await ok('POST', '/voice/command', { text: 'переведи 100 доларів з Bank USD на Приват за курсом 41,5' });
  assert.deepEqual([t.command.intent, t.command.fromAccountId, t.command.toAccountId, t.command.amount, t.command.rate], ['transfer', acc['Bank USD'], acc['Privat UAH'], '100', '41.5']);
  assert.equal((await ok('POST', '/voice/command', { text: 'відкрий звіти' })).command.target, 'reports');
  const e = await ok('POST', '/voice/command', { text: 'витратив 200 на таксі з моно' });
  assert.equal(e.command.draft.categoryId, cat['expense:Транспорт']);
  assert.deepEqual(await balances(), before);
});

// ---------- SMS webhook ----------
test('SMS webhook: token auth, inbox draft, no auto-save', async () => {
  const { token } = await ok('POST', '/integrations/webhook');
  const before = await balances();
  const r = await fetch(`${base}/api/hooks/ingest/${token}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'Privat: Сплата 99.90UAH Картка *4321 ATB Бал. 4900.10UAH' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.amount, '99.90');
  const again = await (await fetch(`${base}/api/hooks/ingest/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Privat: Сплата 99.90UAH Картка *4321 ATB Бал. 4900.10UAH' }) })).json();
  assert.equal(again.duplicate, true);
  assert.equal((await fetch(`${base}/api/hooks/ingest/wrong-token-wrong-token-xx`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x 1 UAH' })).status, 404);
  assert.deepEqual(await balances(), before);
  assert.equal((await ok('GET', '/import/count')).pending, 1);
  const st = await ok('GET', '/integrations');
  assert.equal(st.webhook.received, 1);
});

// ---------- Telegram ----------
let chatId = 555;
test('Telegram: bad token rejected, token encrypted at rest', async () => {
  assert.equal((await api('POST', '/integrations/telegram', { token: 'not-a-token' })).status, 400);
  const st = await ok('POST', '/integrations/telegram', { token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk' });
  assert.equal(st.username, 'my_groshi_bot');
  assert.match(st.linkUrl, /^https:\/\/t\.me\/my_groshi_bot\?start=[0-9a-f]{8}$/);
  const raw = (await pool.query("SELECT secret_enc FROM integrations WHERE kind='telegram'")).rows[0].secret_enc;
  assert.ok(!raw.includes('ABCDEFGHIJ'));
  const all = await ok('GET', '/integrations');
  assert.ok(!JSON.stringify(all).includes('ABCDEFGHIJ'));
});

test('Telegram: only a chat with the link code is accepted', async () => {
  const uid = await userId();
  const bot = new TG.Bot('123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk');
  sent.length = 0;
  await TG.handleUpdate(uid, bot, { update_id: 1, message: { message_id: 1, chat: { id: 777, first_name: 'Stranger' }, text: 'витратив 100 на таксі з моно' } });
  assert.match(sent[0].params.text, /приватний бот/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM imported_messages WHERE source=$1', ['telegram'])).rows[0].n, 0);
  const code = (await ok('GET', '/integrations')).telegram.linkCode;
  await TG.handleUpdate(uid, bot, { update_id: 2, message: { message_id: 2, chat: { id: chatId, first_name: 'Me' }, text: `/start ${code}` } });
  assert.match(sent.at(-1).params.text, /Підключено/);
  assert.equal((await ok('GET', '/integrations')).telegram.chats.length, 1);
  assert.equal((await ok('GET', '/integrations')).telegram.linkCode, null); // single use
});

test('Telegram: forwarded bank SMS -> draft -> buttons -> saved', async () => {
  const uid = await userId();
  const bot = new TG.Bot('123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk');
  sent.length = 0;
  await TG.handleUpdate(uid, bot, { update_id: 3, message: { message_id: 3, chat: { id: chatId }, text: 'Покупка 350.00 UAH. Аптека Доброго дня. Баланс 4550.10 UAH' } });
  const msg = sent.find((s) => s.method === 'sendMessage');
  // account unknown -> account buttons offered
  const buttons = msg.params.reply_markup.inline_keyboard.flat();
  const privatBtn = buttons.find((b: any) => b.text === 'Privat UAH');
  assert.ok(privatBtn, 'account buttons');
  sent.length = 0;
  await TG.handleUpdate(uid, bot, { update_id: 4, callback_query: { id: 'cb1', data: privatBtn.callback_data, message: { message_id: 999, chat: { id: chatId } } } });
  const edited = sent.find((s) => s.method === 'editMessageText');
  const save = edited.params.reply_markup.inline_keyboard.flat().find((b: any) => /Записати/.test(b.text));
  assert.ok(save, 'category was recognised (Аптека → Здоровʼя) so Save is offered');
  const before = (await balances())['Privat UAH'];
  await TG.handleUpdate(uid, bot, { update_id: 5, callback_query: { id: 'cb2', data: save.callback_data, message: { message_id: 999, chat: { id: chatId } } } });
  assert.equal(before, '5000.00');
  assert.equal((await balances())['Privat UAH'], '4650.00');
  // pressing again does nothing
  await TG.handleUpdate(uid, bot, { update_id: 6, callback_query: { id: 'cb3', data: save.callback_data, message: { message_id: 999, chat: { id: chatId } } } });
  assert.equal((await balances())['Privat UAH'], '4650.00');
});

test('Telegram: questions and receipt photos', async () => {
  const uid = await userId();
  const bot = new TG.Bot('123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk');
  sent.length = 0;
  await TG.handleUpdate(uid, bot, { update_id: 7, message: { message_id: 7, chat: { id: chatId }, text: 'баланс на моно' } });
  assert.match(sent[0].params.text, /Mono UAH 880 гривень/);
  // photo with a caption -> draft with receipt -> confirm -> attachment stored
  sent.length = 0;
  await TG.handleUpdate(uid, bot, { update_id: 8, message: { message_id: 8, chat: { id: chatId }, caption: 'купив продукти 250 моно', photo: [{ file_id: 'small' }, { file_id: 'photo-1' }] } });
  const save = sent.find((s) => s.method === 'sendMessage').params.reply_markup.inline_keyboard.flat().find((b: any) => /Записати/.test(b.text));
  await TG.handleUpdate(uid, bot, { update_id: 9, callback_query: { id: 'cb4', data: save.callback_data, message: { message_id: 999, chat: { id: chatId } } } });
  const att = (await pool.query("SELECT a.size_bytes, a.mime_type, t.amount_minor FROM attachments a JOIN transactions t ON t.id=a.transaction_id")).rows;
  assert.equal(att.length, 1);
  assert.equal(att[0].mime_type, 'image/jpeg');
  assert.equal(att[0].amount_minor, 25000n);
  // photo without caption -> choose an operation -> attached
  sent.length = 0;
  await TG.handleUpdate(uid, bot, { update_id: 10, message: { message_id: 10, chat: { id: chatId }, photo: [{ file_id: 'photo-1' }] } });
  const pick = sent[0].params.reply_markup.inline_keyboard[0][0];
  await TG.handleUpdate(uid, bot, { update_id: 11, callback_query: { id: 'cb5', data: pick.callback_data, message: { message_id: 999, chat: { id: chatId } } } });
  assert.equal((await pool.query('SELECT count(*)::int n FROM attachments')).rows[0].n, 2);
});

// ---------- monobank ----------
test('monobank: token check, mapping by currency, sync into inbox, confirm all', async () => {
  assert.equal((await api('POST', '/integrations/monobank', { token: 'wrong-token-1234567890123' })).status, 400);
  const st = await ok('POST', '/integrations/monobank', { token: 'mono-token-123456789012345' });
  assert.equal(st.accounts.length, 2);
  assert.equal((await api('PUT', '/integrations/monobank/mapping', { mapping: { 'acc-usd': acc['Mono UAH'] } })).status, 400); // currency mismatch
  await ok('PUT', '/integrations/monobank/mapping', { mapping: { 'acc-uah': acc['Mono UAH'] } });
  const before = await balances();
  const r = await MONO.syncMonobank(await userId());
  assert.equal(r.added, 3);
  assert.equal((await MONO.syncMonobank(await userId())).added, 0); // idempotent
  assert.deepEqual(await balances(), before); // nothing saved automatically
  const inbox = await ok('GET', '/import/messages?status=pending');
  const silpo = inbox.find((m: any) => m.draft.comment === 'Сільпо');
  assert.equal(silpo.draft.categoryId, cat['expense:Їжа']); // MCC 5411
  assert.equal(silpo.draft.amount, '450.50');
  const income = inbox.find((m: any) => m.draft.type === 'income' && m.source === 'monobank');
  assert.equal(income.draft.amount, '2000.00');
  // income has no category -> stays pending on "confirm all"
  const res = await ok('POST', '/import/confirm-all');
  assert.ok(res.confirmed >= 2);
  assert.equal((await balances())['Mono UAH'], '-9.50'); // 880 - 250 (Telegram receipt) - 450.50 - 189.00
  assert.equal((await balances())['Privat UAH'], '4550.10'); // the ready webhook SMS draft (ATB, Privat) was confirmed too
  assert.ok((await ok('GET', '/import/messages?status=pending')).some((m: any) => m.id === income.id));
});

// ---------- Excel ----------
test('Excel export contains the report and operations', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const r = await api('GET', `/export/xlsx?from=${today.slice(0, 8)}01&to=${today}`);
  assert.equal(r.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.data);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Підсумки', 'Операції', 'Рахунки', 'Перекази']);
  const ops = wb.getWorksheet('Операції')!;
  const amounts = (ops.getColumn(4).values as any[]).slice(2).map(Number);
  assert.ok(amounts.includes(-450.5));
  assert.equal(wb.getWorksheet('Рахунки')!.rowCount, 4);
});

test('Excel import: preview validates, commit is atomic and creates missing items on request', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Операції');
  ws.addRow(['Дата', 'Тип', 'Рахунок', 'Сума', 'Валюта', 'Категорія', 'Проєкт', 'Коментар']);
  ws.addRow(['15.10.2026 10:30', 'Витрата', 'Privat UAH', 1500, 'UAH', 'Дім', 'Квартира', 'Оренда']);
  ws.addRow([new Date(Date.UTC(2026, 9, 16, 9, 0)), 'Дохід', 'Privat UAH', '2 000,50', '', 'Зарплата', '', '']);
  ws.addRow(['17.10.2026', 'Витрата', 'Готівка EUR', 20, 'EUR', 'Кава', '', 'нова категорія і рахунок']);
  ws.addRow(['18.10.2026', 'Витрата', 'Privat UAH', 'abc', 'UAH', 'Дім', '', 'погана сума']);
  ws.addRow(['19.10.2026', 'Переказ', 'Privat UAH', 100, 'UAH', '', '', '']);
  ws.addRow(['20.10.2026', 'Витрата', 'Privat UAH', 10, 'USD', 'Дім', '', 'валюта не та']);
  const dataBase64 = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
  const p = await ok('POST', '/import/excel/preview', { filename: 'ops.xlsx', dataBase64, tzOffsetMinutes: -180 });
  assert.equal(p.summary.total, 6);
  assert.equal(p.summary.valid, 3);
  assert.equal(p.summary.errors, 2);
  assert.equal(p.summary.skipped, 1);
  assert.deepEqual(p.summary.newAccounts, ['Готівка EUR (EUR)']);
  assert.equal(p.rows[0].date, '2026-10-15T07:30:00.000Z'); // Kyiv local time
  assert.equal(p.rows[1].amount, '2000.50');
  const before = (await balances())['Privat UAH'];
  assert.equal((await api('POST', '/import/excel/commit', { filename: 'ops.xlsx', dataBase64, tzOffsetMinutes: -180 })).status, 400); // needs createMissing
  assert.equal((await balances())['Privat UAH'], before);
  const c = await ok('POST', '/import/excel/commit', { filename: 'ops.xlsx', dataBase64, tzOffsetMinutes: -180, createMissing: true });
  assert.equal(c.imported, 3);
  assert.deepEqual(c.created, { accounts: 1, categories: 1, projects: 1 });
  const b = await balances();
  assert.equal(b['Privat UAH'], '5050.60'); // 4550.10 - 1500 + 2000.50
  assert.equal(b['Готівка EUR'], '-20.00');
  // re-import: everything is a duplicate and is skipped by default
  const again = await ok('POST', '/import/excel/commit', { filename: 'ops.xlsx', dataBase64, tzOffsetMinutes: -180, createMissing: true });
  assert.equal(again.imported, 0);
});

test('CSV import (own export format) and template download', async () => {
  const csv = '﻿date;type;account;amount;currency;category;project;comment\n2026-10-21T10:00:00Z;expense;Mono UAH;-12,40;UAH;Їжа;;"кава; булка"\n';
  const p = await ok('POST', '/import/excel/preview', { filename: 'x.csv', dataBase64: Buffer.from(csv).toString('base64') });
  assert.equal(p.summary.valid, 1);
  assert.equal(p.rows[0].amount, '12.40');
  assert.equal(p.rows[0].comment, 'кава; булка');
  const t = await api('GET', '/import/template.xlsx');
  assert.equal(t.status, 200);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(t.data);
  assert.equal(wb.worksheets[0].getRow(1).getCell(4).value, 'Сума');
});
