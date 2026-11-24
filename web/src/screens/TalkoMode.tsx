/**
 * TALKO mode: the phone app is a front end for TALKO CRM finance. Every number is read from
 * TALKO and every new operation is written to TALKO (with TALKO's own confirmation step).
 */
import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, del, get, post, qs } from '../api';
import { Bars, Donut } from '../components/Charts';
import { ErrorBox, Field, Icons, Sheet, fmtDay } from '../components/ui';
import { useT } from '../i18n';
import { money, normalizeAmountInput, todayISO } from '../money';
import * as SY from '../talkoSync';
import type { Op } from '../talkoSync';

interface TAccount { id: string; name: string; type: string; currency: string; balance: string }
interface TCategory { id: string; name: string; type: 'income' | 'expense'; parentId: string | null }
interface TTx { id: string; type: 'income' | 'expense'; amount: string; currency: string; accountId: string; categoryName: string | null; comment: string; counterparty: string; occurredAt: string; localDate: string; time?: string | null }
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
  const ordered = cats.filter((c) => !c.parentId || !cats.some((p) => p.id === c.parentId)).flatMap((p) => [p, ...cats.filter((c) => c.parentId === p.id)]);
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
              {ordered.map((c) => <button key={c.id} className={'chip' + (f.categoryId === c.id ? ' on' : '')} onClick={() => setF({ ...f, categoryId: c.id })}>{c.parentId ? '↳ ' : ''}{c.name}</button>)}
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
          <div className="actions"><button className={'btn ' + (f.type === 'expense' ? 'expense' : 'income')} disabled={!valid || busy} onClick={() => submit()}>{t.save}</button></div>
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
  const [edit, setEdit] = useState<{ id: string; kind: 'comment' | 'date'; value: string } | null>(null);
  useEffect(() => { if (accounts.length && !accounts.some((a) => a.id === accountId)) setAccountId(accounts[0].id); }, [accounts, accountId]);
  // today's list: shown at once from the phone's memory, refreshed from TALKO in the background,
  // with queued (not yet synced) changes laid on top
  const cacheKey = 'gok.today.' + type;
  const [base, setBaseRaw] = useState<TTx[]>(() => { const c = readCache<{ d: string; items: TTx[] }>(cacheKey, { d: '', items: [] }); return c.d === todayISO() ? c.items : []; });
  const setBase = useCallback((f: (b: TTx[]) => TTx[]) => setBaseRaw((b) => { const n = f(b); writeCache(cacheKey, { d: todayISO(), items: n }); return n; }), [cacheKey]);
  useEffect(() => {
    let alive = true;
    get('/talko/transactions' + qs({ from: todayISO(), to: todayISO(), type }))
      .then((r) => { if (alive && !SY.ops().length) setBase(() => r.items ?? []); })
      .catch(() => { /* offline: keep what we have */ });
    return () => { alive = false; };
  }, [version, type, setBase]);
  useEffect(() => SY.subscribe((e) => {
    if (e.type !== 'done') return;
    const op = e.op;
    if (op.kind === 'add' && op.item.type === type && op.item.localDate === todayISO()) {
      const id = e.realId ?? op.tmpId;
      setBase((b) => [{ ...op.item, id }, ...b.filter((x) => x.id !== id)]);
      setSel((s) => s === op.tmpId ? id : s);
    }
    if (op.kind === 'delete') setBase((b) => b.filter((x) => x.id !== op.txId));
    if (op.kind === 'edit') setBase((b) => b.map((x) => x.id !== op.txId ? x : { ...x, ...(op.body.description !== undefined ? { comment: op.body.description } : {}), ...(op.body.date ? { localDate: op.body.date } : {}) }).filter((x) => x.localDate === todayISO()));
  }), [type, setBase]);
  const deleting = new Set<string>(outbox.flatMap((o) => o.kind === 'delete' ? [o.txId] : []));
  const editsOf = (id: string) => outbox.filter((o): o is Extract<Op, { kind: 'edit' }> => o.kind === 'edit' && o.txId === id);
  const pendingIds = new Set<string>(outbox.flatMap((o) => o.kind === 'add' ? [o.tmpId] : 'txId' in o ? [o.txId] : []));
  const items: TTx[] = [
    ...outbox.flatMap((o) => o.kind === 'add' && o.item.type === type ? [{ ...o.item, id: o.tmpId }] : []),
    ...base,
  ].filter((x) => !deleting.has(x.id))
    .map((x) => editsOf(x.id).reduce((a, o) => ({ ...a, ...(o.body.description !== undefined ? { comment: o.body.description } : {}), ...(o.body.date ? { localDate: o.body.date } : {}) }), x))
    .filter((x) => x.localDate === todayISO())
    .sort((a, b) => String(b.time ?? '').localeCompare(String(a.time ?? '')));
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
  const pages = Math.max(1, Math.ceil(accounts.length / PAGE));
  const shown = accounts.slice(page * PAGE, page * PAGE + PAGE);
  const folders = folderIds(categories);
  const cats = folder ? [...categories.filter((c) => c.id === folder), ...categories.filter((c) => c.parentId === folder)] : mainCategories(categories, type).filter((c) => !c.parentId || !folders.has(c.parentId) || !mainCategories(categories, type).some((m) => m.id === c.parentId));
  const folderName = folder ? categories.find((c) => c.id === folder)?.name : null;
  const todayTotal = items.reduce((s: Record<string, number>, x: TTx) => ({ ...s, [x.currency]: Math.round(((s[x.currency] ?? 0) + Number(x.amount)) * 100) / 100 }), {});
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
    enqueue({ id: SY.uid(), kind: 'add', tmpId, at: now.toISOString(), tries: 0, body: { type, amount: n, accountId, categoryId, projectId: null, description: '', date: todayISO() }, item });
    setSel(tmpId); setExpr(''); setFolder(null);
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
    enqueue({ id: SY.uid(), kind: 'edit', txId: e0.id, at: new Date().toISOString(), tries: 0, body: e0.kind === 'comment' ? { description: e0.value } : { date: e0.value } });
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
        {expr && <button className="m-clear" onClick={() => setExpr('')} aria-label="Очистити">✕</button>}
      </div>
      <div className="m-accs">
        <div className="m-acc-grid">
          {shown.map((a) => (
            <button key={a.id} className={'m-acc' + (a.id === accountId ? ' on' : '')} onClick={() => { setAccountId(a.id); try { localStorage.setItem('gok.talko.acc.' + type, a.id); } catch { /* ignore */ } }}>
              <span className="n ellipsis">{a.name}</span><span className="b num">{money(a.balance, a.currency)}</span>
            </button>
          ))}
        </div>
        {pages > 1 && <button className="m-acc-next" onClick={() => setPage((page + 1) % pages)} aria-label="Інші рахунки">›</button>}
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
          <TxList items={items} compact selected={sel} pending={pendingIds} onSelect={(id) => setSel(sel === id ? null : id)}
            onYesterday={(i) => {
              const d = new Date(); d.setDate(d.getDate() - 1);
              moveDate(i, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
            }}
            onDate={(i) => setEdit({ id: i.id, kind: 'date', value: i.localDate ?? todayISO() })}
            onDelete={async (i) => {
              if (sel === i.id) setSel(null);
              enqueue({ id: SY.uid(), kind: 'delete', txId: i.id, at: new Date().toISOString(), tries: 0, item: i });
            }}
            actions={(i) => (<>
              <button onClick={() => setEdit({ id: i.id, kind: 'comment', value: i.comment === '—' ? '' : (i.comment ?? '') })} aria-label="Коментар">✎<span>Коментар</span></button>
              <button onClick={() => setEdit({ id: i.id, kind: 'date', value: i.localDate ?? todayISO() })} aria-label="Дата">📅<span>Дата</span></button>
            </>)} />
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
      {voice && <TVoice defaultType={type} onClose={() => setVoice(false)} />}
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

const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Comment without what the row already shows: the category, the account and the time. */
function cleanComment(c: string | null | undefined, cat?: string | null, acc?: string | null) {
  let x = String(c ?? '');
  x = x.replace(/(^|[\s(,])([01]?\d|2[0-3]):[0-5]\d(?![\d:])/g, '$1');
  x = x.replace(/\s*у\s*«?Деньги ОК»?/gi, '');
  if (acc) x = x.replace(new RegExp('(^|[\\s(,—-])' + esc(acc) + '(?=$|[\\s),—-])', 'giu'), '$1');
  if (cat) x = x.replace(new RegExp('^\\s*' + esc(cat) + '(?=$|[\\s(,—:-])', 'iu'), '');
  x = x.replace(/\(\s*[,;:—-]*\s*\)/g, '').replace(/\(\s*[,;]\s*/g, '(').replace(/\s*[,;]\s*\)/g, ')');
  x = x.replace(/\s{2,}/g, ' ').replace(/^[\s—:,;-]+|[\s—:,;-]+$/g, '').trim();
  return x === '—' ? '' : x;
}

function TxList({ items, compact, selected, onSelect, actions, onDelete, onYesterday, onDate, pending }: { items: TTx[]; compact?: boolean; pending?: Set<string>; selected?: string | null; onSelect?: (id: string) => void; actions?: (i: TTx) => React.ReactNode; onDelete?: (i: TTx) => Promise<void>; onYesterday?: (i: TTx) => void; onDate?: (i: TTx) => void }) {
  const { t, lang } = useT();
  const { accounts } = useTalko();
  // swipe left on an entry reveals the red trash button, like «Деньги ОК»
  const [swiped, setSwiped] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  // swipe right reveals «Вчора» and «Дата» (like iPhone Reminders)
  const [swipedR, setSwipedR] = useState<string | null>(null);
  const touch = useRef<{ id: string; x: number; y: number } | null>(null);
  const sw = onDelete || onYesterday || onDate ? (i: TTx) => ({
    onTouchStart: (e: React.TouchEvent) => { touch.current = { id: i.id, x: e.touches[0].clientX, y: e.touches[0].clientY }; },
    onTouchEnd: (e: React.TouchEvent) => {
      const st = touch.current; touch.current = null;
      if (!st || st.id !== i.id) return;
      const dx = e.changedTouches[0].clientX - st.x, dy = e.changedTouches[0].clientY - st.y;
      if (Math.abs(dx) < 40 || Math.abs(dy) > Math.abs(dx)) return;
      if (swiped || swipedR) { setSwiped(null); setSwipedR(null); return; } // any swipe closes an open row
      if (dx < 0) setSwiped(i.id); else if (onYesterday || onDate) setSwipedR(i.id);
    },
  }) : () => ({});
  if (!items.length) return <div className="empty">{t.nothing}</div>;
  const days: Array<[string, TTx[]]> = [];
  for (const i of items) { const l = days[days.length - 1]; if (l && l[0] === i.localDate) l[1].push(i); else days.push([i.localDate, [i]]); }
  return (
    <>
      {days.map(([d, list]) => (
        <div key={d}>
          {!compact && <div className="day-head"><span>{fmtDay(d, lang, t)}</span></div>}
          <div className="list">
            {list.map((i) => (
              <div key={i.id} className={'item' + (selected === i.id ? ' sel' : '') + (swiped === i.id ? ' swiped' : '') + (swipedR === i.id ? ' swiped-r' : '')} {...sw(i)}
                onClick={() => { if (swiped || swipedR) { setSwiped(null); setSwipedR(null); return; } onSelect?.(i.id); }}>
                {swipedR === i.id && (
                  <div className="m-left-acts" onClick={(e) => e.stopPropagation()}>
                    {onYesterday && <button className="m-yest" onClick={() => { setSwipedR(null); onYesterday(i); }}>Вчора</button>}
                    {onDate && <button className="m-dt" onClick={() => { setSwipedR(null); onDate(i); }}>Дата</button>}
                  </div>
                )}
                <span className="ic">{catIcon(i.categoryName ?? '')}</span>
                <div className="main"><div className="t1">{i.categoryName || i.comment}</div><div className="t2">{accounts.find((a) => a.id === i.accountId)?.name}</div>{(() => { const c = cleanComment(i.comment, i.categoryName, accounts.find((a) => a.id === i.accountId)?.name); return c && i.categoryName ? <div className="t3">{c}</div> : null; })()}</div>
                <div className={'amt num ' + (i.type === 'expense' ? 'c-expense' : 'c-income')}>{money(i.amount, i.currency)}<small>{pending?.has(i.id) && <span className="m-pend" title="Ще не в TALKO">⟳ </span>}{i.time ?? ''}</small></div>
                {selected === i.id && actions && <div className="m-actions" onClick={(e) => e.stopPropagation()}>{actions(i)}</div>}
                {swiped === i.id && onDelete && (
                  <button className="m-trash" aria-label="Видалити" disabled={deleting === i.id}
                    onClick={async (e) => { e.stopPropagation(); setDeleting(i.id); try { await onDelete(i); setSwiped(null); } finally { setDeleting(null); } }}>
                    {deleting === i.id ? '…' : '🗑'}
                  </button>
                )}
              </div>
            ))}
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

function TVoice({ defaultType, onClose }: { defaultType: 'income' | 'expense'; onClose: () => void }) {
  const { t, lang } = useT();
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
    rec.onresult = (e: any) => { const p = Array.from(e.results).map((x: any) => x[0].transcript).join(' '); setText(p); if (e.results[e.results.length - 1].isFinal) run(p); };
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
