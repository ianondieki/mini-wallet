import { getCurrency } from './currencies.js';

/**
 * `Money` — an immutable, exact monetary value.
 *
 * ## Why this exists
 *
 * The original wallet stored balances as a JavaScript `Number` of whole
 * shillings. That works exactly as long as nothing ever produces a fraction,
 * and breaks the moment it does — percentage fees, FX conversion and interest
 * all produce fractions, and `0.1 + 0.2 !== 0.3`. In a ledger, a cent that
 * appears or vanishes through rounding is not a display bug; it is money that
 * does not reconcile.
 *
 * So: value is held in **integer minor units** (cents for KES/USD, whole
 * units for UGX/RWF) as a **BigInt**, and every operation is exact.
 *
 * BigInt rather than a safe-integer `Number` specifically because of FX.
 * Converting KES 1,000,000 at a rate scaled to 8 decimal places computes
 * `100_000_000n * 100_000_000n` ≈ 1e16, which is past `Number.MAX_SAFE_INTEGER`
 * (≈9.007e15). With `Number` that intermediate silently loses precision; with
 * BigInt it cannot. The BigInt stays inside this class — `.minor` hands back a
 * plain, range-checked `Number` at the persistence boundary.
 *
 * Instances are frozen. Every operation returns a new `Money`.
 */

/**
 * Rounding strategies, applied only where a result is genuinely fractional
 * (multiplication, division, FX). Addition and subtraction never round.
 * @readonly
 * @enum {string}
 */
export const Rounding = Object.freeze({
  /** 0.5 rounds away from zero. Conventional for consumer-facing fees. */
  HALF_UP: 'HALF_UP',
  /** 0.5 rounds to the nearest even. Bias-free over many operations. */
  HALF_EVEN: 'HALF_EVEN',
  /** Truncate toward zero. */
  DOWN: 'DOWN',
  /** Away from zero. */
  UP: 'UP',
  /** Toward negative infinity. */
  FLOOR: 'FLOOR',
  /** Toward positive infinity. */
  CEIL: 'CEIL',
});

/** Absolute value of a BigInt. */
const babs = (v) => (v < 0n ? -v : v);

/**
 * Exactly decompose a decimal literal into an integer fraction `num/den`.
 * "1.005" → { num: 1005n, den: 1000n }. Used so a rate or multiplier never
 * passes through binary floating point.
 *
 * @param {number|string|bigint} value
 * @returns {{ num: bigint, den: bigint }}
 */
export const toFraction = (value) => {
  if (typeof value === 'bigint') return { num: value, den: 1n };

  const text = typeof value === 'number' ? numberToPlainString(value) : String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new TypeError(`Cannot interpret "${value}" as an exact decimal`);
  }

  const negative = text.startsWith('-');
  const [whole, frac = ''] = (negative ? text.slice(1) : text).split('.');
  const num = BigInt(`${whole}${frac}` || '0') * (negative ? -1n : 1n);
  return { num, den: 10n ** BigInt(frac.length) };
};

/**
 * Render a `Number` as a plain decimal string without exponent notation, so
 * `1e-7` becomes "0.0000001" rather than parsing as garbage.
 * @param {number} n
 * @returns {string}
 */
const numberToPlainString = (n) => {
  if (!Number.isFinite(n)) throw new TypeError(`Cannot interpret ${n} as money`);
  if (Number.isInteger(n)) return n.toFixed(0);
  // 20 is the maximum `toFixed` precision; trailing zeros are trimmed after.
  return n.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
};

/**
 * Divide `num` by `den` (both BigInt) to an integer, applying `mode`.
 * @param {bigint} num
 * @param {bigint} den  Must be non-zero.
 * @param {string} mode  A {@link Rounding} member.
 * @returns {bigint}
 */
export const divideRounded = (num, den, mode = Rounding.HALF_UP) => {
  if (den === 0n) throw new RangeError('Division by zero');

  // Normalise so the sign lives in one place.
  const negative = num < 0n !== den < 0n;
  const a = babs(num);
  const b = babs(den);
  const quotient = a / b;
  const remainder = a % b;

  if (remainder === 0n) return negative ? -quotient : quotient;

  /** Should the magnitude be bumped by one? */
  let bump = false;
  const twice = remainder * 2n;

  switch (mode) {
    case Rounding.DOWN:
      bump = false;
      break;
    case Rounding.UP:
      bump = true;
      break;
    case Rounding.FLOOR:
      bump = negative;
      break;
    case Rounding.CEIL:
      bump = !negative;
      break;
    case Rounding.HALF_EVEN:
      if (twice > b) bump = true;
      else if (twice < b) bump = false;
      else bump = quotient % 2n === 1n; // tie → round to even
      break;
    case Rounding.HALF_UP:
      bump = twice >= b;
      break;
    default:
      throw new RangeError(`Unknown rounding mode "${mode}"`);
  }

  const magnitude = bump ? quotient + 1n : quotient;
  return negative ? -magnitude : magnitude;
};

export class Money {
  /** @type {bigint} */
  #minor;
  /** @type {import('./currencies.js').Currency} */
  #currency;

  /**
   * Prefer {@link Money.of} or {@link Money.fromMinor} — they validate input.
   * @param {bigint} minor
   * @param {import('./currencies.js').Currency} currency
   */
  constructor(minor, currency) {
    this.#minor = minor;
    this.#currency = currency;
    Object.freeze(this);
  }

  /* ── Construction ─────────────────────────────────────────────────── */

  /**
   * Build from minor units — the form everything is stored and transmitted in.
   * @param {number|string|bigint} minor  Must be a whole number.
   * @param {string} code  ISO currency code.
   * @returns {Money}
   */
  static fromMinor(minor, code) {
    const currency = getCurrency(code);
    let value;
    if (typeof minor === 'bigint') {
      value = minor;
    } else if (typeof minor === 'number') {
      if (!Number.isSafeInteger(minor)) {
        throw new TypeError(
          `Minor units must be a safe integer, got ${minor}. ` +
            'Pass a string or BigInt for values beyond 2^53.'
        );
      }
      value = BigInt(minor);
    } else {
      const text = String(minor).trim();
      if (!/^-?\d+$/.test(text)) {
        throw new TypeError(`Minor units must be a whole number, got "${minor}"`);
      }
      value = BigInt(text);
    }
    return new Money(value, currency);
  }

  /**
   * Build from a major-unit amount: `Money.of('149.99', 'KES')` → 14999 cents.
   *
   * Strings are exact. A `Number` is converted through its shortest decimal
   * representation, which is right for ordinary input (`149.99`) but is still
   * a float — prefer strings for anything arriving from an external system.
   *
   * @param {number|string|bigint} major
   * @param {string} code
   * @returns {Money}
   */
  static of(major, code) {
    const currency = getCurrency(code);
    const { num, den } = toFraction(major);
    const scale = 10n ** BigInt(currency.exponent);
    // Exact only when the input has no more decimals than the currency allows.
    const scaled = num * scale;
    if (scaled % den !== 0n) {
      throw new RangeError(
        `${major} has more precision than ${currency.code} allows ` +
          `(${currency.exponent} decimal place${currency.exponent === 1 ? '' : 's'})`
      );
    }
    return new Money(scaled / den, currency);
  }

  /**
   * Like {@link Money.of} but rounds excess precision instead of throwing.
   * @param {number|string|bigint} major
   * @param {string} code
   * @param {string} [mode]
   * @returns {Money}
   */
  static ofRounded(major, code, mode = Rounding.HALF_UP) {
    const currency = getCurrency(code);
    const { num, den } = toFraction(major);
    const scale = 10n ** BigInt(currency.exponent);
    return new Money(divideRounded(num * scale, den, mode), currency);
  }

  /** The zero value in `code`. */
  static zero(code) {
    return new Money(0n, getCurrency(code));
  }

  /**
   * Rehydrate from the `{ minor, currency }` shape used in the database and
   * on the wire.
   * @param {{minor: number|string|bigint, currency: string}} json
   * @returns {Money}
   */
  static fromJSON(json) {
    if (!json || typeof json !== 'object') {
      throw new TypeError('Money.fromJSON expects { minor, currency }');
    }
    return Money.fromMinor(json.minor, json.currency);
  }

  /** True when `value` is a Money instance. */
  static isMoney(value) {
    return value instanceof Money;
  }

  /* ── Accessors ────────────────────────────────────────────────────── */

  /**
   * Minor units as a plain `Number`, for storage and JSON. Throws rather than
   * silently truncating if the value has outgrown the safe-integer range —
   * at which point the storage column, not this getter, is what needs fixing.
   * @returns {number}
   */
  get minor() {
    const asNumber = Number(this.#minor);
    if (!Number.isSafeInteger(asNumber)) {
      throw new RangeError(
        `${this.toString()} exceeds Number.MAX_SAFE_INTEGER in minor units; ` +
          'use .minorBigInt for exact handling.'
      );
    }
    return asNumber;
  }

  /** Minor units as a BigInt — always exact. */
  get minorBigInt() {
    return this.#minor;
  }

  /** ISO currency code, e.g. "KES". */
  get currency() {
    return this.#currency.code;
  }

  /** Full currency descriptor. */
  get currencyInfo() {
    return this.#currency;
  }

  /* ── Guards ───────────────────────────────────────────────────────── */

  /**
   * Reject cross-currency arithmetic. Adding KES to USD is never a rounding
   * question — it is a bug, and it stops here rather than in the ledger.
   * @param {Money} other
   */
  #assertSameCurrency(other) {
    if (!(other instanceof Money)) {
      throw new TypeError('Expected a Money instance');
    }
    if (other.currency !== this.currency) {
      throw new TypeError(
        `Currency mismatch: cannot combine ${this.currency} with ${other.currency}. ` +
          'Convert through the FX layer first.'
      );
    }
  }

  /* ── Arithmetic (exact, never rounds) ─────────────────────────────── */

  /** @param {Money} other @returns {Money} */
  plus(other) {
    this.#assertSameCurrency(other);
    return new Money(this.#minor + other.minorBigInt, this.#currency);
  }

  /** @param {Money} other @returns {Money} */
  minus(other) {
    this.#assertSameCurrency(other);
    return new Money(this.#minor - other.minorBigInt, this.#currency);
  }

  /** @returns {Money} */
  negate() {
    return new Money(-this.#minor, this.#currency);
  }

  /** @returns {Money} */
  abs() {
    return new Money(babs(this.#minor), this.#currency);
  }

  /** Sum any number of same-currency values. @returns {Money} */
  static sum(code, ...values) {
    return values.reduce((acc, v) => acc.plus(v), Money.zero(code));
  }

  /* ── Scaling (rounds — mode is explicit) ──────────────────────────── */

  /**
   * Multiply by an exact decimal factor.
   * @param {number|string|bigint} factor
   * @param {string} [mode]
   * @returns {Money}
   */
  times(factor, mode = Rounding.HALF_UP) {
    const { num, den } = toFraction(factor);
    return new Money(divideRounded(this.#minor * num, den, mode), this.#currency);
  }

  /**
   * Divide by an exact decimal divisor.
   * @param {number|string|bigint} divisor
   * @param {string} [mode]
   * @returns {Money}
   */
  dividedBy(divisor, mode = Rounding.HALF_UP) {
    const { num, den } = toFraction(divisor);
    if (num === 0n) throw new RangeError('Division by zero');
    return new Money(divideRounded(this.#minor * den, num, mode), this.#currency);
  }

  /**
   * Take a share expressed in **basis points** (1 bp = 0.01%). Fee schedules
   * are declared in bps so "1.5%" is the integer 150 and never a float.
   * @param {number|bigint} bps
   * @param {string} [mode]
   * @returns {Money}
   */
  basisPoints(bps, mode = Rounding.HALF_UP) {
    const points = typeof bps === 'bigint' ? bps : BigInt(Math.trunc(Number(bps)));
    return new Money(divideRounded(this.#minor * points, 10_000n, mode), this.#currency);
  }

  /**
   * Split into parts proportional to `weights`, **conserving every minor
   * unit**. The remainder left by integer division is handed out one unit at
   * a time to the parts with the largest fractional shortfall (ties broken by
   * position), so `sum(allocate(w)) === this` always holds.
   *
   * This is what makes revenue splits, instalments and multi-party settlement
   * safe: naive `amount * ratio` rounding leaks or invents cents.
   *
   * @param {number[]} weights  Non-negative, at least one greater than zero.
   * @returns {Money[]}
   */
  allocate(weights) {
    if (!Array.isArray(weights) || weights.length === 0) {
      throw new TypeError('allocate() needs a non-empty array of weights');
    }
    const w = weights.map((x) => {
      const n = BigInt(Math.trunc(Number(x)));
      if (n < 0n) throw new RangeError('Weights must be non-negative');
      return n;
    });
    const total = w.reduce((a, b) => a + b, 0n);
    if (total === 0n) throw new RangeError('Weights must not sum to zero');

    // Work on the magnitude so negative amounts split symmetrically.
    const sign = this.#minor < 0n ? -1n : 1n;
    const amount = babs(this.#minor);

    const base = w.map((weight) => (amount * weight) / total);
    const remainders = w.map((weight, i) => ({ i, rem: (amount * weight) % total }));
    let leftover = amount - base.reduce((a, b) => a + b, 0n);

    remainders.sort((a, b) => (b.rem === a.rem ? a.i - b.i : b.rem > a.rem ? 1 : -1));
    for (let k = 0; leftover > 0n; k += 1, leftover -= 1n) {
      base[remainders[k % remainders.length].i] += 1n;
    }

    return base.map((v) => new Money(v * sign, this.#currency));
  }

  /**
   * Split into `n` as-equal-as-possible parts, conserving every minor unit.
   * @param {number} n
   * @returns {Money[]}
   */
  split(n) {
    const count = Math.trunc(Number(n));
    if (count < 1) throw new RangeError('split() needs a positive count');
    return this.allocate(new Array(count).fill(1));
  }

  /* ── Comparison ───────────────────────────────────────────────────── */

  /** @param {Money} other @returns {-1|0|1} */
  compare(other) {
    this.#assertSameCurrency(other);
    if (this.#minor < other.minorBigInt) return -1;
    if (this.#minor > other.minorBigInt) return 1;
    return 0;
  }

  /** @param {Money} other */ equals(other) {
    return other instanceof Money && other.currency === this.currency && other.minorBigInt === this.#minor;
  }
  /** @param {Money} other */ greaterThan(other) { return this.compare(other) > 0; }
  /** @param {Money} other */ greaterThanOrEqual(other) { return this.compare(other) >= 0; }
  /** @param {Money} other */ lessThan(other) { return this.compare(other) < 0; }
  /** @param {Money} other */ lessThanOrEqual(other) { return this.compare(other) <= 0; }

  get isZero() { return this.#minor === 0n; }
  get isPositive() { return this.#minor > 0n; }
  get isNegative() { return this.#minor < 0n; }

  /** Largest of same-currency values. */
  static max(...values) { return values.reduce((a, b) => (a.greaterThan(b) ? a : b)); }
  /** Smallest of same-currency values. */
  static min(...values) { return values.reduce((a, b) => (a.lessThan(b) ? a : b)); }

  /**
   * Clamp into `[lower, upper]`. Either bound may be null for open-ended.
   * @param {Money|null} lower
   * @param {Money|null} upper
   * @returns {Money}
   */
  clamp(lower, upper) {
    let out = this;
    if (lower && out.lessThan(lower)) out = lower;
    if (upper && out.greaterThan(upper)) out = upper;
    return out;
  }

  /* ── Rendering ────────────────────────────────────────────────────── */

  /**
   * Exact decimal string in major units: "1499.99". No thousands separators,
   * no symbol — this is the machine-readable form.
   * @returns {string}
   */
  toDecimal() {
    const { exponent } = this.#currency;
    const negative = this.#minor < 0n;
    const digits = babs(this.#minor).toString().padStart(exponent + 1, '0');
    const whole = digits.slice(0, digits.length - exponent) || '0';
    const frac = exponent > 0 ? `.${digits.slice(digits.length - exponent)}` : '';
    return `${negative ? '-' : ''}${whole}${frac}`;
  }

  /**
   * Localised display string, e.g. "KSh 1,499.99".
   * @param {string} [locale]
   * @returns {string}
   */
  format(locale = 'en-KE') {
    const { code, exponent } = this.#currency;
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(Number(this.toDecimal()));
  }

  /**
   * Persistence / wire form. `minor` is authoritative; `amount` is included
   * for human readability in logs and API responses.
   * @returns {{minor: number, currency: string, amount: string}}
   */
  toJSON() {
    return { minor: this.minor, currency: this.currency, amount: this.toDecimal() };
  }

  /** @returns {string} */
  toString() {
    return `${this.toDecimal()} ${this.currency}`;
  }

  /** Make `console.log` show the value rather than "Money {}". */
  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `Money<${this.toString()}>`;
  }
}

export default Money;
