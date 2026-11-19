import { useState } from 'react';
import { useT } from '../i18n';
import { money } from '../money';
import { useStore } from '../store';
import type { FeedItem, Transfer } from '../types';
import { TxEditor } from './TxEditor';
import { TransferSheet } from './TransferForm';
import { CatIcon, fmtDay } from './ui';

function feedToTransfer(i: FeedItem): Transfer {
  return {
    id: i.transferId!, fromAccountId: i.accountId, fromAccountName: i.accountName, fromCurrency: i.currency, toAccountId: i.toAccountId!, toAccountName: i.toAccountName!,
    toCurrency: i.toCurrency!, amountSent: i.amount, amountReceived: i.amountReceived!, rate: i.rate ?? '1', rateBase: i.rateBase ?? i.currency, rateQuote: i.rateQuote ?? i.currency,
    occurredAt: i.occurredAt, comment: i.comment, deletedAt: null,
  };
}

export function FeedRow({ item, onClick }: { item: FeedItem; onClick?: () => void }) {
  const { t, lang } = useT();
  const time = new Date(item.occurredAt).toLocaleTimeString(lang === 'en' ? 'en-GB' : 'uk-UA', { hour: '2-digit', minute: '2-digit' });
  let icon, title, sub, amount;
  if (item.kind === 'transfer') {
    icon = <span className="ic" style={{ color: 'var(--accent)' }}>⇄</span>;
    title = `${item.accountName} → ${item.toAccountName}`;
    sub = [time, item.currency !== item.toCurrency ? `${t.rate} ${item.rate} ${item.rateBase}/${item.rateQuote}` : t.transfer, item.comment].filter(Boolean).join(' · ');
    amount = <div className="amt num c-accent">{money(item.amount, item.currency)}{item.currency !== item.toCurrency && <small>→ {money(item.amountReceived, item.toCurrency!)}</small>}</div>;
  } else if (item.kind === 'correction') {
    icon = <span className="ic">±</span>;
    title = t.correction;
    sub = [time, item.accountName, item.comment].filter(Boolean).join(' · ');
    amount = <div className="amt num muted">{money(item.amount, item.currency, true)}</div>;
  } else {
    icon = <CatIcon icon={item.categoryIcon} color={item.categoryColor} />;
    title = item.comment || item.categoryName;
    sub = [time, item.comment ? item.categoryName : null, item.accountName, item.projectName, item.attachmentCount ? '🧾' : null, item.source === 'voice' ? '🎙' : item.source === 'sms' ? '✉️' : null].filter(Boolean).join(' · ');
    amount = <div className={'amt num ' + (item.kind === 'expense' ? 'c-expense' : 'c-income')}>{item.kind === 'expense' ? '−' : '+'}{money(item.amount, item.currency)}</div>;
  }
  return (
    <button className="item" onClick={onClick} disabled={!onClick}>
      {icon}
      <div className="main"><div className="t1">{title}</div><div className="t2">{sub}</div></div>
      {amount}
    </button>
  );
}

/** Day-grouped list with per-day per-currency totals; clicking opens the right editor. */
export function FeedList({ items, showDayTotals = true }: { items: FeedItem[]; showDayTotals?: boolean }) {
  const { t, lang } = useT();
  const { categories } = useStore();
  const [open, setOpen] = useState<FeedItem | null>(null);
  if (!items.length) return <div className="empty">{t.nothing}</div>;
  const days: Array<[string, FeedItem[]]> = [];
  for (const i of items) {
    const last = days[days.length - 1];
    if (last && last[0] === i.localDate) last[1].push(i); else days.push([i.localDate, [i]]);
  }
  const dayTotal = (list: FeedItem[]) => {
    const m = new Map<string, bigint>();
    for (const i of list) if (i.kind === 'expense') {
      const [a, b = ''] = i.amount.split('.');
      const scale = b.length;
      m.set(`${i.currency}:${scale}`, (m.get(`${i.currency}:${scale}`) ?? 0n) + BigInt(a + b));
    }
    return [...m.entries()].map(([k, v]) => {
      const [c, scale] = k.split(':'); const s = Number(scale);
      const str = v.toString().padStart(s + 1, '0');
      return money(s ? `${str.slice(0, -s)}.${str.slice(-s)}` : str, c);
    }).join(' + ');
  };
  return (
    <>
      {days.map(([day, list]) => (
        <div key={day}>
          <div className="day-head"><span>{fmtDay(day, lang, t)}</span>{showDayTotals && <span className="c-expense num">{dayTotal(list)}</span>}</div>
          <div className="list">{list.map((i) => <FeedRow key={i.id} item={i} onClick={i.deletedAt || i.kind === 'correction' ? undefined : () => setOpen(i)} />)}</div>
        </div>
      ))}
      {open && open.kind === 'transfer' && <TransferSheet transfer={feedToTransfer(open)} onClose={() => setOpen(null)} />}
      {open && (open.kind === 'income' || open.kind === 'expense') && (
        <TxEditor mode="edit" allowTypeChange onClose={() => setOpen(null)}
          initial={{ id: open.id, type: open.kind, amount: open.amount, accountId: open.accountId, categoryId: categories.some((c) => c.id === open.categoryId) ? open.categoryId! : '', projectId: open.projectId, occurredAt: open.occurredAt, comment: open.comment, details: open.details }} />
      )}
    </>
  );
}
