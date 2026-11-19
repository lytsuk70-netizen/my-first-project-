import { useState } from 'react';
import { get, qs } from '../api';
import { Bars, Donut, HBarList } from '../components/Charts';
import { Icons, fmtDate } from '../components/ui';
import { useT } from '../i18n';
import { money } from '../money';
import { useAsync, useStore } from '../store';

type Period = 'day' | 'month' | 'year' | 'custom';
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function range(period: Period, anchor: Date, custom: { from: string; to: string }) {
  if (period === 'custom') return custom;
  if (period === 'day') return { from: iso(anchor), to: iso(anchor) };
  if (period === 'month') return { from: iso(new Date(anchor.getFullYear(), anchor.getMonth(), 1)), to: iso(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0)) };
  return { from: `${anchor.getFullYear()}-01-01`, to: `${anchor.getFullYear()}-12-31` };
}
function shift(period: Period, d: Date, dir: number) {
  if (period === 'day') return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dir);
  if (period === 'month') return new Date(d.getFullYear(), d.getMonth() + dir, 1);
  return new Date(d.getFullYear() + dir, 0, 1);
}

export function Reports() {
  const { t, lang } = useT();
  const { version, openFeed } = useStore();
  const [period, setPeriod] = useState<Period>('month');
  const [anchor, setAnchor] = useState(new Date());
  const [custom, setCustom] = useState({ from: iso(new Date(Date.now() - 29 * 86400000)), to: iso(new Date()) });
  const [kind, setKind] = useState<'expense' | 'income'>('expense');
  const [table, setTable] = useState(false);
  const { from, to } = range(period, anchor, custom);
  const rep = useAsync(() => get('/reports' + qs({ from, to })), [from, to, version]);
  const monthly = useAsync(() => get('/reports/monthly?months=12'), [version]);
  const locale = lang === 'en' ? 'en-GB' : 'uk-UA';

  const title = period === 'day' ? anchor.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })
    : period === 'month' ? anchor.toLocaleDateString(locale, { month: 'long', year: 'numeric' })
    : period === 'year' ? String(anchor.getFullYear()) : `${from} — ${to}`;

  const r = rep.data;
  const sec = r?.[kind];
  const base = r?.baseCurrency;
  const color = kind === 'expense' ? 'var(--expense)' : 'var(--income)';
  const fmt = (v: string) => money(v, base);
  const trendLabel = (b: string) => r.granularity === 'hour' ? b : r.granularity === 'day' ? String(Number(b.slice(8))) : new Date(b + '-15').toLocaleDateString(locale, { month: 'short' });

  return (
    <>
      <div className="seg" style={{ marginBottom: 10 }}>
        {(['day', 'month', 'year', 'custom'] as Period[]).map((p) => <button key={p} className={period === p ? 'on' : ''} onClick={() => { setPeriod(p); setAnchor(new Date()); }}>{t[p]}</button>)}
      </div>
      {period === 'custom' ? (
        <div className="grid2" style={{ marginBottom: 10 }}>
          <input className="input" type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} aria-label={t.from} />
          <input className="input" type="date" value={custom.to} min={custom.from} onChange={(e) => setCustom({ ...custom, to: e.target.value })} aria-label={t.to} />
        </div>
      ) : (
        <div className="row between" style={{ marginBottom: 10 }}>
          <button className="icon-btn" onClick={() => setAnchor(shift(period, anchor, -1))} aria-label="prev">{Icons.chevL}</button>
          <b style={{ textTransform: 'capitalize' }}>{title}</b>
          <button className="icon-btn" onClick={() => setAnchor(shift(period, anchor, 1))} aria-label="next">{Icons.chevR}</button>
        </div>
      )}
      <div className="seg" style={{ marginBottom: 12 }}>
        <button className={kind === 'expense' ? 'on c-expense' : ''} onClick={() => setKind('expense')}>{t.expenses}</button>
        <button className={kind === 'income' ? 'on c-income' : ''} onClick={() => setKind('income')}>{t.income}</button>
      </div>
      <a className="btn small block" style={{ display: 'block', textAlign: 'center', textDecoration: 'none', color: 'var(--text)', marginBottom: 12 }} href={`/api/export/xlsx${qs({ from, to })}`} download>📊 {t.exportXlsx}</a>
      {rep.error && <div className="error">{rep.error}</div>}
      {r && sec && (
        <>
          {r.missingRates.length > 0 && <div className="warn" style={{ marginBottom: 10 }}>{t.missingRatesWarn} ({r.missingRates.join(', ')})</div>}
          <div className="stats" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
            <div className="stat"><div className="l">{t.total}</div><div className="v num" style={{ color, fontSize: 20 }}>{fmt(sec.total)}</div><div className="l">{sec.count} {t.count}</div></div>
            <div className="stat"><div className="l">{t.avgDaily}</div><div className="v num">{fmt(sec.avgDaily)}</div></div>
            <div className="stat"><div className="l">{t.vsPrev}</div><div className="v num">{sec.previous.changePercent === null ? '—' : `${sec.previous.changePercent > 0 ? '+' : ''}${sec.previous.changePercent}%`}</div><div className="l num">{fmt(sec.previous.total)}</div></div>
            <div className="stat"><div className="l">{t.net}</div><div className={'v num ' + (r.net.startsWith('-') ? 'c-expense' : 'c-income')}>{money(r.net, base, true)}</div></div>
          </div>

          <div className="row between"><div className="section-title">{t.byCategory}</div><button className="btn ghost small" onClick={() => setTable((x) => !x)}>{table ? t.showChart : t.showTable}</button></div>
          <div className="card">
            {sec.byCategory.length === 0 ? <div className="empty">{t.nothing}</div> : table ? (
              <table className="tbl"><thead><tr><th>{t.category}</th><th className="r">{t.total}</th><th className="r">%</th><th className="r">{t.count}</th></tr></thead>
                <tbody>{sec.byCategory.map((c: any) => <tr key={c.id}><td>{c.icon} {c.name}{c.archived ? ` (${t.archived})` : ''}</td><td className="r num">{fmt(c.total)}</td><td className="r num">{c.percent}</td><td className="r num">{c.count}</td></tr>)}</tbody></table>
            ) : (
              <Donut otherLabel={t.other} centerTop={fmt(sec.total)} centerBottom={title}
                slices={sec.byCategory.map((c: any) => ({ key: c.id, label: c.name + (c.archived ? ` (${t.archived})` : ''), icon: c.icon, value: c.total, display: fmt(c.total), percent: c.percent, color: c.color, sub: `${c.count} ${t.count}`, onClick: () => openFeed({ kinds: [kind], categoryId: c.id, from, to }) }))} />
            )}
          </div>

          <div className="section-title">{t.trend}</div>
          <div className="card">
            <Bars labels={sec.trend.map((x: any) => trendLabel(x.bucket))} series={[{ key: kind, label: kind === 'expense' ? t.expenses : t.income, color: kind === 'expense' ? '#ff9f0a' : '#30d158', values: sec.trend.map((x: any) => x.total) }]}
              format={fmt} tickEvery={r.granularity === 'day' && sec.trend.length > 16 ? 5 : r.granularity === 'hour' ? 3 : 1}
              onSelect={r.granularity === 'day' ? (i) => openFeed({ kinds: [kind], from: sec.trend[i].bucket, to: sec.trend[i].bucket }) : undefined} />
          </div>

          <div className="section-title">{t.byAccount}</div>
          <div className="card">
            {sec.byAccount.length ? <HBarList rows={sec.byAccount.map((a: any) => ({ key: a.id, label: a.name, value: money(a.original[0].amount, a.currency), sub: a.currency !== base ? `≈ ${fmt(a.total)} · ${a.percent}%` : `${a.percent}%`, percent: a.percent, color: 'var(--accent)', onClick: () => openFeed({ kinds: [kind], accountId: a.id, from, to }) }))} /> : <div className="empty">{t.nothing}</div>}
          </div>

          <div className="section-title">{kind === 'income' ? t.bySource : t.byProject}</div>
          <div className="card">
            {sec.byProject.length ? <HBarList rows={sec.byProject.map((p: any) => ({ key: p.id ?? 'none', label: p.name ?? t.noProject, value: fmt(p.total), sub: `${p.percent}%`, percent: p.percent, color: 'var(--accent)', onClick: p.id ? () => openFeed({ kinds: [kind], projectId: p.id, from, to }) : undefined }))} /> : <div className="empty">{t.nothing}</div>}
          </div>

          <div className="section-title">{t.largest}</div>
          {sec.largest.length ? (
            <div className="list">
              {sec.largest.map((x: any) => (
                <div className="item" key={x.id}>
                  <span className="ic">{x.categoryIcon}</span>
                  <div className="main"><div className="t1">{x.comment || x.categoryName}</div><div className="t2">{fmtDate(x.occurredAt, lang)} · {x.categoryName} · {x.accountName}</div></div>
                  <div className="amt num" style={{ color }}>{money(x.amount, x.currency)}{x.currency !== base && x.baseValue && <small>≈ {fmt(x.baseValue)}</small>}</div>
                </div>
              ))}
            </div>
          ) : <div className="empty">{t.nothing}</div>}
        </>
      )}

      {monthly.data && (
        <>
          <div className="section-title">{t.monthly}</div>
          <div className="card">
            <Bars labels={monthly.data.months.map((m: any) => new Date(m.month + '-15').toLocaleDateString(locale, { month: 'short' }))}
              series={[{ key: 'income', label: t.income, color: '#30d158', values: monthly.data.months.map((m: any) => m.income) }, { key: 'expense', label: t.expenses, color: '#ff9f0a', values: monthly.data.months.map((m: any) => m.expense) }]}
              format={(v) => money(v, monthly.data.baseCurrency)} />
          </div>
        </>
      )}
    </>
  );
}
