/**
 * Claude connector (MCP, Streamable HTTP). Lets the user operate «Гроші ОК» by talking to Claude
 * (including Claude voice mode). Every write tool is two-step: without `confirmed: true` it only
 * returns a preview that Claude must read back; the write happens only after the user's explicit "yes".
 */
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { pool } from '../db.js';
import { sha256 } from '../secrets.js';
import { accountMentions, type Period } from '../engine/commands.js';
import { matchCategory, norm } from '../engine/parser.js';
import { parseAmount, formatMinor, convertMinor, parseRate } from '../engine/money.js';
import * as L from '../services/ledger.js';
import * as C from '../services/catalog.js';
import { feed, report } from '../services/reports.js';
import { periodRange } from '../services/voice.js';
import { getIntegration, upsertIntegration } from './store.js';

// ---------- access token ----------

export async function createMcpToken(userId: string) {
  const token = randomBytes(24).toString('base64url');
  await upsertIntegration(userId, 'mcp', { tokenHash: sha256(token), enabled: true, status: 'ok', config: { createdAt: new Date().toISOString(), hint: token.slice(0, 4) } });
  return token;
}
export async function mcpStatus(userId: string) {
  const row = await getIntegration(userId, 'mcp');
  if (!row) return { configured: false };
  return { configured: true, hint: row.config.hint, createdAt: row.config.createdAt, lastUsedAt: row.last_sync_at };
}
async function userForToken(token: string | undefined): Promise<string | null> {
  if (!token || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const r = await pool.query("UPDATE integrations SET last_sync_at = now() WHERE kind='mcp' AND enabled AND token_hash=$1 RETURNING user_id", [sha256(token)]);
  return r.rows[0]?.user_id ?? null;
}

// ---------- helpers ----------

class Ask extends Error {} // a question Claude must relay to the user

const fmtUa = (v: string, cur: string) => {
  const [i, f] = v.replace('-', '').split('.');
  return `${v.startsWith('-') ? '−' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}${f && f !== '00' ? ',' + f : ''} ${cur}`;
};

async function resolveAccount(userId: string, input: string, currency?: string | null) {
  const all = (await L.listAccounts(userId)).filter((a) => !a.isArchived);
  const byId = all.find((a) => a.id === input);
  if (byId) return byId;
  const exact = all.filter((a) => norm(a.name) === norm(input));
  if (exact.length === 1) return exact[0];
  let ids = accountMentions(input, all.map((a) => ({ id: a.id, name: a.name, currency: a.currency }))).map((m) => m.id);
  if (!ids.length) ids = all.filter((a) => norm(a.name).includes(norm(input))).map((a) => a.id);
  let found = all.filter((a) => ids.includes(a.id));
  if (currency && found.length > 1) found = found.filter((a) => a.currency === currency);
  if (found.length === 1) return found[0];
  const list = (found.length ? found : all).map((a) => `${a.name} (${a.currency})`).join(', ');
  throw new Ask(found.length > 1 ? `Рахунок «${input}» неоднозначний. Запитай користувача, який саме: ${list}.` : `Рахунок «${input}» не знайдено. Доступні рахунки: ${list}. Запитай користувача.`);
}

async function resolveCategory(userId: string, input: string, type: 'income' | 'expense') {
  const cats = (await C.listCategories(userId)).filter((c) => c.type === type && !c.isArchived);
  const exact = cats.find((c) => c.id === input || norm(c.name) === norm(input));
  if (exact) return exact;
  const m = matchCategory(input, cats.map((c) => ({ id: c.id, name: c.name, type: c.type })), type);
  if (m.id) return cats.find((c) => c.id === m.id)!;
  throw new Ask(`Статтю «${input}» не знайдено. Не вигадуй нову — запитай користувача: «Куди занести цю ${type === 'expense' ? 'витрату' : 'операцію'}? Яку статтю обрати?» Доступні статті: ${cats.map((c) => c.name).join(', ')}.`);
}

async function resolveProject(userId: string, input: string | undefined | null) {
  if (!input) return null;
  const projects = (await C.listProjects(userId)).filter((p: any) => !p.isArchived);
  const p = projects.find((x: any) => x.id === input || norm(x.name) === norm(input))
    ?? projects.find((x: any) => norm(x.name).replace(/[\s-]/g, '') === norm(input).replace(/[\s-]/g, ''))
    ?? (projects.filter((x: any) => norm(x.name).includes(norm(input))).length === 1 ? projects.find((x: any) => norm(x.name).includes(norm(input))) : undefined);
  if (p) return p as { id: string; name: string };
  throw new Ask(`Проєкт «${input}» не знайдено. Доступні: ${projects.map((x: any) => x.name).join(', ') || 'немає'}. Запитай користувача, проєкти не створюються автоматично.`);
}

function parseDate(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) throw new Ask(`Не вдалося зрозуміти дату «${input}». Передай її у форматі ISO 8601.`);
  return d.toISOString();
}

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const NOT_SAVED = '\n\n⚠️ НЕ ЗБЕРЕЖЕНО. Прочитай це користувачу українською і виклич інструмент ще раз з тими самими параметрами та confirmed=true ЛИШЕ після явного «так».';

function wrap(fn: (args: any) => Promise<string>) {
  return async (args: any) => {
    try { return text(await fn(args)); }
    catch (e: any) {
      if (e instanceof Ask || e instanceof L.Invalid || e instanceof L.NotFound || e?.name === 'MoneyError' || e?.constructor?.name === 'MoneyError') return { ...text(e.message), isError: true };
      console.error('mcp tool failed', e);
      return { ...text('Внутрішня помилка сервера «Гроші ОК».'), isError: true };
    }
  };
}

const INSTRUCTIONS = `«Гроші ОК» — особистий фінансовий облік користувача. Спілкуйся українською, суми читай чітко (напр. «5 000 гривень»).
Правила:
- Ніколи не вигадуй операції, рахунки, статті, проєкти чи курси валют. Якщо чогось бракує — коротко запитай.
- Будь-який запис (витрата, дохід, переказ, обмін, підтвердження з «Вхідних», видалення) спочатку викликай без confirmed — отримаєш попередній перегляд; прочитай його користувачу і виклич ще раз з confirmed=true лише після явного «так».
- Переказ між власними рахунками — це transfer, не витрата і не дохід. Обмін валют — теж transfer із курсом; курс не припускай, запитай.
- Для питань «скільки…», «який баланс…» використовуй get_balances / get_report / search_transactions.
- Банківські SMS, Telegram і monobank потрапляють у «Вхідні» (list_inbox); пропонуй користувачу підтвердити їх.`;

// ---------- server ----------

function buildServer(userId: string) {
  const server = new McpServer({ name: 'groshi-ok', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  // Untyped wrapper: the SDK's generic zod inference is very expensive for the TypeScript compiler.
  const reg = (server as any).registerTool.bind(server) as (name: string, config: object, cb: (args: any) => Promise<unknown>) => void;
  const readOnly = { readOnlyHint: true, openWorldHint: false } as const;
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

  reg('get_balances', {
    title: 'Баланси рахунків',
    description: 'Залишки на всіх активних рахунках (кожен у своїй валюті) і загальний капітал у базовій валюті. Використовуй для «покажи залишки», «скільки грошей у доларах».',
    inputSchema: { currency: z.string().length(3).optional().describe('Показати лише рахунки в цій валюті, напр. USD') },
    annotations: readOnly,
  }, wrap(async ({ currency }) => {
    const accounts = (await L.listAccounts(userId, false)).filter((a) => !currency || a.currency === currency.toUpperCase());
    const nw = await L.netWorth(userId);
    const lines = accounts.map((a) => `• ${a.name}: ${fmtUa(a.balance, a.currency)}${a.currency !== nw.baseCurrency && a.baseValue ? ` (≈ ${fmtUa(a.baseValue, nw.baseCurrency)})` : ''}`);
    if (currency) {
      const sum = accounts.reduce((s, a) => s + BigInt(a.balance.replace('.', '')), 0n);
      lines.push(`Разом у ${currency.toUpperCase()}: ${fmtUa(formatMinor(sum, 2), currency.toUpperCase())}`);
    } else {
      lines.push(`Загальний капітал: ${fmtUa(nw.total, nw.baseCurrency)}${nw.complete ? '' : ` (без валют, для яких немає курсу: ${nw.missingRates.join(', ')})`}`);
    }
    return lines.join('\n') || 'Рахунків немає.';
  }));

  reg('list_references', {
    title: 'Рахунки, статті, проєкти',
    description: 'Список рахунків, статей (категорій) витрат і доходів та проєктів. Викликай, щоб знати точні назви перед записом.',
    inputSchema: {},
    annotations: readOnly,
  }, wrap(async () => {
    const accounts = await L.listAccounts(userId, false);
    const cats = (await C.listCategories(userId)).filter((c) => !c.isArchived);
    const projects = (await C.listProjects(userId)).filter((p: any) => !p.isArchived);
    return [
      `Рахунки: ${accounts.map((a) => `${a.name} (${a.currency})`).join(', ')}`,
      `Статті витрат: ${cats.filter((c) => c.type === 'expense').map((c) => c.name).join(', ')}`,
      `Статті доходів: ${cats.filter((c) => c.type === 'income').map((c) => c.name).join(', ')}`,
      `Проєкти: ${projects.map((p: any) => p.name).join(', ') || 'немає'}`,
    ].join('\n');
  }));

  reg('add_transaction', {
    title: 'Записати витрату або дохід',
    description: 'Записує витрату або дохід. Спочатку виклич без confirmed (попередній перегляд), потім з confirmed=true після «так» користувача. Не використовуй для переказів між власними рахунками.',
    inputSchema: {
      type: z.enum(['expense', 'income']).describe('expense — витрата, income — дохід'),
      amount: z.string().describe('Сума в валюті рахунку, напр. "5000" або "1250.50"'),
      account: z.string().describe('Назва рахунку, напр. "Приват", "Mono UAH"'),
      category: z.string().describe('Стаття (категорія) з наявних'),
      project: z.string().optional().describe('Проєкт / об\'єкт, напр. "ПВ-5"'),
      comment: z.string().max(500).optional().describe('Коментар, отримувач, опис'),
      date: z.string().optional().describe('Дата й час ISO 8601; за замовчуванням зараз'),
      confirmed: z.boolean().optional().describe('true лише після явного підтвердження користувача'),
    },
    annotations: write,
  }, wrap(async (a) => {
    const acc = await resolveAccount(userId, a.account);
    const cat = await resolveCategory(userId, a.category, a.type);
    const proj = await resolveProject(userId, a.project);
    const occurredAt = parseDate(a.date);
    const d = await L.dec(acc.currency);
    const minor = parseAmount(a.amount, d);
    const balance = BigInt(acc.balance.replace('.', '').replace('-', '')) * (acc.balance.startsWith('-') ? -1n : 1n);
    const after = a.type === 'expense' ? balance - minor : balance + minor;
    const dups = await C.findDuplicates(pool, userId, { type: a.type, amount: formatMinor(minor, d), currency: acc.currency, accountId: acc.id, occurredAt: occurredAt ?? new Date().toISOString() });
    const summary = `${a.type === 'expense' ? 'Витрата' : 'Дохід'} ${fmtUa(formatMinor(minor, d), acc.currency)} · рахунок ${acc.name} · стаття ${cat.name}${proj ? ` · проєкт ${proj.name}` : ''}${a.comment ? ` · «${a.comment}»` : ''}`;
    const dupWarn = dups.length ? `\nУВАГА: схожа операція вже є (${dups.map((x: any) => new Date(x.occurred_at).toLocaleString('uk-UA')).join(', ')}). Запитай, чи це не дублікат.` : '';
    if (!a.confirmed) return `ПОПЕРЕДНІЙ ПЕРЕГЛЯД: ${summary}. Баланс ${acc.name}: ${fmtUa(acc.balance, acc.currency)} → ${fmtUa(formatMinor(after, d), acc.currency)}.${dupWarn}${NOT_SAVED}`;
    await L.createTransaction(userId, { type: a.type, accountId: acc.id, amount: formatMinor(minor, d), categoryId: cat.id, projectId: proj?.id ?? null, comment: a.comment, occurredAt, source: 'claude' });
    const now = (await L.listAccounts(userId)).find((x) => x.id === acc.id)!;
    return `✅ Записано: ${summary}. Новий баланс ${acc.name}: ${fmtUa(now.balance, now.currency)}.`;
  }));

  reg('transfer', {
    title: 'Переказ або обмін валют',
    description: 'Переказ між власними рахунками (не витрата і не дохід). Для різних валют потрібен курс (rate) або сума зарахування (amount_received) — не припускай курс, запитай. Спочатку без confirmed, потім з confirmed=true.',
    inputSchema: {
      from_account: z.string().describe('Рахунок списання'),
      to_account: z.string().describe('Рахунок зарахування'),
      amount: z.string().describe('Сума списання у валюті рахунку списання'),
      rate: z.string().optional().describe('Курс: 1 одиниця rate_base = rate іншої валюти, напр. 41.50'),
      rate_base: z.string().length(3).optional().describe('Валюта, за одиницю якої вказано курс, напр. USD'),
      amount_received: z.string().optional().describe('Фактична сума зарахування замість курсу'),
      comment: z.string().max(500).optional(),
      date: z.string().optional(),
      confirmed: z.boolean().optional(),
    },
    annotations: write,
  }, wrap(async (a) => {
    const from = await resolveAccount(userId, a.from_account);
    const to = await resolveAccount(userId, a.to_account);
    if (from.id === to.id) throw new Ask('Рахунки списання й зарахування однакові. Запитай користувача.');
    const fd = await L.dec(from.currency); const td = await L.dec(to.currency);
    const sent = parseAmount(a.amount, fd);
    let received = sent; let rateText = '';
    let base = a.rate_base?.toUpperCase() ?? (from.currency === 'UAH' ? to.currency : to.currency === 'UAH' ? from.currency : from.currency);
    if (from.currency !== to.currency) {
      if (![from.currency, to.currency].includes(base)) base = from.currency;
      const quote = base === from.currency ? to.currency : from.currency;
      if (a.amount_received) received = parseAmount(a.amount_received, td);
      else if (a.rate) received = convertMinor(sent, { currency: from.currency, decimals: fd }, { currency: to.currency, decimals: td }, { base, quote, rate: parseRate(a.rate) });
      else throw new Ask(`Для обміну ${from.currency} → ${to.currency} потрібен курс. Запитай користувача, за яким курсом (1 ${base} = ? ${quote}) або скільки зараховано.`);
      rateText = a.rate ? ` за курсом 1 ${base} = ${a.rate} ${quote}` : '';
    }
    const balanceFrom = BigInt(from.balance.replace('.', '').replace('-', '')) * (from.balance.startsWith('-') ? -1n : 1n);
    const warn = balanceFrom < sent && !['debt'].includes(from.type) ? `\nУВАГА: на рахунку ${from.name} лише ${fmtUa(from.balance, from.currency)} — після переказу буде мінус.` : '';
    const summary = `Переказ ${fmtUa(formatMinor(sent, fd), from.currency)} з ${from.name} → ${fmtUa(formatMinor(received, td), to.currency)} на ${to.name}${rateText}${a.comment ? ` · «${a.comment}»` : ''}`;
    if (!a.confirmed) return `ПОПЕРЕДНІЙ ПЕРЕГЛЯД: ${summary}.${warn}${NOT_SAVED}`;
    await L.createTransfer(userId, {
      fromAccountId: from.id, toAccountId: to.id, amountSent: formatMinor(sent, fd),
      ...(from.currency !== to.currency ? (a.amount_received ? { amountReceived: formatMinor(received, td) } : { rate: a.rate }) : {}),
      rateBase: from.currency !== to.currency ? base : undefined, comment: a.comment, occurredAt: parseDate(a.date),
    });
    const acc = await L.listAccounts(userId);
    const f = acc.find((x) => x.id === from.id)!; const t2 = acc.find((x) => x.id === to.id)!;
    return `✅ ${summary}. Баланси: ${f.name} ${fmtUa(f.balance, f.currency)}, ${t2.name} ${fmtUa(t2.balance, t2.currency)}.`;
  }));

  reg('get_report', {
    title: 'Звіт',
    description: 'Підсумки витрат і доходів за період у базовій валюті, з розбивкою за статтями та проєктами. Для «скільки витрачено цього місяця», «скільки на ПВ-5».',
    inputSchema: {
      period: z.enum(['today', 'yesterday', 'week', 'month', 'prevMonth', 'year', 'custom']).default('month'),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Для custom: дата початку YYYY-MM-DD'),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      category: z.string().optional().describe('Лише ця стаття'),
      project: z.string().optional().describe('Лише цей проєкт'),
    },
    annotations: readOnly,
  }, wrap(async (a) => {
    const settings = await L.getSettings(userId);
    const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: settings.timezone }).format(new Date());
    const range = a.period === 'custom' ? { from: a.from ?? todayLocal, to: a.to ?? todayLocal } : periodRange(a.period as Period, todayLocal);
    const r = await report(userId, range.from, range.to);
    const base = r.baseCurrency;
    const out = [`Період ${range.from} — ${range.to}, валюта ${base}.`];
    const pick = (rows: any[], id: string) => rows.filter((x) => x.id === id || x.parentId === id).reduce((s, x) => s + BigInt(x.total.replace('.', '')), 0n);
    if (a.project) {
      const p = await resolveProject(userId, a.project);
      for (const k of ['expense', 'income'] as const) {
        const row = (r[k].byProject as any[]).find((x) => x.id === p!.id);
        out.push(`${k === 'expense' ? 'Витрати' : 'Доходи'} по проєкту ${p!.name}: ${fmtUa(row?.total ?? '0.00', base)}`);
      }
    } else if (a.category) {
      const cat = await resolveCategory(userId, a.category, 'expense').catch(() => resolveCategory(userId, a.category!, 'income'));
      out.push(`${cat.name}: ${fmtUa(formatMinor(pick(r[cat.type as "expense" | "income"].byCategory as any[], cat.id), 2), base)}`);
    } else {
      out.push(`Витрати: ${fmtUa(r.expense.total, base)} (${r.expense.count} операцій, у середньому ${fmtUa(r.expense.avgDaily, base)} на день).`);
      out.push(`Доходи: ${fmtUa(r.income.total, base)}. Баланс періоду: ${fmtUa(r.net, base)}.`);
      const top = (r.expense.byCategory as any[]).slice(0, 8).map((c) => `${c.name} ${fmtUa(c.total, base)} (${c.percent}%)`).join('; ');
      if (top) out.push(`Найбільші статті витрат: ${top}.`);
      const projects = (r.expense.byProject as any[]).filter((p) => p.id).map((p) => `${p.name} ${fmtUa(p.total, base)}`).join('; ');
      if (projects) out.push(`За проєктами: ${projects}.`);
    }
    if (r.missingRates.length) out.push(`Без курсу (не враховано): ${r.missingRates.join(', ')}.`);
    return out.join('\n');
  }));

  reg('search_transactions', {
    title: 'Пошук операцій',
    description: 'Історія операцій з фільтрами. Повертає id, які можна передати в delete_transaction.',
    inputSchema: {
      query: z.string().optional().describe('Текст: коментар, сума, стаття, рахунок'),
      kind: z.enum(['expense', 'income', 'transfer', 'correction']).optional(),
      account: z.string().optional(), category: z.string().optional(), project: z.string().optional(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      limit: z.number().int().min(1).max(50).default(15),
    },
    annotations: readOnly,
  }, wrap(async (a) => {
    const accountId = a.account ? (await resolveAccount(userId, a.account)).id : undefined;
    const categoryId = a.category ? (await resolveCategory(userId, a.category, a.kind === 'income' ? 'income' : 'expense')).id : undefined;
    const projectId = a.project ? (await resolveProject(userId, a.project))!.id : undefined;
    const r = await feed(userId, { q: a.query, kinds: a.kind ? [a.kind] : undefined, accountId, categoryId, projectId, from: a.from, to: a.to, limit: a.limit });
    if (!r.items.length) return 'Операцій не знайдено.';
    return r.items.map((i) => {
      const when = new Date(i.occurredAt).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      if (i.kind === 'transfer') return `[${i.id}] ${when} переказ ${fmtUa(i.amount, i.currency)} ${i.accountName} → ${i.toAccountName} ${fmtUa(i.amountReceived!, i.toCurrency!)}`;
      return `[${i.id}] ${when} ${i.kind === 'expense' ? '−' : i.kind === 'income' ? '+' : '±'}${fmtUa(i.amount, i.currency)} · ${i.accountName}${i.categoryName ? ' · ' + i.categoryName : ''}${i.projectName ? ' · ' + i.projectName : ''}${i.comment ? ' · ' + i.comment : ''}`;
    }).join('\n') + (r.hasMore ? '\n…є ще операції, уточни фільтр.' : '');
  }));

  reg('delete_transaction', {
    title: 'Видалити операцію',
    description: 'Видаляє операцію (або переказ цілком) за id із search_transactions. Запис зберігається в журналі й може бути відновлений у застосунку. Спочатку без confirmed.',
    inputSchema: { id: z.string().uuid(), confirmed: z.boolean().optional() },
    annotations: { ...write, destructiveHint: true },
  }, wrap(async (a) => {
    const t = (await pool.query(
      `SELECT t.*, ac.name AS account_name FROM transactions t JOIN accounts ac ON ac.id=t.account_id WHERE t.id=$1 AND t.user_id=$2 AND t.deleted_at IS NULL`, [a.id, userId])).rows[0];
    if (!t) throw new Ask('Операцію не знайдено або її вже видалено.');
    const d = await L.dec(t.currency);
    const summary = `${t.transfer_id ? 'переказ' : t.type === 'expense' ? 'витрату' : t.type === 'income' ? 'дохід' : 'коригування'} ${fmtUa(formatMinor(t.amount_minor, d), t.currency)} (${t.account_name}${t.comment ? ', «' + t.comment + '»' : ''})`;
    if (!a.confirmed) return `ПОПЕРЕДНІЙ ПЕРЕГЛЯД: видалити ${summary}.${NOT_SAVED}`;
    if (t.transfer_id) await L.deleteTransfer(userId, t.transfer_id); else await L.deleteTransaction(userId, a.id);
    return `✅ Видалено ${summary}. Баланси перераховано.`;
  }));

  reg('list_inbox', {
    title: 'Вхідні з банків',
    description: 'Операції з SMS, Telegram і monobank, що чекають підтвердження.',
    inputSchema: {},
    annotations: readOnly,
  }, wrap(async () => {
    const rows = await C.listImported(userId, 'pending');
    if (!rows.length) return 'У «Вхідних» нічого немає.';
    const accounts = await L.listAccounts(userId);
    const cats = await C.listCategories(userId);
    return rows.slice(0, 30).map((m: any) => {
      const d = m.draft;
      const acc = accounts.find((x) => x.id === d.accountId); const cat = cats.find((x) => x.id === d.categoryId);
      return `[${m.id}] ${d.type === 'income' ? '+' : '−'}${d.amount ?? '?'} ${d.currency ?? ''} · ${acc?.name ?? 'рахунок?'} · ${cat?.name ?? 'стаття?'}${d.comment ? ' · ' + d.comment : ''}${m.duplicates.length ? ' · МОЖЛИВИЙ ДУБЛІКАТ' : ''} (джерело: ${m.source})`;
    }).join('\n');
  }));

  reg('confirm_inbox_item', {
    title: 'Підтвердити операцію з «Вхідних»',
    description: 'Записує операцію з «Вхідних», за потреби з уточненими рахунком, статтею, проєктом. Спочатку без confirmed.',
    inputSchema: {
      id: z.string().uuid(),
      type: z.enum(['expense', 'income']).optional(), account: z.string().optional(), category: z.string().optional(), project: z.string().optional(),
      comment: z.string().max(500).optional(), confirmed: z.boolean().optional(),
    },
    annotations: write,
  }, wrap(async (a) => {
    const msg = await C.getImported(userId, a.id);
    if (msg.status !== 'pending') throw new Ask('Цю операцію вже оброблено.');
    const d = msg.parsed;
    const type = a.type ?? d.type;
    if (!type) throw new Ask('Невідомо, витрата це чи дохід. Запитай користувача.');
    if (!d.amount) throw new Ask('У повідомленні не знайдено суми — підтвердіть його в застосунку.');
    const acc = a.account ? await resolveAccount(userId, a.account, d.currency) : d.accountId ? (await L.listAccounts(userId)).find((x) => x.id === d.accountId) : null;
    if (!acc) throw new Ask(`Невідомо, з якого рахунку (${d.currency}). Запитай користувача.`);
    const cat = a.category ? await resolveCategory(userId, a.category, type) : (await C.listCategories(userId)).find((c) => c.id === d.categoryId && c.type === type);
    if (!cat) throw new Ask(`${d.comment ? `Отримувач — ${d.comment}. ` : ''}Куди занести цю ${type === 'expense' ? 'витрату' : 'операцію'}? Яку статтю обрати?`);
    const proj = await resolveProject(userId, a.project);
    const comment = a.comment ?? d.comment;
    const summary = `${type === 'expense' ? 'Витрата' : 'Дохід'} ${fmtUa(d.amount, acc.currency)} · ${acc.name} · ${cat.name}${proj ? ' · ' + proj.name : ''}${comment ? ' · ' + comment : ''}`;
    if (!a.confirmed) return `ПОПЕРЕДНІЙ ПЕРЕГЛЯД: ${summary}.${NOT_SAVED}`;
    await C.confirmImported(userId, a.id, { type, amount: d.amount, accountId: acc.id, categoryId: cat.id, projectId: proj?.id ?? null, comment, occurredAt: d.occurredAt ?? undefined });
    return `✅ Записано: ${summary}.`;
  }));

  reg('ignore_inbox_item', {
    title: 'Пропустити операцію з «Вхідних»',
    description: 'Позначає повідомлення як пропущене (напр. дублікат або переказ між своїми рахунками).',
    inputSchema: { id: z.string().uuid() },
    annotations: write,
  }, wrap(async (a) => { await C.ignoreImported(userId, a.id); return 'Пропущено.'; }));

  reg('add_exchange_rate', {
    title: 'Додати курс валют',
    description: 'Зберігає курс для оцінки капіталу та звітів (1 base = rate quote). Спочатку без confirmed.',
    inputSchema: { base: z.string().length(3), quote: z.string().length(3), rate: z.string(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), confirmed: z.boolean().optional() },
    annotations: write,
  }, wrap(async (a) => {
    const date = a.date ?? new Date().toISOString().slice(0, 10);
    const summary = `курс на ${date}: 1 ${a.base.toUpperCase()} = ${a.rate} ${a.quote.toUpperCase()}`;
    if (!a.confirmed) return `ПОПЕРЕДНІЙ ПЕРЕГЛЯД: ${summary}.${NOT_SAVED}`;
    await C.addRate(userId, { date, base: a.base.toUpperCase(), quote: a.quote.toUpperCase(), rate: a.rate });
    return `✅ Збережено ${summary}.`;
  }));

  return server;
}

/** Express handler for POST /mcp/:token (or /mcp with "Authorization: Bearer <token>"). Stateless. */
export async function handleMcp(req: Request, res: Response) {
  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const userId = await userForToken(req.params.token ?? bearer);
  if (!userId) {
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Invalid or revoked Гроші ОК connector token' }, id: null });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
    return;
  }
  const server = buildServer(userId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
