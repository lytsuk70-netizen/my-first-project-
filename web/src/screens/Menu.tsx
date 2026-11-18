import { useEffect, useState } from 'react';
import { del, get, post, put } from '../api';
import { TxEditor } from '../components/TxEditor';
import { CatIcon, ErrorBox, Field, Icons, Sheet, fmtDate } from '../components/ui';
import { dictionaries, useT } from '../i18n';
import { money, todayISO } from '../money';
import { useAsync, useStore, type MenuScreen } from '../store';
import type { Category, Draft, Project } from '../types';
import { Reports } from './Reports';

export function Menu() {
  const { t } = useT();
  const { menu, setMenu } = useStore();
  const items: Array<[MenuScreen, string, string]> = [
    ['reports', '📊', t.reports], ['categories', '🏷️', t.categories], ['projects', '🏗️', t.projects], ['rates', '💱', t.rates],
    ['import', '✉️', t.smsImport], ['settings', '⚙️', t.settings], ['audit', '🧾', t.audit],
  ];
  const current = items.find((i) => i[0] === menu);
  return (
    <>
      <div className="topbar">
        {menu && <button className="icon-btn" onClick={() => setMenu(null)} aria-label="back">{Icons.back}</button>}
        <h1>{current ? current[2] : t.menu}</h1>
      </div>
      {!menu && (
        <>
          <div className="list">
            {items.map(([key, icon, label]) => (
              <button key={key} className="item" onClick={() => setMenu(key)}><span className="ic">{icon}</span><div className="main"><div className="t1">{label}</div></div>{Icons.chevR}</button>
            ))}
          </div>
          <LogoutButton />
        </>
      )}
      {menu === 'reports' && <Reports />}
      {menu === 'categories' && <Categories />}
      {menu === 'projects' && <Projects />}
      {menu === 'rates' && <Rates />}
      {menu === 'import' && <SmsImport />}
      {menu === 'settings' && <SettingsScreen />}
      {menu === 'audit' && <Audit />}
    </>
  );
}

function LogoutButton() {
  const { t } = useT();
  return <button className="btn danger block" style={{ marginTop: 16 }} onClick={async () => { await post('/auth/logout'); location.reload(); }}>{t.logout}</button>;
}

// ---------- categories ----------

const EMOJI = ['🛒', '🍽️', '☕', '🚕', '⛽', '🚌', '💊', '🏥', '👨‍👩‍👧', '🏠', '💡', '📱', '👕', '🎬', '🎮', '📚', '📈', '🏗️', '💙', '🎁', '💼', '🏢', '💻', '🏦', '✈️', '🐶', '💅', '🍺', '🚗', '🧾', '•'];
const COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767', '#8e8e93'];

function CategoryEditor({ cat, type, onClose }: { cat?: Category; type: 'income' | 'expense'; onClose: () => void }) {
  const { t } = useT();
  const { categories, changed, toast } = useStore();
  const [name, setName] = useState(cat?.name ?? '');
  const [icon, setIcon] = useState(cat?.icon ?? '•');
  const [color, setColor] = useState(cat?.color ?? COLORS[0]);
  const [parentId, setParentId] = useState(cat?.parentId ?? '');
  const [error, setError] = useState<string | null>(null);
  const parents = categories.filter((c) => c.type === type && !c.parentId && c.id !== cat?.id && !c.isArchived);
  async function run(fn: () => Promise<any>) {
    try { const r = await fn(); await changed(); toast(r?.result === 'archived' ? `${t.archived}: ${t.deleteCategoryHint}` : t.saved); onClose(); } catch (e: any) { setError(e.message); }
  }
  const body = { name, icon, color, parentId: parentId || null };
  return (
    <Sheet title={cat ? cat.name : t.newCategory} onClose={onClose}>
      <Field label={t.name}><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus /></Field>
      <Field label={t.icon}><div className="chips" style={{ flexWrap: 'wrap' }}>{EMOJI.map((e) => <button key={e} className={'chip' + (icon === e ? ' on' : '')} onClick={() => setIcon(e)}>{e}</button>)}</div></Field>
      <Field label={t.color}>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {COLORS.map((c) => <button key={c} onClick={() => setColor(c)} aria-label={c} style={{ width: 34, height: 34, borderRadius: '50%', background: c, border: color === c ? '3px solid #fff' : '3px solid transparent' }} />)}
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label={t.color} />
        </div>
      </Field>
      <Field label={t.parent}>
        <select className="input" value={parentId} onChange={(e) => setParentId(e.target.value)}>
          <option value="">{t.none}</option>
          {parents.map((p) => <option key={p.id} value={p.id}>{p.icon} {p.name}</option>)}
        </select>
      </Field>
      <ErrorBox error={error} />
      <div className="actions">
        {cat && <button className="btn danger" onClick={() => confirm(t.deleteCategoryHint) && run(() => del(`/categories/${cat.id}`))}>{t.delete}</button>}
        {cat && <button className="btn" onClick={() => run(() => put(`/categories/${cat.id}`, { isArchived: !cat.isArchived }))}>{cat.isArchived ? t.unarchive : t.archive}</button>}
        <button className="btn primary" disabled={!name.trim()} onClick={() => run(() => (cat ? put(`/categories/${cat.id}`, body) : post('/categories', { ...body, type })))}>{t.save}</button>
      </div>
    </Sheet>
  );
}

function Categories() {
  const { t } = useT();
  const { categories, changed } = useStore();
  const [type, setType] = useState<'expense' | 'income'>('expense');
  const [edit, setEdit] = useState<Category | 'new' | null>(null);
  const list = categories.filter((c) => c.type === type);
  const roots = list.filter((c) => !c.parentId && !c.isArchived);
  const ordered = roots.flatMap((r) => [r, ...list.filter((c) => c.parentId === r.id && !c.isArchived)]);
  const archived = list.filter((c) => c.isArchived);
  async function move(id: string, dir: number) {
    const ids = roots.map((r) => r.id);
    const i = ids.indexOf(id); const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await post('/categories/reorder', { ids }); await changed();
  }
  const row = (c: Category) => (
    <div key={c.id} className="item">
      <CatIcon icon={c.icon} color={c.color} />
      <button className="main" style={{ background: 'none', border: 0, textAlign: 'left', padding: 0, paddingLeft: c.parentId ? 18 : 0 }} onClick={() => setEdit(c)}>
        <div className="t1">{c.parentId ? '↳ ' : ''}{c.name}</div><div className="t2">{c.usage} {t.used}{c.isArchived ? ` · ${t.archived}` : ''}</div>
      </button>
      {!c.parentId && !c.isArchived && <><button className="btn ghost small" onClick={() => move(c.id, -1)} aria-label="up">▲</button><button className="btn ghost small" onClick={() => move(c.id, 1)} aria-label="down">▼</button></>}
    </div>
  );
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="seg grow">
          <button className={type === 'expense' ? 'on c-expense' : ''} onClick={() => setType('expense')}>{t.expenses}</button>
          <button className={type === 'income' ? 'on c-income' : ''} onClick={() => setType('income')}>{t.income}</button>
        </div>
        <button className="btn primary small" onClick={() => setEdit('new')}>+ {t.add}</button>
      </div>
      <div className="list">{ordered.map(row)}</div>
      {archived.length > 0 && <><div className="section-title">{t.archiveTab}</div><div className="list">{archived.map(row)}</div></>}
      {edit && <CategoryEditor cat={edit === 'new' ? undefined : edit} type={type} onClose={() => setEdit(null)} />}
    </>
  );
}

// ---------- projects ----------

function Projects() {
  const { t } = useT();
  const { projects, changed, toast, openFeed } = useStore();
  const [edit, setEdit] = useState<Project | 'new' | null>(null);
  const [name, setName] = useState(''); const [desc, setDesc] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (edit && edit !== 'new') { setName(edit.name); setDesc(edit.description); } else { setName(''); setDesc(''); } setError(null); }, [edit]);
  async function save(extra: object = {}) {
    try {
      if (edit === 'new') await post('/projects', { name, description: desc }); else await put(`/projects/${(edit as Project).id}`, { name, description: desc, ...extra });
      await changed(); toast(t.saved); setEdit(null);
    } catch (e: any) { setError(e.message); }
  }
  return (
    <>
      <button className="btn primary small" onClick={() => setEdit('new')} style={{ marginBottom: 12 }}>+ {t.newProject}</button>
      {projects.length ? <div className="list">{projects.map((p) => (
        <div key={p.id} className="item">
          <span className="ic">🏗️</span>
          <button className="main" style={{ background: 'none', border: 0, textAlign: 'left', padding: 0 }} onClick={() => setEdit(p)}><div className="t1">{p.name}</div><div className="t2">{p.usage} {t.used}{p.isArchived ? ` · ${t.archived}` : ''}{p.description ? ' · ' + p.description : ''}</div></button>
          <button className="btn ghost small" onClick={() => openFeed({ projectId: p.id })}>{t.history} →</button>
        </div>
      ))}</div> : <div className="empty">{t.nothing}</div>}
      {edit && (
        <Sheet title={edit === 'new' ? t.newProject : edit.name} onClose={() => setEdit(null)}>
          <Field label={t.name}><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus /></Field>
          <Field label={t.description}><input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={500} /></Field>
          <ErrorBox error={error} />
          <div className="actions">
            {edit !== 'new' && <button className="btn" onClick={() => save({ isArchived: !edit.isArchived })}>{edit.isArchived ? t.unarchive : t.archive}</button>}
            <button className="btn primary" disabled={!name.trim()} onClick={() => save()}>{t.save}</button>
          </div>
        </Sheet>
      )}
    </>
  );
}

// ---------- exchange rates ----------

function Rates() {
  const { t } = useT();
  const { currencies, settings, version, changed, toast } = useStore();
  const rates = useAsync(() => get('/rates'), [version]);
  const [form, setForm] = useState({ date: todayISO(), base: settings.base_currency === 'USD' ? 'EUR' : 'USD', quote: settings.base_currency, rate: '' });
  const [error, setError] = useState<string | null>(null);
  async function add() {
    try { await post('/rates', { ...form, rate: form.rate.replace(',', '.') }); setForm({ ...form, rate: '' }); setError(null); await changed(); toast(t.saved); } catch (e: any) { setError(e.message); }
  }
  async function remove(id: string) { try { await del(`/rates/${id}`); await changed(); } catch (e: any) { toast(e.message, true); } }
  return (
    <>
      <div className="card">
        <p className="faint" style={{ marginTop: 0 }}>{t.rateExplain}</p>
        <div className="grid2">
          <Field label={t.date}><input className="input" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
          <Field label={t.rate}><input className="input num" inputMode="decimal" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} placeholder="41,50" /></Field>
          <Field label={t.base}><select className="input" value={form.base} onChange={(e) => setForm({ ...form, base: e.target.value })}>{currencies.map((c) => <option key={c.code}>{c.code}</option>)}</select></Field>
          <Field label={t.quote}><select className="input" value={form.quote} onChange={(e) => setForm({ ...form, quote: e.target.value })}>{currencies.map((c) => <option key={c.code}>{c.code}</option>)}</select></Field>
        </div>
        <ErrorBox error={error} />
        <button className="btn primary block" disabled={!/^\d+([.,]\d+)?$/.test(form.rate) || form.base === form.quote} onClick={add}>{t.add}</button>
      </div>
      <div className="section-title">{t.rates}</div>
      {rates.data?.length ? (
        <div className="list">
          {rates.data.map((r: any) => (
            <div key={r.id} className="item">
              <span className="ic">💱</span>
              <div className="main"><div className="t1 num">1 {r.base} = {r.rate} {r.quote}</div><div className="t2">{r.date} · {t.rateSource[r.source]}</div></div>
              {r.source !== 'transfer' && <button className="btn ghost small c-danger" onClick={() => remove(r.id)}>{t.delete}</button>}
            </div>
          ))}
        </div>
      ) : <div className="empty">{t.nothing}</div>}
    </>
  );
}

// ---------- SMS import ----------

interface Imported { id: string; text: string; status: string; alreadyImported: boolean; draft: Draft; duplicates: Array<{ id: string; occurred_at: string; comment: string; account_name: string }> }

function SmsImport() {
  const { t, lang } = useT();
  const { accounts, sharedText, consumeShared, version } = useStore();
  const [text, setText] = useState('');
  const [results, setResults] = useState<Imported[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Imported | null>(null);
  const pending = useAsync(() => get('/import/messages?status=pending'), [version]);

  useEffect(() => { if (sharedText) { setText(sharedText); consumeShared(); } }, [sharedText, consumeShared]);
  async function parse() {
    try { setResults(await post('/import/messages', { text, source: 'paste', tzOffsetMinutes: new Date().getTimezoneOffset() })); setError(null); } catch (e: any) { setError(e.message); }
  }
  async function ignore(id: string) { await post(`/import/messages/${id}/ignore`); setResults((r) => r.map((x) => (x.id === id ? { ...x, status: 'ignored' } : x))); }
  const shown: Imported[] = results.length ? results : (pending.data ?? []).map((p: any) => ({ ...p, alreadyImported: true, duplicates: [] }));

  return (
    <>
      <p className="faint">{t.smsIosNote}</p>
      <textarea className="input" style={{ minHeight: 120 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={t.smsPaste} />
      <ErrorBox error={error} />
      <button className="btn primary block" style={{ marginTop: 10 }} disabled={!text.trim()} onClick={parse}>{t.parse}</button>
      {shown.map((m) => {
        const d = m.draft;
        const acc = accounts.find((a) => a.id === d.accountId);
        const done = m.status !== 'pending';
        return (
          <div key={m.id} className="card" style={{ marginTop: 12, opacity: done ? 0.6 : 1 }}>
            <div className="faint" style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
            <div className="row between" style={{ marginTop: 8 }}>
              <b className={'num ' + (d.type === 'income' ? 'c-income' : 'c-expense')}>{d.amount ? money(d.amount, d.currency ?? undefined) : '?'}</b>
              <span className="faint">{acc?.name ?? '?'} · {d.occurredAt ? fmtDate(d.occurredAt, lang) : ''}</span>
            </div>
            {d.balance && <div className="faint num">{t.bankBalance}: {money(d.balance, d.balanceCurrency ?? undefined)}{acc ? ` · ${t.appBalance}: ${money(acc.balance, acc.currency)}` : ''}</div>}
            {m.duplicates.length > 0 && <div className="warn" style={{ marginTop: 6 }}>⚠️ {t.possibleDuplicate}: {m.duplicates.map((x) => `${fmtDate(x.occurred_at, lang)} ${x.account_name} ${x.comment}`).join('; ')}</div>}
            {d.questions.length > 0 && !done && <div className="faint" style={{ marginTop: 6 }}>{d.questions.join(' ')}</div>}
            <div className="row" style={{ marginTop: 10 }}>
              {done ? <span className="faint">{m.status === 'imported' ? t.alreadyImported : t.ignore}</span> : (
                <>
                  <button className="btn small" onClick={() => ignore(m.id)}>{t.ignore}</button>
                  <button className="btn primary small grow" onClick={() => setConfirming(m)}>{t.checkAndConfirm}</button>
                </>
              )}
            </div>
          </div>
        );
      })}
      {confirming && (
        <TxEditor mode="create" allowTypeChange importMessageId={confirming.id} source="sms" title={t.checkAndConfirm} questions={confirming.draft.questions}
          onClose={() => setConfirming(null)} onSaved={() => setResults((r) => r.map((x) => (x.id === confirming.id ? { ...x, status: 'imported' } : x)))}
          initial={{ type: confirming.draft.type ?? 'expense', amount: confirming.draft.amount ?? '', accountId: confirming.draft.accountId ?? (confirming.draft.candidates.accounts.length === 1 ? confirming.draft.candidates.accounts[0] : ''), categoryId: confirming.draft.categoryId ?? '', occurredAt: confirming.draft.occurredAt, comment: confirming.draft.comment }} />
      )}
    </>
  );
}

// ---------- settings ----------

function SettingsScreen() {
  const { t } = useT();
  const { settings, currencies, reload, toast } = useStore();
  const [pw, setPw] = useState({ current: '', next: '' });
  const [error, setError] = useState<string | null>(null);
  async function update(patch: object) {
    try { await put('/settings', patch); await reload(); toast(t.saved); } catch (e: any) { toast(e.message, true); }
  }
  async function changePw() {
    try { await post('/auth/password', pw); setPw({ current: '', next: '' }); setError(null); toast(t.saved); } catch (e: any) { setError(e.message); }
  }
  const zones = (Intl as any).supportedValuesOf ? (Intl as any).supportedValuesOf('timeZone') as string[] : [settings.timezone];
  return (
    <>
      <div className="card">
        <Field label={t.language}>
          <div className="seg">{(Object.keys(dictionaries) as Array<'uk' | 'en'>).map((l) => <button key={l} className={settings.language === l ? 'on' : ''} onClick={() => update({ language: l })}>{l === 'uk' ? 'Українська' : 'English'}</button>)}</div>
        </Field>
        <Field label={t.baseCurrency}>
          <select className="input" value={settings.base_currency} onChange={(e) => update({ baseCurrency: e.target.value })}>{currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</select>
        </Field>
        <Field label={t.timezone}>
          <select className="input" value={settings.timezone} onChange={(e) => update({ timezone: e.target.value })}>{(zones.includes(settings.timezone) ? zones : [settings.timezone, ...zones]).map((z) => <option key={z}>{z}</option>)}</select>
        </Field>
      </div>
      <div className="section-title">{t.exportData}</div>
      <div className="card">
        <a className="btn block" style={{ display: 'block', textAlign: 'center', textDecoration: 'none', color: 'var(--text)' }} href="/api/export/json" download>💾 {t.backupJson}</a>
        <a className="btn block" style={{ display: 'block', textAlign: 'center', textDecoration: 'none', color: 'var(--text)', marginTop: 8 }} href="/api/export/csv" download>📄 {t.exportCsv}</a>
        <p className="faint">{t.backupHint}</p>
      </div>
      <div className="section-title">{t.changePassword}</div>
      <div className="card">
        <Field label={t.currentPassword}><input className="input" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
        <Field label={t.newPassword}><input className="input" type="password" autoComplete="new-password" minLength={8} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
        <ErrorBox error={error} />
        <button className="btn primary block" disabled={!pw.current || pw.next.length < 8} onClick={changePw}>{t.save}</button>
      </div>
      <LogoutButton />
    </>
  );
}

// ---------- audit ----------

function Audit() {
  const { t, lang } = useT();
  const { version } = useStore();
  const log = useAsync(() => get('/audit'), [version]);
  const summarize = (e: any) => {
    const v = e.after ?? e.before ?? {};
    return [v.name, v.amount_minor !== undefined ? `${v.amount_minor} (minor) ${v.currency ?? ''}` : null, v.delta ? `Δ ${v.delta}` : null, v.amount_sent_minor ? `${v.amount_sent_minor} → ${v.amount_received_minor}` : null, v.comment].filter(Boolean).join(' · ');
  };
  return log.data?.length ? (
    <div className="list">
      {log.data.map((e: any) => (
        <div key={e.id} className="item"><div className="main"><div className="t1">{e.entity} · {e.action}</div><div className="t2">{fmtDate(e.createdAt, lang)} · {summarize(e)}</div></div></div>
      ))}
    </div>
  ) : <div className="empty">{t.nothing}</div>;
}
