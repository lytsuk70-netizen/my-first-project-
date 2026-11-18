import { useState } from 'react';
import { get } from '../api';
import { AccountEditor } from '../components/AccountEditor';
import { TransferForm, TransferSheet } from '../components/TransferForm';
import { fmtDate } from '../components/ui';
import { useT } from '../i18n';
import { money } from '../money';
import { useAsync, useStore } from '../store';
import type { Account, Transfer } from '../types';

const TYPE_ICON: Record<string, string> = { cash: '💵', bank: '🏦', card: '💳', savings: '🐷', debt: '📉', other: '•' };

export function Accounts() {
  const { t } = useT();
  const [tab, setTab] = useState<'accounts' | 'transfers' | 'archive'>('accounts');
  const [edit, setEdit] = useState<Account | 'new' | null>(null);
  return (
    <>
      <div className="topbar">
        <h1>{t.accounts}</h1>
        <button className="btn primary small" onClick={() => setEdit('new')}>+ {t.add}</button>
      </div>
      <div className="seg" style={{ marginBottom: 12 }}>
        <button className={tab === 'accounts' ? 'on' : ''} onClick={() => setTab('accounts')}>{t.accounts}</button>
        <button className={tab === 'transfers' ? 'on' : ''} onClick={() => setTab('transfers')}>{t.transfers}</button>
        <button className={tab === 'archive' ? 'on' : ''} onClick={() => setTab('archive')}>{t.archiveTab}</button>
      </div>
      {tab === 'accounts' && <AccountList onOpen={setEdit} />}
      {tab === 'transfers' && <Transfers />}
      {tab === 'archive' && <Archive onOpen={setEdit} />}
      {edit && <AccountEditor account={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function AccountRow({ a, onOpen }: { a: Account; onOpen: (a: Account) => void }) {
  const { t } = useT();
  const { settings } = useStore();
  return (
    <button className="item" onClick={() => onOpen(a)}>
      <span className="ic">{TYPE_ICON[a.type]}</span>
      <div className="main">
        <div className="t1">{a.name}</div>
        <div className="t2">{t.types[a.type]}{a.description ? ' · ' + a.description : ''}</div>
      </div>
      <div className="amt num">
        <span className="c-balance">{money(a.balance, a.currency)}</span>
        {a.currency !== settings.base_currency && <small>{a.baseValue ? `≈ ${money(a.baseValue, settings.base_currency)}` : t.missingRate}</small>}
      </div>
    </button>
  );
}

function AccountList({ onOpen }: { onOpen: (a: Account) => void }) {
  const { t } = useT();
  const { accounts, version } = useStore();
  const nw = useAsync(() => get('/net-worth'), [version]);
  const active = accounts.filter((a) => !a.isArchived);
  const groups = ['card', 'bank', 'cash', 'savings', 'debt', 'other'].map((type) => [type, active.filter((a) => a.type === type)] as const).filter(([, l]) => l.length);
  return (
    <>
      {nw.data && (
        <div className="card">
          <div className="faint">{t.netWorth}, {nw.data.baseCurrency}</div>
          <div className="hero c-balance num">{money(nw.data.total, nw.data.baseCurrency)}</div>
          <div style={{ marginTop: 8 }}>
            {nw.data.byCurrency.map((c: any) => (
              <div key={c.currency} className="row between faint num" style={{ padding: '2px 0' }}>
                <span>{money(c.balance, c.currency)}</span>
                <span>{c.currency === nw.data.baseCurrency ? '' : c.baseValue ? `× ${c.rate} = ${money(c.baseValue, nw.data.baseCurrency)}${c.approximate ? ` (${t.approxRate})` : ''}` : <span className="c-danger">{t.missingRate}</span>}</span>
              </div>
            ))}
          </div>
          {!nw.data.complete && <div className="warn" style={{ marginTop: 8 }}>{t.missingRatesWarn} ({nw.data.missingRates.join(', ')})</div>}
        </div>
      )}
      {!active.length && <div className="empty">{t.noAccounts}</div>}
      {groups.map(([type, list]) => (
        <div key={type}>
          <div className="section-title">{t.types[type]}</div>
          <div className="list">{list.map((a) => <AccountRow key={a.id} a={a} onOpen={onOpen} />)}</div>
        </div>
      ))}
    </>
  );
}

function TransferRow({ tr, onClick }: { tr: Transfer; onClick?: () => void }) {
  const { t, lang } = useT();
  return (
    <button className="item" onClick={onClick} disabled={!onClick}>
      <span className="ic" style={{ color: 'var(--accent)' }}>⇄</span>
      <div className="main">
        <div className="t1">{tr.fromAccountName} → {tr.toAccountName}</div>
        <div className="t2">{fmtDate(tr.occurredAt, lang)}{tr.fromCurrency !== tr.toCurrency ? ` · ${t.rate} 1 ${tr.rateBase} = ${tr.rate} ${tr.rateQuote}` : ''}{tr.comment ? ' · ' + tr.comment : ''}</div>
      </div>
      <div className="amt num">
        <span className="c-expense">−{money(tr.amountSent, tr.fromCurrency)}</span>
        <small className="c-income">+{money(tr.amountReceived, tr.toCurrency)}</small>
      </div>
    </button>
  );
}

function Transfers() {
  const { t } = useT();
  const { version } = useStore();
  const list = useAsync(() => get<Transfer[]>('/transfers'), [version]);
  const [open, setOpen] = useState<Transfer | null>(null);
  return (
    <>
      <div className="card"><TransferForm /></div>
      <div className="section-title">{t.transfers}</div>
      {list.data && (list.data.length ? <div className="list">{list.data.map((tr) => <TransferRow key={tr.id} tr={tr} onClick={() => setOpen(tr)} />)}</div> : <div className="empty">{t.nothing}</div>)}
      {open && <TransferSheet transfer={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function Archive({ onOpen }: { onOpen: (a: Account) => void }) {
  const { t } = useT();
  const { accounts, version } = useStore();
  const deleted = useAsync(() => get<Transfer[]>('/transfers?deleted=true'), [version]);
  const archived = accounts.filter((a) => a.isArchived);
  return (
    <>
      <div className="section-title">{t.archivedAccounts}</div>
      {archived.length ? <div className="list">{archived.map((a) => <AccountRow key={a.id} a={a} onOpen={onOpen} />)}</div> : <div className="empty">{t.nothing}</div>}
      <div className="section-title">{t.deletedTransfers}</div>
      {deleted.data?.length ? <div className="list">{deleted.data.map((tr) => <TransferRow key={tr.id} tr={tr} />)}</div> : <div className="empty">{t.nothing}</div>}
    </>
  );
}
