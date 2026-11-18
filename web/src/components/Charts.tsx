import { useRef, useState, type ReactNode } from 'react';

/** Chart geometry only uses Number(); every displayed value is the server's exact decimal string. */
const n = (s: string) => Number(s) || 0;

interface Tip { x: number; y: number; content: ReactNode }
function useTip() {
  const [tip, setTip] = useState<Tip | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const show = (e: React.MouseEvent | React.PointerEvent, content: ReactNode) => {
    const r = ref.current!.getBoundingClientRect();
    setTip({ x: e.clientX - r.left, y: e.clientY - r.top, content });
  };
  const node = tip ? <div className="tooltip" style={{ left: tip.x, top: tip.y }}>{tip.content}</div> : null;
  return { ref, show, hide: () => setTip(null), node };
}

export interface Slice { key: string; label: string; value: string; display: string; percent: number; color: string; icon?: string; onClick?: () => void; sub?: string }

/** Donut + legend. More than 7 slices fold into one neutral "Other" slice. */
export function Donut({ slices, otherLabel, centerTop, centerBottom }: { slices: Slice[]; otherLabel: string; centerTop: ReactNode; centerBottom?: ReactNode }) {
  const tip = useTip();
  let list = slices;
  if (slices.length > 8) {
    const rest = slices.slice(7);
    const restPct = rest.reduce((s, x) => s + x.percent, 0);
    const restVal = rest.reduce((s, x) => s + n(x.value), 0);
    list = [...slices.slice(0, 7), { key: '__other', label: `${otherLabel} (${rest.length})`, value: String(restVal), display: '', percent: Math.round(restPct * 100) / 100, color: '#8e8e93' }];
  }
  const total = list.reduce((s, x) => s + n(x.value), 0);
  const R = 70, r = 48, C = 90;
  let angle = -Math.PI / 2;
  const arcs = total > 0 ? list.map((sl) => {
    const frac = n(sl.value) / total;
    const a0 = angle; const a1 = angle + frac * Math.PI * 2; angle = a1;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad: number, a: number) => `${C + rad * Math.cos(a)} ${C + rad * Math.sin(a)}`;
    const d = frac >= 0.9999
      ? `M ${C} ${C - R} A ${R} ${R} 0 1 1 ${C - 0.01} ${C - R} L ${C - 0.01} ${C - r} A ${r} ${r} 0 1 0 ${C} ${C - r} Z`
      : `M ${p(R, a0)} A ${R} ${R} 0 ${large} 1 ${p(R, a1)} L ${p(r, a1)} A ${r} ${r} 0 ${large} 0 ${p(r, a0)} Z`;
    return { sl, d };
  }) : [];
  return (
    <div className="donut-wrap">
      <div className="chart-wrap" ref={tip.ref} style={{ width: 180, height: 180 }}>
        <svg viewBox="0 0 180 180" width="180" height="180" role="img" aria-label={String(centerTop)}>
          {total === 0 && <circle cx={C} cy={C} r={(R + r) / 2} fill="none" stroke="var(--surface-3)" strokeWidth={R - r} />}
          {arcs.map(({ sl, d }) => (
            <path key={sl.key} d={d} fill={sl.color} stroke="var(--surface)" strokeWidth={2} style={{ cursor: sl.onClick ? 'pointer' : 'default' }}
              onPointerMove={(e) => tip.show(e, <><b>{sl.label}</b> · {sl.percent}%{sl.display ? <> · {sl.display}</> : null}</>)} onPointerLeave={tip.hide} onClick={sl.onClick} />
          ))}
          <text x={C} y={C - 2} textAnchor="middle" fill="var(--text)" fontSize="15" fontWeight="700">{centerTop}</text>
          {centerBottom && <text x={C} y={C + 16} textAnchor="middle" fill="var(--text-3)" fontSize="11">{centerBottom}</text>}
        </svg>
        {tip.node}
      </div>
      <div className="legend">
        {slices.map((sl) => (
          <button key={sl.key} onClick={sl.onClick} disabled={!sl.onClick}>
            <span className="swatch" style={{ background: list.some((x) => x.key === sl.key) ? sl.color : '#8e8e93' }} />
            <span className="grow" style={{ minWidth: 0 }}>
              <span className="row between"><span className="ellipsis">{sl.icon} {sl.label}</span><b className="num" style={{ whiteSpace: 'nowrap' }}>{sl.display}</b></span>
              <span className="row between faint"><span>{sl.sub}</span><span className="num">{sl.percent}%</span></span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export interface BarSeries { key: string; label: string; color: string; values: string[] }

/** Vertical bars on one shared axis. One series -> no legend box; two -> legend above. */
export function Bars({ labels, series, format, tickEvery = 1, height = 180, onSelect }: { labels: string[]; series: BarSeries[]; format: (v: string) => string; tickEvery?: number; height?: number; onSelect?: (i: number) => void }) {
  const tip = useTip();
  const W = Math.max(320, labels.length * (series.length * 10 + 8));
  const H = height, padL = 4, padB = 22, padT = 8;
  const max = Math.max(1, ...series.flatMap((s) => s.values.map(n)));
  const slot = (W - padL) / labels.length;
  const gap = 2;
  const bw = Math.max(3, Math.min(22, (slot - 6) / series.length - gap));
  const y = (v: number) => H - padB - (v / max) * (H - padB - padT);
  const ticks = [0.5, 1].map((f) => f * max);
  return (
    <div>
      {series.length > 1 && (
        <div className="row" style={{ gap: 16, marginBottom: 6 }}>
          {series.map((s) => <span key={s.key} className="row faint" style={{ gap: 6 }}><span className="swatch" style={{ background: s.color }} />{s.label}</span>)}
        </div>
      )}
      <div className="chart-wrap" ref={tip.ref} style={{ overflowX: 'auto' }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ minWidth: Math.min(W, 900) }}>
          {ticks.map((tv) => <line key={tv} x1={0} x2={W} y1={y(tv)} y2={y(tv)} stroke="var(--line)" strokeDasharray="2 4" />)}
          <line x1={0} x2={W} y1={H - padB} y2={H - padB} stroke="var(--line)" />
          {labels.map((lab, i) => {
            const x0 = padL + i * slot + (slot - series.length * (bw + gap)) / 2;
            return (
              <g key={lab} onPointerMove={(e) => tip.show(e, <><b>{lab}</b>{series.map((s) => <div key={s.key}>{series.length > 1 ? s.label + ': ' : ''}{format(s.values[i])}</div>)}</>)}
                onPointerLeave={tip.hide} onClick={onSelect ? () => onSelect(i) : undefined} style={{ cursor: onSelect ? 'pointer' : 'default' }}>
                <rect x={padL + i * slot} y={0} width={slot} height={H - padB} fill="transparent" />
                {series.map((s, si) => {
                  const v = n(s.values[i]);
                  if (v <= 0) return null;
                  const top = y(v); const h = H - padB - top; const rx = Math.min(4, bw / 2, h);
                  const x = x0 + si * (bw + gap);
                  return <path key={s.key} d={`M ${x} ${H - padB} V ${top + rx} Q ${x} ${top} ${x + rx} ${top} H ${x + bw - rx} Q ${x + bw} ${top} ${x + bw} ${top + rx} V ${H - padB} Z`} fill={s.color} />;
                })}
                {i % tickEvery === 0 && <text x={padL + i * slot + slot / 2} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--text-3)">{lab}</text>}
              </g>
            );
          })}
        </svg>
        {tip.node}
      </div>
    </div>
  );
}

export function HBarList({ rows }: { rows: Array<{ key: string; label: ReactNode; value: string; percent: number; color: string; onClick?: () => void; sub?: ReactNode }> }) {
  return (
    <div className="legend">
      {rows.map((r) => (
        <button key={r.key} onClick={r.onClick} disabled={!r.onClick}>
          <span className="grow" style={{ minWidth: 0 }}>
            <span className="row between"><span className="ellipsis">{r.label}</span><b className="num">{r.value}</b></span>
            <span className="bar-track"><span className="bar-fill" style={{ display: 'block', width: `${Math.max(r.percent, 0.5)}%`, background: r.color }} /></span>
            {r.sub && <span className="faint">{r.sub}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}
