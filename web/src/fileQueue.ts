/**
 * Offline-first attachments. A photo or scan is saved on the phone (IndexedDB) the moment it is taken
 * and shown on the entry right away; it is sent to TALKO in the background when the entry is already
 * in TALKO and there is a connection. Survives closing the app.
 */
import { ApiError, api } from './api';
import { realIdOf, subscribe as subscribeOutbox } from './talkoSync';

export interface QFile { id: string; txId: string; name: string; contentType: string; data: string; at: string; tries: number; error?: string }
export interface SentFile { id: number; name: string; url: string; contentType: string }
type Ev = { type: 'change' } | { type: 'sent'; file: QFile; result: SentFile; txId: string } | { type: 'failed'; file: QFile; message: string };

const DB = 'gok-files', STORE = 'q';
let items: QFile[] = [];
let ready: Promise<void>;
let running = false;
let timer: number | undefined;
const listeners = new Set<(e: Ev) => void>();
const emit = (e: Ev) => { for (const l of listeners) l(e); };

function open(): Promise<IDBDatabase> {
  return new Promise((ok, bad) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'id' }); };
    r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  return new Promise((ok, bad) => {
    const t = db.transaction(STORE, mode); const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { ok(req ? (req as IDBRequest<T>).result : undefined); db.close(); };
    t.onerror = () => { bad(t.error); db.close(); };
  });
}
ready = tx<QFile[]>('readonly', (s) => s.getAll()).then((r) => { items = (r ?? []).sort((a, b) => a.at.localeCompare(b.at)); emit({ type: 'change' }); }).catch(() => {});

export const subscribe = (fn: (e: Ev) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const pendingFor = (txId: string) => items.filter((f) => f.txId === txId || realIdOf(f.txId) === realIdOf(txId));
export const count = () => items.length;

export async function add(txId: string, file: { name: string; contentType: string; data: string }) {
  await ready;
  const f: QFile = { id: 'f-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), txId, ...file, at: new Date().toISOString(), tries: 0 };
  await tx('readwrite', (s) => s.put(f)); // throws if the phone has no room — the caller tells the user
  items = [...items, f]; emit({ type: 'change' }); kick();
  return f;
}
export async function remove(id: string) {
  items = items.filter((f) => f.id !== id); emit({ type: 'change' });
  await tx('readwrite', (s) => s.delete(id)).catch(() => {});
}

export function kick(delay = 0) { window.clearTimeout(timer); timer = window.setTimeout(run, delay); }

async function run() {
  await ready;
  if (running) return;
  running = true;
  try {
    for (const f of [...items]) {
      if (f.error) continue;
      const real = realIdOf(f.txId);
      if (real.startsWith('tmp-')) continue; // the entry itself is not in TALKO yet
      try {
        const r = await api<SentFile>('POST', '/talko/transactions/' + encodeURIComponent(real) + '/files', { name: f.name, contentType: f.contentType, data: f.data, clientId: f.id });
        await remove(f.id);
        emit({ type: 'sent', file: f, result: r, txId: real });
      } catch (e: any) {
        const status = e instanceof ApiError ? e.status : 0;
        f.tries += 1;
        if (status >= 400 && status < 500 && ![401, 408, 409, 429].includes(status) && f.tries >= 3) {
          const msg: string = e?.message || 'помилка'; f.error = msg; emit({ type: 'failed', file: f, message: msg });
        }
        await tx('readwrite', (s) => s.put(f)).catch(() => {});
        emit({ type: 'change' });
        if (status !== 401) kick([5, 15, 40, 90][Math.min(f.tries - 1, 3)] * 1000);
        return;
      }
    }
  } finally { running = false; }
}

/** Try a file that TALKO refused again (the user tapped it). */
export function retry(id: string) { const f = items.find((x) => x.id === id); if (f) { f.error = undefined; f.tries = 0; kick(); emit({ type: 'change' }); } }

export function previewUrl(f: QFile) {
  const bin = atob(f.data); const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([b], { type: f.contentType }));
}

// an entry just got its TALKO id → its files can go
subscribeOutbox((e) => { if (e.type === 'done' && e.op.kind === 'add') kick(200); });
window.addEventListener('online', () => kick());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') kick(); });
kick(1500);
