/**
 * Financial calculation engine — money primitives.
 * All amounts are integers in minor units (bigint). Rates are Decimal.
 * No JavaScript floating point numbers are ever used for money.
 */
import { Decimal } from 'decimal.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export class MoneyError extends Error {}

export function decimalsOf(currency: string, table: Record<string, number>): number {
  const d = table[currency];
  if (d === undefined) throw new MoneyError(`Unknown currency ${currency}`);
  return d;
}

/** "1 250,50" | "1250.5" | 1250 -> 125050n (for 2 decimals). Rejects extra precision. */
export function parseAmount(input: string | number, decimals: number, opts: { allowNegative?: boolean; allowZero?: boolean } = {}): bigint {
  const raw = String(input).replace(/[\s ']/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new MoneyError(`Invalid amount: ${input}`);
  const d = new Decimal(raw);
  if (d.decimalPlaces() > decimals) throw new MoneyError(`Too many decimal places (max ${decimals})`);
  if (!opts.allowNegative && d.isNegative()) throw new MoneyError('Amount must not be negative');
  if (!opts.allowZero && d.isZero()) throw new MoneyError('Amount must not be zero');
  const minor = d.mul(new Decimal(10).pow(decimals));
  if (minor.abs().gt('9000000000000000')) throw new MoneyError('Amount is too large');
  return BigInt(minor.toFixed(0));
}

/** 125050n -> "1250.50" */
export function formatMinor(minor: bigint, decimals: number): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const s = abs.toString().padStart(decimals + 1, '0');
  const int = decimals ? s.slice(0, -decimals) : s;
  const frac = decimals ? '.' + s.slice(-decimals) : '';
  return (neg ? '-' : '') + int + frac;
}

export function parseRate(input: string | number): Decimal {
  const raw = String(input).replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new MoneyError(`Invalid exchange rate: ${input}`);
  const d = new Decimal(raw);
  if (d.lte(0)) throw new MoneyError('Exchange rate must be positive');
  if (d.decimalPlaces() > 10) throw new MoneyError('Exchange rate: max 10 decimal places');
  return d;
}

/**
 * Convert an amount between currencies with rate "1 base = rate quote".
 * Handles both directions and different decimal precisions. Rounds half-up to target minor units.
 */
export function convertMinor(
  amountMinor: bigint,
  from: { currency: string; decimals: number },
  to: { currency: string; decimals: number },
  rate: { base: string; quote: string; rate: Decimal },
): bigint {
  if (from.currency === to.currency) return amountMinor;
  const major = new Decimal(amountMinor.toString()).div(new Decimal(10).pow(from.decimals));
  let converted: Decimal;
  if (rate.base === from.currency && rate.quote === to.currency) converted = major.mul(rate.rate);
  else if (rate.base === to.currency && rate.quote === from.currency) converted = major.div(rate.rate);
  else throw new MoneyError(`Rate ${rate.base}/${rate.quote} cannot convert ${from.currency}->${to.currency}`);
  return BigInt(converted.mul(new Decimal(10).pow(to.decimals)).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));
}

/** Implied rate "1 base = ? quote" from two confirmed amounts. */
export function impliedRate(
  sent: { minor: bigint; currency: string; decimals: number },
  received: { minor: bigint; currency: string; decimals: number },
  base: string,
): Decimal {
  const s = new Decimal(sent.minor.toString()).div(new Decimal(10).pow(sent.decimals));
  const r = new Decimal(received.minor.toString()).div(new Decimal(10).pow(received.decimals));
  const rate = base === sent.currency ? r.div(s) : s.div(r);
  return rate.toDecimalPlaces(10, Decimal.ROUND_HALF_UP);
}

export function sumMinor(values: bigint[]): bigint {
  return values.reduce((a, b) => a + b, 0n);
}

export { Decimal };
