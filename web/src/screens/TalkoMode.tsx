/**
 * TALKO mode: the phone app is a front end for TALKO CRM finance. Every number is read from
 * TALKO and every new operation is written to TALKO (with TALKO's own confirmation step).
 */
import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, del, get, post, qs } from '../api';
import { Bars, Donut } from '../components/Charts';
import { ErrorBox, Field, Icons, Sheet, fmtDay } from '../components/ui';
import { useT } from '../i18n';
import { money, normalizeAmountInput, todayISO } from '../money';
import * as FQ from '../fileQueue';
import * as SY from '../talkoSync';
import { loadPhoto, detectCorners, cropToPage, pagesToPdf, bytesToBase64, type ScanPage, type Pt } from '../scan';
import type { Op } from '../talkoSync';
// the same voice parser as the server, run on the phone: no waiting for the server or TALKO
import { interpret } from '../../../server/src/engine/commands';
import type { Draft } from '../../../server/src/engine/parser';

interface TAccount { id: string; name: string; type: string; currency: string; balance: string }
interface TCategory { id: string; name: string; type: 'income' | 'expense'; parentId: string | null }
interface TTx { id: string; type: 'income' | 'expense'; amount: string; currency: string; accountId: string; categoryId?: string | null; categoryName: string | null; projectId?: string | null; comment: string; counterparty: string; occurredAt: string; localDate: string; time?: string | null; files?: number }
type Tab = 'expense' | 'income' | 'accounts' | 'feed' | 'menu';

interface Ctx {
  accounts: TAccount[]; totals: Record<string, string>; totalBase: string | null; baseCurrency: string;
  categories: TCategory[]; projects: Array<{ id: string; name: string }>;
  version: number; changed: () => Promise<void>; changedAll: () => Promise<void>; error: string | null;
  outbox: Op[]; syncErr: string | null; enqueue: (op: Op) => void;
  toast: (m: string, err?: boolean) => void;
}
const TC = createContext<Ctx>(null as unknown as Ctx);
const useTalko = () => useContext(TC);

const PALETTE = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767'];

/** Balance change a queued (not yet synced) operation makes. */
function opDeltas(op: Op): Array<[string, number]> {
  if (op.kind === 'add') return [[op.item.accountId, (op.item.type === 'expense' ? -1 : 1) * Number(op.item.amount)]];
  if (op.kind === 'delete') return [[op.item.accountId, (op.item.type === 'expense' ? 1 : -1) * Number(op.item.amount)]];
  if (op.kind === 'transfer') return [[op.body.fromAccountId, -Number(op.body.amount)], [op.body.toAccountId, Number(op.body.amountTo ?? op.body.amount)]];
  if (op.kind === 'edit' && op.body.amount && op.prev) return [[op.prev.accountId, (op.prev.type === 'expense' ? -1 : 1) * (Number(op.body.amount) - Number(op.prev.amount))]];
  return [];
}
function applyDeltas(accounts: TAccount[], deltas: Array<[string, number]>) {
  if (!deltas.length) return accounts;
  const m = new Map<string, number>();
  for (const [id, d] of deltas) m.set(id, (m.get(id) ?? 0) + d);
  return accounts.map((a) => m.has(a.id) ? { ...a, balance: (Math.round((Number(a.balance) + m.get(a.id)!) * 100) / 100).toFixed(2) } : a);
}
type BaseData = Omit<Ctx, 'version' | 'changed' | 'changedAll' | 'toast' | 'error' | 'outbox' | 'syncErr' | 'enqueue'>;
const EMPTY: BaseData = { accounts: [], totals: {}, totalBase: null, baseCurrency: 'UAH', categories: [], projects: [] };
const readCache = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const writeCache = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full */ } };

export function TalkoShell() {
  const { t } = useT();
  const [tab, setTab] = useState<Tab>('expense');
  // the last known TALKO data is shown at once from the phone's memory, then refreshed in the background
  const [data, setDataRaw] = useState<BaseData>(() => readCache('gok.base', EMPTY));
  const setData = useCallback((f: (d: BaseData) => BaseData) => setDataRaw((d) => { const n = f(d); writeCache('gok.base', n); return n; }), []);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [outbox, setOutbox] = useState<Op[]>(SY.ops());
  const [syncErr, setSyncErr] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<{ m: string; err?: boolean } | null>(null);
  const timer = useRef<number>();
  const refreshTimer = useRef<number>();
  const toast = useCallback((m: string, err?: boolean) => { setToastMsg({ m, err }); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setToastMsg(null), err ? 5000 : 2200); }, []);
  const load = useCallback(async () => {
    try {
      const [a, c, p] = await Promise.all([get('/talko/accounts'), get('/talko/categories'), get('/talko/projects')]);
      // while changes wait in the queue TALKO's balances are behind; keep ours and refresh after the queue is sent
      if (SY.ops().length) setData((d) => ({ ...d, categories: c, projects: p }));
      else setData(() => ({ accounts: a.accounts, totals: a.totalsByCurrency, totalBase: a.totalBase, baseCurrency: a.baseCurrency, categories: c, projects: p }));
      setError(null);
    } catch (e: any) { if (!readCache<BaseData>('gok.base', EMPTY).accounts.length) setError(e.message); }
  }, [setData]);
  const loadAccounts = useCallback(async () => {
    try {
      const a = await get('/talko/accounts');
      if (SY.ops().length) return;
      setData((d) => ({ ...d, accounts: a.accounts, totals: a.totalsByCurrency, totalBase: a.totalBase, baseCurrency: a.baseCurrency })); setError(null);
    } catch { /* keep the cached balances */ }
  }, [setData]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => SY.subscribe((e) => {
    setOutbox([...SY.ops()]); setSyncErr(SY.syncError());
    if (e.type === 'done') {
      // the change is in TALKO now: keep it in the shown balances until the next refresh brings TALKO's numbers
      setData((d) => ({ ...d, accounts: applyDeltas(d.accounts, opDeltas(e.op)) }));
    }
    if (e.type === 'failed') toast('TALKO не прийняв зміну: ' + e.message, true);
    if (e.type !== 'change' && !SY.ops().length) {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => { setVersion((v) => v + 1); loadAccounts(); }, 1500);
    }
  }), [setData, loadAccounts, toast]);
  const pendingDeltas = outbox.flatMap(opDeltas);
  const ctx: Ctx = {
    ...data, accounts: applyDeltas(data.accounts, pendingDeltas), version, error, outbox, syncErr,
    enqueue: (op) => SY.enqueue(op),
    // after a write only balances and lists change; categories/projects are reloaded only when they were edited
    changed: async () => { setVersion((v) => v + 1); await loadAccounts(); },
    changedAll: async () => { await load(); setVersion((v) => v + 1); },
    toast,
  };
  const nav: Array<[Tab, string, JSX.Element, string]> = [
    ['expense', t.expenses, Icons.minus, 'expense'], ['income', t.income, Icons.plus, 'income'], ['accounts', t.accounts, Icons.wallet, ''],
    ['feed', t.feed, Icons.list, ''], ['menu', t.menu, Icons.menu, ''],
  ];
  return (
    <TC.Provider value={ctx}>
      <main className="app">
        {error && <div className="error" style={{ marginTop: 12 }}>{error}</div>}
        {(tab === 'expense' || tab === 'income') && <TEntry key={tab} type={tab} />}
        {tab === 'accounts' && <TAccounts />}
        {tab === 'feed' && <TFeed />}
        {tab === 'menu' && <TMenu />}
      </main>
      <nav className="nav">
        {nav.map(([key, label, icon, cls]) => (
          <button key={key} className={(tab === key ? 'active ' : '') + cls} onClick={() => setTab(key)}>{icon}<span>{label}</span></button>
        ))}
      </nav>
      {toastMsg && <div className={'toast' + (toastMsg.err ? ' err' : '')} role="status">{toastMsg.m}</div>}
    </TC.Provider>
  );
}

function useAsyncT<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, set] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  useEffect(() => {
    let alive = true;
    set((s) => ({ ...s, loading: true }));
    fn().then((d) => alive && set({ data: d, error: null, loading: false })).catch((e) => alive && set({ data: null, error: e.message, loading: false }));
    return () => { alive = false; };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

// ---------- create operation (with TALKO confirmation) ----------

function TxSheet({ type, amount, accountId, categoryId, comment, onClose, title }: { type: 'income' | 'expense'; amount: string; accountId: string; categoryId: string; comment?: string; title?: string; onClose: () => void }) {
  const { t } = useT();
  const { accounts, categories, projects, toast, enqueue } = useTalko();
  const [f, setF] = useState({ type, amount, accountId, categoryId, projectId: '', description: comment ?? '', counterparty: '', date: todayISO() });
  const [pending, setPending] = useState<{ token: string; preview: unknown } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cats = categories.filter((c) => c.type === f.type);
  // personal categories (and ПВ) first, like the entry screen; «Усі статті» shows the business ones too
  const [allCats, setAllCats] = useState(false);
  const mine = mainCategories(categories, f.type);
  const mineIds = new Set(mine.map((c) => c.id));
  const ordered = allCats
    ? cats.filter((c) => !c.parentId || !cats.some((p) => p.id === c.parentId)).flatMap((p) => [p, ...cats.filter((c) => c.parentId === p.id)])
    : [...mine, ...cats.filter((c) => c.parentId && mineIds.has(c.parentId) && !mineIds.has(c.id)), ...cats.filter((c) => c.id === f.categoryId && !mineIds.has(c.id) && !(c.parentId && mineIds.has(c.parentId)))];
  const valid = /^\d+([.,]\d{1,2})?$/.test(f.amount.trim()) && Number(normalizeAmountInput(f.amount)) > 0 && f.accountId && f.categoryId;
  // saved in the app at once; sent to TALKO by the background queue
  async function submit(_token?: string) {
    const a = accounts.find((x) => x.id === f.accountId);
    if (!a) return;
    const n = normalizeAmountInput(f.amount);
    const now = new Date();
    const tmpId = 'tmp-' + SY.uid();
    enqueue({ id: SY.uid(), kind: 'add', tmpId, at: now.toISOString(), tries: 0,
      body: { type: f.type, amount: n, accountId: f.accountId, categoryId: f.categoryId, projectId: f.projectId || null, description: f.description, date: f.date },
      item: { id: tmpId, type: f.type, amount: n, currency: a.currency, accountId: f.accountId, categoryName: categories.find((c) => c.id === f.categoryId)?.name ?? '', comment: f.description, counterparty: '', occurredAt: now.toISOString(), localDate: f.date, time: f.date === todayISO() ? now.toTimeString().slice(0, 5) : null } });
    toast(t.saved); onClose();
  }
  void setPending; void setBusy; void setError;
  const acc = accounts.find((a) => a.id === f.accountId);
  return (
    <Sheet title={title ?? (f.type === 'expense' ? t.expense : t.incomeOne)} onClose={onClose}>
      {pending ? (
        <>
          <div className="warn">TALKO просить підтвердити запис:</div>
          <div className="answer" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>{typeof pending.preview === 'string' ? pending.preview : `${f.type === 'expense' ? '−' : '+'}${money(normalizeAmountInput(f.amount), acc?.currency)} · ${acc?.name} · ${cats.find((c) => c.id === f.categoryId)?.name}${f.description ? ' · ' + f.description : ''}`}</div>
          <ErrorBox error={error} />
          <div className="actions">
            <button className="btn" onClick={() => setPending(null)}>{t.edit}</button>
            <button className={'btn ' + (f.type === 'expense' ? 'expense' : 'income')} disabled={busy} onClick={() => submit(pending.token)}>{t.confirm}</button>
          </div>
        </>
      ) : (
        <>
          <div className="grid2 stack">
            <Field label={`${t.amount}${acc ? ', ' + acc.currency : ''}`}><input className="input num" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} style={{ fontSize: 22, fontWeight: 700 }} /></Field>
            <Field label={t.account}>
              <select className="input" value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })}>
                <option value="">{t.chooseAccount}</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {money(a.balance, a.currency)}</option>)}
              </select>
            </Field>
          </div>
          <Field label={t.category}>
            <div className="chips" style={{ flexWrap: 'wrap' }}>
              {ordered.map((c) => <button key={c.id} className={'chip' + (f.categoryId === c.id ? ' on' : '')} onClick={() => setF({ ...f, categoryId: c.id })}>{allCats && c.parentId ? '↳ ' : ''}{c.name}</button>)}
              <button className="chip" onClick={() => setAllCats(!allCats)}>{allCats ? 'Лише мої' : 'Усі статті…'}</button>
            </div>
          </Field>
          <Field label={t.comment}><div className="m-micwrap"><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={500} /><MicButton value={f.description} onChange={(v) => setF((x: any) => ({ ...x, description: v.slice(0, 500) }))} /></div></Field>
          <div className="grid2 stack">
            <Field label={t.project}>
              <select className="input" value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })}>
                <option value="">{t.none}</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label={t.date}><input className="input" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
          </div>
          <ErrorBox error={error} />
          <div className="actions m-sticky"><button className={'btn ' + (f.type === 'expense' ? 'expense' : 'income')} disabled={!valid || busy} onClick={() => submit()}>{valid ? `${t.save} · ${money(normalizeAmountInput(f.amount), acc?.currency)}` : 'Оберіть рахунок і статтю'}</button></div>
        </>
      )}
    </Sheet>
  );
}

// ---------- expense / income entry ----------

/** Emoji icon for a TALKO category name (Деньги ОК style colored icons). */
export function catIcon(name: string): string {
  const n = name.toLowerCase();
  const map: Array<[RegExp, string]> = [
    [/пв-?\s*\d|будів|об.?єкт/, '🏗️'], [/продукт|їж/, '🛒'], [/кафе|ресторан/, '☕'], [/авто/, '🚗'], [/транспорт|таксі/, '🚌'],
    [/житл|дім|оренд|комунал/, '🏠'], [/здоров|аптек|лік/, '💊'], [/сім/, '👨‍👩‍👧'], [/хімі/, '🧴'], [/тварин/, '🐾'],
    [/відряд/, '🧳'], [/zeekr|зікр|мийк/, '🚘'], [/меб|техн/, '🛋️'], [/хобі|хобб/, '🎨'], [/одяг|взут/, '👕'], [/ремонт/, '🔨'], [/комунал|світл|газ|вод/, '💡'], [/діт|дит|нік/, '🧒'], [/спорт/, '⚽'], [/зв.?яз|телефон|інтернет/, '📱'], [/відпоч|подорож/, '🏖️'], [/дивід/, '💰'], [/дохід|доход|надходж|виручк/, '💵'], [/камінь/, '💎'], [/подар/, '🎁'], [/податк/, '🧾'],
    [/зарплат/, '👷'], [/реклам|маркет/, '📣'], [/навчан|освіт/, '📚'], [/банк|комісі|еквайр/, '🏦'], [/інвест/, '📈'], [/повернен|списан/, '↩️'],
  ];
  return map.find(([re]) => re.test(n))?.[1] ?? '•';
}

/** Categories shown as big buttons: the personal ones and construction objects; the rest sit behind «Всі статті». */
function mainCategories(cats: TCategory[], type: 'income' | 'expense') {
  const own = cats.filter((c) => c.type === type);
  const personalRoot = own.filter((c) => !c.parentId && /особист/i.test(c.name)).map((c) => c.id);
  const main = own.filter((c) => (c.parentId && personalRoot.includes(c.parentId)) || /пв-?\s*\d/i.test(c.name));
  return main.length ? main : own.filter((c) => !c.parentId);
}

/** Folders: categories that contain other categories, plus empty folders created in this app. */
function folderIds(cats: TCategory[]): Set<string> {
  const ids = new Set(cats.filter((c) => c.parentId).map((c) => c.parentId as string));
  try { for (const id of JSON.parse(localStorage.getItem('gok.folders') ?? '[]')) ids.add(id); } catch { /* ignore */ }
  return ids;
}
function rememberFolder(id: string) {
  try { const a = JSON.parse(localStorage.getItem('gok.folders') ?? '[]'); if (!a.includes(id)) localStorage.setItem('gok.folders', JSON.stringify([...a, id])); } catch { /* ignore */ }
}
/** The personal root («Особисті витрати» / «Особисті доходи») that new folders go under. */
function personalRoot(cats: TCategory[], type: 'income' | 'expense') {
  return cats.find((c) => c.type === type && !c.parentId && /особист/i.test(c.name)) ?? null;
}

/** Calculator line «1200+350×2» → "1900" (×÷ before +−). Returns null while incomplete. */
function evalExpr(expr: string): string | null {
  const toks = expr.replace(/,/g, '.').match(/\d+(?:\.\d+)?|[+\-×÷]/g);
  if (!toks || /[+\-×÷]$/.test(expr)) return null;
  const out: Array<number | string> = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === '×' || t === '÷') { const a = out.pop() as number; const b = Number(toks[++i]); out.push(t === '×' ? a * b : b ? a / b : NaN); }
    else out.push(/[+\-]/.test(t) ? t : Number(t));
  }
  let r = out[0] as number;
  for (let i = 1; i < out.length; i += 2) r = out[i] === '+' ? r + (out[i + 1] as number) : r - (out[i + 1] as number);
  if (!Number.isFinite(r)) return null;
  return String(Math.round(r * 100) / 100).replace('.', ',');
}

const PAGE = 4;
/** A queued change laid over an entry, so the screen shows it before TALKO has it. */
function applyEdit(x: TTx, o: Extract<Op, { kind: 'edit' }>): TTx {
  return { ...x, ...(o.body.description !== undefined ? { comment: o.body.description } : {}), ...(o.body.date ? { localDate: o.body.date } : {}),
    ...(o.body.categoryId ? { categoryId: o.body.categoryId, categoryName: o.categoryName ?? x.categoryName } : {}), ...(o.body.amount ? { amount: o.body.amount } : {}), ...(o.body.time ? { time: o.body.time } : {}) };
}
/** YYYY-MM-DD of today + offset days, in the phone's time zone. */
function isoDay(offset = 0) { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function sumByCurrency(list: TTx[]) {
  const m: Record<string, number> = {};
  for (const x of list) m[x.currency] = Math.round(((m[x.currency] ?? 0) + Number(x.amount)) * 100) / 100;
  return Object.entries(m).map(([c, v]) => money(v.toFixed(2), c)).join(' + ');
}

function TEntry({ type }: { type: 'income' | 'expense' }) {
  const { t } = useT();
  const { accounts, categories, version, toast, outbox, syncErr, enqueue } = useTalko();
  const [expr, setExpr] = useState('');
  const [accountId, setAccountId] = useState(() => { try { return localStorage.getItem('gok.talko.acc.' + type) ?? ''; } catch { return ''; } });
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [folder, setFolder] = useState<string | null>(null);
  const busy = false;
  const [voice, setVoice] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [hist, setHist] = useState(false);
  const [accPick, setAccPick] = useState(false);
  const [openTx, setOpenTx] = useState<TTx | null>(null);
  const voiceComment = useRef('');
  const [edit, setEdit] = useState<{ id: string; kind: 'comment' | 'date'; value: string } | null>(null);
  useEffect(() => { if (accounts.length && !accounts.some((a) => a.id === accountId)) setAccountId(accounts[0].id); }, [accounts, accountId]);
  // today's list: shown at once from the phone's memory, refreshed from TALKO in the background,
  // with queued (not yet synced) changes laid on top
  const cacheKey = 'gok.today.' + type;
  const [base, setBaseRaw] = useState<TTx[]>(() => { const c = readCache<{ d: string; items: TTx[] }>(cacheKey, { d: '', items: [] }); return c.d === todayISO() ? c.items : []; });
  const setBase = useCallback((f: (b: TTx[]) => TTx[]) => setBaseRaw((b) => { const n = f(b); writeCache(cacheKey, { d: todayISO(), items: n }); return n; }), [cacheKey]);
  useEffect(() => {
    let alive = true;
    get('/talko/transactions' + qs({ from: isoDay(-1), to: todayISO(), type }))
      .then((r) => { if (alive && !SY.ops().length) setBase(() => r.items ?? []); })
      .catch(() => { /* offline: keep what we have */ });
    return () => { alive = false; };
  }, [version, type, setBase]);
  useEffect(() => SY.subscribe((e) => {
    if (e.type !== 'done') return;
    const op = e.op;
    if (op.kind === 'add' && op.item.type === type && op.item.localDate >= isoDay(-1)) {
      const id = e.realId ?? op.tmpId;
      setBase((b) => [{ ...op.item, id }, ...b.filter((x) => x.id !== id)]);
      setSel((s) => s === op.tmpId ? id : s);
    }
    if (op.kind === 'delete') setBase((b) => b.filter((x) => x.id !== op.txId));
    if (op.kind === 'edit') setBase((b) => b.map((x) => x.id !== op.txId ? x : { ...x, ...(op.body.description !== undefined ? { comment: op.body.description } : {}), ...(op.body.date ? { localDate: op.body.date } : {}) }).filter((x) => x.localDate >= isoDay(-1)));
  }), [type, setBase]);
  const deleting = new Set<string>(outbox.flatMap((o) => o.kind === 'delete' ? [o.txId] : []));
  const editsOf = (id: string) => outbox.filter((o): o is Extract<Op, { kind: 'edit' }> => o.kind === 'edit' && o.txId === id);
  const pendingIds = new Set<string>(outbox.flatMap((o) => o.kind === 'add' ? [o.tmpId] : 'txId' in o ? [o.txId] : []));
  const items: TTx[] = [
    ...outbox.flatMap((o) => o.kind === 'add' && o.item.type === type ? [{ ...o.item, id: o.tmpId }] : []),
    ...base,
  ].filter((x) => !deleting.has(x.id))
    .map((x) => editsOf(x.id).reduce((a, o) => applyEdit(a, o), x))
    .filter((x) => x.localDate >= isoDay(-1))
    .sort((a, b) => String(b.localDate).localeCompare(String(a.localDate)) || String(b.time ?? '').localeCompare(String(a.time ?? '')));
  const exp = type === 'expense';
  const amount = /[+\-×÷]/.test(expr) ? (evalExpr(expr) ?? '') : expr;
  const hasAmount = /[1-9]/.test(amount);
  const press = (k: string) => setExpr((a) => {
    if (k === '⌫') return a.slice(0, -1);
    if (k === '=') return evalExpr(a) ?? a;
    if ('+-×÷'.includes(k)) return !a ? a : /[+\-×÷]$/.test(a) ? a.slice(0, -1) + k : a + k;
    const last = a.split(/[+\-×÷]/).pop() ?? '';
    if (k === ',') return last.includes(',') ? a : a + (last ? ',' : '0,');
    if (last.includes(',') && last.split(',')[1].length >= 2) return a;
    if (a.length >= 24) return a;
    return last === '0' ? a.slice(0, -1) + k : a + k;
  });
  // the first four accounts as tiles; the chosen one is always among them (like «Деньги ОК»)
  const first = accounts.slice(0, PAGE);
  const chosen = accounts.find((a) => a.id === accountId);
  const shown = chosen && !first.some((a) => a.id === chosen.id) ? [...first.slice(0, PAGE - 1), chosen] : first;
  void page; void setPage;
  const folders = folderIds(categories);
  const cats = folder ? [...categories.filter((c) => c.id === folder), ...categories.filter((c) => c.parentId === folder)] : mainCategories(categories, type).filter((c) => !c.parentId || !folders.has(c.parentId) || !mainCategories(categories, type).some((m) => m.id === c.parentId));
  const folderName = folder ? categories.find((c) => c.id === folder)?.name : null;
  const todayTotal = items.filter((x) => x.localDate === todayISO()).reduce((s: Record<string, number>, x: TTx) => ({ ...s, [x.currency]: Math.round(((s[x.currency] ?? 0) + Number(x.amount)) * 100) / 100 }), {});
  const totalTxt = Object.entries(todayTotal).map(([c, v]) => money((v as number).toFixed(2), c)).join(' + ') || money('0', 'UAH');
  const pick = (id: string) => {
    if (id !== folder && folders.has(id) && categories.some((c) => c.parentId === id)) { setAll(false); setFolder(id); return; }
    if (!hasAmount || busy) return; setAll(false);
    if (longPressed.current) { longPressed.current = false; setOpen(id); return; }
    void quickSave(id);
  };
  /** One tap on a category records the expense right away (the tap is the confirmation), like «Деньги ОК». */
  function quickSave(categoryId: string) {
    const acc = accounts.find((a) => a.id === accountId);
    if (!acc) return;
    const n = normalizeAmountInput(amount);
    const cat = categories.find((c) => c.id === categoryId)?.name ?? '';
    const now = new Date();
    const tmpId = 'tmp-' + SY.uid();
    const item: TTx = { id: tmpId, type, amount: n, currency: acc.currency, accountId, categoryName: cat, comment: '', counterparty: '', occurredAt: now.toISOString(), localDate: todayISO(), time: now.toTimeString().slice(0, 5) };
    const description = voiceComment.current; voiceComment.current = '';
    enqueue({ id: SY.uid(), kind: 'add', tmpId, at: now.toISOString(), tries: 0, body: { type, amount: n, accountId, categoryId, projectId: null, description, date: todayISO() }, item: { ...item, comment: description } });
    setSel(tmpId); setExpr(''); setFolder(null);
  }
  /** Voice: a full phrase («100 Приват кава») is saved at once; otherwise the amount and account are filled in and you tap the category. */
  function fromVoice(d: Draft): boolean {
    if ((d.type ?? type) !== type || !d.amount) return false;
    const n = normalizeAmountInput(d.amount);
    const accId = d.accountId ?? accountId;
    const acc = accounts.find((a) => a.id === accId);
    const day = d.occurredAt ? (() => { const x = new Date(d.occurredAt!); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; })() : todayISO();
    if (acc && d.categoryId) {
      const now = new Date();
      const tmpId = 'tmp-' + SY.uid();
      const cat = categories.find((c) => c.id === d.categoryId)?.name ?? '';
      enqueue({ id: SY.uid(), kind: 'add', tmpId, at: now.toISOString(), tries: 0,
        body: { type, amount: n, accountId: acc.id, categoryId: d.categoryId, projectId: null, description: d.comment ?? '', date: day },
        item: { id: tmpId, type, amount: n, currency: acc.currency, accountId: acc.id, categoryName: cat, comment: d.comment ?? '', counterparty: '', occurredAt: now.toISOString(), localDate: day, time: now.toTimeString().slice(0, 5) } });
      setSel(tmpId);
      toast(`Записано: ${money(n, acc.currency)} · ${cat} · ${acc.name}`);
      return true;
    }
    if (d.accountId) setAccountId(d.accountId);
    voiceComment.current = d.comment ?? '';
    setExpr(n.replace('.', ','));
    toast('Сума ' + money(n, acc?.currency ?? 'UAH') + ' — оберіть статтю');
    return true;
  }
  function moveDate(i: TTx, date: string) {
    if (sel === i.id) setSel(null);
    enqueue({ id: SY.uid(), kind: 'edit', txId: i.id, at: new Date().toISOString(), tries: 0, body: { date } });
    toast(`Перенесено на ${date.split('-').reverse().slice(0, 2).join('.')}: ${i.categoryName ?? ''} ${money(i.amount, i.currency)}`);
  }
  function saveEdit() {
    if (!edit) return;
    const e0 = edit;
    setEdit(null);
    if (e0.kind === 'date') { const it = items.find((x) => x.id === e0.id); if (it && e0.value !== todayISO()) { moveDate(it, e0.value); return; } }
    // the bank time lives in the comment (TALKO keeps only the day): keep it when the comment is rewritten
    const it = items.find((x) => x.id === e0.id);
    const keepTime = e0.kind === 'comment' && !!it?.time && new RegExp(TIME_RE).test(it?.comment ?? '') && !new RegExp(TIME_RE).test(e0.value);
    const description = keepTime ? `${e0.value.trim()} (${it!.time})`.trim() : e0.value;
    enqueue({ id: SY.uid(), kind: 'edit', txId: e0.id, at: new Date().toISOString(), tries: 0, body: e0.kind === 'comment' ? { description } : { date: e0.value } });
  }
  // long press on a category opens the full form (comment, date, project)
  const longPressed = useRef(false);
  const pressTimer = useRef<number | null>(null);
  const holdStart = () => { longPressed.current = false; pressTimer.current = window.setTimeout(() => { longPressed.current = true; }, 550); };
  const holdEnd = () => { if (pressTimer.current) window.clearTimeout(pressTimer.current); };
  return (
    <div className={'m-entry ' + (exp ? 'exp' : 'inc')}>
      <div className="m-head">
        <button className="m-hbtn" onClick={() => setVoice(true)} aria-label={t.voice}>{Icons.mic}</button>
        <div className="m-title">{exp ? t.expenses : t.income}</div>
        {outbox.length
          ? <button className={'m-hbtn m-sync' + (syncErr ? ' err' : '')} onClick={() => { SY.kick(); if (syncErr) toast(syncErr, true); }} aria-label="Синхронізація з TALKO">⟳<small>{outbox.length}</small></button>
          : <span className="m-hbtn m-sync ok" title="Усе в TALKO">✓</span>}
      </div>
      <div className={'m-amount' + (expr ? '' : ' ph')}>
        <span className="m-amount-txt num">{expr ? expr : t.enterAmount}</span>
        {expr && /[+\-×÷]/.test(expr) && amount && <span className="m-amount-res num">= {amount}</span>}
        {expr && <button className="m-clear" onClick={() => { setExpr(''); voiceComment.current = ''; }} aria-label="Очистити">✕</button>}
      </div>
      <div className="m-accs">
        <div className="m-acc-grid">
          {shown.map((a) => (
            <button key={a.id} className={'m-acc' + (a.id === accountId ? ' on' : '')} onClick={() => { setAccountId(a.id); try { localStorage.setItem('gok.talko.acc.' + type, a.id); } catch { /* ignore */ } }}>
              <span className="n ellipsis">{a.name}</span><span className="b num">{money(a.balance, a.currency)}</span>
            </button>
          ))}
        </div>
        {accounts.length > PAGE && <button className="m-acc-next" onClick={() => setAccPick(true)} aria-label="Усі рахунки">›</button>}
      </div>
      <div className="m-strip">{exp ? 'Витрачено сьогодні' : 'Отримано сьогодні'}: <b className="num">{totalTxt}</b></div>
      <div className="m-mid">
        {hasAmount ? (
          <div className="m-cats">
            {folder
              ? <button className="m-cat" onClick={() => setFolder(null)}><span className="ic all">‹</span><span className="lbl">Назад</span></button>
              : <button className="m-cat" onClick={() => setAll(true)}><span className="ic all">☰</span><span className="lbl">Всі статті</span></button>}
            {cats.map((c) => (
              <button key={c.id} className="m-cat" disabled={busy} onClick={() => pick(c.id)} onPointerDown={holdStart} onPointerUp={holdEnd} onPointerLeave={holdEnd} onContextMenu={(e) => e.preventDefault()}>
                <span className={'ic' + (folders.has(c.id) && c.id !== folder ? ' folder' : '')}>{folders.has(c.id) && c.id !== folder ? '📁' : catIcon(c.name)}</span>
                <span className="lbl">{c.name.replace(/^Витрати\s+/i, '')}</span>
                {folderName && <span className="sub">{c.id === folder ? 'уся папка' : folderName}</span>}
              </button>
            ))}
            <div className="m-hint">{busy ? 'Записую в TALKO…' : 'Натисніть статтю — витрата запишеться. Утримайте — додати коментар чи дату.'}</div>
          </div>
        ) : (
          <div>
          <TxList items={items} compact dayHeads selected={sel} pending={pendingIds} onSelect={(id) => { setSel(id); const it = items.find((x) => x.id === id); if (it) setOpenTx(it); }}
            onYesterday={(i) => {
              const d = new Date(); d.setDate(d.getDate() - 1);
              moveDate(i, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
            }}
            onDate={(i) => setEdit({ id: i.id, kind: 'date', value: i.localDate ?? todayISO() })}
            onDelete={async (i) => {
              if (sel === i.id) setSel(null);
              enqueue({ id: SY.uid(), kind: 'delete', txId: i.id, at: new Date().toISOString(), tries: 0, item: i });
            }}
            />
          <button className="m-histlink" onClick={() => setHist(true)}>Історія</button>
          </div>
        )}
      </div>
      <div className="m-pad">
        <div className="m-ops">{['÷', '×', '-', '+', '='].map((k) => <button key={k} onClick={() => press(k)}>{k === '-' ? '−' : k}</button>)}</div>
        <div className="m-keys">
          {[['1', ''], ['2', 'АБВГ'], ['3', 'ДЕЖЗ'], ['4', 'ИЙКЛ'], ['5', 'МНОП'], ['6', 'РСТУ'], ['7', 'ФХЦЧ'], ['8', 'ШЩЬЫ'], ['9', 'ЭЮЯ'], [',', ''], ['0', ''], ['⌫', '']].map(([k, sub]) => (
            <button key={k} className={k === ',' || k === '⌫' ? 'fn' : ''} onClick={() => press(k)} aria-label={k === '⌫' ? 'Backspace' : k}>
              {k === '⌫' ? <span style={{ display: 'grid', placeItems: 'center' }}>{Icons.backspace}</span> : <><span className="d">{k}</span>{sub && <span className="s">{sub}</span>}</>}
            </button>
          ))}
        </div>
      </div>
      {all && (
        <Sheet title="Всі статті" onClose={() => setAll(false)}>
          <FolderManager type={type} />
          <div className="m-cats">
            {categories.filter((c) => c.type === type).map((c) => (
              <button key={c.id} className="m-cat" onClick={() => pick(c.id)}><span className="ic">{catIcon(c.name)}</span><span className="lbl">{c.name}</span></button>
            ))}
          </div>
        </Sheet>
      )}
      {open && <TxSheet type={type} amount={amount.replace(',', '.')} accountId={accountId} categoryId={open} onClose={() => { setOpen(null); setExpr(''); setFolder(null); }} />}
      {voice && <TVoice defaultType={type} onClose={() => setVoice(false)} onDraft={fromVoice} />}
      {hist && <THistory type={type} onClose={() => setHist(false)} />}
      {openTx && <TEditTx tx={items.find((x) => x.id === openTx.id || x.id === SY.realIdOf(openTx.id)) ?? openTx} onClose={() => setOpenTx(null)} />}
      {accPick && <div className="m-hist"><AccountPicker title="Рахунки" value={accountId} onPick={(id) => { setAccountId(id); try { localStorage.setItem('gok.talko.acc.' + type, id); } catch { /* ignore */ } }} onClose={() => setAccPick(false)} /></div>}
      {edit && (
        <div className="m-modal" onClick={() => setEdit(null)}>
          <div className="m-modal-box" onClick={(e) => e.stopPropagation()}>
            {edit.kind === 'comment'
              ? <div className="m-micwrap">
                  <textarea className="input" rows={4} placeholder="Коментар — надиктуйте або напишіть" value={edit.value} maxLength={500} onChange={(e) => setEdit({ ...edit, value: e.target.value })} />
                  <MicButton auto value={edit.value} onChange={(v) => setEdit((x) => x ? { ...x, value: v.slice(0, 500) } : x)} />
                </div>
              : <input autoFocus type="date" className="input" value={edit.value} max={todayISO()} onChange={(e) => setEdit({ ...edit, value: e.target.value })} />}
            <div className="m-modal-btns">
              {edit.kind === 'comment' && <button onClick={() => setEdit({ ...edit, value: '' })}>Очистити</button>}
              <button onClick={() => setEdit(null)} aria-label="Скасувати">✕</button>
              <button className="ok" disabled={busy || (edit.kind === 'date' && !edit.value)} onClick={saveEdit} aria-label="Зберегти">✓</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Group categories into folders: create a folder, move a category into it (TALKO asks to confirm). */
function FolderManager({ type }: { type: 'income' | 'expense' }) {
  const { categories, changedAll, toast } = useTalko();
  const [openMgr, setOpenMgr] = useState(false);
  const [name, setName] = useState('');
  const [pending, setPending] = useState<{ catId: string; parentId: string | null; token: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = personalRoot(categories, type);
  const own = categories.filter((c) => c.type === type);
  const folders = folderIds(categories);
  const folderList = own.filter((c) => folders.has(c.id) && c.id !== root?.id);
  const movable = own.filter((c) => !folders.has(c.id) && c.id !== root?.id && (c.parentId === root?.id || folders.has(c.parentId ?? '') || /пв-?\s*\d/i.test(c.name)));
  const nameOf = (id: string | null) => (id ? own.find((c) => c.id === id)?.name : null) ?? 'Без папки';
  async function create() {
    if (!name.trim()) return;
    setBusy(true); setError(null);
    try {
      const r = await post('/talko/categories', { name: name.trim(), type, parentId: root?.id ?? null });
      if (r.id) rememberFolder(r.id);
      setName(''); await changedAll(); toast('Папку створено в TALKO');
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  async function move(catId: string, parentId: string | null, token?: string) {
    setBusy(true); setError(null);
    try {
      const r = await api('PATCH', '/talko/categories/' + encodeURIComponent(catId), { parentId, confirmationToken: token });
      if (r.status === 'needs_confirmation') { setPending({ catId, parentId, token: r.confirmationToken }); return; }
      setPending(null); await changedAll(); toast('Перенесено в TALKO');
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  if (!openMgr) return <button className="btn small" style={{ marginBottom: 10 }} onClick={() => setOpenMgr(true)}>📁 Папки статей</button>;
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <input className="input grow" placeholder="Назва нової папки, напр. Дом" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        <button className="btn small primary" disabled={busy || !name.trim()} onClick={create}>Створити</button>
      </div>
      {pending && (
        <div className="warn" style={{ marginBottom: 8 }}>
          Перенести «{nameOf(pending.catId)}» у «{pending.parentId === root?.id ? 'Без папки' : nameOf(pending.parentId)}»? Зміниться і в TALKO.
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn small" onClick={() => setPending(null)}>Скасувати</button>
            <button className="btn small primary" disabled={busy} onClick={() => move(pending.catId, pending.parentId, pending.token)}>Підтвердити</button>
          </div>
        </div>
      )}
      {error && <div className="error" style={{ marginBottom: 8 }}>{error}</div>}
      <div className="list">
        {movable.map((c) => (
          <div key={c.id} className="item">
            <span className="ic">{catIcon(c.name)}</span>
            <div className="main"><div className="t1">{c.name}</div></div>
            <select className="input" style={{ width: 150, minHeight: 36, padding: '6px 8px' }} value={c.parentId && folders.has(c.parentId) && c.parentId !== root?.id ? c.parentId : ''} disabled={busy}
              onChange={(e) => move(c.id, e.target.value || root?.id || null)}>
              <option value="">Без папки</option>
              {folderList.map((f) => <option key={f.id} value={f.id}>📁 {f.name}</option>)}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}

const TIME_RE = '(?:[01]?\\d|2[0-3]):[0-5]\\d';
/**
 * Comment as shown under an entry: without what the row already shows — the category, the account
 * and the time (e.g. «Продукти (Дом, 13:34)» → nothing, «Кафе — Кондитерська» → «Кондитерська»).
 */
function cleanComment(c: string | null | undefined, cat?: string | null, acc?: string | null) {
  let x = String(c ?? '').trim();
  const lc = (v: unknown) => String(v ?? '').toLowerCase().trim();
  // «готівка» is already said by the cash account (Мої гроші, Дом)
  x = x.replace(/\s*[—–-]?\s*(?<!\p{L})готівк(?:а|ою|ова)(?!\p{L})/giu, '');
  const isNoise = (p: string) => { const q = lc(p).replace(/у\s*«?деньги ок»?/g, '').replace(new RegExp(TIME_RE, 'g'), '').trim(); return !q || q === lc(acc) || q === lc(cat); };
  x = x.replace(/\s*\(([^()]*)\)/g, (_m, inner: string) => { const keep = inner.split(',').filter((p) => !isNoise(p)); return keep.length ? ` (${keep.map((p) => p.trim()).join(', ')})` : ''; });
  x = x.replace(new RegExp(`\\s+${TIME_RE}$`), '').trim();
  const m = x.match(/^([^—–:,-]+?)\s*[—–:-]\s+(.+)$/);
  if (m && cat && (lc(m[1]) === lc(cat) || (lc(m[1]).length >= 4 && lc(cat).startsWith(lc(m[1]))))) x = m[2].trim();
  if ([lc(cat), lc(acc), '—'].includes(lc(x))) return '';
  return x;
}

function TxList({ items, compact, dayHeads, selected, onSelect, actions, onDelete, onYesterday, onDate, pending }: { items: TTx[]; compact?: boolean; dayHeads?: boolean; pending?: Set<string>; selected?: string | null; onSelect?: (id: string) => void; actions?: (i: TTx) => React.ReactNode; onDelete?: (i: TTx) => Promise<void>; onYesterday?: (i: TTx) => void; onDate?: (i: TTx) => void }) {
  const { t, lang } = useT();
  const { accounts } = useTalko();
  // Swipe like iPhone: the row follows the finger. Left — a red «Видалити» shows behind it; let go past ~80px and it
  // stays open (tap it to delete); drag on past half the width and the entry is deleted at once.
  // Right — «Вчора» and «Дата».
  const OPEN_L = 96, OPEN_R = 170;
  const [swiped, setSwiped] = useState<string | null>(null);
  const [swipedR, setSwipedR] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; x: number } | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const touch = useRef<{ id: string; x0: number; y0: number; base: number; lock: 0 | 1 | 2; w: number; last: number } | null>(null);
  const noClickUntil = useRef(0);
  const canL = !!onDelete, canR = !!(onYesterday || onDate);
  const close = () => { setSwiped(null); setSwipedR(null); };
  const remove = (i: TTx) => {
    if (!onDelete) return;
    setGone(i.id); close();
    setTimeout(() => { onDelete(i).finally(() => setGone((g) => (g === i.id ? null : g))); }, 180);
  };
  const sw = canL || canR ? (i: TTx) => ({
    onTouchStart: (e: React.TouchEvent<HTMLDivElement>) => {
      if ((swiped && swiped !== i.id) || (swipedR && swipedR !== i.id)) close();
      const base = swiped === i.id ? -OPEN_L : swipedR === i.id ? OPEN_R : 0;
      touch.current = { id: i.id, x0: e.touches[0].clientX, y0: e.touches[0].clientY, base, lock: 0, w: e.currentTarget.getBoundingClientRect().width || 360, last: base };
    },
    onTouchMove: (e: React.TouchEvent<HTMLDivElement>) => {
      const st = touch.current; if (!st || st.id !== i.id) return;
      const dx = e.touches[0].clientX - st.x0, dy = e.touches[0].clientY - st.y0;
      if (!st.lock) { if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return; st.lock = Math.abs(dx) > Math.abs(dy) ? 1 : 2; }
      if (st.lock !== 1) return;
      let x = st.base + dx;
      x = Math.min(canR ? OPEN_R + 30 : 0, Math.max(canL ? -st.w : 0, x));
      st.last = x; setDrag({ id: i.id, x });
    },
    onTouchEnd: () => {
      const st = touch.current; touch.current = null;
      if (!st || st.id !== i.id || st.lock !== 1) return;
      noClickUntil.current = Date.now() + 350;
      setDrag(null);
      const x = st.last;
      if (canL && x < -st.w * 0.5) { remove(i); return; }
      if (canL && x < -40) { setSwiped(i.id); setSwipedR(null); return; }
      if (canR && x > 60) { setSwipedR(i.id); setSwiped(null); return; }
      close();
    },
  }) : () => ({});
  if (!items.length) return <div className="empty">{t.nothing}</div>;
  const days: Array<[string, TTx[]]> = [];
  for (const i of items) { const l = days[days.length - 1]; if (l && l[0] === i.localDate) l[1].push(i); else days.push([i.localDate, [i]]); }
  return (
    <>
      {days.map(([d, list]) => (
        <div key={d}>
          {!compact && <div className="day-head"><span>{fmtDay(d, lang, t)}</span><span className="num">{sumByCurrency(list)}</span></div>}
          {compact && dayHeads && d !== todayISO() && <div className="m-day">{d === isoDay(-1) ? (list[0]?.type === 'income' ? 'Отримано вчора' : 'Витрачено вчора') : fmtDay(d, lang, t)}: <b className="num">{sumByCurrency(list)}</b></div>}
          <div className="list">
            {list.map((i) => {
              const x = gone === i.id ? -2000 : drag?.id === i.id ? drag.x : swiped === i.id ? -OPEN_L : swipedR === i.id ? OPEN_R : 0;
              const full = drag?.id === i.id && x < -((touch.current?.w ?? 360) * 0.5);
              return (
              <div key={i.id} className={'m-sw' + (gone === i.id ? ' gone' : '')}>
                {canL && x < 0 && (
                  <button className={'m-swdel' + (full ? ' full' : '')} aria-label="Видалити" onClick={(e) => { e.stopPropagation(); remove(i); }}>
                    <span>🗑</span><small>Видалити</small>
                  </button>
                )}
                {canR && x > 0 && (
                  <div className="m-left-acts" onClick={(e) => e.stopPropagation()}>
                    {onYesterday && <button className="m-yest" onClick={() => { close(); onYesterday(i); }}>Вчора</button>}
                    {onDate && <button className="m-dt" onClick={() => { close(); onDate(i); }}>Дата</button>}
                  </div>
                )}
                <div className={'item' + (selected === i.id ? ' sel' : '')} {...sw(i)}
                  style={{ transform: x ? `translateX(${x}px)` : undefined, transition: drag?.id === i.id ? 'none' : undefined }}
                  onClick={() => { if (Date.now() < noClickUntil.current) return; if (swiped || swipedR) { close(); return; } onSelect?.(i.id); }}>
                <span className="ic">{catIcon(i.categoryName ?? '')}</span>
                <div className="main"><div className="t1">{i.categoryName || i.comment}</div><div className="t2">{accounts.find((a) => a.id === i.accountId)?.name}</div>{(() => { const c = cleanComment(i.comment, i.categoryName, accounts.find((a) => a.id === i.accountId)?.name); return c && i.categoryName ? <div className="t3">{c}</div> : null; })()}</div>
                <div className={'amt num ' + (i.type === 'expense' ? 'c-expense' : 'c-income')}>{money(i.amount, i.currency)}<small>{pending?.has(i.id) && <span className="m-pend" title="Ще не в TALKO">⟳ </span>}{((i.files ?? 0) > 0 || FQ.pendingFor(i.id).length > 0) && <span title="Є фото або документ">📎 </span>}{i.time ?? ''}</small></div>
                {selected === i.id && actions && <div className="m-actions" onClick={(e) => e.stopPropagation()}>{actions(i)}</div>}
                </div>
              </div>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}

// ---------- accounts + transfers ----------

function TAccounts() {
  const { t } = useT();
  const { accounts, totals, totalBase, baseCurrency } = useTalko();
  const [view, setView] = useState<'accounts' | 'transfers' | 'archive'>(() => (localStorage.getItem('gok.accView') as any) || 'accounts');
  const go = (v: typeof view) => { setView(v); try { localStorage.setItem('gok.accView', v); } catch { /* */ } };
  return (
    <>
      <div className="seg acc-seg">
        <button className={view === 'accounts' ? 'on' : ''} onClick={() => go('accounts')}>💳 Рахунки</button>
        <button className={view === 'transfers' ? 'on' : ''} onClick={() => go('transfers')}>⇄ Перекази</button>
        <button className={view === 'archive' ? 'on' : ''} onClick={() => go('archive')}>🗂 Архів</button>
      </div>
      {view === 'accounts' && (<>
        <div className="list acc-list">
          {accounts.map((a) => (
            <div key={a.id} className="item">
              <div className="main"><div className="t1">{a.name}</div></div>
              <div className="amt num c-balance">{money(a.balance, a.currency)}</div>
            </div>
          ))}
        </div>
        <div className="card" style={{ marginTop: 10 }}>
          <div className="faint">{t.netWorth}</div>
          {totalBase && <div className="hero c-balance num">{money(totalBase, baseCurrency)}</div>}
          {Object.entries(totals).map(([c, v]) => <div key={c} className="faint num">{money(v, c)}</div>)}
        </div>
      </>)}
      {view === 'transfers' && <TTransferScreen />}
      {view === 'archive' && <TTransferList days={60} />}
    </>
  );
}

interface TTr { id: number; fromAccountId: string; toAccountId: string; amount: string; amountTo: string | null; description: string; date: string }

function AccountPicker({ title, value, onPick, onClose }: { title: string; value: string; onPick: (id: string) => void; onClose: () => void }) {
  const { accounts } = useTalko();
  return (
    <div className="m-picker">
      <div className="m-picker-top"><button onClick={onClose} aria-label="Назад">‹</button><b>{title}</b><span /></div>
      <div className="list acc-list">
        {accounts.map((a) => (
          <div key={a.id} className="item" onClick={() => { onPick(a.id); onClose(); }}>
            <div className="main"><div className="t1">{a.name}</div></div>
            <div className="amt num c-balance">{money(a.balance, a.currency)}{a.id === value && <span className="m-check"> ✓</span>}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TTransferList({ days }: { days?: number }) {
  const { t, lang } = useT();
  const { accounts, version, outbox } = useTalko();
  const [cached, setCached] = useState<TTr[]>(() => readCache('gok.transfers', [] as TTr[]));
  const list = useAsyncT<TTr[]>(() => get('/talko/transfers').then((r: TTr[]) => { writeCache('gok.transfers', r); setCached(r); return r; }), [version]);
  const name = (id: string) => accounts.find((a) => a.id === id)?.name ?? '—';
  const cur = (id: string) => accounts.find((a) => a.id === id)?.currency ?? 'UAH';
  // queued transfers (not in TALKO yet) on top, marked ⟳
  const queued: TTr[] = outbox.flatMap((o, k) => o.kind === 'transfer' ? [{ id: -1 - k, fromAccountId: o.body.fromAccountId, toAccountId: o.body.toAccountId, amount: o.body.amount, amountTo: o.body.amountTo ?? null, description: '⟳ ' + (o.body.description ?? 'ще не в TALKO'), date: o.body.date ?? todayISO() }] : []);
  const items = [...queued, ...(list.data ?? cached)].slice(0, days ? 200 : 30);
  const groups: Array<[string, TTr[]]> = [];
  for (const x of items) { const g = groups.find((q) => q[0] === x.date); if (g) g[1].push(x); else groups.push([x.date, [x]]); }
  if (list.loading && !list.data && !cached.length && !queued.length) return <div className="faint" style={{ padding: 12 }}>Завантаження…</div>;
  if (!items.length) return <div className="faint" style={{ padding: 12 }}>Переказів, зроблених у застосунку, ще немає.</div>;
  return (
    <div className="m-trlist">
      {groups.map(([d, xs]) => (
        <div key={d}>
          <div className="m-day">{fmtDay(d, lang, t)}</div>
          {xs.map((x) => {
            const fx = x.amountTo && cur(x.fromAccountId) !== cur(x.toAccountId);
            return (
              <div key={x.id} className="m-tr">
                <div><div>{name(x.fromAccountId)} → {name(x.toAccountId)}</div><small>{x.description || fmtDay(d, lang, t)}</small></div>
                <div className="num c-expense">{money(x.amount, cur(x.fromAccountId))}{fx && ` (${money(x.amountTo!, cur(x.toAccountId))})`}</div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function TTransferScreen() {
  const { accounts, toast, enqueue } = useTalko();
  const [fromId, setFromId] = useState(() => localStorage.getItem('gok.tr.from') ?? '');
  const [toId, setToId] = useState(() => localStorage.getItem('gok.tr.to') ?? '');
  const [pick, setPick] = useState<'from' | 'to' | null>(null);
  const [date, setDate] = useState(todayISO());
  const [comment, setComment] = useState('');
  const [amount, setAmount] = useState('');
  const [amountTo, setAmountTo] = useState('');
  const busy = false;
  const from = accounts.find((a) => a.id === fromId); const to = accounts.find((a) => a.id === toId);
  const fx = !!(from && to && from.currency !== to.currency);
  const n = (v: string) => Number(normalizeAmountInput(v));
  const valid = !!(from && to && from.id !== to.id && n(amount) > 0 && (!fx || n(amountTo) > 0));
  const setAcc = (k: 'from' | 'to', id: string) => {
    if (k === 'from') { setFromId(id); try { localStorage.setItem('gok.tr.from', id); } catch { /* */ } }
    else { setToId(id); try { localStorage.setItem('gok.tr.to', id); } catch { /* */ } }
  };
  function submit() {
    if (!valid) return;
    const n = normalizeAmountInput(amount);
    enqueue({ id: SY.uid(), kind: 'transfer', at: new Date().toISOString(), tries: 0, fromCurrency: from!.currency, toCurrency: to!.currency,
      body: { fromAccountId: fromId, toAccountId: toId, amount: n, amountTo: fx ? normalizeAmountInput(amountTo) : undefined, description: comment.trim() || undefined, date: date !== todayISO() ? date : undefined } });
    setAmount(''); setAmountTo(''); setComment(''); setDate(todayISO());
    toast(`Переказ: ${from!.name} → ${to!.name} · ${money(n, from!.currency)}`);
  }
  if (pick) return <AccountPicker title={pick === 'from' ? 'Списати з рахунку' : 'Зарахувати на рахунок'} value={pick === 'from' ? fromId : toId} onPick={(id) => setAcc(pick, id)} onClose={() => setPick(null)} />;
  return (
    <>
      <div className="m-trform">
        <div className="m-lbl">Списати з рахунку</div>
        <button className="m-accrow" onClick={() => setPick('from')}><span>{from?.name ?? 'Оберіть рахунок'}</span><span className="num c-balance">{from ? money(from.balance, from.currency) : ''} ›</span></button>
        <div className="m-lbl">Зарахувати на рахунок</div>
        <button className="m-accrow" onClick={() => setPick('to')}><span>{to?.name ?? 'Оберіть рахунок'}</span><span className="num c-balance">{to ? money(to.balance, to.currency) : ''} ›</span></button>
        <div className="m-trbtns">
          <label className="m-gbtn">{date === todayISO() ? 'Сьогодні' : fmtDay(date, 'uk', { today: 'Сьогодні', yesterday: 'Вчора' })}<input type="date" value={date} max={todayISO()} onChange={(e) => e.target.value && setDate(e.target.value)} /></label>
          <div className="m-micwrap"><input className="m-gbtn" placeholder="Коментар" value={comment} maxLength={500} onChange={(e) => setComment(e.target.value)} /><MicButton value={comment} onChange={(v) => setComment(v.slice(0, 500))} /></div>
          <div className="m-sumrow">
            <input className="m-gbtn num" inputMode="decimal" placeholder={fx ? `Сума, ${from!.currency}` : 'Сума'} value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ''))} onKeyDown={(e) => e.key === 'Enter' && submit()} />
            <button className="m-ok" disabled={!valid || busy} onClick={submit} aria-label="Провести переказ">{busy ? '…' : '✓'}</button>
          </div>
          {fx && <input className="m-gbtn num" inputMode="decimal" placeholder={`Отримано, ${to!.currency}`} value={amountTo} onChange={(e) => setAmountTo(e.target.value.replace(/[^\d.,]/g, ''))} />}
          {fx && n(amount) > 0 && n(amountTo) > 0 && <div className="faint" style={{ textAlign: 'center' }}>Курс: {(Math.max(n(amount), n(amountTo)) / Math.min(n(amount), n(amountTo))).toFixed(4)}</div>}
          {from && to && from.id === to.id && <div className="faint" style={{ textAlign: 'center' }}>Оберіть різні рахунки</div>}
        </div>
      </div>
      <TTransferList />
    </>
  );
}

function TTransfer({ onClose, draft }: { onClose: () => void; draft?: { fromAccountId?: string | null; toAccountId?: string | null; amount?: string | null } }) {
  const { t } = useT();
  const { accounts, changed, toast } = useTalko();
  const [f, setF] = useState({ fromAccountId: draft?.fromAccountId ?? '', toAccountId: draft?.toAccountId ?? '', amount: draft?.amount ?? '', amountTo: '', description: '' });
  const [pending, setPending] = useState<{ token: string; preview: any } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const from = accounts.find((a) => a.id === f.fromAccountId); const to = accounts.find((a) => a.id === f.toAccountId);
  const fx = from && to && from.currency !== to.currency;
  const valid = from && to && from.id !== to.id && Number(normalizeAmountInput(f.amount)) > 0 && (!fx || Number(normalizeAmountInput(f.amountTo)) > 0);
  async function submit(token?: string) {
    setError(null);
    try {
      const r = await post('/talko/transfers', { ...f, amount: normalizeAmountInput(f.amount), amountTo: fx ? normalizeAmountInput(f.amountTo) : undefined, confirmationToken: token });
      if (r.status === 'needs_confirmation') { setPending({ token: r.confirmationToken, preview: r.preview }); return; }
      await changed(); toast(t.saved + ' у TALKO'); onClose();
    } catch (e: any) { setError(e.message); }
  }
  const rate = fx && Number(normalizeAmountInput(f.amount)) > 0 && Number(normalizeAmountInput(f.amountTo)) > 0
    ? (Math.max(Number(normalizeAmountInput(f.amount)), Number(normalizeAmountInput(f.amountTo))) / Math.min(Number(normalizeAmountInput(f.amount)), Number(normalizeAmountInput(f.amountTo)))).toFixed(4) : null;
  return (
    <Sheet title={t.transfer} onClose={onClose}>
      {pending ? (
        <>
          <div className="warn">Перевірте переказ (TALKO, ще не записано):</div>
          <div className="answer" style={{ marginTop: 10 }}>
            {from?.name}: −{money(normalizeAmountInput(f.amount), from?.currency)} → {to?.name}: +{money(normalizeAmountInput(fx ? f.amountTo : f.amount), to?.currency)}
            {rate && <div className="faint">{t.rate}: {rate}</div>}
          </div>
          <ErrorBox error={error} />
          <div className="actions"><button className="btn" onClick={() => setPending(null)}>{t.edit}</button><button className="btn primary" onClick={() => submit(pending.token)}>{t.confirm}</button></div>
        </>
      ) : (
        <>
          <div className="grid2">
            <Field label={t.from}><select className="input" value={f.fromAccountId} onChange={(e) => setF({ ...f, fromAccountId: e.target.value })}><option value="">{t.chooseAccount}</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {money(a.balance, a.currency)}</option>)}</select></Field>
            <Field label={t.to}><select className="input" value={f.toAccountId} onChange={(e) => setF({ ...f, toAccountId: e.target.value })}><option value="">{t.chooseAccount}</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {money(a.balance, a.currency)}</option>)}</select></Field>
            <Field label={`${t.amountSent}${from ? ', ' + from.currency : ''}`}><input className="input num" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
            {fx && <Field label={`${t.amountReceived}, ${to!.currency}`}><input className="input num" inputMode="decimal" value={f.amountTo} onChange={(e) => setF({ ...f, amountTo: e.target.value })} /></Field>}
          </div>
          {rate && <p className="faint">{t.rate}: {rate}</p>}
          <Field label={t.comment}><div className="m-micwrap"><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={500} /><MicButton value={f.description} onChange={(v) => setF((x: any) => ({ ...x, description: v.slice(0, 500) }))} /></div></Field>
          <p className="faint">{t.transferNotIncome}</p>
          <ErrorBox error={error} />
          <div className="actions"><button className="btn primary" disabled={!valid} onClick={() => submit()}>{t.makeTransfer}</button></div>
        </>
      )}
    </Sheet>
  );
}

// ---------- feed ----------

// ---------- one entry, full screen (like «Деньги ОК» → Редагування) ----------

/** Photos are shrunk on the phone before upload (long side 1600 px, JPEG) — a 5 MB photo becomes ~300 KB. */
async function fileToUpload(f: File): Promise<{ name: string; contentType: string; data: string }> {
  const toB64 = (b: Blob) => new Promise<string>((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.onerror = () => bad(r.error); r.readAsDataURL(b); });
  if (f.type.startsWith('image/') && !/gif|svg/.test(f.type)) {
    try {
      const bmp = await createImageBitmap(f);
      const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/jpeg', 0.82));
      if (blob) return { name: (f.name || 'photo').replace(/\.\w+$/, '') + '.jpg', contentType: 'image/jpeg', data: await toB64(blob) };
    } catch { /* HEIC the browser cannot read: send as is */ }
  }
  if (f.size > 10 * 1024 * 1024) throw new Error('Файл більший за 10 МБ');
  return { name: f.name || 'document', contentType: f.type || 'application/octet-stream', data: await toB64(f) };
}

interface TFile { id: number; name: string; url: string; contentType: string }

/** One row that slides left under the finger like an iPhone list: «Видалити» behind it, a long swipe deletes at once. */
function SwipeDel({ onDelete, children }: { onDelete: () => void; children: React.ReactNode }) {
  const OPEN = 96;
  const [x, setX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [gone, setGone] = useState(false);
  const st = useRef<{ x0: number; y0: number; base: number; lock: 0 | 1 | 2; w: number; last: number } | null>(null);
  const noClick = useRef(0);
  const del = () => { setGone(true); setX(-2000); setTimeout(onDelete, 200); };
  return (
    <div className={'m-sw' + (gone ? ' gone' : '')}>
      {x < 0 && (
        <button className={'m-swdel' + (dragging && x < -(st.current?.w ?? 360) * 0.5 ? ' full' : '')} aria-label="Видалити" onClick={(e) => { e.stopPropagation(); del(); }}>
          <span>🗑</span><small>Видалити</small>
        </button>
      )}
      <div className="m-swrow" style={{ transform: x ? `translateX(${x}px)` : undefined, transition: dragging ? 'none' : undefined }}
        onClickCapture={(e) => { if (Date.now() < noClick.current || x) { e.preventDefault(); e.stopPropagation(); if (x && !gone) setX(0); } }}
        onTouchStart={(e) => { st.current = { x0: e.touches[0].clientX, y0: e.touches[0].clientY, base: x, lock: 0, w: e.currentTarget.getBoundingClientRect().width || 360, last: x }; }}
        onTouchMove={(e) => {
          const t = st.current; if (!t) return;
          const dx = e.touches[0].clientX - t.x0, dy = e.touches[0].clientY - t.y0;
          if (!t.lock) { if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return; t.lock = Math.abs(dx) > Math.abs(dy) ? 1 : 2; }
          if (t.lock !== 1) return;
          const nx = Math.min(0, Math.max(-t.w, t.base + dx)); t.last = nx; setDragging(true); setX(nx);
        }}
        onTouchEnd={() => {
          const t = st.current; st.current = null; setDragging(false);
          if (!t || t.lock !== 1) return;
          noClick.current = Date.now() + 350;
          if (t.last < -t.w * 0.5) del(); else setX(t.last < -40 ? -OPEN : 0);
        }}>
        {children}
      </div>
    </div>
  );
}
const b64ToBlob = (data: string, type: string) => { const bin = atob(data); const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return new Blob([b], { type }); };
const ShareIcon = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3v12" /><path d="M8 7l4-4 4 4" /><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
  </svg>
);

/** Crop like a scanner app: drag the 4 corners onto the edges of the sheet; the page is straightened after. */
function CropEditor({ src, corners, onDone, onCancel, onRetake }: { src: HTMLCanvasElement; corners: Pt[]; onDone: (c: Pt[]) => void; onCancel: () => void; onRetake?: () => void }) {
  const [pts, setPts] = useState<Pt[]>(corners);
  const url = useMemo(() => src.toDataURL('image/jpeg', 0.85), [src]);
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const drag = useRef<{ i: number; dx: number; dy: number } | null>(null);
  useEffect(() => {
    const el = boxRef.current; if (!el) return;
    const fit = () => {
      const k = Math.min((el.clientWidth - 32) / src.width, (el.clientHeight - 32) / src.height);
      setBox({ w: src.width * k, h: src.height * k });
    };
    fit(); window.addEventListener('resize', fit); return () => window.removeEventListener('resize', fit);
  }, [src]);
  const k = box.w ? box.w / src.width : 0;
  const svgRef = useRef<SVGSVGElement>(null);
  const toImg = (e: React.PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
  };
  const down = (i: number) => (e: React.PointerEvent<SVGGElement>) => {
    e.preventDefault(); svgRef.current?.setPointerCapture?.(e.pointerId);
    const p = toImg(e); drag.current = { i, dx: pts[i].x - p.x, dy: pts[i].y - p.y };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    const p = toImg(e);
    const x = Math.min(src.width, Math.max(0, p.x + d.dx)), y = Math.min(src.height, Math.max(0, p.y + d.dy));
    setPts((a) => a.map((q, j) => (j === d.i ? { x, y } : q)));
  };
  const up = () => { drag.current = null; };
  const poly = pts.map((p) => `${p.x * k},${p.y * k}`).join(' ');
  const r = 22;
  return (
    <div className="m-hist m-crop">
      <div className="m-picker-top"><button onClick={onCancel} aria-label="Скасувати">‹</button><b>Обрізати</b>
        <button className="m-crop-reset" onClick={() => setPts([{ x: 0, y: 0 }, { x: src.width, y: 0 }, { x: src.width, y: src.height }, { x: 0, y: src.height }])}>Усе фото</button></div>
      <div className="m-crop-area" ref={boxRef}>
        {box.w > 0 && (
          <div className="m-crop-box" style={{ width: box.w, height: box.h }}>
            <img src={url} alt="" draggable={false} />
            <svg ref={svgRef} width={box.w} height={box.h} onPointerMove={move} onPointerUp={up} onPointerCancel={up} style={{ touchAction: 'none' }}>
              <path d={`M0,0H${box.w}V${box.h}H0Z M${poly.split(' ').join(' L')}Z`} fill="rgba(0,0,0,.55)" fillRule="evenodd" />
              <polygon points={poly} fill="none" stroke="#2f8bff" strokeWidth={2} />
              {pts.map((p, i) => (
                <g key={i} onPointerDown={down(i)}>
                  <circle cx={p.x * k} cy={p.y * k} r={r} fill="transparent" />
                  <circle cx={p.x * k} cy={p.y * k} r={11} fill="rgba(47,139,255,.25)" stroke="#2f8bff" strokeWidth={3} />
                </g>
              ))}
            </svg>
          </div>
        )}
      </div>
      <div className="m-scanbtns">
        {onRetake ? <button onClick={onRetake}>📷 Перезняти</button> : <button onClick={onCancel}>Скасувати</button>}
        <button className="ok" onClick={() => onDone(pts)}>Готово</button>
      </div>
    </div>
  );
}

function TEditTx({ tx, onClose }: { tx: TTx; onClose: () => void }) {
  const { accounts, categories, enqueue, toast } = useTalko();
  const [mode, setMode] = useState<null | 'account' | 'category' | 'amount' | 'date' | 'time'>(null);
  const [val, setVal] = useState('');
  const [note, setNote] = useState(() => cleanComment(tx.comment, tx.categoryName, accounts.find((a) => a.id === tx.accountId)?.name));
  const [files, setFiles] = useState<TFile[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [askDelete, setAskDelete] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const camRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [scan, setScan] = useState<ScanPage[] | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [crop, setCrop] = useState<{ src: HTMLCanvasElement; corners: Pt[]; index: number | null } | null>(null);
  const pending = tx.id.startsWith('tmp-') && SY.realIdOf(tx.id) === tx.id;
  const acc = accounts.find((a) => a.id === tx.accountId);
  const exp = tx.type === 'expense';
  const [queued, setQueued] = useState<FQ.QFile[]>(() => FQ.pendingFor(tx.id));
  // a just-entered expense opens with the comment field ready to type in
  useEffect(() => { if (pending && !note) noteRef.current?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => FQ.subscribe((e) => {
    setQueued(FQ.pendingFor(tx.id));
    if (e.type === 'sent' && e.txId === SY.realIdOf(tx.id)) setFiles((x) => (x ?? []).some((f) => f.id === e.result.id) ? x : [...(x ?? []), e.result]);
    if (e.type === 'failed' && FQ.pendingFor(tx.id).some((f) => f.id === e.file.id)) toast('TALKO не прийняв файл: ' + e.message + ' — він збережений у телефоні', true);
  }), [tx.id]);
  useEffect(() => {
    if (pending) { setFiles([]); return; }
    let alive = true;
    get('/talko/transactions/' + encodeURIComponent(SY.realIdOf(tx.id)) + '/files').then((r) => alive && setFiles(r)).catch(() => alive && setFiles((x) => x ?? []));
    return () => { alive = false; };
  }, [tx.id, pending]);
  const edit = (body: SY.EditBody, extra?: { categoryName?: string }) => enqueue({ id: SY.uid(), kind: 'edit', txId: tx.id, at: new Date().toISOString(), tries: 0, body,
    prev: { amount: tx.amount, type: tx.type, accountId: tx.accountId }, ...(extra ?? {}) });
  function moveAccount(accountId: string) {
    const a = accounts.find((x) => x.id === accountId);
    if (!a || accountId === tx.accountId) return;
    if (a.currency !== tx.currency) { toast('Інша валюта рахунку — оберіть рахунок у ' + tx.currency, true); return; }
    if (!tx.categoryId && !pending) { toast('Не вдалося визначити статтю — оновіть список і спробуйте ще', true); return; }
    // TALKO cannot move an operation between accounts: the old one is removed and the same one is written on the new account
    const now = new Date();
    const [y, mo, d] = tx.localDate.split('-').map(Number); const [h, mi] = (tx.time ?? now.toTimeString().slice(0, 5)).split(':').map(Number);
    const at = new Date(y, mo - 1, d, h, mi).toISOString();
    const tmpId = 'tmp-' + SY.uid();
    enqueue({ id: SY.uid(), kind: 'delete', txId: tx.id, at: now.toISOString(), tries: 0, item: tx });
    enqueue({ id: SY.uid(), kind: 'add', tmpId, at, tries: 0,
      body: { type: tx.type, amount: tx.amount, accountId, categoryId: tx.categoryId ?? '', projectId: tx.projectId ?? null, description: tx.comment === '—' ? '' : tx.comment, date: tx.localDate },
      item: { ...tx, id: tmpId, accountId, currency: a.currency } });
    toast(`Перенесено на ${a.name}`); onClose();
  }
  function save() {
    const v = val.trim();
    if (mode === 'amount') { const n = normalizeAmountInput(v); if (!(Number(n) > 0)) { toast('Невірна сума', true); return; } if (n !== tx.amount) edit({ amount: n }); }
    if (mode === 'date' && v && v !== tx.localDate) edit({ date: v });
    if (mode === 'time' && /^\d{2}:\d{2}$/.test(v)) {
      // a bank time written in the comment would win, so it is changed there too
      const re = new RegExp(TIME_RE);
      edit(re.test(tx.comment ?? '') ? { time: v, day: tx.localDate, description: (tx.comment ?? '').replace(re, v) } : { time: v, day: tx.localDate });
    }
    setMode(null);
  }
  function saveComment(raw: string) {
    const v = raw.trim();
    const re = new RegExp(TIME_RE);
    const keep = !!tx.time && re.test(tx.comment ?? '') && !re.test(v);
    edit({ description: keep ? `${v} (${tx.time})`.trim() : v });
  }
  async function addScanPage(f: File | undefined) {
    if (camRef.current) camRef.current.value = '';
    if (!f) return;
    setScanBusy(true);
    try { const src = await loadPhoto(f); setCrop({ src, corners: detectCorners(src), index: null }); }
    catch { toast('Не вдалося обробити фото', true); }
    finally { setScanBusy(false); }
  }
  async function applyCrop(corners: Pt[]) {
    if (!crop) return;
    const { src, index } = crop;
    setCrop(null); setScanBusy(true);
    try {
      const pg = await cropToPage(src, corners);
      setScan((x) => {
        const arr = [...(x ?? [])];
        if (index === null) arr.push(pg); else { URL.revokeObjectURL(arr[index].preview); arr[index] = pg; }
        return arr;
      });
    } catch { toast('Не вдалося обробити фото', true); }
    finally { setScanBusy(false); }
  }
  async function saveScan() {
    if (!scan?.length) return;
    const d = new Date();
    const name = `Скан ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()} ${d.toTimeString().slice(0, 5).replace(':', '-')}.pdf`;
    const pdf = pagesToPdf(scan);
    if (pdf.length > 15 * 1024 * 1024) { toast('Забагато сторінок: файл більший за 15 МБ', true); return; }
    if (await keep({ name, contentType: 'application/pdf', data: bytesToBase64(pdf) })) { scan.forEach((p) => URL.revokeObjectURL(p.preview)); setScan(null); }
  }
  /** Saved on the phone at once; goes to TALKO in the background. */
  async function keep(body: { name: string; contentType: string; data: string }) {
    setUploading(true);
    try { await FQ.add(tx.id, body); toast(navigator.onLine ? 'Збережено — надсилаю в TALKO' : 'Збережено в телефоні — надішлю, коли з’явиться зв’язок'); return true; }
    catch { toast('Не вдалося зберегти файл у телефоні — мало місця?', true); return false; }
    finally { setUploading(false); }
  }
  /** Saved files are fetched in advance, so «Поділитися» opens the iPhone share sheet at once. */
  const blobs = useRef(new Map<number, Blob>());
  useEffect(() => {
    for (const f of files ?? []) if (!blobs.current.has(f.id)) {
      fetch('/api/talko/files/' + f.id + '/raw', { credentials: 'same-origin', headers: { 'X-Requested-With': 'groshi-ok' } })
        .then((r) => r.ok ? r.blob() : null).then((b) => { if (b) blobs.current.set(f.id, b); }).catch(() => {});
    }
  }, [files]);
  async function shareBlob(name: string, type: string, blob: Blob) {
    const file = new File([blob], name, { type });
    try {
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
      const u = URL.createObjectURL(blob); window.open(u, '_blank'); setTimeout(() => URL.revokeObjectURL(u), 60_000);
      toast('Цей браузер не вміє ділитися файлами — відкрив файл, поділіться з нього');
    } catch (e: any) { if (e?.name !== 'AbortError') toast('Не вдалося поділитися: ' + (e?.message ?? 'помилка'), true); }
  }
  async function shareSaved(f: TFile) {
    const b = blobs.current.get(f.id);
    if (b) { await shareBlob(f.name, f.contentType, b); return; }
    toast('Завантажую файл… натисніть «Поділитися» ще раз за секунду');
    try {
      const r = await fetch('/api/talko/files/' + f.id + '/raw', { credentials: 'same-origin', headers: { 'X-Requested-With': 'groshi-ok' } });
      if (!r.ok) throw new Error('файл недоступний');
      blobs.current.set(f.id, await r.blob());
    } catch (e: any) { toast('Не вдалося завантажити файл: ' + (e?.message ?? 'помилка'), true); }
  }
  async function removeSaved(f: TFile) {
    setFiles((x) => (x ?? []).filter((y) => y.id !== f.id));
    try { await del('/talko/transactions/' + encodeURIComponent(SY.realIdOf(tx.id)) + '/files/' + f.id); toast('Файл видалено'); }
    catch (e: any) { setFiles((x) => [...(x ?? []), f]); toast('Не вдалося видалити: ' + (e?.message ?? 'помилка'), true); }
  }
  async function addFile(f: File | undefined) {
    if (fileRef.current) fileRef.current.value = '';
    if (!f) return;
    try { await keep(await fileToUpload(f)); }
    catch (e: any) { toast('Файл не додано: ' + (e?.message ?? 'помилка'), true); }
  }
  const cats = categories.filter((c) => c.type === tx.type);
  const mine = mainCategories(categories, tx.type);
  const mineIds = new Set(mine.map((c) => c.id));
  const catList = [...mine, ...cats.filter((c) => c.parentId && mineIds.has(c.parentId) && !mineIds.has(c.id))];
  if (mode === 'account') return <ListPicker title="Рахунок" value={tx.accountId} onClose={() => setMode(null)}
    items={accounts.map((a) => ({ id: a.id, label: a.name, sub: money(a.balance, a.currency) }))} onPick={moveAccount} />;
  if (mode === 'category') return <ListPicker title="Стаття" value={tx.categoryId ?? ''} onClose={() => setMode(null)}
    items={catList.map((c) => ({ id: c.id, label: c.name }))} onPick={(id) => { if (id !== tx.categoryId) edit({ categoryId: id }, { categoryName: categories.find((c) => c.id === id)?.name }); }} />;
  const comment = cleanComment(tx.comment, tx.categoryName, acc?.name);
  const noteDirty = note.trim() !== comment.trim();
  const saveNote = () => { if (noteDirty) { saveComment(note); toast('Коментар збережено'); } };
  const close = () => { saveNote(); onClose(); };
  const row =(label: string, value: React.ReactNode, onClick?: () => void) => (
    <button className="m-erow" onClick={onClick} disabled={!onClick}><span>{label}</span><span className="m-eval">{value} {onClick && '›'}</span></button>
  );
  return (
    <div className="m-hist">
      <div className="m-picker-top"><button onClick={close} aria-label="Назад">‹</button><b>Редагування</b><span /></div>
      <div className="m-histbody">
        <div className="m-egroup">
          {row('Рахунок', acc?.name ?? '—', () => setMode('account'))}
          {row('Стаття', tx.categoryName ?? '—', () => setMode('category'))}
          {row('Сума', <b className={exp ? 'c-expense' : 'c-income'}>{money(tx.amount, tx.currency)}</b>, () => { setVal(tx.amount); setMode('amount'); })}
          {row('Дата', fmtDayLong(tx.localDate), () => { setVal(tx.localDate); setMode('date'); })}
          {row('Час', tx.time ?? '—', () => { setVal(tx.time ?? new Date().toTimeString().slice(0, 5)); setMode('time'); })}
        </div>
        {/* the comment is open right away, above the file and delete buttons */}
        <div className="m-egroup m-enote">
          <div className="m-enote-label">Коментар</div>
          <div className="m-micwrap">
            <textarea ref={noteRef} className="input" rows={3} placeholder="Коментар — надиктуйте або напишіть" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
            <MicButton value={note} onChange={(v) => setNote(v.slice(0, 500))} />
          </div>
          {noteDirty && (
            <div className="m-modal-btns">
              <button onClick={() => setNote(comment)} aria-label="Скасувати зміни">✕</button>
              <button className="ok" onClick={saveNote} aria-label="Зберегти коментар">✓</button>
            </div>
          )}
        </div>
        {pending && <div className="m-day">⟳ Ще записується в TALKO — зміни підуть услід</div>}
        <div className="m-egroup">
          {(files ?? []).map((f) => (
            <SwipeDel key={f.id} onDelete={() => removeSaved(f)}>
            <div className="m-efile">
              <a className="m-efile-open" href={f.url} target="_blank" rel="noreferrer">
                {f.contentType.startsWith('image/') ? <img src={f.url} alt="" /> : <span className="m-edoc">📄</span>}
                <span className="ellipsis">{f.name}</span>
              </a>
              <button className="m-efile-share" onClick={() => shareSaved(f)} aria-label="Поділитися">{ShareIcon}</button>
            </div>
            </SwipeDel>
          ))}
          {queued.map((f) => (
            <SwipeDel key={f.id} onDelete={() => { FQ.remove(f.id); toast('Файл видалено'); }}>
            <div className="m-efile">
              <button className="m-efile-open" onClick={() => window.open(FQ.previewUrl(f), '_blank')}>
                {f.contentType.startsWith('image/') ? <img src={'data:' + f.contentType + ';base64,' + f.data} alt="" /> : <span className="m-edoc">📄</span>}
                <span className="m-efile-name"><span className="ellipsis">{f.name}</span>{f.error && <small className="m-efile-err">{f.error}</small>}</span>
              </button>
              {f.error
                ? <button className="m-efile-st err" onClick={() => FQ.retry(f.id)} title={f.error}>⚠ ще раз</button>
                : <span className="m-efile-st">⟳</span>}
              <button className="m-efile-share" onClick={() => shareBlob(f.name, f.contentType, b64ToBlob(f.data, f.contentType))} aria-label="Поділитися">{ShareIcon}</button>
            </div>
            </SwipeDel>
          ))}
          <button className="m-erow m-eadd" disabled={uploading} onClick={() => fileRef.current?.click()}>{uploading ? 'Завантажую…' : '📷 Додати фото або файл'}</button>
          <button className="m-erow m-eadd" disabled={uploading} onClick={() => { setScan([]); setTimeout(() => camRef.current?.click(), 50); }}>📄 Сканувати документ</button>
          <input ref={fileRef} type="file" accept="image/*,application/pdf,.pdf,.heic,.doc,.docx,.xls,.xlsx" hidden onChange={(e) => addFile(e.target.files?.[0])} />
        </div>
        <div className="m-egroup">
          {askDelete
            ? <div className="m-edel"><span>Видалити {money(tx.amount, tx.currency)}?</span><button onClick={() => setAskDelete(false)}>Ні</button>
                <button className="danger" onClick={() => { enqueue({ id: SY.uid(), kind: 'delete', txId: tx.id, at: new Date().toISOString(), tries: 0, item: tx }); toast('Видалено'); onClose(); }}>Так, видалити</button></div>
            : <button className="m-erow m-edanger" onClick={() => setAskDelete(true)}>{exp ? 'Видалити витрату…' : 'Видалити дохід…'}</button>}
        </div>
      </div>
      <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => addScanPage(e.target.files?.[0])} />
      {scan && (
        <div className="m-hist">
          <div className="m-picker-top"><button onClick={() => { scan.forEach((p) => URL.revokeObjectURL(p.preview)); setScan(null); }} aria-label="Скасувати">‹</button><b>Скан · {scan.length} стор.</b><span /></div>
          <div className="m-histbody m-scan">
            {scan.map((p, i) => (
              <div key={p.preview} className="m-scanpage">
                <img src={p.preview} alt={'Сторінка ' + (i + 1)} onClick={() => setCrop({ src: p.src, corners: p.corners, index: i })} />
                <button onClick={() => { URL.revokeObjectURL(p.preview); setScan((x) => (x ?? []).filter((_, k) => k !== i)); }} aria-label="Прибрати сторінку">✕</button>
                <span>{i + 1}</span>
              </div>
            ))}
            {scan.length > 0 && !scanBusy && <div className="empty" style={{ padding: 4 }}>Натисніть на сторінку, щоб обрізати ще раз</div>}
            {!scan.length && !scanBusy && <div className="empty">Сфотографуйте документ — сторінка стане чорно-білою, як скан.</div>}
            {scanBusy && <div className="empty">Обробляю сторінку…</div>}
          </div>
          <div className="m-scanbtns">
            <button onClick={() => camRef.current?.click()} disabled={scanBusy}>📷 {scan.length ? 'Ще сторінка' : 'Сфотографувати'}</button>
            <button className="ok" disabled={!scan.length || scanBusy || uploading} onClick={saveScan}>{uploading ? 'Зберігаю…' : 'Готово — зберегти PDF'}</button>
          </div>
        </div>
      )}
      {crop && <CropEditor src={crop.src} corners={crop.corners} onCancel={() => setCrop(null)} onDone={applyCrop}
        onRetake={crop.index === null ? () => { setCrop(null); setTimeout(() => camRef.current?.click(), 50); } : undefined} />}
      {mode && (
        <div className="m-modal" onClick={() => setMode(null)}>
          <div className="m-modal-box" onClick={(e) => e.stopPropagation()}>
            {mode === 'amount' && <input autoFocus className="input num" inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value.replace(/[^\d.,]/g, ''))} style={{ fontSize: 24 }} />}
            {mode === 'date' && <input autoFocus className="input" type="date" value={val} max={todayISO()} onChange={(e) => setVal(e.target.value)} />}
            {mode === 'time' && <input autoFocus className="input" type="time" value={val} onChange={(e) => setVal(e.target.value)} />}
            <div className="m-modal-btns">
              <button onClick={() => setMode(null)} aria-label="Скасувати">✕</button>
              <button className="ok" onClick={save} aria-label="Зберегти">✓</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
const fmtDayLong = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', ...(y !== new Date().getFullYear() ? { year: 'numeric' } : {}) }); };

// ---------- history (like «Деньги ОК»: month / year, by account, by category) ----------

type Period = { kind: 'month'; ym: string } | { kind: 'year'; y: string };
const periodRange = (p: Period): [string, string] => {
  if (p.kind === 'year') return [`${p.y}-01-01`, `${p.y}-12-31`];
  const [y, m] = p.ym.split('-').map(Number);
  return [`${p.ym}-01`, `${p.ym}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`];
};
const periodName = (p: Period) => {
  if (p.kind === 'year') return `${p.y} рік`;
  const [y, m] = p.ym.split('-').map(Number);
  const s = new Date(y, m - 1, 1).toLocaleDateString('uk-UA', { month: 'long' });
  return `${s.charAt(0).toUpperCase() + s.slice(1)} ${y}`;
};

function ListPicker({ title, items, value, onPick, onClose }: { title: string; items: Array<{ id: string; label: string; sub?: string; folder?: boolean }>; value: string; onPick: (id: string) => void; onClose: () => void }) {
  return (
    <div className="m-hist">
      <div className="m-picker-top"><button onClick={onClose} aria-label="Назад">‹</button><b>{title}</b><span /></div>
      <div className="list acc-list m-histbody">
        {items.map((x) => (
          <div key={x.id} className="item" onClick={() => { onPick(x.id); onClose(); }}>
            <div className="main"><div className="t1" style={x.folder ? { fontWeight: 700 } : undefined}>{x.label}</div></div>
            <div className="amt num c-balance">{x.sub ?? ''}{x.id === value && <span className="m-check"> ✓</span>}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function THistory({ type, onClose }: { type: 'income' | 'expense'; onClose: () => void }) {
  const { accounts, categories, version, enqueue, outbox } = useTalko();
  const [period, setPeriod] = useState<Period>({ kind: 'month', ym: todayISO().slice(0, 7) });
  const [accountId, setAccountId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState(false);
  const [pick, setPick] = useState<null | 'period' | 'account' | 'category'>(null);
  const [openTx, setOpenTx] = useState<TTx | null>(null);
  useEffect(() => { const h = setTimeout(() => setQuery(q.trim()), 400); return () => clearTimeout(h); }, [q]);
  const [from, to] = periodRange(period);
  const key = `gok.hist.${type}.${from}.${to}.${accountId}.${categoryId}.${query}`;
  const [items, setItems] = useState<TTx[] | null>(() => readCache<TTx[] | null>(key, null));
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let alive = true;
    setItems(readCache<TTx[] | null>(key, null)); setLoading(true);
    get('/talko/transactions' + qs({ from, to, type, accountId: accountId || undefined, categoryId: categoryId || undefined, q: query || undefined }))
      .then((r) => { if (!alive) return; setItems(r.items ?? []); writeCache(key, r.items ?? []); })
      .catch(() => { /* offline: keep the cached list */ })
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [key, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const deleting = new Set<string>(outbox.flatMap((o) => o.kind === 'delete' ? [o.txId] : []));
  const edits = outbox.filter((o): o is Extract<Op, { kind: 'edit' }> => o.kind === 'edit');
  const shown = (items ?? []).filter((x) => !deleting.has(x.id)).map((x) => edits.filter((o) => o.txId === x.id).reduce((a, o) => applyEdit(a, o), x));
  const acc = accounts.find((a) => a.id === accountId);
  const cat = categories.find((c) => c.id === categoryId);
  const total = sumByCurrency(shown) || money('0', acc?.currency ?? 'UAH');
  // months back to the start of last year, then whole years
  const now = new Date();
  const months: Period[] = Array.from({ length: 24 }, (_, i) => { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); return { kind: 'month' as const, ym: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` }; });
  const years: Period[] = [0, 1, 2].map((i) => ({ kind: 'year' as const, y: String(now.getFullYear() - i) }));
  const pid = (p: Period) => p.kind === 'year' ? 'y' + p.y : 'm' + p.ym;
  const cats = categories.filter((c) => c.type === type);
  const ordered = cats.filter((c) => !c.parentId || !cats.some((x) => x.id === c.parentId)).flatMap((p) => [p, ...cats.filter((c) => c.parentId === p.id)]);
  if (pick === 'period') return <ListPicker title="Період" value={pid(period)} onClose={() => setPick(null)}
    items={[...years.map((p) => ({ id: pid(p), label: periodName(p), folder: true })), ...months.map((p) => ({ id: pid(p), label: periodName(p) }))]}
    onPick={(id) => setPeriod(id.startsWith('y') ? { kind: 'year', y: id.slice(1) } : { kind: 'month', ym: id.slice(1) })} />;
  if (pick === 'account') return <ListPicker title="Рахунок" value={accountId} onClose={() => setPick(null)}
    items={[{ id: '', label: 'Усі рахунки' }, ...accounts.map((a) => ({ id: a.id, label: a.name, sub: money(a.balance, a.currency) }))]} onPick={setAccountId} />;
  if (pick === 'category') return <ListPicker title="Стаття" value={categoryId} onClose={() => setPick(null)}
    items={[{ id: '', label: 'Усі статті' }, ...ordered.map((c) => ({ id: c.id, label: (c.parentId ? '   ↳ ' : '') + c.name, folder: !c.parentId && cats.some((x) => x.parentId === c.id) }))]} onPick={setCategoryId} />;
  return (
    <div className="m-hist">
      <div className="m-picker-top">
        <button onClick={onClose} aria-label="Назад">‹</button><b>Історія</b>
        <button onClick={() => { setSearch(!search); if (search) setQ(''); }} aria-label="Пошук" style={{ fontSize: 20 }}>🔍</button>
      </div>
      {search && <input className="input" autoFocus type="search" placeholder="Пошук: отримувач, коментар" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 8 }} />}
      <button className="m-accrow" onClick={() => setPick('period')}><span>{periodName(period)}</span><span>›</span></button>
      <div className="m-histfilters">
        <button className="m-accrow" onClick={() => setPick('account')}><span className="ellipsis">{acc?.name ?? 'Усі рахунки'}</span><span className="num c-balance">{acc ? money(acc.balance, acc.currency) : ''} ›</span></button>
        <button className="m-accrow" onClick={() => setPick('category')}><span className="ellipsis">{cat?.name ?? 'Усі статті'}</span><span>›</span></button>
      </div>
      <div className="m-day">{type === 'expense' ? 'Витрачено' : 'Отримано'} за період: <b className="num">{total}</b>{loading && ' · оновлюю…'}</div>
      {openTx && <TEditTx tx={shown.find((x) => x.id === openTx.id) ?? openTx} onClose={() => setOpenTx(null)} />}
      <div className="m-histbody">
        {items === null && loading ? <div className="empty">Завантаження…</div> : (
          <TxList items={shown} onSelect={(id) => { const it = shown.find((x) => x.id === id); if (it) setOpenTx(it); }}
            onDelete={async (i) => { enqueue({ id: SY.uid(), kind: 'delete', txId: i.id, at: new Date().toISOString(), tries: 0, item: i }); }} />
        )}
      </div>
    </div>
  );
}

function TFeed() {
  const { t } = useT();
  const { version } = useTalko();
  const [q, setQ] = useState('');
  const [from, setFrom] = useState(todayISO().slice(0, 8) + '01');
  const [to, setTo] = useState(todayISO());
  const [query, setQuery] = useState('');
  useEffect(() => { const h = setTimeout(() => setQuery(q), 400); return () => clearTimeout(h); }, [q]);
  const r = useAsyncT(() => get('/talko/transactions' + qs({ from, to, q: query })), [from, to, query, version]);
  return (
    <>
      <div className="topbar"><h1>{t.feed}</h1></div>
      <input className="input" type="search" placeholder={t.search} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="grid2" style={{ marginTop: 8 }}>
        <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label={t.from} />
        <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label={t.to} />
      </div>
      {r.error && <div className="error" style={{ marginTop: 8 }}>{r.error}</div>}
      {r.loading && <div className="empty">…</div>}
      {r.data && <TxList items={r.data.items} />}
    </>
  );
}

// ---------- reports ----------

function TReports() {
  const { t, lang } = useT();
  const { version } = useTalko();
  const [month, setMonth] = useState(todayISO().slice(0, 7));
  const [kind, setKind] = useState<'expense' | 'income'>('expense');
  const [y, m] = month.split('-').map(Number);
  const from = `${month}-01`; const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const r = useAsyncT(() => get('/talko/report' + qs({ from, to })), [from, to, version]);
  const shift = (d: number) => { const dt = new Date(Date.UTC(y, m - 1 + d, 1)); setMonth(dt.toISOString().slice(0, 7)); };
  const sec = r.data?.[kind];
  const fmt = (v: string) => money(v, r.data?.baseCurrency);
  return (
    <>
      <div className="row between" style={{ marginBottom: 10 }}>
        <button className="icon-btn" onClick={() => shift(-1)}>{Icons.chevL}</button>
        <b style={{ textTransform: 'capitalize' }}>{new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString(lang === 'en' ? 'en-GB' : 'uk-UA', { month: 'long', year: 'numeric' })}</b>
        <button className="icon-btn" onClick={() => shift(1)}>{Icons.chevR}</button>
      </div>
      <div className="seg" style={{ marginBottom: 12 }}>
        <button className={kind === 'expense' ? 'on c-expense' : ''} onClick={() => setKind('expense')}>{t.expenses}</button>
        <button className={kind === 'income' ? 'on c-income' : ''} onClick={() => setKind('income')}>{t.income}</button>
      </div>
      {r.error && <div className="error">{r.error}</div>}
      {r.loading && <div className="empty">…</div>}
      {sec && (
        <>
          {!r.data.complete && <div className="warn" style={{ marginBottom: 8 }}>Показано не всі операції періоду (дуже багато записів).</div>}
          <div className="stats" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
            <div className="stat"><div className="l">{t.total}</div><div className="v num" style={{ color: kind === 'expense' ? 'var(--expense)' : 'var(--income)', fontSize: 20 }}>{fmt(sec.total)}</div><div className="l">{sec.count} {t.count}</div></div>
            <div className="stat"><div className="l">{t.net}</div><div className={'v num ' + (r.data.net.startsWith('-') ? 'c-expense' : 'c-income')}>{fmt(r.data.net)}</div></div>
          </div>
          <div className="section-title">{t.byCategory}</div>
          <div className="card">
            {sec.byCategory.length ? <Donut otherLabel={t.other} centerTop={fmt(sec.total)} slices={sec.byCategory.map((c: any, i: number) => ({ key: c.id, label: c.name, value: c.total, display: fmt(c.total), percent: c.percent, color: i < 8 ? PALETTE[i] : '#8e8e93', sub: `${c.count} ${t.count}` }))} /> : <div className="empty">{t.nothing}</div>}
          </div>
          <div className="section-title">{t.trend}</div>
          <div className="card">
            <Bars labels={sec.byDay.map((d: any) => String(Number(d.day.slice(8))))} series={[{ key: kind, label: kind, color: kind === 'expense' ? '#ff9f0a' : '#30d158', values: sec.byDay.map((d: any) => d.total) }]} format={fmt} />
          </div>
        </>
      )}
    </>
  );
}

// ---------- dictation ----------

/** 🎤 next to a comment field: tap and speak, the words are added to the text (Ukrainian). */
function MicButton({ value, onChange, auto }: { value: string; onChange: (v: string) => void; auto?: boolean }) {
  const { lang } = useT();
  const { toast } = useTalko();
  const [on, setOn] = useState(false);
  const rec = useRef<any>(null);
  const base = useRef('');
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  function start() {
    if (!SR) { toast('Диктування тут недоступне — натисніть 🎤 на клавіатурі телефона'); return; }
    try {
      const r = new SR(); r.lang = lang === 'en' ? 'en-US' : 'uk-UA'; r.interimResults = true; r.continuous = false;
      base.current = value.trim();
      r.onresult = (e: any) => {
        const said = Array.from(e.results).map((x: any) => x[0].transcript).join(' ').trim();
        const txt = (base.current ? base.current + ' ' : '') + said;
        onChange(txt.charAt(0).toUpperCase() + txt.slice(1));
      };
      r.onend = () => setOn(false);
      r.onerror = (e: any) => { setOn(false); if (e.error === 'not-allowed') toast('Дозвольте мікрофон для застосунку в налаштуваннях', true); };
      rec.current = r; r.start(); setOn(true);
    } catch { setOn(false); }
  }
  const stop = () => { try { rec.current?.stop(); } catch { /* */ } setOn(false); };
  useEffect(() => { if (auto && SR) start(); return () => { try { rec.current?.abort(); } catch { /* */ } }; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <button type="button" className={'m-mic' + (on ? ' on' : '')} onClick={on ? stop : start} aria-label={on ? 'Зупинити диктування' : 'Надиктувати'}>
      {Icons.mic}
    </button>
  );
}

// ---------- voice ----------

function TVoice({ defaultType, onClose, onDraft }: { defaultType: 'income' | 'expense'; onClose: () => void; onDraft?: (d: Draft) => boolean }) {
  const { t, lang } = useT();
  const { accounts, categories } = useTalko();
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<any>(null);
  const [transfer, setTransfer] = useState<any>(null);
  const recRef = useRef<any>(null);
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  const say = (s: string) => { if (!s || !('speechSynthesis' in window)) return; const u = new SpeechSynthesisUtterance(s); u.lang = lang === 'en' ? 'en-US' : 'uk-UA'; speechSynthesis.cancel(); speechSynthesis.speak(u); };
  async function run(phrase = text) {
    if (!phrase.trim()) return;
    try {
      // expenses, incomes and transfers are understood on the phone at once
      const local = interpret(phrase, accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency })), categories.map((c) => ({ id: c.id, name: c.name, type: c.type })), { lang: lang === 'en' ? 'en' : 'uk', defaultType });
      if (local.intent === 'transaction' && onDraft && onDraft(local.draft)) { recRef.current?.abort?.(); onClose(); return; }
      if (local.intent === 'transaction') { setDraft(local.draft); return; }
      if (local.intent === 'transfer') { setTransfer({ fromAccountId: local.fromAccountId, toAccountId: local.toAccountId, amount: local.amount }); return; }
      const r = await post('/talko/voice', { text: phrase, defaultType });
      const c = r.command;
      if (c.intent === 'transaction') { setDraft(c.draft); say(c.draft.questions.join(' ')); return; }
      if (c.intent === 'transfer') { setTransfer({ fromAccountId: c.fromAccountId, toAccountId: c.toAccountId, amount: c.amount }); return; }
      setAnswer(r.answer || t.voiceHint); say(r.answer);
    } catch (e: any) { setError(e.message); }
  }
  function listen() {
    if (!SR) { setError(t.voiceUnsupported); return; }
    const rec = new SR(); rec.lang = lang === 'en' ? 'en-US' : 'uk-UA'; rec.interimResults = true;
    rec.onresult = (e: any) => { const p = Array.from(e.results).map((x: any) => x[0].transcript).join(' '); setText(p); };
    rec.onend = () => setListening(false);
    rec.onerror = (e: any) => { setListening(false); if (e.error !== 'no-speech' && e.error !== 'aborted') setError(e.error); };
    recRef.current = rec; rec.start(); setListening(true);
  }
  useEffect(() => { if (SR) listen(); return () => recRef.current?.abort?.(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (draft) return <TxSheet title={t.checkAndConfirm} type={draft.type ?? defaultType} amount={draft.amount ?? ''} accountId={draft.accountId ?? ''} categoryId={draft.categoryId ?? ''} comment={draft.comment} onClose={onClose} />;
  if (transfer) return <TTransfer draft={transfer} onClose={onClose} />;
  return (
    <Sheet title={t.voiceControl} onClose={onClose}>
      <div style={{ textAlign: 'center', margin: '8px 0 14px' }}>
        <button className={'fab-voice' + (listening ? ' on' : '')} style={{ position: 'static', width: 84, height: 84, margin: '0 auto' }} onClick={listening ? () => recRef.current?.stop() : listen}><span style={{ transform: 'scale(1.5)', display: 'grid' }}>{Icons.mic}</span></button>
      </div>
      {answer && <div className="answer">{answer}</div>}
      <textarea className="input" style={{ marginTop: 12 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={t.voicePlaceholder} />
      <p className="faint">{t.voiceHint}</p>
      <ErrorBox error={error} />
      <div className="actions"><button className="btn primary" disabled={!text.trim()} onClick={() => run()}>{t.doIt}</button></div>
    </Sheet>
  );
}

// ---------- menu ----------

function TMenu() {
  const { t } = useT();
  const [screen, setScreen] = useState<null | 'reports' | 'talko'>(null);
  const [companyName, setCompanyName] = useState('');
  useEffect(() => { get('/talko/status').then((s) => setCompanyName(s.companyName ?? '')).catch(() => {}); }, []);
  return (
    <>
      <div className="topbar">
        {screen && <button className="icon-btn" onClick={() => setScreen(null)} aria-label="back">{Icons.back}</button>}
        <h1>{screen === 'reports' ? t.reports : screen === 'talko' ? 'TALKO' : t.menu}</h1>
      </div>
      {!screen && (
        <>
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="faint">Дані з CRM TALKO</div>
            <b>{companyName}</b>
          </div>
          <div className="list">
            <button className="item" onClick={() => setScreen('reports')}><span className="ic">📊</span><div className="main"><div className="t1">{t.reports}</div></div>{Icons.chevR}</button>
            <button className="item" onClick={() => setScreen('talko')}><span className="ic">🔗</span><div className="main"><div className="t1">Підключення TALKO</div></div>{Icons.chevR}</button>
          </div>
          <button className="btn danger block" style={{ marginTop: 16 }} onClick={async () => { await post('/auth/logout'); try { localStorage.removeItem('gok.me'); } catch { /* ignore */ } location.reload(); }}>{t.logout}</button>
        </>
      )}
      {screen === 'reports' && <TReports />}
      {screen === 'talko' && <TalkoConnect />}
    </>
  );
}

/** Connect / disconnect TALKO (also shown in local mode under Menu → Bank connections). */
export function TalkoConnect() {
  const { t } = useT();
  const [status, setStatus] = useState<any>(null);
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { get('/talko/status').then(setStatus).catch((e) => setError(e.message)); }, []);
  async function connect() {
    setBusy(true); setError(null);
    try { await post('/talko/connect', { url, apiKey: key }); location.reload(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  async function disconnect() {
    if (!confirm('Відключити TALKO? Застосунок повернеться до власної бази.')) return;
    await del('/talko'); location.reload();
  }
  if (!status) return <div className="empty">{error ?? '…'}</div>;
  return (
    <div className="card">
      <p className="faint" style={{ marginTop: 0 }}>Після підключення застосунок показує рахунки, статті, проєкти й операції з TALKO, а нові витрати, доходи й перекази записує в TALKO (з підтвердженням). Власна база застосунку при цьому не використовується.</p>
      {status.configured ? (
        <>
          <div className="row between"><b>{status.companyName}</b><span className={status.status === 'ok' ? 'c-income' : 'c-danger'}>● {status.status}</span></div>
          <div className="faint">{status.host} · {status.role}</div>
          {status.lastError && status.status !== 'ok' && <div className="error" style={{ marginTop: 8 }}>{status.lastError}</div>}
          <button className="btn danger block" style={{ marginTop: 12 }} onClick={disconnect}>{t.disconnect}</button>
        </>
      ) : (
        <>
          <Field label="Адреса MCP-сервера TALKO (https://…)"><input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/mcp" autoComplete="off" /></Field>
          <Field label="API-ключ TALKO"><input className="input" type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" /></Field>
          <p className="faint">Ключ зберігається на сервері зашифрованим і в застосунку більше не показується.</p>
          <ErrorBox error={error} />
          <button className="btn primary block" disabled={busy || !url || key.length < 10} onClick={connect}>{t.connect}</button>
        </>
      )}
    </div>
  );
}
