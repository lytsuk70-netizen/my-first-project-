/**
 * Offline-first outbox for TALKO writes. Every change is applied in the app at once and stored in
 * localStorage; the queue is sent to TALKO in the background, in order, with retries. It survives
 * closing the app, so nothing typed is lost when the network or TALKO is slow.
 */
import { ApiError, api } from './api';

export interface TxItem {
  id: string; type: 'income' | 'expense'; amount: string; currency: string; accountId: string; categoryName: string | null;
  comment: string; counterparty: string; occurredAt: string; localDate: string; time?: string | null;
}
export type Op =
  | { id: string; kind: 'add'; tmpId: string; at: string; tries: number; body: { type: 'income' | 'expense'; amount: string; accountId: string; categoryId: string; projectId: string | null; description: string; date: string }; item: TxItem }
  | { id: string; kind: 'delete'; txId: string; at: string; tries: number; item: TxItem }
  | { id: string; kind: 'edit'; txId: string; at: string; tries: number; body: EditBody; prev?: { amount: string; type: 'income' | 'expense'; accountId: string }; categoryName?: string }
  | { id: string; kind: 'transfer'; at: string; tries: number; body: { fromAccountId: string; toAccountId: string; amount: string; amountTo?: string; description?: string; date?: string }; fromCurrency: string; toCurrency: string };
export interface EditBody { description?: string; date?: string; categoryId?: string; amount?: string; time?: string; day?: string }
export type SyncEvent =
  | { type: 'done'; op: Op; realId?: string }
  | { type: 'failed'; op: Op; message: string }
  | { type: 'change' };

const KEY = 'gok.outbox';
let queue: Op[] = load();
let running = false;
let inflight: string | null = null;
let timer: number | undefined;
let lastError: string | null = null;
const listeners = new Set<(e: SyncEvent) => void>();
// entries that were written to TALKO: temporary id on the phone → TALKO id (so later edits reach the right entry)
const realIds: Record<string, string> = (() => { try { return JSON.parse(localStorage.getItem('gok.realIds') ?? '{}'); } catch { return {}; } })();
export const realIdOf = (id: string) => realIds[id] ?? id;

function load(): Op[] { try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; } }
function save() { try { localStorage.setItem(KEY, JSON.stringify(queue)); } catch { /* storage full: keep in memory */ } }
function emit(e: SyncEvent) { for (const l of listeners) l(e); }

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export function ops() { return queue; }
export function syncError() { return lastError; }
export function isInflight(id: string) { return inflight === id; }
export function subscribe(fn: (e: SyncEvent) => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }

export function enqueue(op: Op) {
  if ('txId' in op) op = { ...op, txId: realIdOf(op.txId) } as Op;
  // changing an entry that is not in TALKO yet: fold the change into its pending «add»
  if (op.kind === 'delete' || op.kind === 'edit') {
    const add = queue.find((o) => o.kind === 'add' && o.tmpId === op.txId && o.id !== inflight) as Extract<Op, { kind: 'add' }> | undefined;
    if (add && op.kind === 'delete') { queue = queue.filter((o) => o !== add && !('txId' in o && o.txId === op.txId)); save(); emit({ type: 'change' }); return; }
    if (add && op.kind === 'edit') {
      if (op.body.description !== undefined) { add.body.description = op.body.description; add.item = { ...add.item, comment: op.body.description }; }
      if (op.body.date) { add.body.date = op.body.date; add.item = { ...add.item, localDate: op.body.date }; }
      if (op.body.categoryId) { add.body.categoryId = op.body.categoryId; add.item = { ...add.item, categoryName: op.categoryName ?? add.item.categoryName }; }
      if (op.body.amount) { add.body.amount = op.body.amount; add.item = { ...add.item, amount: op.body.amount }; }
      if (op.body.time) {
        add.item = { ...add.item, time: op.body.time };
        const [y, mo, d] = (add.body.date || add.item.localDate).split('-').map(Number); const [h, mi] = op.body.time.split(':').map(Number);
        add.at = new Date(y, mo - 1, d, h, mi).toISOString();
      }
      save(); emit({ type: 'change' }); return;
    }
  }
  queue = [...queue, op]; save(); emit({ type: 'change' }); kick();
}

export function kick(delay = 0) {
  window.clearTimeout(timer);
  timer = window.setTimeout(run, delay);
}

async function send(op: Op): Promise<string | undefined> {
  switch (op.kind) {
    case 'add': {
      const r = await api('POST', '/talko/transactions', { ...op.body, autoConfirm: true, clientId: op.id, clientTime: op.at });
      if (r.status !== 'saved') throw new ApiError(422, 'TALKO не підтвердив запис');
      return r.id ? String(r.id) : undefined;
    }
    case 'delete': await api('DELETE', '/talko/transactions/' + encodeURIComponent(op.txId) + '?clientId=' + op.id); return;
    case 'edit': await api('PATCH', '/talko/transactions/' + encodeURIComponent(op.txId), op.body); return;
    case 'transfer': {
      const r = await api('POST', '/talko/transfers', { ...op.body, autoConfirm: true, clientId: op.id });
      if (r.status !== 'saved') throw new ApiError(422, 'TALKO не підтвердив переказ');
      return;
    }
  }
}

async function run() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const op = queue[0];
      // an edit/delete of an entry whose «add» failed and was dropped has nothing to change
      if ('txId' in op && op.txId.startsWith('tmp-')) {
        const real = realIdOf(op.txId);
        if (real !== op.txId) { queue[0] = { ...op, txId: real } as Op; save(); continue; }
        queue = queue.slice(1); save(); emit({ type: 'failed', op, message: 'запис не знайдено в TALKO' }); emit({ type: 'change' }); continue;
      }
      inflight = op.id; emit({ type: 'change' });
      try {
        const realId = await send(op);
        queue = queue.slice(1);
        if (op.kind === 'add' && realId) {
          queue = queue.map((o) => ('txId' in o && o.txId === op.tmpId ? { ...o, txId: realId } : o));
          realIds[op.tmpId] = realId;
          try { localStorage.setItem('gok.realIds', JSON.stringify(Object.fromEntries(Object.entries(realIds).slice(-200)))); } catch { /* ignore */ }
        }
        lastError = null; save(); inflight = null;
        emit({ type: 'done', op, realId });
        emit({ type: 'change' });
      } catch (e: any) {
        inflight = null;
        const status = e instanceof ApiError ? e.status : 0;
        if (status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 409 && status !== 429) {
          // TALKO rejected this change: drop it (the app rolls it back) and go on with the rest
          queue = queue.slice(1); save(); lastError = null;
          emit({ type: 'failed', op, message: e.message || 'помилка' }); emit({ type: 'change' });
          continue;
        }
        op.tries = (op.tries ?? 0) + 1; save();
        lastError = status === 401 ? 'Увійдіть знову, щоб синхронізувати' : 'Немає зв’язку з TALKO — повторю';
        emit({ type: 'change' });
        if (status !== 401) kick([3, 8, 20, 45, 90][Math.min(op.tries - 1, 4)] * 1000);
        return;
      }
    }
  } finally { running = false; }
}

window.addEventListener('online', () => kick());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') kick(); });
kick(500);
