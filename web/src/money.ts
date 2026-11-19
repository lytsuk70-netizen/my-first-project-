/** Display + preview helpers. Authoritative calculations happen on the server; previews use BigInt, never floats. */

export function fmtAmount(value: string | null | undefined, currency?: string, opts: { sign?: boolean; symbol?: Record<string, string> } = {}) {
  if (value === null || value === undefined) return '—';
  const neg = value.startsWith('-');
  const [i, f] = value.replace('-', '').split('.');
  const int = i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const body = f && f !== '00' ? `${int},${f}` : int;
  const sym = currency ? (opts.symbol?.[currency] ?? currency) : '';
  const sign = neg ? '−' : opts.sign ? '+' : '';
  return `${sign}${body}${sym ? ' ' + sym : ''}`;
}

export const SYMBOLS: Record<string, string> = { UAH: '₴', USD: '$', EUR: '€', PLN: 'zł', GBP: '£', CHF: 'Fr', CZK: 'Kč', CAD: 'C$', JPY: '¥', BTC: '₿' };
export const money = (v: string | null | undefined, c?: string, sign = false) => fmtAmount(v, c, { symbol: SYMBOLS, sign });

/** "1250,5" -> "1250.5" ; validates the shape only */
export function normalizeAmountInput(s: string): string {
  return s.replace(/[\s ]/g, '').replace(',', '.');
}

function toScaled(s: string, scale: number): bigint | null {
  const n = normalizeAmountInput(s);
  if (!/^\d+(\.\d+)?$/.test(n)) return null;
  const [i, f = ''] = n.split('.');
  if (f.length > scale) return null;
  return BigInt(i + f.padEnd(scale, '0'));
}

/** Preview for the transfer form: amount (2-dec currencies) * or / rate, rounded half-up to `decimals`. */
export function previewConvert(amount: string, rate: string, multiply: boolean, fromDecimals = 2, toDecimals = 2): string | null {
  const a = toScaled(amount, fromDecimals);
  const r = toScaled(rate, 10);
  if (a === null || r === null || r === 0n || a === 0n) return null;
  const R = 10n ** 10n;
  // result in toDecimals minor units
  let num: bigint, den: bigint;
  if (multiply) { num = a * r * 10n ** BigInt(toDecimals); den = 10n ** BigInt(fromDecimals) * R; }
  else { num = a * R * 10n ** BigInt(toDecimals); den = 10n ** BigInt(fromDecimals) * r; }
  const q = (num * 2n + den) / (2n * den);
  const s = q.toString().padStart(toDecimals + 1, '0');
  return toDecimals ? `${s.slice(0, -toDecimals)}.${s.slice(-toDecimals)}` : s;
}

/** Implied rate preview from two amounts: base per quote */
export function previewRate(sent: string, received: string, baseIsSent: boolean): string | null {
  const s = toScaled(sent, 4); const r = toScaled(received, 4);
  if (!s || !r) return null;
  const [num, den] = baseIsSent ? [r, s] : [s, r];
  const q = (num * 10n ** 6n * 2n + den) / (2n * den);
  const str = q.toString().padStart(7, '0');
  return `${str.slice(0, -6)}.${str.slice(-6)}`.replace(/\.?0+$/, '');
}

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function toLocalInput(iso: string) {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fromLocalInput(v: string) { return new Date(v).toISOString(); }
export function isPositiveAmount(s: string) { const n = normalizeAmountInput(s); return /^\d+(\.\d{1,4})?$/.test(n) && /[1-9]/.test(n); }
