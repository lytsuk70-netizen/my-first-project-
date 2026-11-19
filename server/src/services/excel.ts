/**
 * Excel (.xlsx) export of reports and import of operations from Excel/CSV.
 * Import is two-step: preview (validation of every row) → commit (all valid rows in one DB transaction).
 */
import ExcelJS from 'exceljs';
import type pg from 'pg';
import { pool, withTx, audit } from '../db.js';
import { norm } from '../engine/parser.js';
import { parseAmount } from '../engine/money.js';
import { findDuplicates } from './catalog.js';
import { createTransaction, currencies, getSettings, Invalid, listAccounts, listTransfers } from './ledger.js';
import { feed, report } from './reports.js';

const HEAD_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F1F1F' } };
const HEAD_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFFFFFFF' } };

function styleHeader(ws: ExcelJS.Worksheet) {
  const r = ws.getRow(1);
  r.font = HEAD_FONT; r.fill = HEAD_FILL; r.alignment = { vertical: 'middle' }; r.height = 20;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  if (ws.columnCount) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
}
const num = (s: string | null | undefined) => (s === null || s === undefined ? null : Number(s));
const moneyFmt = (d: number) => (d ? `#,##0.${'0'.repeat(d)}` : '#,##0');

const L = {
  uk: {
    summary: 'Підсумки', ops: 'Операції', accounts: 'Рахунки', transfers: 'Перекази', cats: 'Категорії',
    period: 'Період', base: 'Базова валюта', totalExp: 'Витрати', totalInc: 'Доходи', net: 'Баланс періоду', avgExp: 'Витрати в середньому на день',
    date: 'Дата', type: 'Тип', account: 'Рахунок', amount: 'Сума', currency: 'Валюта', inBase: 'У базовій валюті', category: 'Категорія', project: 'Проєкт',
    comment: 'Коментар', details: 'Деталі', percent: '%', count: 'Кількість', name: 'Назва', balance: 'Баланс', initial: 'Початковий баланс',
    from: 'Звідки', to: 'Куди', sent: 'Списано', received: 'Зараховано', rate: 'Курс', kinds: { expense: 'Витрата', income: 'Дохід', transfer: 'Переказ', correction: 'Коригування' } as Record<string, string>,
    noRate: 'немає курсу для: ', guide: 'Довідка',
  },
  en: {
    summary: 'Summary', ops: 'Operations', accounts: 'Accounts', transfers: 'Transfers', cats: 'Categories',
    period: 'Period', base: 'Base currency', totalExp: 'Expenses', totalInc: 'Income', net: 'Net for period', avgExp: 'Average daily expenses',
    date: 'Date', type: 'Type', account: 'Account', amount: 'Amount', currency: 'Currency', inBase: 'In base currency', category: 'Category', project: 'Project',
    comment: 'Comment', details: 'Details', percent: '%', count: 'Count', name: 'Name', balance: 'Balance', initial: 'Initial balance',
    from: 'From', to: 'To', sent: 'Sent', received: 'Received', rate: 'Rate', kinds: { expense: 'Expense', income: 'Income', transfer: 'Transfer', correction: 'Correction' } as Record<string, string>,
    noRate: 'no rate for: ', guide: 'Reference',
  },
};

// ---------- export ----------

export async function exportReportXlsx(userId: string, from: string, to: string): Promise<Buffer> {
  const settings = await getSettings(userId);
  const t = L[settings.language] ?? L.uk;
  const cur = await currencies();
  const base = settings.base_currency;
  const r = await report(userId, from, to);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Гроші ОК';
  wb.created = new Date();

  // Summary + categories
  const s = wb.addWorksheet(t.summary);
  s.columns = [{ width: 34 }, { width: 18 }, { width: 10 }, { width: 12 }];
  s.addRow([t.period, `${from} — ${to}`]);
  s.addRow([t.base, base]);
  for (const [label, v] of [[t.totalExp, r.expense.total], [t.totalInc, r.income.total], [t.net, r.net], [t.avgExp, r.expense.avgDaily]] as const) {
    const row = s.addRow([label, num(v)]); row.getCell(2).numFmt = moneyFmt(cur[base].decimals); row.getCell(1).font = { bold: true };
  }
  if (r.missingRates.length) s.addRow([t.noRate + r.missingRates.join(', ')]);
  for (const kind of ['expense', 'income'] as const) {
    s.addRow([]);
    const h = s.addRow([`${t.cats}: ${t.kinds[kind]}`, `${t.amount}, ${base}`, t.percent, t.count]);
    h.font = HEAD_FONT; h.fill = HEAD_FILL;
    for (const c of r[kind].byCategory as any[]) {
      const row = s.addRow([c.name, num(c.total), c.percent / 100, c.count]);
      row.getCell(2).numFmt = moneyFmt(cur[base].decimals); row.getCell(3).numFmt = '0.0%';
    }
  }

  // Operations (all kinds)
  const ops = wb.addWorksheet(t.ops);
  ops.columns = [
    { header: t.date, key: 'date', width: 18 }, { header: t.type, key: 'type', width: 13 }, { header: t.account, key: 'account', width: 20 },
    { header: t.amount, key: 'amount', width: 14 }, { header: t.currency, key: 'currency', width: 9 }, { header: t.category, key: 'category', width: 20 },
    { header: t.project, key: 'project', width: 18 }, { header: t.comment, key: 'comment', width: 36 }, { header: t.details, key: 'details', width: 24 },
    { header: 'ID', key: 'id', width: 38 },
  ];
  let offset = 0;
  for (;;) {
    const page = await feed(userId, { from, to, limit: 500, offset });
    for (const i of [...page.items].reverse()) {
      const signed = i.kind === 'expense' || i.kind === 'transfer' ? -Number(i.amount) : Number(i.amount);
      const row = ops.addRow({
        date: new Date(i.occurredAt), type: t.kinds[i.kind], account: i.kind === 'transfer' ? `${i.accountName} → ${i.toAccountName}` : i.accountName,
        amount: signed, currency: i.currency, category: i.categoryName ?? '', project: i.projectName ?? '', comment: i.comment, details: i.details, id: i.id,
      });
      row.getCell('date').numFmt = 'dd.mm.yyyy hh:mm';
      row.getCell('amount').numFmt = moneyFmt(cur[i.currency].decimals);
      row.getCell('amount').font = { color: { argb: signed < 0 ? 'FFC0392B' : 'FF1E8449' } };
    }
    if (!page.hasMore) break;
    offset += 500;
  }
  styleHeader(ops);

  // Accounts
  const acc = wb.addWorksheet(t.accounts);
  acc.columns = [{ header: t.name, width: 24 }, { header: t.type, width: 12 }, { header: t.currency, width: 9 }, { header: t.initial, width: 18 }, { header: t.balance, width: 16 }, { header: t.inBase, width: 18 }];
  for (const a of await listAccounts(userId)) {
    const row = acc.addRow([a.name + (a.isArchived ? ' (archive)' : ''), a.type, a.currency, num(a.initialBalance), num(a.balance), num(a.baseValue)]);
    [4, 5].forEach((c) => (row.getCell(c).numFmt = moneyFmt(cur[a.currency].decimals)));
    row.getCell(6).numFmt = moneyFmt(cur[base].decimals);
  }
  styleHeader(acc);

  // Transfers in period
  const tr = wb.addWorksheet(t.transfers);
  tr.columns = [{ header: t.date, width: 18 }, { header: t.from, width: 20 }, { header: t.sent, width: 14 }, { header: t.currency, width: 9 }, { header: t.to, width: 20 }, { header: t.received, width: 14 }, { header: t.currency, width: 9 }, { header: t.rate, width: 16 }, { header: t.comment, width: 30 }];
  for (const x of (await listTransfers(userId, { limit: 100000 })).filter((x) => { const d = new Date(x.occurredAt).toISOString().slice(0, 10); return d >= from && d <= to; })) {
    const row = tr.addRow([new Date(x.occurredAt), x.fromAccountName, num(x.amountSent), x.fromCurrency, x.toAccountName, num(x.amountReceived), x.toCurrency, `1 ${x.rateBase} = ${x.rate} ${x.rateQuote}`, x.comment]);
    row.getCell(1).numFmt = 'dd.mm.yyyy hh:mm';
  }
  styleHeader(tr);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Empty template with the exact import columns and a reference sheet of names. */
export async function importTemplateXlsx(userId: string): Promise<Buffer> {
  const settings = await getSettings(userId);
  const t = L[settings.language] ?? L.uk;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(t.ops);
  ws.columns = [
    { header: t.date, width: 18 }, { header: t.type, width: 12 }, { header: t.account, width: 20 }, { header: t.amount, width: 12 },
    { header: t.currency, width: 9 }, { header: t.category, width: 20 }, { header: t.project, width: 18 }, { header: t.comment, width: 36 },
  ];
  const accounts = await listAccounts(userId, false);
  const cats = (await pool.query('SELECT name, type FROM categories WHERE user_id=$1 AND NOT is_archived ORDER BY type, sort_order', [userId])).rows;
  const a = accounts[0];
  const exp = cats.find((c) => c.type === 'expense');
  const row = ws.addRow([new Date(), t.kinds.expense, a?.name ?? 'Mono UAH', 250.5, a?.currency ?? 'UAH', exp?.name ?? 'Їжа', '', settings.language === 'en' ? 'example — delete this row' : 'приклад — видаліть цей рядок']);
  row.getCell(1).numFmt = 'dd.mm.yyyy hh:mm';
  styleHeader(ws);
  const g = wb.addWorksheet(t.guide);
  g.columns = [{ header: t.accounts, width: 26 }, { header: t.currency, width: 10 }, { header: '', width: 4 }, { header: t.cats, width: 26 }, { header: t.type, width: 12 }];
  const n = Math.max(accounts.length, cats.length);
  for (let i = 0; i < n; i++) g.addRow([accounts[i]?.name ?? '', accounts[i]?.currency ?? '', '', cats[i]?.name ?? '', cats[i] ? t.kinds[cats[i].type] : '']);
  styleHeader(g);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------- import ----------

type Cell = string | number | Date | null;

function parseCsv(text: string): Cell[][] {
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delim = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ';' : firstLine.includes('\t') ? '\t' : ',';
  const rows: Cell[][] = [];
  let row: string[] = []; let field = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') q = false; else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function readRows(filename: string, data: Buffer): Promise<Cell[][]> {
  if (/\.(csv|txt)$/i.test(filename)) return parseCsv(data.toString('utf8').replace(/^﻿/, ''));
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(data as any); } catch { throw new Invalid('Не вдалося прочитати файл. Підтримуються .xlsx та .csv (у Excel: «Зберегти як» → Книга Excel або CSV).'); }
  // the first sheet whose header looks like operations
  const ws = wb.worksheets.find((w) => (w.getRow(1).values as any[]).some((v) => /сума|amount/i.test(String(v ?? '')))) ?? wb.worksheets[0];
  if (!ws) return [];
  const out: Cell[][] = [];
  ws.eachRow({ includeEmpty: false }, (r) => {
    const vals = (r.values as any[]).slice(1).map((v): Cell => {
      if (v === null || v === undefined) return null;
      if (v instanceof Date || typeof v === 'number' || typeof v === 'string') return v;
      if (typeof v === 'object' && 'result' in v) return v.result as Cell;     // formula
      if (typeof v === 'object' && 'richText' in v) return v.richText.map((x: any) => x.text).join('');
      if (typeof v === 'object' && 'text' in v) return String(v.text);         // hyperlink
      return String(v);
    });
    out.push(vals);
  });
  return out;
}

const COLS: Record<string, RegExp> = {
  date: /^(дата|date|час|time|дата операції|дата і час)/i,
  type: /^(тип|type|вид)/i,
  account: /^(рахунок|account|картка|card|гаманець)/i,
  amount: /^(сума|amount|sum)/i,
  currency: /^(валюта|currency)/i,
  category: /^(категорія|category)/i,
  project: /^(проєкт|проект|project|об'єкт|джерело)/i,
  comment: /^(коментар|comment|опис|description|призначення|note)/i,
};

function parseDate(v: Cell, tzOffsetMin: number): Date | null {
  if (v instanceof Date) return new Date(v.getTime() + tzOffsetMin * 60000); // Excel stores local wall time as UTC
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400000) + tzOffsetMin * 60000); // Excel serial
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return new Date(Date.UTC(y, +m[2] - 1, +m[1], +(m[4] ?? 12), +(m[5] ?? 0), +(m[6] ?? 0)) + tzOffsetMin * 60000);
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (m) {
    if (m[7]) return new Date(s);
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 12), +(m[5] ?? 0), +(m[6] ?? 0)) + tzOffsetMin * 60000);
  }
  return null;
}

function parseType(v: Cell, amount: string): 'income' | 'expense' | 'skip' | null {
  const s = norm(String(v ?? ''));
  if (/^(витрат|expense|видат|списан|-$)/.test(s)) return 'expense';
  if (/^(дохід|доход|income|надход|зарахув|\+$)/.test(s)) return 'income';
  if (/^(переказ|transfer|коригув|correction)/.test(s)) return 'skip';
  if (!s) return amount.startsWith('-') ? 'expense' : null;
  return null;
}

export interface ImportRow {
  row: number; date: string | null; type: 'income' | 'expense' | null; accountName: string; accountId: string | null; amount: string | null; currency: string | null;
  categoryName: string; categoryId: string | null; projectName: string; projectId: string | null; comment: string;
  errors: string[]; warnings: string[]; duplicate: boolean; createAccount: boolean; createCategory: boolean; createProject: boolean; skip: boolean;
}

export async function previewImport(userId: string, filename: string, dataBase64: string, opts: { tzOffsetMinutes?: number } = {}) {
  const data = Buffer.from(dataBase64, 'base64');
  if (!data.length || data.length > 10 * 1024 * 1024) throw new Invalid('Файл має бути до 10 МБ');
  const settings = await getSettings(userId);
  const en = settings.language === 'en';
  const msg = (uk: string, e: string) => (en ? e : uk);
  const rows = await readRows(filename, data);
  if (rows.length < 2) throw new Invalid(msg('Файл порожній або без заголовка', 'The file is empty or has no header'));
  const headerIdx = rows.findIndex((r) => r.some((c) => COLS.amount.test(String(c ?? '').trim())));
  if (headerIdx < 0) throw new Invalid(msg('Не знайдено стовпця «Сума». Скористайтеся шаблоном.', 'No "Amount" column found. Use the template.'));
  const header = rows[headerIdx].map((c) => String(c ?? '').trim());
  const col: Record<string, number> = {};
  for (const [k, re] of Object.entries(COLS)) col[k] = header.findIndex((h) => re.test(h));
  if (col.date < 0) throw new Invalid(msg('Не знайдено стовпця «Дата»', 'No "Date" column found'));
  if (rows.length - headerIdx - 1 > 20000) throw new Invalid(msg('Максимум 20 000 рядків за раз', 'At most 20,000 rows at once'));

  const cur = await currencies();
  const accounts = (await pool.query('SELECT id, name, currency, is_archived FROM accounts WHERE user_id=$1', [userId])).rows;
  const cats = (await pool.query('SELECT id, name, type FROM categories WHERE user_id=$1', [userId])).rows;
  const projects = (await pool.query('SELECT id, name FROM projects WHERE user_id=$1', [userId])).rows;
  const byName = <T extends { name: string }>(list: T[], name: string) => list.find((x) => norm(x.name) === norm(name));
  const tz = opts.tzOffsetMinutes ?? 0;
  const out: ImportRow[] = [];

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (k: string) => (col[k] >= 0 ? r[col[k]] : null);
    if (r.every((c) => c === null || String(c).trim() === '')) continue;
    const errors: string[] = []; const warnings: string[] = [];
    const rawAmount = get('amount');
    let amountStr = typeof rawAmount === 'number' ? String(rawAmount) : String(rawAmount ?? '').replace(/[\s ₴$€]/g, '').replace(/[−–]/g, '-').replace(',', '.');
    const t = parseType(get('type'), amountStr);
    if (t === 'skip') { out.push({ row: i + 1, date: null, type: null, accountName: String(get('account') ?? ''), accountId: null, amount: null, currency: null, categoryName: '', categoryId: null, projectName: '', projectId: null, comment: '', errors: [], warnings: [msg('Перекази й коригування не імпортуються — створіть їх у застосунку', 'Transfers and corrections are not imported — create them in the app')], duplicate: false, createAccount: false, createCategory: false, createProject: false, skip: true }); continue; }
    amountStr = amountStr.replace(/^[-+]/, '');
    if (typeof rawAmount === 'number') amountStr = Math.abs(rawAmount).toFixed(10).replace(/\.?0+$/, '');
    const date = parseDate(get('date'), tz);
    if (!date || Number.isNaN(date.getTime())) errors.push(msg('Невірна дата', 'Invalid date'));
    if (!t) errors.push(msg('Невідомий тип (Витрата/Дохід)', 'Unknown type (Expense/Income)'));
    const accountName = String(get('account') ?? '').trim();
    const acc = accountName ? byName(accounts, accountName) : null;
    let currency = String(get('currency') ?? '').trim().toUpperCase() || acc?.currency || null;
    if (!accountName) errors.push(msg('Не вказано рахунок', 'Account is missing'));
    if (currency && !cur[currency]) { errors.push(msg(`Невідома валюта ${currency}`, `Unknown currency ${currency}`)); currency = null; }
    if (acc && currency && acc.currency !== currency) errors.push(msg(`Рахунок «${acc.name}» у ${acc.currency}, а в рядку ${currency}`, `Account "${acc.name}" is in ${acc.currency}, row says ${currency}`));
    if (acc?.is_archived) errors.push(msg('Рахунок в архіві', 'Account is archived'));
    if (!acc && accountName && !currency) errors.push(msg('Новий рахунок: вкажіть валюту', 'New account: currency is required'));
    let amount: string | null = null;
    if (currency) {
      try {
        const minor = parseAmount(amountStr, cur[currency].decimals);
        const d = cur[currency].decimals; const s = minor.toString().padStart(d + 1, '0');
        amount = d ? `${s.slice(0, -d)}.${s.slice(-d)}` : s;
      } catch (e: any) {
        // Excel floats such as 0.1+0.2 → round to currency precision
        if (/^\d+(\.\d+)?$/.test(amountStr) && Number(amountStr) > 0) { amount = Number(amountStr).toFixed(cur[currency].decimals); warnings.push(msg('Суму округлено', 'Amount rounded')); }
        else errors.push(msg(`Невірна сума «${String(rawAmount ?? '')}»`, `Invalid amount "${String(rawAmount ?? '')}"`));
      }
    }
    const categoryName = String(get('category') ?? '').trim();
    const cat = categoryName && t ? cats.find((c) => c.type === t && norm(c.name) === norm(categoryName)) : null;
    if (!categoryName) errors.push(msg('Не вказано категорію', 'Category is missing'));
    const projectName = String(get('project') ?? '').trim();
    const proj = projectName ? byName(projects, projectName) : null;
    const comment = String(get('comment') ?? '').trim().slice(0, 500);
    let duplicate = false;
    if (!errors.length && acc && amount && t) {
      duplicate = (await findDuplicates(pool, userId, { type: t, amount, currency, accountId: acc.id, occurredAt: date!.toISOString() })).length > 0;
      if (duplicate) warnings.push(msg('Схожа операція вже є (±36 год)', 'A similar operation already exists (±36 h)'));
    }
    out.push({
      row: i + 1, date: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null, type: t, accountName, accountId: acc?.id ?? null, amount, currency,
      categoryName, categoryId: cat?.id ?? null, projectName, projectId: proj?.id ?? null, comment, errors, warnings, duplicate,
      createAccount: !acc && !!accountName && !!currency, createCategory: !cat && !!categoryName && !!t, createProject: !proj && !!projectName, skip: false,
    });
  }
  const valid = out.filter((r) => !r.skip && !r.errors.length);
  return {
    rows: out,
    summary: {
      total: out.length, valid: valid.length, errors: out.filter((r) => r.errors.length).length, duplicates: valid.filter((r) => r.duplicate).length,
      skipped: out.filter((r) => r.skip).length,
      newAccounts: [...new Set(valid.filter((r) => r.createAccount).map((r) => `${r.accountName} (${r.currency})`))],
      newCategories: [...new Set(valid.filter((r) => r.createCategory).map((r) => `${r.categoryName} (${r.type})`))],
      newProjects: [...new Set(valid.filter((r) => r.createProject).map((r) => r.projectName))],
    },
  };
}

/** Re-validates on the server and writes all importable rows atomically. */
export async function commitImport(userId: string, filename: string, dataBase64: string, opts: { tzOffsetMinutes?: number; createMissing: boolean; includeDuplicates: boolean }) {
  const preview = await previewImport(userId, filename, dataBase64, opts);
  const rows = preview.rows.filter((r) => !r.skip && !r.errors.length && (opts.includeDuplicates || !r.duplicate));
  const needsCreate = rows.some((r) => r.createAccount || r.createCategory || r.createProject);
  if (needsCreate && !opts.createMissing) throw new Invalid('Файл містить нові рахунки/категорії/проєкти — увімкніть «Створити відсутні»');
  return withTx(async (c: pg.PoolClient) => {
    const made = { accounts: new Map<string, string>(), categories: new Map<string, string>(), projects: new Map<string, string>() };
    let imported = 0;
    for (const r of rows) {
      let accountId = r.accountId;
      if (!accountId) {
        const key = norm(r.accountName);
        accountId = made.accounts.get(key) ?? null;
        if (!accountId) {
          accountId = (await c.query("INSERT INTO accounts (user_id, name, type, currency) VALUES ($1,$2,'other',$3) RETURNING id", [userId, r.accountName, r.currency])).rows[0].id;
          made.accounts.set(key, accountId!);
          await audit(c, userId, 'account', accountId!, 'create', null, { name: r.accountName, currency: r.currency, via: 'import' });
        }
      }
      let categoryId = r.categoryId;
      if (!categoryId) {
        const key = `${r.type}:${norm(r.categoryName)}`;
        categoryId = made.categories.get(key) ?? null;
        if (!categoryId) {
          categoryId = (await c.query('INSERT INTO categories (user_id, name, type, sort_order) VALUES ($1,$2,$3,999) RETURNING id', [userId, r.categoryName, r.type])).rows[0].id;
          made.categories.set(key, categoryId!);
        }
      }
      let projectId = r.projectId;
      if (!projectId && r.projectName) {
        const key = norm(r.projectName);
        projectId = made.projects.get(key) ?? null;
        if (!projectId) {
          projectId = (await c.query('INSERT INTO projects (user_id, name) VALUES ($1,$2) RETURNING id', [userId, r.projectName])).rows[0].id;
          made.projects.set(key, projectId!);
        }
      }
      await createTransaction(userId, { type: r.type!, accountId: accountId!, amount: r.amount!, categoryId: categoryId!, projectId, occurredAt: r.date!, comment: r.comment }, c);
      imported++;
    }
    return { imported, skipped: preview.rows.length - imported, created: { accounts: made.accounts.size, categories: made.categories.size, projects: made.projects.size } };
  });
}
