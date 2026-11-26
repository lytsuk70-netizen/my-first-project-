/**
 * TALKO CRM as the system of record. The mobile app reads accounts, categories, projects and
 * operations from TALKO and writes new operations to TALKO through TALKO's own MCP server
 * (authorised with a TALKO API key). Nothing financial is stored locally in this mode.
 *
 * Writes follow TALKO's confirmation protocol: the first call returns a preview and a
 * confirmationToken; only a second call with that token records the operation.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { pool } from '../db.js';
import { IntegrationError } from './http.js';
import { getIntegration, secretOf, setStatus, upsertIntegration } from './store.js';

type Json = Record<string, any>;

// ---------- connection ----------

const clients = new Map<string, { client: Client; at: number }>();
let factory: (url: string, apiKey: string) => Promise<{ callTool: (name: string, args: Json) => Promise<any>; close: () => Promise<void> }> = async (url, apiKey) => {
  const client = new Client({ name: 'groshi-ok', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${apiKey}` } } }));
  return { callTool: (name, args) => client.callTool({ name, arguments: args }), close: () => client.close() };
};
/** Tests replace the transport with an in-memory fake TALKO. */
export function setTalkoFactory(f: typeof factory) { factory = f; clients.clear(); }

const conns = new Map<string, Awaited<ReturnType<typeof factory>>>();

async function connection(userId: string) {
  const cached = conns.get(userId);
  if (cached) return cached;
  const row = await getIntegration(userId, 'talko');
  if (!row || !row.enabled) throw new IntegrationError('TALKO не підключено');
  const c = await factory(row.config.url, secretOf(row)!);
  conns.set(userId, c);
  return c;
}

/** TALKO often prefixes the JSON with a human sentence ("Готово. {...}"); take the JSON part. */
export function parseLoose(text: string): Json {
  try { return JSON.parse(text); } catch { /* fall through */ }
  for (const open of ['{', '[']) {
    const i = text.indexOf(open);
    const j = text.lastIndexOf(open === '{' ? '}' : ']');
    if (i >= 0 && j > i) {
      try { const v = JSON.parse(text.slice(i, j + 1)); return Array.isArray(v) ? { items: v } : v; } catch { /* next */ }
    }
  }
  return { message: text };
}

function parse(result: any): Json {
  const text = (result?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
  let data: Json;
  data = parseLoose(text);
  if (result?.isError || data.error || (data.code && data.message && data.ok === false)) {
    const msg = [data.message ?? data.error ?? text, data.next].filter(Boolean).join(' ');
    throw new IntegrationError(`TALKO: ${String(msg).slice(0, 500)}`);
  }
  return data;
}

/** Calls a TALKO tool (directly, or via talko_call_tool when it is outside the connector's toolset). */
export async function talko(userId: string, tool: string, args: Json = {}): Promise<Json> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const c = await connection(userId);
      let res = await c.callTool(tool, args);
      if (res?.isError && /unknown tool|not found|невідом/i.test(JSON.stringify(res.content ?? ''))) res = await c.callTool('talko_call_tool', { tool, arguments: args });
      return parse(res);
    } catch (e: any) {
      if (e instanceof IntegrationError) throw e;
      conns.get(userId)?.close().catch(() => {});
      conns.delete(userId);
      if (attempt === 1) {
        await setStatus(userId, 'talko', 'error', String(e.message ?? e)).catch(() => {});
        throw new IntegrationError(`Немає зв'язку з TALKO: ${e.message ?? e}`, 503);
      }
    }
  }
  throw new IntegrationError('TALKO недоступний', 503);
}

// ---------- configuration ----------

export async function configureTalko(userId: string, url: string, apiKey: string) {
  let u: URL;
  try { u = new URL(url.trim()); } catch { throw new IntegrationError('Невірна адреса TALKO'); }
  if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) throw new IntegrationError('Адреса TALKO має бути https://');
  // verify before saving
  const probe = await factory(u.toString(), apiKey.trim()).catch((e) => { throw new IntegrationError(`Не вдалося підключитися до TALKO: ${e.message ?? e}`); });
  let me: Json;
  try { me = parse(await probe.callTool('talko_whoami', {})); } finally { probe.close().catch(() => {}); }
  await upsertIntegration(userId, 'talko', {
    secret: apiKey.trim(), enabled: true, status: 'ok', lastError: null,
    config: { url: u.toString(), companyId: me.companyId, companyName: me.companyName, baseCurrency: me.baseCurrency, role: me.role },
  });
  conns.delete(userId);
  await pool.query("UPDATE settings SET data_source='talko', base_currency=COALESCE((SELECT code FROM currencies WHERE code=$2), base_currency), updated_at=now() WHERE user_id=$1", [userId, me.baseCurrency ?? 'UAH']);
  return talkoStatus(userId);
}

export async function disconnectTalko(userId: string) {
  conns.get(userId)?.close().catch(() => {});
  conns.delete(userId);
  await pool.query("UPDATE settings SET data_source='local', updated_at=now() WHERE user_id=$1", [userId]);
  await pool.query("DELETE FROM integrations WHERE user_id=$1 AND kind='talko'", [userId]);
}

export async function talkoStatus(userId: string) {
  const row = await getIntegration(userId, 'talko');
  if (!row) return { configured: false };
  const c = row.config;
  return { configured: true, status: row.status, lastError: row.last_error, companyName: c.companyName, baseCurrency: c.baseCurrency, role: c.role, host: new URL(c.url).host };
}

// ---------- reads ----------

const DEC: Record<string, number> = { JPY: 0, BTC: 8 };
const dec = (c: string) => DEC[c] ?? 2;
/** TALKO returns numbers; the app works with exact decimal strings. */
export function money(n: unknown, currency: string): string {
  const v = typeof n === 'number' ? n : Number(n ?? 0);
  return (Math.round(v * 10 ** dec(currency)) / 10 ** dec(currency)).toFixed(dec(currency));
}

const TYPE_MAP: Record<string, string> = { cash: 'cash', bank: 'bank', card: 'card', deposit: 'savings', savings: 'savings', credit: 'debt', loan: 'debt' };

/**
 * Optional filter: only accounts of these TALKO legal entities (comma-separated entity ids in
 * TALKO_ENTITY_IDS). Used to show the owner's personal contour without company cash desks.
 */
function entityFilter(): Set<string> | null {
  // default: Юрій's personal contour «Гроші Окей» + «ФОП Луцюк ЮП ПП»; TALKO_ENTITY_IDS=all disables the filter
  const raw = process.env.TALKO_ENTITY_IDS ?? 'hm3HL8FgqM1RHcr9hH8L,rdXfhqXyKQ9bmzOG1hC2';
  if (raw.trim().toLowerCase() === 'all') return null;
  const ids = raw.split(',').map((x) => x.trim()).filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

const visCache = new Map<string, { at: number; ids: Set<string> }>();
async function rawAccounts(userId: string) {
  const r = await talko(userId, 'talko_list_finance_accounts', { activeOnly: true });
  const only = entityFilter();
  const list: Json[] = (r.accounts ?? []).filter((a: Json) => !only || only.has(String(a.entityId ?? a.legalEntityId ?? '')));
  if (only) visCache.set(userId, { at: Date.now(), ids: new Set(list.map((a) => String(a.id))) });
  return { r, list, filtered: !!only };
}

/** Account ids visible in the app (null = no filter). */
export async function visibleAccountIds(userId: string): Promise<Set<string> | null> {
  if (!entityFilter()) return null;
  const c = visCache.get(userId);
  if (c && Date.now() - c.at < 10 * 60_000) return c.ids; // the set of accounts rarely changes; balances are not cached
  const { list } = await rawAccounts(userId);
  const ids = new Set(list.map((a) => String(a.id)));
  visCache.set(userId, { at: Date.now(), ids });
  return ids;
}

export async function accounts(userId: string) {
  const { r, list, filtered } = await rawAccounts(userId);
  const base = r.baseCurrency ?? 'UAH';
  let totalsByCurrency: Record<string, string>;
  let totalBase: string | null;
  if (filtered) {
    const sums = new Map<string, number>();
    for (const a of list) { const c = a.currency ?? 'UAH'; sums.set(c, (sums.get(c) ?? 0) + Math.round(Number(a.balance ?? 0) * 10 ** dec(c))); }
    totalsByCurrency = Object.fromEntries([...sums.entries()].map(([c, v]) => [c, money(v / 10 ** dec(c), c)]));
    // a total across currencies needs rates; show it only when everything is in the base currency
    totalBase = [...sums.keys()].every((c) => c === base) ? (totalsByCurrency[base] ?? money(0, base)) : null;
  } else {
    totalsByCurrency = Object.fromEntries(Object.entries(r.totalsByCurrency ?? {}).map(([c, v]) => [c, money(v, c)]));
    totalBase = r.totalBase === undefined || r.totalBase === null ? null : money(r.totalBase, base);
  }
  return {
    baseCurrency: base,
    totalsByCurrency,
    totalBase,
    accounts: list.map((a: Json) => ({
      id: a.id, name: a.name, type: TYPE_MAP[a.type] ?? 'other', currency: a.currency ?? 'UAH',
      balance: money(a.balance, a.currency ?? 'UAH'), initialBalance: money(a.openingBalance ?? 0, a.currency ?? 'UAH'),
    })),
  };
}

export async function categories(userId: string) {
  const r = await talko(userId, 'talko_list_finance_categories', {});
  return (r.categories ?? []).map((c: Json) => ({ id: c.id, name: c.name, type: c.type, parentId: c.parentId || null }));
}

/** New category or folder (a folder is just a category that other categories point to). */
export async function createCategory(userId: string, input: { name: string; type: 'income' | 'expense'; parentId?: string | null }) {
  const r = await talko(userId, 'talko_create_category', { name: input.name, type: input.type, parentId: input.parentId ?? null });
  return { id: r.id ?? r.categoryId ?? r.category?.id ?? null, result: r };
}

/** Move a category into a folder (parentId) and/or rename it: dry run first, then the confirmed write. */
export async function updateCategory(userId: string, id: string, input: { parentId?: string | null; name?: string }, confirmationToken?: string) {
  const base: Json = { categoryId: id, ...(input.parentId !== undefined ? { parentId: input.parentId } : {}), ...(input.name ? { name: input.name } : {}) };
  if (!confirmationToken) {
    const preview = await talko(userId, 'talko_update_category', { ...base, dryRun: true });
    return { status: 'needs_confirmation' as const, confirmationToken: confirmationOf(preview) ?? 'dry-run-ok', preview };
  }
  const r = await talko(userId, 'talko_update_category', confirmationToken === 'dry-run-ok'
    ? base : { ...base, confirmationToken, confirmationReason: 'Підтверджено в застосунку «Гроші ОК»' });
  return { status: 'saved' as const, result: r };
}

export async function projects(userId: string) {
  const r = await talko(userId, 'talko_list_projects', { mode: 'registry', rawList: true, status: 'active', limit: 200 });
  return (r.projects ?? r.items ?? []).map((p: Json) => ({ id: p.id, name: p.name ?? p.title }));
}

export interface TxQuery { from?: string; to?: string; type?: 'income' | 'expense'; accountId?: string; categoryId?: string; projectId?: string; q?: string; max?: number }

/** Time of the payment written in the comment, e.g. «Кондитерська (12:11)» (from a bank screenshot). */
export function timeFromText(text: string): string | null {
  const m = String(text).match(/(?:^|[\s(,])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

/** Loads operations for a period (TALKO pages by document id) and returns them newest first. */
export async function transactions(userId: string, q: TxQuery) {
  const rows: Json[] = [];
  let cursor: string | undefined;
  const max = Math.min(q.max ?? 1500, 5000);
  let complete = true;
  for (let page = 0; page < 30; page++) {
    const r = await talko(userId, 'talko_list_finance_transactions', {
      dateFrom: q.from, dateTo: q.to, type: q.type, accountId: q.accountId, categoryId: q.categoryId, projectId: q.projectId, query: q.q, limit: 200, cursor,
    });
    rows.push(...(r.transactions ?? []));
    if (!r.hasMore || !r.nextCursor) break;
    if (rows.length >= max) { complete = false; break; }
    cursor = r.nextCursor;
  }
  const visible = await visibleAccountIds(userId);
  if (visible) {
    const keep = rows.filter((t) => visible.has(String(t.accountId)));
    rows.length = 0; rows.push(...keep);
  }
  rows.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.id).localeCompare(String(a.id)));
  return {
    complete,
    items: rows.map((t) => ({
      id: t.id, kind: t.type, type: t.type, amount: money(t.amount, t.currency ?? 'UAH'), currency: t.currency ?? 'UAH',
      amountBase: t.amountBase === null || t.amountBase === undefined ? null : money(t.amountBase, t.baseCurrency ?? 'UAH'), baseCurrency: t.baseCurrency ?? 'UAH',
      accountId: t.accountId, categoryId: t.categoryId || null, categoryName: t.categoryName || null, projectId: t.projectId || null,
      comment: t.description ?? '', counterparty: t.counterparty ?? '', occurredAt: t.date, localDate: String(t.date).slice(0, 10), source: t.source ?? '',
      time: timeFromText(t.description ?? ''),
    })),
  };
}

/** Category / account / day breakdown in the base currency, computed from TALKO's stored base amounts. */
export async function report(userId: string, from: string, to: string) {
  const { items, complete } = await transactions(userId, { from, to, max: 5000 });
  const base = items[0]?.baseCurrency ?? (await getIntegration(userId, 'talko'))?.config.baseCurrency ?? 'UAH';
  const cents = (s: string | null) => (s ? BigInt(s.replace('.', '').replace(/^(-?)0+(?=\d)/, '$1')) : 0n);
  const fmt = (v: bigint) => { const neg = v < 0n; const s = (neg ? -v : v).toString().padStart(3, '0'); return `${neg ? '-' : ''}${s.slice(0, -2)}.${s.slice(-2)}`; };
  let missing = 0;
  const section = (type: 'income' | 'expense') => {
    const list = items.filter((t) => t.type === type);
    let total = 0n;
    const byCat = new Map<string, { name: string; total: bigint; count: number }>();
    const byDay = new Map<string, bigint>();
    for (const t of list) {
      if (t.amountBase === null) { missing++; continue; }
      const v = cents(t.amountBase);
      total += v;
      const k = t.categoryId ?? '—';
      const g = byCat.get(k) ?? { name: t.categoryName ?? '—', total: 0n, count: 0 };
      g.total += v; g.count++; byCat.set(k, g);
      byDay.set(t.localDate, (byDay.get(t.localDate) ?? 0n) + v);
    }
    return {
      total: fmt(total), count: list.length,
      byCategory: [...byCat.entries()].sort((a, b) => (b[1].total > a[1].total ? 1 : -1)).map(([id, g]) => ({ id, name: g.name, total: fmt(g.total), count: g.count, percent: total ? Number((g.total * 10000n) / total) / 100 : 0 })),
      byDay: [...byDay.entries()].sort().map(([day, v]) => ({ day, total: fmt(v) })),
    };
  };
  const expense = section('expense');
  const income = section('income');
  return { from, to, baseCurrency: base, expense, income, net: fmt(cents(income.total) - cents(expense.total)), complete, missingBase: missing };
}

// ---------- writes (two-step: preview → confirm) ----------

export interface TalkoTxInput { type: 'income' | 'expense'; amount: string; accountId: string; categoryId: string; projectId?: string | null; date?: string; description: string; counterparty?: string }

function confirmationOf(r: Json) {
  // TALKO sometimes answers in plain text: "Потрібне явне підтвердження… confirmationToken: mcpc_… (діє …)"
  const fromText = typeof r.message === 'string' ? r.message.match(/confirmationToken:\s*([A-Za-z0-9_\-]+)/)?.[1] : undefined;
  return r.confirmationToken ?? r.previewToken ?? r.confirmation?.token ?? fromText ?? null;
}
function stillNeedsConfirmation(r: Json) {
  return typeof r.message === 'string' && /підтвердження|confirmationToken/i.test(r.message) && !r.ok && !r.id;
}

export async function addTransaction(userId: string, input: TalkoTxInput, confirmationToken?: string) {
  const args: Json = {
    type: input.type, amount: Number(input.amount), accountId: input.accountId, categoryId: input.categoryId,
    description: input.description || '—', date: input.date ? input.date.slice(0, 10) : undefined,
    ...(input.projectId ? { projectId: input.projectId } : {}), ...(input.counterparty ? { counterparty: input.counterparty } : {}),
    ...(confirmationToken ? { confirmationToken } : {}),
  };
  const r = await talko(userId, 'talko_add_transaction', args);
  const token = confirmationOf(r);
  if (!confirmationToken && token) return { status: 'needs_confirmation' as const, confirmationToken: token, preview: r.preview ?? r.message ?? r.summary ?? null };
  return { status: 'saved' as const, id: r.id ?? r.transactionId ?? r.transaction?.id ?? null, result: r };
}

/** Change comment and/or date of a TALKO operation. The user's ✓ in the app is the confirmation. */
export async function editTransaction(userId: string, id: string, input: { description?: string; date?: string; categoryId?: string; amount?: string }) {
  const base: Json = { transactionId: id, ...(input.description !== undefined ? { description: input.description || '—' } : {}), ...(input.date ? { date: input.date.slice(0, 10) } : {}),
    ...(input.categoryId ? { categoryId: input.categoryId } : {}), ...(input.amount ? { amount: Number(input.amount) } : {}) };
  if (Object.keys(base).length === 1) return { status: 'saved' as const, result: null };
  let r = await talko(userId, 'talko_edit_transaction', base);
  const token = confirmationOf(r);
  if (token) r = await talko(userId, 'talko_edit_transaction', { ...base, confirmationToken: token, confirmationReason: 'Підтверджено в застосунку «Гроші ОК»' });
  if (stillNeedsConfirmation(r)) throw new IntegrationError('TALKO не підтвердив зміну');
  return { status: 'saved' as const, result: r };
}

/** Store a photo/scan in TALKO's file storage; returns its link. */
export async function uploadFile(userId: string, input: { name: string; contentType: string; data: string }) {
  const r = await talko(userId, 'talko_upload_file', { content: input.data, name: input.name, contentType: input.contentType });
  const url = r.url ?? r.file?.url ?? r.downloadUrl ?? null;
  const fileId = r.fileId ?? r.file?.id ?? r.id ?? null;
  if (!url) throw new IntegrationError('TALKO не прийняв файл' + (typeof r.message === 'string' ? ': ' + r.message.slice(0, 120) : ''));
  return { url: String(url), fileId: fileId ? String(fileId) : null };
}

/** Soft-delete a TALKO operation (balance is rolled back). The swipe + 🗑 tap in the app is the user's confirmation. */
export async function deleteTransaction(userId: string, id: string) {
  const reason = 'Видалено користувачем у застосунку «Гроші ОК»';
  let r = await talko(userId, 'talko_delete_transaction', { transactionId: id });
  const token = confirmationOf(r);
  if (token) r = await talko(userId, 'talko_delete_transaction', { transactionId: id, confirmationToken: token, confirmationReason: reason });
  if (stillNeedsConfirmation(r)) throw new IntegrationError('TALKO не підтвердив видалення');
  return { status: 'deleted' as const, result: r };
}

export async function transfer(userId: string, input: { fromAccountId: string; toAccountId: string; amount: string; amountTo?: string; description?: string; date?: string }, confirmationToken?: string) {
  const base: Json = {
    fromAccountId: input.fromAccountId, toAccountId: input.toAccountId, amount: Number(input.amount),
    ...(input.amountTo ? { amountTo: Number(input.amountTo) } : {}), ...(input.description ? { description: input.description } : {}),
    ...(input.date ? { date: input.date.slice(0, 10) } : {}),
  };
  if (!confirmationToken) {
    // dry run: balances before/after, nothing is written
    const preview = await talko(userId, 'talko_transfer_between_accounts', { ...base, dryRun: true });
    return { status: 'needs_confirmation' as const, confirmationToken: confirmationOf(preview) ?? 'dry-run-ok', preview };
  }
  const r = await talko(userId, 'talko_transfer_between_accounts', confirmationToken === 'dry-run-ok' ? base : { ...base, confirmationToken, confirmationReason: 'Підтверджено в застосунку «Гроші ОК»' });
  const token = confirmationOf(r);
  if (token && token !== confirmationToken && !r.id && !r.transferId) return { status: 'needs_confirmation' as const, confirmationToken: token, preview: r };
  return { status: 'saved' as const, result: r };
}
