import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, formatMinor, convertMinor, impliedRate, parseRate, Decimal } from '../src/engine/money.ts';
import { RateBook } from '../src/engine/rates.ts';

test('parseAmount handles separators and rejects extra precision', () => {
  assert.equal(parseAmount('1 250,50', 2), 125050n);
  assert.equal(parseAmount('0.1', 2) + parseAmount('0.2', 2), 30n);
  assert.throws(() => parseAmount('1.234', 2));
  assert.throws(() => parseAmount('0', 2));
  assert.throws(() => parseAmount('-5', 2));
  assert.equal(parseAmount('-5', 2, { allowNegative: true }), -500n);
  assert.equal(parseAmount('1500', 0), 1500n);
  assert.throws(() => parseAmount('abc', 2));
});

test('formatMinor', () => {
  assert.equal(formatMinor(125050n, 2), '1250.50');
  assert.equal(formatMinor(-5n, 2), '-0.05');
  assert.equal(formatMinor(1500n, 0), '1500');
});

test('USD -> UAH at 41.50: $1,000 = 41,500 UAH', () => {
  const r = convertMinor(100000n, { currency: 'USD', decimals: 2 }, { currency: 'UAH', decimals: 2 }, { base: 'USD', quote: 'UAH', rate: parseRate('41.50') });
  assert.equal(r, 4150000n);
});

test('UAH -> USD with USD/UAH rate divides and rounds half up', () => {
  const r = convertMinor(4150000n, { currency: 'UAH', decimals: 2 }, { currency: 'USD', decimals: 2 }, { base: 'USD', quote: 'UAH', rate: parseRate('41.50') });
  assert.equal(r, 100000n);
  const r2 = convertMinor(100n, { currency: 'UAH', decimals: 2 }, { currency: 'USD', decimals: 2 }, { base: 'USD', quote: 'UAH', rate: parseRate('41.50') });
  assert.equal(r2, 2n); // 1 UAH = 0.0240963.. USD -> 0.02
});

test('implied rate from confirmed amounts', () => {
  const rate = impliedRate({ minor: 4500000n, currency: 'UAH', decimals: 2 }, { minor: 100000n, currency: 'EUR', decimals: 2 }, 'EUR');
  assert.equal(rate.toString(), '45');
});

test('RateBook picks latest rate on/before date, inverse and cross rates', () => {
  const book = new RateBook([
    { rate_date: '2026-01-01', base: 'USD', quote: 'UAH', rate: '40', source: 'manual' },
    { rate_date: '2026-02-01', base: 'USD', quote: 'UAH', rate: '41.5', source: 'manual' },
    { rate_date: '2026-02-01', base: 'EUR', quote: 'UAH', rate: '45', source: 'manual' },
  ]);
  assert.equal(book.find('USD', 'UAH', '2026-01-15')!.rate.toString(), '40');
  assert.equal(book.find('USD', 'UAH', '2026-03-01')!.rate.toString(), '41.5');
  const early = book.find('USD', 'UAH', '2025-12-01')!;
  assert.equal(early.approximate, true);
  assert.equal(book.find('UAH', 'USD', '2026-02-01')!.rate.mul(41.5).toDecimalPlaces(10).toString(), '1');
  const cross = book.find('EUR', 'USD', '2026-02-02')!;
  assert.equal(cross.via, 'UAH');
  assert.equal(cross.rate.toDecimalPlaces(6).toString(), new Decimal(45).div(41.5).toDecimalPlaces(6).toString());
  assert.equal(book.find('PLN', 'UAH', '2026-02-02'), null);
});
