/**
 * TALKO mode: the phone app is a front end for TALKO CRM finance. Every number is read from
 * TALKO and every new operation is written to TALKO (with TALKO's own confirmation step).
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { del, get, post, qs } from '../api';
import { Bars, Donut } from '../components/Charts';
import { ErrorBox, Field, Icons, Sheet, fmtDay } from '../components/ui';
import { useT } from '../i18n';
import { money, normalizeAmountInput, todayISO } from '../money';

interface TAccount { id: string; name: string; type: string; currency: string; balance: string }
interface TCategory { id: string; name: string; type: 'income' | 'expense'; parentId: string | null }
interface TTx { id: string; type: 'income' | 'expense'; amount: string; currency: string; accountId: string; categoryName: string | null; comment: string; counterparty: string; occurredAt: string; localDate: string }
type Tab = 'expense' | 'income' | 'accounts' | 'feed' | 'menu';

interface Ctx {
  accounts: TAccount[]; totals: Record<string, string>; totalBase: string | null; baseCurrency: string;
  categories: TCategory[]; projects: Array<{ id: string; name: string }>;
  version: number; changed: () => Promise<void>; error: string | null;
  toast: (m: string, err?: boolean) => void;
}
const TC = createContext<Ctx>(null as unknown as Ctx);
const useTalko = () => useContext(TC);

const PALETTE = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767'];

export function TalkoShell() {
  const { t } = useT();
  const [tab, setTab] = useState<Tab>('expense');
  const [data, setData] = useState<Omit<Ctx, 'version' | 'changed' | 'toast' | 'error'>>({ accounts: [], totals: {}, totalBase: null, baseCurrency: 'UAH', categories: [], projects: [] });
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<{ m: string; err?: boolean } | null>(null);
  const timer = useRef<number>();
  const load = useCallback(async () => {
    try {
      const [a, c, p] = await Promise.all([get('/talko/accounts'), get('/talko/categories'), get('/talko/projects')]);
      setData({ accounts: a.accounts, totals: a.totalsByCurrency, totalBase: a.totalBase, baseCurrency: a.baseCurrency, categories: c, projects: p });
      setError(null);
    } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const ctx: Ctx = {
    ...data, version, error,
    changed: async () => { await load(); setVersion((v) => v + 1); },
    toast: (m, err) => { setToastMsg({ m, err }); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setToastMsg(null), err ? 5000 : 2200); },
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
  const { accounts, categories, projects, changed, toast } = useTalko();
  const [f, setF] = useState({ type, amount, accountId, categoryId, projectId: '', description: comment ?? '', counterparty: '', date: todayISO() });
  const [pending, setPending] = useState<{ token: string; preview: unknown } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cats = categories.filter((c) => c.type === f.type);
  const ordered = cats.filter((c) => !c.parentId || !cats.some((p) => p.id === c.parentId)).flatMap((p) => [p, ...cats.filter((c) => c.parentId === p.id)]);
  const valid = /^\d+([.,]\d{1,2})?$/.test(f.amount.trim()) && Number(normalizeAmountInput(f.amount)) > 0 && f.accountId && f.categoryId;
  async function submit(token?: string) {
    setBusy(true); setError(null);
    try {
      const r = await post('/talko/transactions', { ...f, amount: normalizeAmountInput(f.amount), projectId: f.projectId || null, confirmationToken: token });
      if (r.status === 'needs_confirmation') { setPending({ token: r.confirmationToken, preview: r.preview }); return; }
      await changed(); toast(t.saved + ' у TALKO'); onClose();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
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
          <Field label={t.comment}><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={500} /></Field>
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

function TEntry({ type }: { type: 'income' | 'expense' }) {
  const { t } = useT();
  const { accounts, categories, version } = useTalko();
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState(() => { try { return localStorage.getItem('gok.talko.acc.' + type) ?? ''; } catch { return ''; } });
  const [open, setOpen] = useState<string | null>(null);
  const [voice, setVoice] = useState(false);
  useEffect(() => { if (accounts.length && !accounts.some((a) => a.id === accountId)) setAccountId(accounts[0].id); }, [accounts, accountId]);
  const today = useAsyncT(() => get('/talko/transactions' + qs({ from: todayISO(), to: todayISO(), type })), [version, type]);
  const color = type === 'expense' ? 'var(--expense)' : 'var(--income)';
  const press = (k: string) => setAmount((a) => (k === '⌫' ? a.slice(0, -1) : k === ',' ? (a.includes(',') ? a : (a || '0') + ',') : a.includes(',') && a.split(',')[1].length >= 2 ? a : a.length >= 12 ? a : a === '0' ? k : a + k));
  const roots = categories.filter((c) => c.type === type);
  const account = accounts.find((a) => a.id === accountId);
  const todayTotal = (today.data?.items ?? []).reduce((s: Record<string, number>, x: TTx) => ({ ...s, [x.currency]: Math.round(((s[x.currency] ?? 0) + Number(x.amount)) * 100) / 100 }), {});
  return (
    <>
      <div className="topbar">
        <h1 style={{ color }}>{type === 'expense' ? t.expenses : t.income}</h1>
        <div style={{ textAlign: 'right' }}>
          <div className="faint">{type === 'expense' ? t.todayExpenses : t.todayIncome}</div>
          <div className="num" style={{ fontWeight: 800, color }}>{Object.entries(todayTotal).map(([c, v]) => money((v as number).toFixed(2), c)).join(' + ') || '0'}</div>
        </div>
        <button className="icon-btn" onClick={() => setVoice(true)} aria-label={t.voice}>{Icons.mic}</button>
      </div>
      <div className="entry-grid">
        <div className="entry-left">
          <div className={'amount-display num' + (amount ? '' : ' placeholder')} style={amount ? { color } : undefined}>{amount || '0'}<span className="cur">{account?.currency}</span></div>
          <div className="chips">
            {accounts.map((a) => (
              <button key={a.id} className={'acc-chip' + (a.id === accountId ? ' on' : '') + (type === 'income' ? ' income' : '')} onClick={() => { setAccountId(a.id); try { localStorage.setItem('gok.talko.acc.' + type, a.id); } catch { /* ignore */ } }}>
                <div className="n ellipsis">{a.name}</div><div className="b num">{money(a.balance, a.currency)}</div>
              </button>
            ))}
          </div>
          <div className="keypad">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', ',', '0', '⌫'].map((k) => <button key={k} onClick={() => press(k)} aria-label={k === '⌫' ? 'Backspace' : k}>{k === '⌫' ? <span style={{ display: 'grid', placeItems: 'center' }}>{Icons.backspace}</span> : k}</button>)}
          </div>
        </div>
        <div>
          <div className="section-title">{/[1-9]/.test(amount) ? t.chooseCategory : t.category}</div>
          <div className="cat-grid">
            {roots.map((c, i) => (
              <button key={c.id} className="cat-btn" disabled={!/[1-9]/.test(amount)} onClick={() => setOpen(c.id)}>
                <span className="ic" style={{ width: 40, height: 40, background: (c.parentId ? '#8e8e93' : PALETTE[i % PALETTE.length]) + '33', color: c.parentId ? '#8e8e93' : PALETTE[i % PALETTE.length], fontWeight: 700 }}>{c.name.slice(0, 1)}</span>
                <span className="lbl">{c.name}</span>
              </button>
            ))}
          </div>
          <div className="section-title">{t.today}</div>
          <TxList items={today.data?.items ?? []} />
        </div>
      </div>
      {open && <TxSheet type={type} amount={amount.replace(',', '.')} accountId={accountId} categoryId={open} onClose={() => { setOpen(null); setAmount(''); }} />}
      {voice && <TVoice defaultType={type} onClose={() => setVoice(false)} />}
    </>
  );
}

function TxList({ items }: { items: TTx[] }) {
  const { t, lang } = useT();
  const { accounts } = useTalko();
  if (!items.length) return <div className="empty">{t.nothing}</div>;
  const days: Array<[string, TTx[]]> = [];
  for (const i of items) { const l = days[days.length - 1]; if (l && l[0] === i.localDate) l[1].push(i); else days.push([i.localDate, [i]]); }
  return (
    <>
      {days.map(([d, list]) => (
        <div key={d}>
          <div className="day-head"><span>{fmtDay(d, lang, t)}</span></div>
          <div className="list">
            {list.map((i) => (
              <div key={i.id} className="item">
                <span className="ic">{i.type === 'expense' ? '−' : '+'}</span>
                <div className="main"><div className="t1">{i.comment || i.categoryName}</div><div className="t2">{[i.categoryName, accounts.find((a) => a.id === i.accountId)?.name, i.counterparty].filter(Boolean).join(' · ')}</div></div>
                <div className={'amt num ' + (i.type === 'expense' ? 'c-expense' : 'c-income')}>{i.type === 'expense' ? '−' : '+'}{money(i.amount, i.currency)}</div>
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
  const [transfer, setTransfer] = useState(false);
  return (
    <>
      <div className="topbar"><h1>{t.accounts}</h1><button className="btn primary small" onClick={() => setTransfer(true)}>⇄ {t.transfer}</button></div>
      <div className="card">
        <div className="faint">{t.netWorth} (TALKO)</div>
        {totalBase && <div className="hero c-balance num">{money(totalBase, baseCurrency)}</div>}
        {Object.entries(totals).map(([c, v]) => <div key={c} className="faint num">{money(v, c)}</div>)}
      </div>
      <div className="section-title">{t.accounts}</div>
      <div className="list">
        {accounts.map((a) => (
          <div key={a.id} className="item">
            <span className="ic">{a.type === 'cash' ? '💵' : a.type === 'card' ? '💳' : a.type === 'savings' ? '🐷' : '🏦'}</span>
            <div className="main"><div className="t1">{a.name}</div><div className="t2">{t.types[a.type] ?? a.type}</div></div>
            <div className="amt num c-balance">{money(a.balance, a.currency)}</div>
          </div>
        ))}
      </div>
      {transfer && <TTransfer onClose={() => setTransfer(false)} />}
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
          <Field label={t.comment}><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
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
          <button className="btn danger block" style={{ marginTop: 16 }} onClick={async () => { await post('/auth/logout'); location.reload(); }}>{t.logout}</button>
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
