import { useEffect, useState } from 'react';
import { get, post } from '../api';
import { TxEditor } from '../components/TxEditor';
import { ErrorBox, fmtDate } from '../components/ui';
import { useT } from '../i18n';
import { money, todayISO } from '../money';
import { useAsync, useStore } from '../store';
import type { Draft } from '../types';

interface Msg { id: string; text: string; source: string; status: string; alreadyImported?: boolean; draft: Draft & { files?: unknown[] }; duplicates: Array<{ id: string; occurred_at: string; comment: string; account_name: string }> }

/** Inbox for operations coming from banks (Telegram, monobank, SMS forwarding, pasted SMS) + Excel import. */
export function Inbox() {
  const { t } = useT();
  const { sharedText } = useStore();
  const [tab, setTab] = useState<'inbox' | 'paste' | 'excel'>(sharedText ? 'paste' : 'inbox');
  return (
    <>
      <div className="seg" style={{ marginBottom: 12 }}>
        <button className={tab === 'inbox' ? 'on' : ''} onClick={() => setTab('inbox')}>{t.inbox}</button>
        <button className={tab === 'paste' ? 'on' : ''} onClick={() => setTab('paste')}>{t.pasteSms}</button>
        <button className={tab === 'excel' ? 'on' : ''} onClick={() => setTab('excel')}>{t.excel}</button>
      </div>
      {tab === 'inbox' && <Pending />}
      {tab === 'paste' && <Paste />}
      {tab === 'excel' && <ExcelImport />}
    </>
  );
}

function MsgCard({ m, onConfirm, onIgnore }: { m: Msg; onConfirm: () => void; onIgnore: () => void }) {
  const { t, lang } = useT();
  const { accounts, categories } = useStore();
  const d = m.draft;
  const acc = accounts.find((a) => a.id === d.accountId);
  const cat = categories.find((c) => c.id === d.categoryId);
  const done = m.status !== 'pending';
  return (
    <div className="card" style={{ marginTop: 10, opacity: done ? 0.6 : 1 }}>
      <div className="row between"><span className="src-tag">{t.sourceNames[m.source] ?? m.source}{d.files?.length ? ' · 🧾' : ''}</span><span className="faint">{d.occurredAt ? fmtDate(d.occurredAt, lang) : ''}</span></div>
      <div className="row between" style={{ marginTop: 8 }}>
        <b className={'num ' + (d.type === 'income' ? 'c-income' : 'c-expense')} style={{ fontSize: 18 }}>{d.type === 'income' ? '+' : '−'}{d.amount ? money(d.amount, d.currency ?? undefined) : '?'}</b>
        <span className="faint">{acc?.name ?? '❔ ' + t.account} · {cat ? `${cat.icon} ${cat.name}` : '❔ ' + t.category}</span>
      </div>
      {d.comment && <div className="muted">{d.comment}</div>}
      <details style={{ marginTop: 4 }}><summary className="faint">SMS</summary><div className="faint" style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div></details>
      {d.balance && <div className="faint num">{t.bankBalance}: {money(d.balance, d.balanceCurrency ?? undefined)}{acc ? ` · ${t.appBalance}: ${money(acc.balance, acc.currency)}` : ''}</div>}
      {m.duplicates.length > 0 && <div className="warn" style={{ marginTop: 6 }}>⚠️ {t.possibleDuplicate}: {m.duplicates.map((x) => `${fmtDate(x.occurred_at, lang)} ${x.account_name} ${x.comment}`).join('; ')}</div>}
      {!done && d.questions.length > 0 && <div className="faint" style={{ marginTop: 6 }}>{d.questions.join(' ')}</div>}
      <div className="row" style={{ marginTop: 10 }}>
        {done ? <span className="faint">{m.status === 'imported' ? t.alreadyImported : t.ignore}</span> : (
          <>
            <button className="btn small" onClick={onIgnore}>{t.ignore}</button>
            <button className="btn primary small grow" onClick={onConfirm}>{t.checkAndConfirm}</button>
          </>
        )}
      </div>
    </div>
  );
}

function useConfirm(onDone: (id: string) => void) {
  const { t } = useT();
  const [m, setM] = useState<Msg | null>(null);
  const node = m && (
    <TxEditor mode="create" allowTypeChange importMessageId={m.id} source="sms" title={t.checkAndConfirm} questions={m.draft.questions}
      onClose={() => setM(null)} onSaved={() => onDone(m.id)}
      initial={{ type: m.draft.type ?? 'expense', amount: m.draft.amount ?? '', accountId: m.draft.accountId ?? (m.draft.candidates.accounts.length === 1 ? m.draft.candidates.accounts[0] : ''), categoryId: m.draft.categoryId ?? '', occurredAt: m.draft.occurredAt, comment: m.draft.comment }} />
  );
  return { open: setM, node };
}

function Pending() {
  const { t } = useT();
  const { version, changed, toast, setMenu } = useStore();
  const list = useAsync(() => get<Msg[]>('/import/messages?status=pending'), [version]);
  const { open, node } = useConfirm(() => {});
  async function ignore(id: string) { await post(`/import/messages/${id}/ignore`); await changed(); }
  async function confirmAll() {
    try { const r = await post('/import/confirm-all'); await changed(); toast(`${t.confirmAllDone}: ${r.confirmed}`); } catch (e: any) { toast(e.message, true); }
  }
  const items = list.data ?? [];
  const ready = items.filter((m) => m.draft.type && m.draft.amount && m.draft.accountId && m.draft.categoryId && !m.duplicates.length).length;
  return (
    <>
      {items.length > 0 ? (
        <button className="btn primary block" disabled={!ready} onClick={confirmAll}>{t.confirmAll} ({ready})</button>
      ) : (
        <div className="empty">
          {t.nothing}
          <div><button className="btn ghost" onClick={() => setMenu('integrations')}>{t.banks} →</button></div>
        </div>
      )}
      {items.map((m) => <MsgCard key={m.id} m={m} onConfirm={() => open(m)} onIgnore={() => ignore(m.id)} />)}
      {node}
    </>
  );
}

function Paste() {
  const { t } = useT();
  const { sharedText, consumeShared, changed } = useStore();
  const [text, setText] = useState('');
  const [results, setResults] = useState<Msg[]>([]);
  const [error, setError] = useState<string | null>(null);
  const mark = (id: string, status: string) => setResults((r) => r.map((x) => (x.id === id ? { ...x, status } : x)));
  const { open, node } = useConfirm((id) => mark(id, 'imported'));
  useEffect(() => { if (sharedText) { setText(sharedText); consumeShared(); } }, [sharedText, consumeShared]);
  async function parse() {
    try { setResults(await post('/import/messages', { text, source: 'paste', tzOffsetMinutes: new Date().getTimezoneOffset() })); setError(null); await changed(); } catch (e: any) { setError(e.message); }
  }
  async function ignore(id: string) { await post(`/import/messages/${id}/ignore`); mark(id, 'ignored'); await changed(); }
  return (
    <>
      <p className="faint">{t.smsIosNote}</p>
      <textarea className="input" style={{ minHeight: 120 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={t.smsPaste} />
      <ErrorBox error={error} />
      <button className="btn primary block" style={{ marginTop: 10 }} disabled={!text.trim()} onClick={parse}>{t.parse}</button>
      {results.map((m) => <MsgCard key={m.id} m={m} onConfirm={() => open(m)} onIgnore={() => ignore(m.id)} />)}
      {node}
    </>
  );
}

function ExcelImport() {
  const { t } = useT();
  const { changed, toast } = useStore();
  const [file, setFile] = useState<{ filename: string; dataBase64: string } | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [createMissing, setCreateMissing] = useState(true);
  const [includeDuplicates, setIncludeDuplicates] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tz = new Date().getTimezoneOffset();

  async function choose(f: File | undefined) {
    if (!f) return;
    setError(null); setPreview(null); setBusy(true);
    try {
      const dataBase64 = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(f); });
      const payload = { filename: f.name, dataBase64 };
      setFile(payload);
      setPreview(await post('/import/excel/preview', { ...payload, tzOffsetMinutes: tz }));
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  async function commit() {
    setBusy(true); setError(null);
    try {
      const r = await post('/import/excel/commit', { ...file, tzOffsetMinutes: tz, createMissing, includeDuplicates });
      await changed();
      toast(`${t.imported}: ${r.imported}`);
      setPreview(null); setFile(null);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  const s = preview?.summary;
  const importable = s ? s.valid - (includeDuplicates ? 0 : s.duplicates) : 0;
  return (
    <>
      <div className="card">
        <b>📤 {t.exportXlsx}</b>
        <p className="faint">{t.reports} → {t.exportXlsx}</p>
        <a className="btn block" style={{ display: 'block', textAlign: 'center', textDecoration: 'none', color: 'var(--text)' }} href={`/api/export/xlsx?from=${todayISO().slice(0, 8)}01&to=${todayISO()}`} download>{t.exportXlsx}: {t.thisMonth}</a>
      </div>
      <div className="card">
        <b>📥 {t.importExcel}</b>
        <p className="faint">{t.excelHint}</p>
        <div className="row">
          <a className="btn small grow" style={{ textAlign: 'center', textDecoration: 'none', color: 'var(--text)' }} href="/api/import/template.xlsx" download>{t.downloadTemplate}</a>
          <label className="btn primary small grow" style={{ textAlign: 'center' }}>
            {t.chooseFile}
            <input type="file" accept=".xlsx,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" hidden onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
        </div>
        {busy && <div className="faint" style={{ marginTop: 8 }}>…</div>}
        <ErrorBox error={error} />
      </div>
      {s && (
        <>
          <div className="section-title">{t.importPreview}: {file?.filename}</div>
          <div className="stats" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))' }}>
            <div className="stat"><div className="l">{t.rowsValid}</div><div className="v c-income">{s.valid}</div></div>
            <div className="stat"><div className="l">{t.rowsErrors}</div><div className="v c-danger">{s.errors}</div></div>
            <div className="stat"><div className="l">{t.rowsDuplicates}</div><div className="v">{s.duplicates}</div></div>
            <div className="stat"><div className="l">{t.rowsSkipped}</div><div className="v">{s.skipped}</div></div>
          </div>
          {(s.newAccounts.length > 0 || s.newCategories.length > 0 || s.newProjects.length > 0) && (
            <div className="warn" style={{ marginTop: 10 }}>
              {s.newAccounts.length > 0 && <div>+ {t.accounts}: {s.newAccounts.join(', ')}</div>}
              {s.newCategories.length > 0 && <div>+ {t.categories}: {s.newCategories.join(', ')}</div>}
              {s.newProjects.length > 0 && <div>+ {t.projects}: {s.newProjects.join(', ')}</div>}
            </div>
          )}
          <div className="card" style={{ overflowX: 'auto', marginTop: 10 }}>
            <table className="tbl">
              <thead><tr><th>#</th><th>{t.date}</th><th>{t.account}</th><th className="r">{t.amount}</th><th>{t.category}</th><th>{t.comment}</th></tr></thead>
              <tbody>
                {preview.rows.slice(0, 300).map((r: any) => (
                  <tr key={r.row} style={{ opacity: r.skip ? 0.5 : 1 }}>
                    <td className="faint">{r.row}</td>
                    <td className="faint">{r.date ? r.date.slice(0, 10) : '—'}</td>
                    <td>{r.accountName}{r.createAccount ? ' ✚' : ''}</td>
                    <td className={'r num ' + (r.type === 'income' ? 'c-income' : 'c-expense')}>{r.amount ? money(r.amount, r.currency) : '—'}</td>
                    <td>{r.categoryName}{r.createCategory ? ' ✚' : ''}</td>
                    <td>
                      {r.comment}
                      {r.errors.map((e: string) => <div key={e} className="c-danger" style={{ fontSize: 12 }}>✖ {e}</div>)}
                      {r.warnings.map((e: string) => <div key={e} style={{ fontSize: 12, color: 'var(--warn)' }}>⚠ {e}</div>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className="row faint" style={{ gap: 8, marginTop: 10 }}><input type="checkbox" checked={createMissing} onChange={(e) => setCreateMissing(e.target.checked)} />{t.createMissing}</label>
          <label className="row faint" style={{ gap: 8, marginTop: 6 }}><input type="checkbox" checked={includeDuplicates} onChange={(e) => setIncludeDuplicates(e.target.checked)} />{t.includeDuplicates}</label>
          <button className="btn primary block" style={{ marginTop: 12 }} disabled={busy || importable <= 0} onClick={commit}>{t.importNow} ({importable})</button>
        </>
      )}
    </>
  );
}
