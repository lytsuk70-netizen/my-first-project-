import { useEffect, useMemo, useState } from 'react';
import { del, post, put } from '../api';
import { useT } from '../i18n';
import { fromLocalInput, isPositiveAmount, money, normalizeAmountInput, previewConvert, previewRate, toLocalInput } from '../money';
import { useStore } from '../store';
import type { Transfer } from '../types';
import { AccountSelect, ErrorBox, Field, Icons, Sheet } from './ui';

/** Transfer / currency exchange form. Used inline (create) and inside a sheet (edit). */
export interface TransferDraft { fromAccountId?: string | null; toAccountId?: string | null; amountSent?: string | null; rate?: string | null }

export function TransferForm({ existing, draft, onDone }: { existing?: Transfer; draft?: TransferDraft; onDone?: () => void }) {
  const { t } = useT();
  const { accounts, currencies, changed, toast } = useStore();
  const active = accounts.filter((a) => !a.isArchived);
  const [fromId, setFromId] = useState(existing?.fromAccountId ?? draft?.fromAccountId ?? '');
  const [toId, setToId] = useState(existing?.toAccountId ?? draft?.toAccountId ?? '');
  const [sent, setSent] = useState(existing?.amountSent ?? draft?.amountSent ?? '');
  const [rate, setRate] = useState(existing && existing.fromCurrency !== existing.toCurrency ? existing.rate : draft?.rate ?? '');
  const [received, setReceived] = useState(existing && existing.fromCurrency !== existing.toCurrency ? existing.amountReceived : '');
  const [lastEdited, setLastEdited] = useState<'rate' | 'received'>('rate');
  const [rateBase, setRateBase] = useState(existing?.rateBase ?? '');
  const [when, setWhen] = useState(toLocalInput(existing?.occurredAt ?? new Date().toISOString()));
  const [comment, setComment] = useState(existing?.comment ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const from = accounts.find((a) => a.id === fromId);
  const to = accounts.find((a) => a.id === toId);
  const exchange = !!from && !!to && from.currency !== to.currency;
  const decimals = (c?: string) => currencies.find((x) => x.code === c)?.decimals ?? 2;

  // Default rate base: the non-UAH currency (USD/UAH style), otherwise the source currency.
  useEffect(() => {
    if (!from || !to || !exchange) return;
    if (rateBase === from.currency || rateBase === to.currency) return;
    setRateBase(from.currency === 'UAH' ? to.currency : to.currency === 'UAH' ? from.currency : from.currency);
  }, [from?.currency, to?.currency]); // eslint-disable-line react-hooks/exhaustive-deps

  const computedReceived = useMemo(() => {
    if (!exchange || lastEdited !== 'rate' || !sent || !rate) return null;
    return previewConvert(normalizeAmountInput(sent), normalizeAmountInput(rate), rateBase === from!.currency, decimals(from!.currency), decimals(to!.currency));
  }, [exchange, lastEdited, sent, rate, rateBase, from, to]); // eslint-disable-line react-hooks/exhaustive-deps
  const impliedRate = useMemo(() => {
    if (!exchange || lastEdited !== 'received' || !sent || !received) return null;
    return previewRate(normalizeAmountInput(sent), normalizeAmountInput(received), rateBase === from!.currency);
  }, [exchange, lastEdited, sent, received, rateBase, from]);

  const shownReceived = !exchange ? sent : lastEdited === 'rate' ? (computedReceived ?? '') : received;
  const shownRate = !exchange ? '1' : lastEdited === 'received' ? (impliedRate ?? '') : rate;
  const quote = exchange ? (rateBase === from!.currency ? to!.currency : from!.currency) : '';
  const valid = fromId && toId && fromId !== toId && isPositiveAmount(sent) && (!exchange || (lastEdited === 'rate' ? isPositiveAmount(rate) : isPositiveAmount(received)));

  async function submit() {
    if (!valid) return;
    setBusy(true); setError(null);
    const body = {
      fromAccountId: fromId, toAccountId: toId, amountSent: normalizeAmountInput(sent),
      ...(exchange ? (lastEdited === 'rate' ? { rate: normalizeAmountInput(rate) } : { amountReceived: normalizeAmountInput(received) }) : {}),
      rateBase: exchange ? rateBase : undefined, occurredAt: fromLocalInput(when), comment,
    };
    try {
      if (existing) await put(`/transfers/${existing.id}`, body); else await post('/transfers', body);
      await changed();
      toast(t.saved);
      if (!existing) { setSent(''); setRate(''); setReceived(''); setComment(''); setWhen(toLocalInput(new Date().toISOString())); }
      onDone?.();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  async function remove() {
    if (!existing || !confirm(t.confirmDelete)) return;
    setBusy(true);
    try { await del(`/transfers/${existing.id}`); await changed(); toast(t.deleted); onDone?.(); } catch (e: any) { setError(e.message); setBusy(false); }
  }

  return (
    <div>
      <div className="grid2" style={{ alignItems: 'end' }}>
        <Field label={t.from}><AccountSelect accounts={existing ? accounts : active} value={fromId} onChange={setFromId} /></Field>
        <Field label={t.to}><AccountSelect accounts={existing ? accounts : active} value={toId} onChange={setToId} /></Field>
      </div>
      <div style={{ textAlign: 'center', marginTop: -6 }}>
        <button className="btn ghost small" onClick={() => { setFromId(toId); setToId(fromId); }} aria-label={t.swap}>{Icons.swap} {t.swap}</button>
      </div>
      <div className="grid2">
        <Field label={`${t.amountSent}${from ? ', ' + from.currency : ''}`}>
          <input className="input num" inputMode="decimal" value={sent} onChange={(e) => setSent(e.target.value)} style={{ fontWeight: 700, fontSize: 18 }} />
        </Field>
        <Field label={`${t.amountReceived}${to ? ', ' + to.currency : ''}`}>
          <input className="input num" inputMode="decimal" value={shownReceived} disabled={!exchange}
            onChange={(e) => { setLastEdited('received'); setReceived(e.target.value); }} style={{ fontWeight: 700, fontSize: 18, color: 'var(--income)' }} />
        </Field>
      </div>
      {exchange && (
        <Field label={<>{t.rate}: 1 {rateBase} = ? {quote} <button type="button" className="btn ghost small" onClick={() => { setRateBase(quote); setRate(''); setReceived(''); }}>⇄</button></>}>
          <input className="input num" inputMode="decimal" value={shownRate} onChange={(e) => { setLastEdited('rate'); setRate(e.target.value); }} placeholder="41,50" />
        </Field>
      )}
      <p className="faint" style={{ marginTop: -4 }}>{t.rateHint} {t.transferNotIncome}</p>
      <div className="grid2 stack">
        <Field label={t.date}><input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
        <Field label={t.comment}><input className="input" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} /></Field>
      </div>
      {from && to && isPositiveAmount(sent) && shownReceived && (
        <div className="card" style={{ background: 'var(--surface-2)', marginBottom: 12 }}>
          <div className="row between"><span>{from.name}</span><b className="c-expense num">−{money(normalizeAmountInput(sent), from.currency)}</b></div>
          <div className="row between"><span>{to.name}</span><b className="c-income num">+{money(normalizeAmountInput(shownReceived), to.currency)}</b></div>
        </div>
      )}
      <ErrorBox error={error} />
      <div className="row" style={{ marginTop: 10 }}>
        {existing && <button className="btn danger" disabled={busy} onClick={remove}>{t.delete}</button>}
        <button className="btn primary grow" disabled={!valid || busy} onClick={submit}>{existing ? t.save : t.makeTransfer}</button>
      </div>
    </div>
  );
}

export function TransferSheet({ transfer, draft, title, onClose }: { transfer?: Transfer; draft?: TransferDraft; title?: string; onClose: () => void }) {
  const { t } = useT();
  return <Sheet title={title ?? t.transfer} onClose={onClose}><TransferForm existing={transfer} draft={draft} onDone={onClose} /></Sheet>;
}
