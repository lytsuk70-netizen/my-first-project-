/**
 * monobank personal API (https://api.monobank.ua/docs/). The user creates a personal token at
 * api.monobank.ua; we read the statement of the mapped cards and put every operation into the inbox.
 * The API allows one statement request per 60 s, so accounts are synced one after another.
 */
import { pool } from '../db.js';
import { matchCategory, norm, type ParseCategory, type SmsDraft } from '../engine/parser.js';
import { ingest, parseContext } from '../services/catalog.js';
import { currencies, getSettings } from '../services/ledger.js';
import { http, IntegrationError } from './http.js';
import { getIntegration, mergeConfig, secretOf, setStatus, upsertIntegration } from './store.js';

const API = 'https://api.monobank.ua';
const ISO4217: Record<number, string> = { 980: 'UAH', 840: 'USD', 978: 'EUR', 985: 'PLN', 826: 'GBP', 756: 'CHF', 203: 'CZK', 124: 'CAD', 392: 'JPY' };
export let STATEMENT_GAP_MS = 61_000;
export function setStatementGap(ms: number) { STATEMENT_GAP_MS = ms; }

async function mono<T = any>(token: string, path: string): Promise<T> {
  const res = await http(API + path, { headers: { 'X-Token': token } });
  if (res.status === 429) throw new IntegrationError('monobank: забагато запитів, спробуйте за хвилину', 429);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new IntegrationError(`monobank: ${body.errorDescription ?? 'HTTP ' + res.status}`, res.status);
  }
  return res.json();
}

/** MCC → category name stems (matched against the user's own category names). */
const MCC: Array<[number[], string[]]> = [
  [[5411, 5412, 5422, 5441, 5451, 5462, 5499, 5300, 5311, 5331], ['їж', 'food', 'продукт', 'харч']],
  [[5812, 5813, 5814], ['ресторан', 'restaurant', 'кафе']],
  [[4111, 4121, 4131, 4112, 4784, 4789, 5541, 5542, 5983, 7523, 7512, 3000], ['транспорт', 'transport', 'авто']],
  [[5122, 5912, 8011, 8021, 8031, 8042, 8043, 8049, 8050, 8062, 8071, 8099], ["здоров", 'health', 'медиц']],
  [[4812, 4814, 4816, 4899], ["зв'яз", 'phone', 'mobile', 'інтернет']],
  [[5611, 5621, 5631, 5641, 5651, 5655, 5661, 5691, 5699, 5948], ['одяг', 'cloth']],
  [[5815, 5816, 5817, 5818, 7832, 7841, 7922, 7929, 7932, 7933, 7991, 7993, 7994, 7996, 7997], ['розваг', 'entertain']],
  [[5942, 5943, 8211, 8220, 8241, 8244, 8249, 8299], ['освіт', 'educat', 'навчан']],
  [[1520, 1711, 1731, 1740, 1750, 5039, 5200, 5211, 5231, 5251, 5261], ['будів', 'construct', 'ремонт']],
  [[4900, 6513, 5719, 5712, 5722], ['дім', 'home', 'житл', 'house']],
  [[8398, 8661], ['благод', 'charity', 'донат']],
];

function categoryByMcc(mcc: number, type: 'income' | 'expense', categories: ParseCategory[]) {
  const stems = MCC.find(([codes]) => codes.includes(mcc))?.[1];
  if (!stems || type !== 'expense') return null;
  return categories.find((c) => c.type === type && !c.is_archived && stems.some((s) => norm(c.name).startsWith(norm(s))))?.id ?? null;
}

const OWN_TRANSFER = /переказ|з картки|на картку|з гривнев|на гривнев|з долар|на долар|з євро|на євро|поповнення|own account|between accounts|банка|конверт/i;

export function statementToDraft(item: any, accountId: string, categories: ParseCategory[], decimalsOf: (c: string) => number, lang: 'uk' | 'en'): SmsDraft {
  const currency = ISO4217[item.currencyCode] ?? 'UAH';
  const d = decimalsOf(currency);
  const fmt = (minor: number) => {
    const s = String(Math.abs(Math.trunc(minor))).padStart(d + 1, '0');
    return d ? `${s.slice(0, -d)}.${s.slice(-d)}` : s;
  };
  const type: 'income' | 'expense' = item.amount < 0 ? 'expense' : 'income';
  const description = String(item.description ?? '').trim();
  const categoryId = categoryByMcc(item.mcc, type, categories) ?? matchCategory(`${description} ${item.comment ?? ''}`, categories, type).id;
  const questions: string[] = [];
  if (OWN_TRANSFER.test(description)) {
    questions.push(lang === 'en'
      ? 'This may be a transfer between your own accounts — then skip it and record a transfer instead.'
      : 'Можливо, це переказ між вашими рахунками — тоді пропустіть його і зробіть переказ.');
  }
  const missing: SmsDraft['missing'] = [];
  if (!categoryId) missing.push('category');
  return {
    type, amount: fmt(item.amount), currency, accountId, categoryId,
    comment: [description, item.comment].filter(Boolean).join(' · ').slice(0, 200),
    occurredAt: new Date(item.time * 1000).toISOString(),
    missing, questions, candidates: { accounts: [accountId], amounts: [fmt(item.amount)] },
    balance: typeof item.balance === 'number' ? fmt(item.balance) : null, balanceCurrency: currency, cardLast4: null, bank: 'monobank', merchant: description,
  };
}

// ---------- configuration ----------

export async function configureMonobank(userId: string, token: string) {
  const t = token.trim();
  if (!/^[A-Za-z0-9_-]{20,}$/.test(t)) throw new IntegrationError('Невірний формат токена monobank.');
  const info = await mono(t, '/personal/client-info');
  const prev = (await getIntegration(userId, 'monobank'))?.config ?? {};
  await upsertIntegration(userId, 'monobank', {
    secret: t, enabled: true, status: 'ok', lastError: null,
    config: { clientName: info.name, accounts: summarize(info.accounts), mapping: prev.mapping ?? {}, cursor: prev.cursor ?? {} },
  });
  return monobankStatus(userId);
}

function summarize(accounts: any[]) {
  return (accounts ?? []).map((a) => ({
    id: a.id, currency: ISO4217[a.currencyCode] ?? String(a.currencyCode), type: a.type, maskedPan: (a.maskedPan ?? [])[0] ?? '', iban: a.iban ?? '', balance: a.balance,
  }));
}

export async function setMonobankMapping(userId: string, mapping: Record<string, string | null>) {
  const row = await getIntegration(userId, 'monobank');
  if (!row) throw new IntegrationError('monobank не підключено');
  const valid = new Set(row.config.accounts.map((a: any) => a.id));
  const appAccounts = (await pool.query('SELECT id, currency FROM accounts WHERE user_id=$1', [userId])).rows;
  const clean: Record<string, string> = {};
  for (const [monoId, appId] of Object.entries(mapping)) {
    if (!appId || !valid.has(monoId)) continue;
    const app = appAccounts.find((a) => a.id === appId);
    const m = row.config.accounts.find((a: any) => a.id === monoId);
    if (!app) throw new IntegrationError('Рахунок не знайдено');
    if (app.currency !== m.currency) throw new IntegrationError(`Валюта картки ${m.maskedPan} (${m.currency}) не збігається з рахунком (${app.currency})`);
    clean[monoId] = appId;
  }
  await mergeConfig(userId, 'monobank', { mapping: clean });
  return monobankStatus(userId);
}

export async function monobankStatus(userId: string) {
  const row = await getIntegration(userId, 'monobank');
  if (!row) return { configured: false };
  const c = row.config;
  return {
    configured: true, enabled: row.enabled, status: row.status, lastError: row.last_error, lastSyncAt: row.last_sync_at,
    clientName: c.clientName, accounts: c.accounts, mapping: c.mapping ?? {}, syncing: running.has(userId),
  };
}

// ---------- sync ----------

const running = new Set<string>();

/** Pulls new statement items for every mapped card (from the per-card cursor, max 31 days back). */
export async function syncMonobank(userId: string, opts: { initialDays?: number } = {}) {
  if (running.has(userId)) return { started: false, reason: 'already running' };
  const row = await getIntegration(userId, 'monobank');
  if (!row || !row.enabled) return { started: false, reason: 'not configured' };
  running.add(userId);
  let added = 0;
  try {
    const token = secretOf(row)!;
    const settings = await getSettings(userId);
    const cur = await currencies();
    const decimalsOf = (c: string) => cur[c]?.decimals ?? 2;
    const mapping: Record<string, string> = row.config.mapping ?? {};
    const cursor: Record<string, number> = { ...(row.config.cursor ?? {}) };
    const ids = Object.keys(mapping);
    for (let i = 0; i < ids.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, STATEMENT_GAP_MS));
      const monoId = ids[i];
      const now = Math.floor(Date.now() / 1000);
      const minFrom = now - 31 * 86400 + 3600;
      const from = Math.max(cursor[monoId] ? cursor[monoId] - 3600 : now - (opts.initialDays ?? 7) * 86400, minFrom);
      const items: any[] = await mono(token, `/personal/statement/${monoId}/${from}/${now}`);
      const { categories } = await parseContext(userId);
      for (const item of items.sort((a, b) => a.time - b.time)) {
        const draft = statementToDraft(item, mapping[monoId], categories, decimalsOf, settings.language);
        const r = await ingest(userId, `monobank ${draft.type === 'expense' ? '−' : '+'}${draft.amount} ${draft.currency} ${draft.comment}`, { source: 'monobank', externalId: `mono:${item.id}`, draft });
        if (!r.alreadyImported) added++;
      }
      cursor[monoId] = now;
      await mergeConfig(userId, 'monobank', { cursor });
    }
    await setStatus(userId, 'monobank', 'ok', null, true);
    return { started: true, added };
  } catch (e: any) {
    await setStatus(userId, 'monobank', e.status === 401 || e.status === 403 ? 'invalid_token' : 'error', String(e.message ?? e));
    throw e;
  } finally {
    running.delete(userId);
  }
}

let timer: NodeJS.Timeout | null = null;
/** Background sync every 10 minutes for all users with monobank connected. */
export function startMonobankScheduler() {
  if (timer) return;
  const tick = async () => {
    const rows = (await pool.query("SELECT user_id FROM integrations WHERE kind='monobank' AND enabled AND status <> 'invalid_token'")).rows;
    for (const r of rows) await syncMonobank(r.user_id).catch((e) => console.error('monobank sync failed', e.message));
  };
  timer = setInterval(() => { tick().catch(() => {}); }, 10 * 60000);
  setTimeout(() => { tick().catch(() => {}); }, 15000);
}
