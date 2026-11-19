import { useState } from 'react';
import { post } from '../api';
import { ErrorBox, Field } from '../components/ui';
import { useT } from '../i18n';

export function Auth({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const { t } = useT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      if (setup) await post('/auth/register', { email, password, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, language: navigator.language.startsWith('en') ? 'en' : 'uk' });
      else await post('/auth/login', { email, password });
      onDone();
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <form className="auth" onSubmit={submit}>
      <div style={{ textAlign: 'center', marginBottom: 24 }}>
        <img src="/icon.svg" width="72" height="72" alt="" />
        <h1 style={{ margin: '12px 0 4px' }}>{t.appName}</h1>
        {setup && <p className="muted">{t.setupTitle}. {t.setupHint}</p>}
      </div>
      <Field label={t.email}><input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <Field label={t.password}><input className="input" type="password" autoComplete={setup ? 'new-password' : 'current-password'} required minLength={setup ? 8 : 1} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      <ErrorBox error={error} />
      <button className="btn primary block" style={{ marginTop: 12 }} disabled={busy}>{setup ? t.register : t.login}</button>
    </form>
  );
}
