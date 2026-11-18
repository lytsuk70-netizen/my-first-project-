import { useEffect, useState } from 'react';
import { get, qs } from '../api';
import { AccountEditor } from '../components/AccountEditor';
import { FeedList } from '../components/FeedList';
import { TxEditor, type TxDraft } from '../components/TxEditor';
import { VoiceSheet } from '../components/VoiceSheet';
import { CatIcon, Icons } from '../components/ui';
import { useT } from '../i18n';
import { money } from '../money';
import { useAsync, useStore } from '../store';
import type { FeedItem, TxType } from '../types';

const MAX_LEN = 12;

/** Expense / Income entry: amount -> account -> category -> confirm. */
export function Entry({ type }: { type: TxType }) {
  const { t } = useT();
  const { accounts, categories, version } = useStore();
  const active = accounts.filter((a) => !a.isArchived);
  const storageKey = `gok.lastAccount.${type}`;
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState<string>(() => { try { return localStorage.getItem(storageKey) ?? ''; } catch { return ''; } });
  const [draft, setDraft] = useState<TxDraft | null>(null);
  const [voice, setVoice] = useState(false);
  const [newAccount, setNewAccount] = useState(false);

  useEffect(() => {
    if (active.length && !active.some((a) => a.id === accountId)) setAccountId(active[0].id);
  }, [active, accountId]);
  const pickAccount = (id: string) => { setAccountId(id); try { localStorage.setItem(storageKey, id); } catch { /* ignore */ } };
  const account = accounts.find((a) => a.id === accountId);
  const decimals = account?.currency === 'JPY' ? 0 : 2;

  const summary = useAsync(() => get(`/summary?type=${type}`), [type, version]);
  const recent = useAsync(() => get<{ items: FeedItem[] }>('/transactions' + qs({ kinds: type, limit: 30 })), [type, version]);

  function press(k: string) {
    setAmount((a) => {
      if (k === '⌫') return a.slice(0, -1);
      if (k === ',') return decimals === 0 || a.includes(',') ? a : (a || '0') + ',';
      if (a.includes(',') && a.split(',')[1].length >= decimals) return a;
      if (a.replace(',', '').length >= MAX_LEN) return a;
      if (a === '0') return k;
      return a + k;
    });
  }
  // physical keyboard on desktop
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (draft || voice || newAccount) return;
      const el = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === ',' || e.key === '.') press(',');
      else if (e.key === 'Backspace') press('⌫');
      else if (e.key === 'Escape') setAmount('');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const amountOk = /[1-9]/.test(amount);
  const cats = categories.filter((c) => c.type === type && !c.isArchived);
  const color = type === 'expense' ? 'var(--expense)' : 'var(--income)';

  function chooseCategory(categoryId: string) {
    setDraft({ type, amount: amount.replace(',', '.'), accountId, categoryId });
  }

  const s = summary.data;
  return (
    <>
      <div className="topbar">
        <h1 style={{ color }}>{type === 'expense' ? t.expenses : t.income}</h1>
        <div style={{ textAlign: 'right' }}>
          <div className="faint">{type === 'expense' ? t.todayExpenses : t.todayIncome}</div>
          <div className="num" style={{ fontWeight: 800, fontSize: 18, color }}>{s ? money(s.today, s.baseCurrency) : '…'}</div>
        </div>
        <button className="icon-btn" onClick={() => setVoice(true)} aria-label={t.voice}>{Icons.mic}</button>
      </div>

      {!active.length ? (
        <div className="card empty">
          <p>{t.noAccounts}</p>
          <button className="btn primary" onClick={() => setNewAccount(true)}>{t.createAccount}</button>
        </div>
      ) : (
        <div className="entry-grid">
          <div className="entry-left">
            <div className={'amount-display num' + (amount ? '' : ' placeholder')} style={amount ? { color } : undefined} aria-live="polite">
              {amount || '0'}<span className="cur">{account?.currency}</span>
            </div>
            <div className="chips" role="radiogroup" aria-label={t.account}>
              {active.map((a) => (
                <button key={a.id} role="radio" aria-checked={a.id === accountId} className={'acc-chip' + (a.id === accountId ? ' on' : '') + (type === 'income' ? ' income' : '')} onClick={() => pickAccount(a.id)}>
                  <div className="n ellipsis">{a.name}</div>
                  <div className="b num">{money(a.balance, a.currency)}</div>
                </button>
              ))}
            </div>
            <div className="keypad">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', ',', '0', '⌫'].map((k) => (
                <button key={k} onClick={() => press(k)} aria-label={k === '⌫' ? 'Backspace' : k} onContextMenu={(e) => { if (k === '⌫') { e.preventDefault(); setAmount(''); } }}>
                  {k === '⌫' ? <span style={{ display: 'grid', placeItems: 'center' }}>{Icons.backspace}</span> : k}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="section-title">{amountOk ? t.chooseCategory : t.category}</div>
            <div className="cat-grid">
              {cats.map((c) => (
                <button key={c.id} className="cat-btn" disabled={!amountOk || !account} onClick={() => chooseCategory(c.id)} title={amountOk ? c.name : t.enterAmount}>
                  <CatIcon icon={c.icon} color={c.color} size={40} />
                  <span className="lbl">{c.name}</span>
                </button>
              ))}
            </div>
            {s && (
              <div className="stats" style={{ marginTop: 16 }}>
                <div className="stat"><div className="l">{t.today}</div><div className="v num">{money(s.today, s.baseCurrency)}</div></div>
                <div className="stat"><div className="l">{t.yesterday}</div><div className="v num">{money(s.yesterday, s.baseCurrency)}</div></div>
                <div className="stat"><div className="l">{t.thisMonth}</div><div className="v num">{money(s.month, s.baseCurrency)}</div></div>
                <div className="stat"><div className="l">{t.prevMonth}</div><div className="v num">{money(s.prevMonth, s.baseCurrency)}</div></div>
              </div>
            )}
            {s?.missingRates?.length > 0 && <div className="warn" style={{ marginTop: 8 }}>{t.missingRatesWarn} ({s.missingRates.join(', ')})</div>}
            <div className="section-title">{t.recent}</div>
            {recent.data && <FeedList items={recent.data.items} />}
          </div>
        </div>
      )}

      {draft && <TxEditor mode="create" initial={draft} onClose={() => setDraft(null)} onSaved={() => setAmount('')} />}
      {voice && <VoiceSheet defaultType={type} onClose={() => setVoice(false)} />}
      {newAccount && <AccountEditor onClose={() => setNewAccount(false)} />}
    </>
  );
}
