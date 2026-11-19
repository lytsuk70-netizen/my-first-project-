import { useEffect, useState } from 'react';
import { get, qs } from '../api';
import { FeedList } from '../components/FeedList';
import { useT } from '../i18n';
import { useStore } from '../store';
import type { FeedItem } from '../types';

interface Filters { kinds: string[]; accountId: string; categoryId: string; projectId: string; currency: string; from: string; to: string; q: string }
const EMPTY: Filters = { kinds: [], accountId: '', categoryId: '', projectId: '', currency: '', from: '', to: '', q: '' };

export function Feed() {
  const { t } = useT();
  const { accounts, categories, projects, currencies, version, feedPreset } = useStore();
  const [f, setF] = useState<Filters>(EMPTY);
  const [showFilters, setShowFilters] = useState(false);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    if (feedPreset) {
      setF({ ...EMPTY, kinds: feedPreset.kinds ?? [], accountId: feedPreset.accountId ?? '', categoryId: feedPreset.categoryId ?? '', projectId: feedPreset.projectId ?? '', from: feedPreset.from ?? '', to: feedPreset.to ?? '' });
      setQ('');
      setShowFilters(true);
    }
  }, [feedPreset]);
  useEffect(() => { const h = setTimeout(() => setF((x) => ({ ...x, q })), 300); return () => clearTimeout(h); }, [q]);

  const query = (offset: number) => '/transactions' + qs({ kinds: f.kinds.join(','), accountId: f.accountId, categoryId: f.categoryId, projectId: f.projectId, currency: f.currency, from: f.from, to: f.to, q: f.q, limit: 100, offset });
  useEffect(() => {
    let alive = true;
    setLoading(true);
    get<{ items: FeedItem[]; hasMore: boolean }>(query(0))
      .then((r) => { if (alive) { setItems(r.items); setHasMore(r.hasMore); setError(null); } })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [f, version]); // eslint-disable-line react-hooks/exhaustive-deps

  async function more() {
    const r = await get<{ items: FeedItem[]; hasMore: boolean }>(query(items.length));
    setItems((x) => [...x, ...r.items]); setHasMore(r.hasMore);
  }
  const toggleKind = (k: string) => setF((x) => ({ ...x, kinds: x.kinds.includes(k) ? x.kinds.filter((y) => y !== k) : [...x.kinds, k] }));
  const active = Object.entries(f).some(([k, v]) => k !== 'q' && (Array.isArray(v) ? v.length : v));

  return (
    <>
      <div className="topbar">
        <h1>{t.feed}</h1>
        <button className={'btn small' + (showFilters || active ? ' primary' : '')} onClick={() => setShowFilters((s) => !s)}>{t.filters}{active ? ' •' : ''}</button>
      </div>
      <input className="input" type="search" placeholder={t.search} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="chips" style={{ marginTop: 10 }}>
        <button className={'chip' + (!f.kinds.length ? ' on' : '')} onClick={() => setF((x) => ({ ...x, kinds: [] }))}>{t.all}</button>
        <button className={'chip' + (f.kinds.includes('expense') ? ' on' : '')} onClick={() => toggleKind('expense')}>{t.expenses}</button>
        <button className={'chip' + (f.kinds.includes('income') ? ' on' : '')} onClick={() => toggleKind('income')}>{t.income}</button>
        <button className={'chip' + (f.kinds.includes('transfer') ? ' on' : '')} onClick={() => toggleKind('transfer')}>{t.transfers}</button>
        <button className={'chip' + (f.kinds.includes('correction') ? ' on' : '')} onClick={() => toggleKind('correction')}>{t.correction}</button>
      </div>
      {showFilters && (
        <div className="card" style={{ marginTop: 8 }}>
          <div className="grid2">
            <select className="input" value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })} aria-label={t.account}>
              <option value="">{t.account}: {t.all}</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <select className="input" value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })} aria-label={t.category}>
              <option value="">{t.category}: {t.all}</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.type === 'income' ? '+ ' : '− '}{c.icon} {c.name}{c.isArchived ? ` (${t.archived})` : ''}</option>)}
            </select>
            <select className="input" value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })} aria-label={t.project}>
              <option value="">{t.project}: {t.all}</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <select className="input" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })} aria-label={t.currency}>
              <option value="">{t.currency}: {t.all}</option>
              {currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
            </select>
            <input className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} aria-label={t.from} />
            <input className="input" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} aria-label={t.to} />
          </div>
          <button className="btn ghost small" onClick={() => { setF(EMPTY); setQ(''); }} style={{ marginTop: 6 }}>{t.reset}</button>
        </div>
      )}
      {error && <div className="error" style={{ marginTop: 10 }}>{error}</div>}
      <FeedList items={items} />
      {loading && <div className="empty">…</div>}
      {hasMore && <button className="btn block" style={{ marginTop: 12 }} onClick={more}>{t.loadMore}</button>}
    </>
  );
}
