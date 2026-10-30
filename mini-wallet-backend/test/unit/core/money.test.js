import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Money, Rounding, divideRounded, toFraction } from '../../../src/core/money/Money.js';
import { getCurrency, isSupportedCurrency } from '../../../src/core/money/currencies.js';

describe('Money — construction', () => {
  test('parses major units exactly into minor units', () => {
    assert.equal(Money.of('1499.99', 'KES').minor, 149_999);
    assert.equal(Money.of('0.01', 'KES').minor, 1);
    assert.equal(Money.of('0', 'KES').minor, 0);
    assert.equal(Money.of('-5.50', 'KES').minor, -550);
  });

  test('respects per-currency exponents', () => {
    assert.equal(Money.of('5000', 'UGX').minor, 5000, 'UGX has no minor unit');
    assert.equal(Money.of('5000', 'KES').minor, 500_000, 'KES is in cents');
  });

  test('rejects precision the currency cannot represent', () => {
    assert.throws(() => Money.of('1.005', 'KES'), /more precision/);
    assert.throws(() => Money.of('1.5', 'UGX'), /more precision/);
  });

  test('ofRounded accepts excess precision under an explicit mode', () => {
    assert.equal(Money.ofRounded('1.005', 'KES', Rounding.HALF_UP).minor, 101);
    assert.equal(Money.ofRounded('1.004', 'KES', Rounding.HALF_UP).minor, 100);
  });

  test('rejects unknown currencies rather than inventing a balance bucket', () => {
    assert.throws(() => Money.of('1', 'XYZ'), /Unsupported currency/);
    assert.equal(isSupportedCurrency('kes'), true);
    assert.equal(getCurrency('kes').code, 'KES');
  });

  test('rejects non-integer minor units', () => {
    assert.throws(() => Money.fromMinor(1.5, 'KES'), /safe integer/);
    assert.throws(() => Money.fromMinor('12.3', 'KES'), /whole number/);
  });

  test('round-trips through JSON', () => {
    const original = Money.of('1234.56', 'KES');
    const revived = Money.fromJSON(JSON.parse(JSON.stringify(original)));
    assert.ok(revived.equals(original));
    assert.equal(original.toJSON().amount, '1234.56');
  });
});

describe('Money — the float bugs this class exists to prevent', () => {
  test('0.1 + 0.2 === 0.3 exactly', () => {
    const sum = Money.of('0.10', 'KES').plus(Money.of('0.20', 'KES'));
    assert.equal(sum.toDecimal(), '0.30');
    assert.ok(sum.equals(Money.of('0.30', 'KES')));
  });

  test('a thousand one-cent additions land exactly on ten shillings', () => {
    let total = Money.zero('KES');
    for (let i = 0; i < 1000; i += 1) total = total.plus(Money.of('0.01', 'KES'));
    assert.equal(total.toDecimal(), '10.00');
  });

  test('survives amounts past Number.MAX_SAFE_INTEGER in intermediate maths', () => {
    // 90 billion KES — the intermediate of `minor * rate` overflows a float.
    const huge = Money.of('90000000000.00', 'KES');
    const converted = huge.times('0.00775431');
    assert.equal(converted.toDecimal(), '697887900.00');
  });
});

describe('Money — arithmetic', () => {
  test('addition and subtraction never round', () => {
    const a = Money.of('10.00', 'KES');
    assert.equal(a.plus(Money.of('0.01', 'KES')).toDecimal(), '10.01');
    assert.equal(a.minus(Money.of('10.01', 'KES')).toDecimal(), '-0.01');
  });

  test('refuses to mix currencies', () => {
    assert.throws(
      () => Money.of('1', 'KES').plus(Money.of('1', 'USD')),
      /Currency mismatch/
    );
    assert.throws(() => Money.of('1', 'KES').compare(Money.of('1', 'USD')), /Currency mismatch/);
  });

  test('basis points express fees without floats', () => {
    // 1.5% of 1,500.00 = 22.50
    assert.equal(Money.of('1500.00', 'KES').basisPoints(150).toDecimal(), '22.50');
    // 0.35% of 100.00 = 0.35
    assert.equal(Money.of('100.00', 'KES').basisPoints(35).toDecimal(), '0.35');
  });

  test('is immutable', () => {
    const a = Money.of('10.00', 'KES');
    a.plus(Money.of('5.00', 'KES'));
    assert.equal(a.toDecimal(), '10.00');
    assert.throws(() => {
      'use strict';
      a.whatever = 1;
    });
  });
});

describe('Money — rounding modes', () => {
  const cases = [
    [Rounding.HALF_UP, 5n, 2n, 3n],
    [Rounding.HALF_EVEN, 5n, 2n, 2n],
    [Rounding.HALF_EVEN, 7n, 2n, 4n],
    [Rounding.DOWN, 9n, 2n, 4n],
    [Rounding.UP, 1n, 2n, 1n],
    [Rounding.FLOOR, -5n, 2n, -3n],
    [Rounding.CEIL, -5n, 2n, -2n],
  ];
  for (const [mode, num, den, expected] of cases) {
    test(`${mode}: ${num}/${den} → ${expected}`, () => {
      assert.equal(divideRounded(num, den, mode), expected);
    });
  }

  test('toFraction decomposes decimals without binary error', () => {
    assert.deepEqual(toFraction('1.005'), { num: 1005n, den: 1000n });
    assert.deepEqual(toFraction(-2.5), { num: -25n, den: 10n });
  });
});

describe('Money — allocation conserves every minor unit', () => {
  test('splits an indivisible amount without losing a cent', () => {
    const parts = Money.of('1.00', 'KES').allocate([1, 1, 1]);
    assert.deepEqual(parts.map((p) => p.toDecimal()), ['0.34', '0.33', '0.33']);
    assert.ok(Money.sum('KES', ...parts).equals(Money.of('1.00', 'KES')));
  });

  test('weighted splits stay exact', () => {
    const parts = Money.of('100.00', 'KES').allocate([70, 20, 10]);
    assert.deepEqual(parts.map((p) => p.toDecimal()), ['70.00', '20.00', '10.00']);
  });

  test('awkward weights still conserve the total', () => {
    const total = Money.of('0.05', 'KES');
    const parts = total.allocate([3, 7]);
    assert.ok(Money.sum('KES', ...parts).equals(total));
  });

  test('negative amounts split symmetrically', () => {
    const parts = Money.of('-1.00', 'KES').allocate([1, 1, 1]);
    assert.ok(Money.sum('KES', ...parts).equals(Money.of('-1.00', 'KES')));
    assert.ok(parts.every((p) => p.isNegative));
  });

  test('fuzz: allocation always conserves the total', () => {
    for (let i = 0; i < 400; i += 1) {
      const minor = Math.floor(Math.random() * 1_000_000) - 500_000;
      const amount = Money.fromMinor(minor, 'KES');
      const weights = Array.from(
        { length: 2 + Math.floor(Math.random() * 6) },
        () => 1 + Math.floor(Math.random() * 50)
      );
      const parts = amount.allocate(weights);
      assert.ok(
        Money.sum('KES', ...parts).equals(amount),
        `lost value splitting ${amount} by [${weights}]`
      );
    }
  });

  test('rejects degenerate weights', () => {
    assert.throws(() => Money.of('1', 'KES').allocate([]), /non-empty/);
    assert.throws(() => Money.of('1', 'KES').allocate([0, 0]), /sum to zero/);
    assert.throws(() => Money.of('1', 'KES').allocate([-1, 2]), /non-negative/);
  });
});

describe('Money — comparison and rendering', () => {
  test('orders correctly', () => {
    const a = Money.of('10.00', 'KES');
    const b = Money.of('20.00', 'KES');
    assert.ok(a.lessThan(b) && b.greaterThan(a));
    assert.ok(Money.max(a, b).equals(b) && Money.min(a, b).equals(a));
    assert.ok(a.clamp(Money.of('15.00', 'KES'), null).equals(Money.of('15.00', 'KES')));
  });

  test('renders exact decimals for zero-exponent currencies', () => {
    assert.equal(Money.of('5000', 'UGX').toDecimal(), '5000');
    assert.equal(Money.fromMinor(7, 'KES').toDecimal(), '0.07');
    assert.equal(Money.fromMinor(-7, 'KES').toDecimal(), '-0.07');
  });

  test('toString is unambiguous', () => {
    assert.equal(Money.of('1.5', 'USD').toString(), '1.50 USD');
  });
});
