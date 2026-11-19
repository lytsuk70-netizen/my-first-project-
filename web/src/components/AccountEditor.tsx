import { useState } from 'react';
import { post, put } from '../api';
import { useT } from '../i18n';
import { money, normalizeAmountInput } from '../money';
import { useStore } from '../store';
import type { Account } from '../types';
import { ErrorBox, Field, Sheet, fmtDate } from './ui';

const TYPES = ['cash', 'bank', 'card', 'savings', 'debt', 'other'] as const;

export function AccountEditor({ account, onClose }: { account?: Account; onClose: () => void }) {
  const { t, lang } = useT();
  const { currencies, settings, changed, toast, openFeed } = useStore();
  const [name, setName] = useState(account?.name ?? '');
  const [type, setType] = useState<string>(account?.type ?? 'card');
  const [currency, setCurrency] = useState(account?.currency ?? settings.base_currency);
  const [initial, setInitial] = useState(account?.initialBalance ?? '0');
  const [description, setDescription] = useState(account?.description ?? '');
  const [sms, setSms] = useState(account?.smsKeywords ?? '');
  const [actual, setActual] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<unknown>, close = true) {
    setBusy(true); setError(null);
    try { await fn(); await changed(); toast(t.saved); if (close) onClose(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  const body = { name, type, currency, initialBalance: normalizeAmountInput(initial || '0'), description, smsKeywords: sms };
  const save = () => run(() => (account ? put(`/accounts/${account.id}`, body) : post('/accounts', body)));
  const archive = () => run(() => put(`/accounts/${account!.id}`, { isArchived: !account!.isArchived }));
  const correct = () => run(() => post(`/accounts/${account!.id}/correct`, { actualBalance: normalizeAmountInput(actual) }), false).then(() => setActual(''));

  return (
    <Sheet title={account ? account.name : t.createAccount} onClose={onClose}>
      {account && (
        <div className="card" style={{ background: 'var(--surface-2)', marginBottom: 14 }}>
          <div className="faint">{t.currentBalance}</div>
          <div className="hero c-balance num">{money(account.balance, account.currency)}</div>
          {account.baseValue && account.currency !== settings.base_currency && <div className="faint num">≈ {money(account.baseValue, settings.base_currency)} · {t.rate} {account.baseRate}</div>}
          <div className="faint">{t.created}: {fmtDate(account.createdAt, lang, false)}</div>
          <button className="btn ghost small" style={{ paddingLeft: 0 }} onClick={() => { onClose(); openFeed({ accountId: account.id }); }}>{t.history} →</button>
        </div>
      )}
      <Field label={t.accountName}><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus={!account} placeholder="Mono UAH" /></Field>
      <div className="grid2">
        <Field label={t.accountType}>
          <select className="input" value={type} onChange={(e) => setType(e.target.value)}>{TYPES.map((x) => <option key={x} value={x}>{t.types[x]}</option>)}</select>
        </Field>
        <Field label={t.currency}>
          <select className="input" value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={!!account && account.txCount > 0}>
            {currencies.map((c) => <option key={c.code} value={c.code}>{c.code} · {lang === 'en' ? c.name_en : c.name_uk}</option>)}
          </select>
        </Field>
      </div>
      <Field label={t.initialBalance}><input className="input num" inputMode="decimal" value={initial} onChange={(e) => setInitial(e.target.value)} /></Field>
      <Field label={t.description}><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} /></Field>
      <Field label={t.smsKeywords}><input className="input" value={sms} onChange={(e) => setSms(e.target.value)} maxLength={200} placeholder="*1234" /></Field>
      <ErrorBox error={error} />
      <div className="actions">
        {account && <button className="btn" disabled={busy} onClick={archive}>{account.isArchived ? t.unarchive : t.archive}</button>}
        <button className="btn primary" disabled={busy || !name.trim()} onClick={save}>{account ? t.save : t.create}</button>
      </div>
      {account && !account.isArchived && (
        <>
          <div className="section-title">{t.correctBalance}</div>
          <div className="row">
            <input className="input num grow" inputMode="decimal" placeholder={t.actualBalance} value={actual} onChange={(e) => setActual(e.target.value)} />
            <button className="btn" disabled={busy || !/^-?\d+([.,]\d+)?$/.test(actual.replace(/\s/g, ''))} onClick={correct}>{t.confirm}</button>
          </div>
          <p className="faint">{t.correctionHint}</p>
        </>
      )}
    </Sheet>
  );
}
