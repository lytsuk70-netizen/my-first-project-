/**
 * Exchange-rate book: finds the valuation rate for a currency pair on a date.
 * Rule: use the most recent rate on or before the date; if none exists, use the earliest
 * later rate and mark the result as approximate. Manual rates win over transfer/imported
 * rates recorded on the same date. Falls back to a cross rate through a pivot currency.
 */
import { Decimal, convertMinor } from './money.js';

export interface RateRow {
  rate_date: string; // YYYY-MM-DD
  base: string;
  quote: string;
  rate: string;
  source: 'manual' | 'imported' | 'transfer';
  created_at?: string;
}

export interface FoundRate {
  rate: Decimal; // 1 from = rate to
  date: string;
  approximate: boolean;
  via?: string;
}

const SOURCE_PRIORITY: Record<string, number> = { manual: 3, imported: 2, transfer: 1 };

export class RateBook {
  private byPair = new Map<string, RateRow[]>();

  constructor(rows: RateRow[]) {
    for (const r of rows) {
      const key = `${r.base}/${r.quote}`;
      if (!this.byPair.has(key)) this.byPair.set(key, []);
      this.byPair.get(key)!.push(r);
    }
    for (const list of this.byPair.values()) {
      list.sort((a, b) =>
        a.rate_date !== b.rate_date
          ? a.rate_date.localeCompare(b.rate_date)
          : (SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source]) || String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')),
      );
    }
  }

  private pick(list: RateRow[] | undefined, date: string): { row: RateRow; approximate: boolean } | null {
    if (!list || list.length === 0) return null;
    let best: RateRow | null = null;
    for (const r of list) if (r.rate_date <= date) best = r; // sorted ascending → last one wins
    if (best) return { row: best, approximate: false };
    return { row: list[0], approximate: true };
  }

  /** Direct or inverse rate: 1 from = ? to */
  private direct(from: string, to: string, date: string): FoundRate | null {
    const d = this.pick(this.byPair.get(`${from}/${to}`), date);
    const i = this.pick(this.byPair.get(`${to}/${from}`), date);
    // Prefer the non-approximate, then the more recent one.
    const candidates: FoundRate[] = [];
    if (d) candidates.push({ rate: new Decimal(d.row.rate), date: d.row.rate_date, approximate: d.approximate });
    if (i) candidates.push({ rate: new Decimal(1).div(new Decimal(i.row.rate)), date: i.row.rate_date, approximate: i.approximate });
    if (!candidates.length) return null;
    candidates.sort((a, b) => Number(a.approximate) - Number(b.approximate) || (a.approximate ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)));
    return candidates[0];
  }

  find(from: string, to: string, date: string): FoundRate | null {
    if (from === to) return { rate: new Decimal(1), date, approximate: false };
    const direct = this.direct(from, to, date);
    if (direct && !direct.approximate) return direct;
    const pivots = new Set<string>();
    for (const key of this.byPair.keys()) for (const c of key.split('/')) pivots.add(c);
    let cross: FoundRate | null = null;
    for (const p of pivots) {
      if (p === from || p === to) continue;
      const a = this.direct(from, p, date);
      const b = this.direct(p, to, date);
      if (a && b) {
        const candidate: FoundRate = {
          rate: a.rate.mul(b.rate),
          date: a.date < b.date ? a.date : b.date,
          approximate: a.approximate || b.approximate,
          via: p,
        };
        if (!cross || (cross.approximate && !candidate.approximate)) cross = candidate;
      }
    }
    if (cross && !cross.approximate) return cross;
    return direct ?? cross;
  }

  /** Convert minor units; returns null when no rate exists at all. */
  convert(amountMinor: bigint, from: string, fromDecimals: number, to: string, toDecimals: number, date: string) {
    const found = this.find(from, to, date);
    if (!found) return null;
    const minor = convertMinor(
      amountMinor,
      { currency: from, decimals: fromDecimals },
      { currency: to, decimals: toDecimals },
      { base: from, quote: to, rate: found.rate },
    );
    return { minor, rate: found };
  }
}
