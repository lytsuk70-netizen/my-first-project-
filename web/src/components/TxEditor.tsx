import { useEffect, useState } from 'react';
import { del, get, post, put } from '../api';
import { useT } from '../i18n';
import { fromLocalInput, isPositiveAmount, normalizeAmountInput, toLocalInput } from '../money';
import { useStore } from '../store';
import type { TxType } from '../types';
import { AccountSelect, CategoryPicker, ErrorBox, Field, Sheet } from './ui';

export interface TxDraft {
  id?: string;
  type: TxType;
  amount: string;
  accountId: string;
  categoryId: string;
  projectId?: string | null;
  occurredAt?: string | null;
  comment?: string;
  details?: string;
}

interface Props {
  initial: TxDraft;
  mode: 'create' | 'edit';
  title?: string;
  questions?: string[];
  importMessageId?: string;
  source?: 'manual' | 'voice' | 'sms';
  allowTypeChange?: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

const ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,application/pdf';

/** Downscale large photos to keep receipts small; returns base64 + mime. */
async function encodeFile(file: File): Promise<{ filename: string; mimeType: string; dataBase64: string }> {
  const toB64 = (blob: Blob) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
  if (/^image\/(jpeg|png|webp)$/.test(file.type) && file.size > 600_000) {
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob: Blob = await new Promise((res) => canvas.toBlob((b) => res(b!), 'image/jpeg', 0.82));
      return { filename: file.name.replace(/\.\w+$/, '') + '.jpg', mimeType: 'image/jpeg', dataBase64: await toB64(blob) };
    } catch { /* fall back to the original */ }
  }
  const type = file.type || (file.name.toLowerCase().endsWith('.heic') ? 'image/heic' : '');
  return { filename: file.name, mimeType: type, dataBase64: await toB64(file) };
}

export function TxEditor({ initial, mode, title, questions, importMessageId, source, allowTypeChange, onClose, onSaved }: Props) {
  const { t } = useT();
  const { accounts, categories, projects, changed, toast } = useStore();
  const [d, setD] = useState<TxDraft>({ ...initial, comment: initial.comment ?? '', details: initial.details ?? '' });
  const [when, setWhen] = useState(toLocalInput(initial.occurredAt ?? new Date().toISOString()));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<File[]>([]);
  const [attachments, setAttachments] = useState<Array<{ id: string; filename: string; mimeType: string }>>([]);
  const account = accounts.find((a) => a.id === d.accountId);
  const set = (patch: Partial<TxDraft>) => setD((x) => ({ ...x, ...patch }));

  useEffect(() => {
    if (mode === 'edit' && d.id) get(`/transactions/${d.id}/attachments`).then(setAttachments).catch(() => {});
  }, [mode, d.id]);

  const valid = isPositiveAmount(d.amount) && d.accountId && d.categoryId;

  async function save() {
    if (!valid) { setError(!isPositiveAmount(d.amount) ? t.enterAmount : !d.accountId ? t.chooseAccount : t.chooseCategory); return; }
    setBusy(true); setError(null);
    const body = {
      type: d.type, amount: normalizeAmountInput(d.amount), accountId: d.accountId, categoryId: d.categoryId, projectId: d.projectId || null,
      occurredAt: fromLocalInput(when), comment: d.comment, details: d.details, ...(mode === 'create' && source ? { source } : {}),
    };
    try {
      let id = d.id;
      if (mode === 'edit') await put(`/transactions/${d.id}`, body);
      else if (importMessageId) id = (await post(`/import/messages/${importMessageId}/confirm`, body)).id;
      else id = (await post('/transactions', body)).id;
      for (const f of pending) await post(`/transactions/${id}/attachments`, await encodeFile(f));
      await changed();
      toast(t.saved);
      onSaved?.();
      onClose();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  async function remove() {
    if (!confirm(t.confirmDelete)) return;
    setBusy(true);
    try { await del(`/transactions/${d.id}`); await changed(); toast(t.deleted); onClose(); } catch (e: any) { setError(e.message); setBusy(false); }
  }
  async function duplicate() {
    setBusy(true);
    try { await post(`/transactions/${d.id}/duplicate`); await changed(); toast(t.saved); onClose(); } catch (e: any) { setError(e.message); setBusy(false); }
  }
  async function uploadNow(files: FileList | null) {
    if (!files) return;
    if (mode === 'create') { setPending((p) => [...p, ...Array.from(files)]); return; }
    try {
      for (const f of Array.from(files)) await post(`/transactions/${d.id}/attachments`, await encodeFile(f));
      setAttachments(await get(`/transactions/${d.id}/attachments`));
      await changed();
    } catch (e: any) { setError(e.message); }
  }
  async function removeAttachment(id: string) {
    await del(`/attachments/${id}`); setAttachments((a) => a.filter((x) => x.id !== id)); await changed();
  }

  const projectLabel = d.type === 'income' ? t.source : t.project;
  return (
    <Sheet title={title ?? (mode === 'edit' ? t.edit : d.type === 'expense' ? t.expense : t.incomeOne)} onClose={onClose}>
      {questions && questions.length > 0 && <div className="warn" style={{ marginBottom: 12 }}>{questions.map((q, i) => <div key={i}>• {q}</div>)}</div>}
      {allowTypeChange && (
        <div className="seg" style={{ marginBottom: 12 }}>
          <button className={d.type === 'expense' ? 'on c-expense' : ''} onClick={() => set({ type: 'expense', categoryId: '' })}>{t.expense}</button>
          <button className={d.type === 'income' ? 'on c-income' : ''} onClick={() => set({ type: 'income', categoryId: '' })}>{t.incomeOne}</button>
        </div>
      )}
      <div className="grid2 stack">
        <Field label={`${t.amount}${account ? ', ' + account.currency : ''}`}>
          <input className="input num" inputMode="decimal" autoFocus={!d.amount} value={d.amount} onChange={(e) => set({ amount: e.target.value })} style={{ fontSize: 22, fontWeight: 700, color: d.type === 'expense' ? 'var(--expense)' : 'var(--income)' }} />
        </Field>
        <Field label={t.account}><AccountSelect accounts={accounts} value={d.accountId} onChange={(v) => set({ accountId: v })} /></Field>
      </div>
      <Field label={t.category}>
        <CategoryPicker categories={categories} type={d.type} value={d.categoryId} onChange={(v) => set({ categoryId: v })} />
      </Field>
      <Field label={t.comment}>
        <input className="input" value={d.comment} onChange={(e) => set({ comment: e.target.value })} maxLength={500} autoFocus={!!d.amount && mode === 'create' && !questions?.length && !source} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />
      </Field>
      <div className="grid2 stack">
        <Field label={projectLabel}>
          <select className="input" value={d.projectId ?? ''} onChange={(e) => set({ projectId: e.target.value || null })}>
            <option value="">{t.none}</option>
            {projects.filter((p) => !p.isArchived || p.id === d.projectId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label={t.date}><input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
      </div>
      <Field label={t.details}><textarea className="input" value={d.details} onChange={(e) => set({ details: e.target.value })} maxLength={2000} /></Field>
      <Field label={t.receipt}>
        <div className="thumbs">
          {attachments.map((a) => (
            <div key={a.id} className="thumb">
              <a href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer" title={a.filename}>
                {a.mimeType.startsWith('image/') && a.mimeType !== 'image/heic' ? <img src={`/api/attachments/${a.id}`} alt={a.filename} loading="lazy" /> : <span className="doc">📄<small>{a.filename}</small></span>}
              </a>
              <button className="x" onClick={() => removeAttachment(a.id)} aria-label={t.delete}>✕</button>
            </div>
          ))}
          {pending.map((f, i) => (
            <div key={i} className="thumb">
              {f.type.startsWith('image/') && f.type !== 'image/heic' ? <img src={URL.createObjectURL(f)} alt={f.name} /> : <span className="doc">📄<small>{f.name}</small></span>}
              <button className="x" onClick={() => setPending((p) => p.filter((_, j) => j !== i))} aria-label={t.delete}>✕</button>
            </div>
          ))}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <label className="btn small grow" style={{ textAlign: 'center' }}>
            📷 {t.takePhoto}
            <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => { uploadNow(e.target.files); e.target.value = ''; }} />
          </label>
          <label className="btn small grow" style={{ textAlign: 'center' }}>
            🖼️ {t.pickFile}
            <input type="file" accept={ACCEPT} multiple hidden onChange={(e) => { uploadNow(e.target.files); e.target.value = ''; }} />
          </label>
        </div>
      </Field>
      <ErrorBox error={error} />
      <div className="actions">
        {mode === 'edit' && <button className="btn danger" disabled={busy} onClick={remove}>{t.delete}</button>}
        {mode === 'edit' && <button className="btn" disabled={busy} onClick={duplicate}>{t.duplicate}</button>}
        <button className={'btn ' + (d.type === 'expense' ? 'expense' : 'income')} disabled={busy || !valid} onClick={save}>{importMessageId || source === 'voice' ? t.confirm : t.save}</button>
      </div>
    </Sheet>
  );
}
