import { useEffect, type ReactNode } from 'react';
import { useT } from '../i18n';
import { money } from '../money';
import type { Account, Category } from '../types';

export function Sheet({ title, onClose, children, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const { t } = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" role="dialog" aria-modal="true" style={wide ? { maxWidth: 760 } : undefined}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="btn ghost" onClick={onClose}>{t.close}</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

export function AccountSelect({ accounts, value, onChange, currency, allowEmpty, id }: { accounts: Account[]; value: string; onChange: (v: string) => void; currency?: string; allowEmpty?: boolean; id?: string }) {
  const { t } = useT();
  const list = accounts.filter((a) => (!a.isArchived || a.id === value) && (!currency || a.currency === currency));
  return (
    <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      {(allowEmpty || !value) && <option value="">{t.chooseAccount}</option>}
      {list.map((a) => <option key={a.id} value={a.id}>{a.name} · {money(a.balance, a.currency)}</option>)}
    </select>
  );
}

export function CategoryPicker({ categories, type, value, onChange }: { categories: Category[]; type: 'income' | 'expense'; value: string; onChange: (id: string) => void }) {
  const list = categories.filter((c) => c.type === type && (!c.isArchived || c.id === value));
  const ordered = list.filter((c) => !c.parentId).flatMap((p) => [p, ...list.filter((c) => c.parentId === p.id)]);
  return (
    <div className="chips" style={{ flexWrap: 'wrap' }}>
      {ordered.map((c) => (
        <button type="button" key={c.id} className={'chip' + (value === c.id ? ' on' : '')} onClick={() => onChange(c.id)} style={c.parentId ? { fontSize: 13 } : undefined}>
          {c.parentId ? '↳ ' : ''}{c.icon} {c.name}
        </button>
      ))}
    </div>
  );
}

export function CatIcon({ icon, color, size = 38 }: { icon: string | null; color: string | null; size?: number }) {
  return <span className="ic" style={{ width: size, height: size, background: (color ?? '#8e8e93') + '33', color: color ?? undefined }}>{icon ?? '•'}</span>;
}

export function ErrorBox({ error }: { error: string | null }) {
  return error ? <div className="error" role="alert">{error}</div> : null;
}

export function fmtDate(iso: string, lang: string, withTime = true) {
  const d = new Date(iso);
  return d.toLocaleString(lang === 'en' ? 'en-GB' : 'uk-UA', { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) });
}
export function fmtDay(ymd: string, lang: string, t: { today: string; yesterday: string }) {
  const today = new Date(); const y = new Date(Date.now() - 86400000);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (ymd === iso(today)) return t.today;
  if (ymd === iso(y)) return t.yesterday;
  return new Date(ymd + 'T12:00:00').toLocaleDateString(lang === 'en' ? 'en-GB' : 'uk-UA', { weekday: 'short', day: 'numeric', month: 'long', year: ymd.slice(0, 4) === String(today.getFullYear()) ? undefined : 'numeric' });
}

const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
export const Icons = {
  minus: <svg viewBox="0 0 24 24" {...P}><circle cx="12" cy="12" r="9" /><path d="M8 12h8" /></svg>,
  plus: <svg viewBox="0 0 24 24" {...P}><circle cx="12" cy="12" r="9" /><path d="M8 12h8M12 8v8" /></svg>,
  wallet: <svg viewBox="0 0 24 24" {...P}><rect x="3" y="6" width="18" height="14" rx="3" /><path d="M3 10h18M16 15h2" /><path d="M6 6l9-3 2 3" /></svg>,
  list: <svg viewBox="0 0 24 24" {...P}><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>,
  menu: <svg viewBox="0 0 24 24" {...P}><path d="M4 6h16M4 12h16M4 18h16" /></svg>,
  mic: <svg viewBox="0 0 24 24" {...P}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>,
  back: <svg viewBox="0 0 24 24" {...P}><path d="M15 18l-6-6 6-6" /></svg>,
  swap: <svg viewBox="0 0 24 24" {...P}><path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3" /></svg>,
  backspace: <svg viewBox="0 0 24 24" {...P} width="26" height="26"><path d="M21 5H9l-6 7 6 7h12z" /><path d="M13 9l5 6M18 9l-5 6" /></svg>,
  chevL: <svg viewBox="0 0 24 24" {...P} width="20" height="20"><path d="M15 18l-6-6 6-6" /></svg>,
  chevR: <svg viewBox="0 0 24 24" {...P} width="20" height="20"><path d="M9 6l6 6-6 6" /></svg>,
};
