import { useState } from 'react';
import { del, get, post, put } from '../api';
import { ErrorBox, Field, fmtDate } from '../components/ui';
import { useT } from '../i18n';
import { money } from '../money';
import { useAsync, useStore } from '../store';
import { TalkoConnect } from './TalkoMode';

/** Bank connections: Telegram bot, monobank personal API, SMS forwarding webhook. */
export function Banks() {
  const { t } = useT();
  const { version } = useStore();
  const [tick, setTick] = useState(0);
  const st = useAsync(() => get('/integrations'), [version, tick]);
  const refresh = () => setTick((x) => x + 1);
  if (!st.data) return <div className="empty">{st.error ?? '…'}</div>;
  return (
    <>
      <div className="section-title">🔗 CRM TALKO</div>
      <TalkoConnect />
      <TelegramCard s={st.data.telegram} refresh={refresh} />
      <div className="section-title">{t.monoTitle}</div>
      <MonoCard s={st.data.monobank} refresh={refresh} />
      <div className="section-title">{t.hookTitle}</div>
      <HookCard s={st.data.webhook} refresh={refresh} />
      <p className="faint" style={{ marginTop: 16 }}>{t.smsIosNote}</p>
    </>
  );
}

function useRun(refresh: () => void) {
  const { toast } = useStore();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(true); setError(null);
    try { await fn(); if (okMsg) toast(okMsg); refresh(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return { error, busy, run };
}

function TelegramCard({ s, refresh }: { s: any; refresh: () => void }) {
  const { t, lang } = useT();
  const [token, setToken] = useState('');
  const { error, busy, run } = useRun(refresh);
  return (
    <>
      <div className="section-title">✈️ {t.tgTitle}</div>
      <div className="card">
        <p className="faint" style={{ marginTop: 0 }}>{t.tgHint}</p>
        {!s.configured ? (
          <>
            <p className="faint">{t.tgSteps}</p>
            <Field label={t.botToken}><input className="input" value={token} onChange={(e) => setToken(e.target.value)} placeholder="123456789:AA…" autoComplete="off" /></Field>
            <ErrorBox error={error} />
            <button className="btn primary block" disabled={busy || token.length < 20} onClick={() => run(() => post('/integrations/telegram', { token }), t.saved)}>{t.connect}</button>
          </>
        ) : (
          <>
            <div className="row between"><b>@{s.username}</b><span className={s.status === 'ok' ? 'c-income' : 'c-danger'}>{s.status === 'ok' ? '● online' : `● ${s.status}`}</span></div>
            {s.lastError && s.status !== 'ok' && <div className="error" style={{ marginTop: 8 }}>{s.lastError}</div>}
            {s.chats.length > 0 && (
              <>
                <div className="section-title">{t.linkedChats}</div>
                {s.chats.map((c: any) => (
                  <div key={c.chatId} className="row between" style={{ padding: '4px 0' }}>
                    <span>💬 {c.title || c.chatId} <span className="faint">{fmtDate(c.linkedAt, lang, false)}</span></span>
                    <button className="btn ghost small c-danger" onClick={() => run(() => del(`/integrations/telegram/chats/${c.chatId}`))}>{t.disconnect}</button>
                  </div>
                ))}
              </>
            )}
            <div className="section-title">{t.linkChat}</div>
            {s.linkUrl ? (
              <>
                <a className="btn primary block" style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }} href={s.linkUrl} target="_blank" rel="noreferrer">{t.linkChat}: @{s.username}</a>
                <p className="faint">/start {s.linkCode}</p>
              </>
            ) : <button className="btn block" disabled={busy} onClick={() => run(() => post('/integrations/telegram/link-code'))}>{t.newCode}</button>}
            <ErrorBox error={error} />
            <button className="btn danger block" style={{ marginTop: 10 }} disabled={busy} onClick={() => confirm(`${t.disconnect}?`) && run(() => del('/integrations/telegram'))}>{t.disconnect}</button>
          </>
        )}
      </div>
    </>
  );
}

function MonoCard({ s, refresh }: { s: any; refresh: () => void }) {
  const { t, lang } = useT();
  const { accounts, toast } = useStore();
  const [token, setToken] = useState('');
  const [mapping, setMapping] = useState<Record<string, string>>(s.mapping ?? {});
  const { error, busy, run } = useRun(refresh);
  if (!s.configured) {
    return (
      <div className="card">
        <p className="faint" style={{ marginTop: 0 }}>{t.monoHint} <a href="https://api.monobank.ua/" target="_blank" rel="noreferrer">api.monobank.ua</a></p>
        <Field label={t.monoToken}><input className="input" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" /></Field>
        <ErrorBox error={error} />
        <button className="btn primary block" disabled={busy || token.length < 20} onClick={() => run(() => post('/integrations/monobank', { token }), t.saved)}>{t.connect}</button>
      </div>
    );
  }
  return (
    <div className="card">
      <div className="row between"><b>{s.clientName}</b><span className={s.status === 'ok' ? 'c-income' : 'c-danger'}>● {s.syncing ? '…' : s.status}</span></div>
      {s.lastSyncAt && <div className="faint">{t.lastSync}: {fmtDate(s.lastSyncAt, lang)}</div>}
      {s.lastError && s.status !== 'ok' && <div className="error" style={{ marginTop: 8 }}>{s.lastError}</div>}
      <div className="section-title">{t.mapCards}</div>
      {s.accounts.map((m: any) => (
        <div key={m.id} className="grid2" style={{ alignItems: 'center', marginBottom: 8 }}>
          <div><b>{m.maskedPan || m.type}</b><div className="faint num">{m.type} · {money(String((m.balance / 100).toFixed(2)), m.currency)}</div></div>
          <select className="input" value={mapping[m.id] ?? ''} onChange={(e) => setMapping({ ...mapping, [m.id]: e.target.value })}>
            <option value="">{t.notSynced}</option>
            {accounts.filter((a) => !a.isArchived && a.currency === m.currency).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
      ))}
      <ErrorBox error={error} />
      <div className="row" style={{ marginTop: 6 }}>
        <button className="btn grow" disabled={busy} onClick={() => run(() => put('/integrations/monobank/mapping', { mapping: Object.fromEntries(Object.entries(mapping).map(([k, v]) => [k, v || null])) }), t.saved)}>{t.save}</button>
        <button className="btn primary grow" disabled={busy || !Object.values(s.mapping ?? {}).length} onClick={() => run(async () => { await post('/integrations/monobank/sync', {}); toast(t.syncStarted); })}>{t.syncNow}</button>
      </div>
      <button className="btn danger block" style={{ marginTop: 10 }} disabled={busy} onClick={() => confirm(`${t.disconnect}?`) && run(() => del('/integrations/monobank'))}>{t.disconnect}</button>
    </div>
  );
}

function HookCard({ s, refresh }: { s: any; refresh: () => void }) {
  const { t, lang } = useT();
  const { toast } = useStore();
  const [url, setUrl] = useState<string | null>(null);
  const { error, busy, run } = useRun(refresh);
  const create = () => run(async () => { const r = await post('/integrations/webhook'); setUrl(`${location.origin}/api/hooks/ingest/${r.token}`); });
  const copy = async () => { try { await navigator.clipboard.writeText(url!); toast(t.copied); } catch { /* select manually */ } };
  return (
    <div className="card">
      <p className="faint" style={{ marginTop: 0 }}>{t.hookHint}</p>
      {url && (
        <>
          <div className="warn" style={{ marginBottom: 8 }}>{t.hookOnce}</div>
          <code className="url">{url}</code>
          <button className="btn small" style={{ marginTop: 8 }} onClick={copy}>{t.copy}</button>
        </>
      )}
      {s.configured && !url && <div className="faint">…/api/hooks/ingest/{s.hint}••• · {t.received}: {s.received}{s.lastReceivedAt ? ` · ${fmtDate(s.lastReceivedAt, lang)}` : ''}</div>}
      <p className="faint">📱 {t.hookAndroid}</p>
      <p className="faint">🍏 {t.hookIos}</p>
      <ErrorBox error={error} />
      <button className="btn block" disabled={busy} onClick={() => (!s.configured || confirm(t.hookRecreate + '?')) && create()}>{s.configured ? t.hookRecreate : t.hookCreate}</button>
      {s.configured && <button className="btn danger block" style={{ marginTop: 8 }} disabled={busy} onClick={() => run(() => del('/integrations/webhook'))}>{t.disconnect}</button>}
    </div>
  );
}
