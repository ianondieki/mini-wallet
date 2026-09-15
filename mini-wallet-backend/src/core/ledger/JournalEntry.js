import { randomUUID } from 'node:crypto';
import { Money } from '../money/Money.js';
import { Direction, parseAccount, signFor } from './accounts.js';

/**
 * A journal entry: the atomic, immutable unit of ledger change.
 *
 * An entry is a set of postings that **must sum to zero in every currency it
 * touches**. That single invariant is what makes the system trustworthy —
 * value cannot be conjured or lost, only moved between accounts. A transfer
 * is not "subtract here, add there and hope both succeed"; it is one object
 * that is either wholly valid and written, or rejected.
 *
 * Entries are append-only. A mistake is corrected by posting a *reversing*
 * entry, never by editing history — so the audit trail always explains how
 * a balance came to be, which is what an auditor and a regulator actually ask
 * for.
 *
 * Multi-currency entries are permitted (an FX conversion touches two) and are
 * validated per currency independently.
 */

/**
 * @typedef {object} Posting
 * @property {string} account    Account path, e.g. "liabilities:user:abc:available:kes".
 * @property {string} direction  "debit" | "credit".
 * @property {Money}  amount     Always positive; direction carries the sign.
 * @property {object} [meta]     Optional per-posting annotation.
 */

/** Construct a debit posting. @param {string} account @param {Money} amount @param {object} [meta] */
export const debit = (account, amount, meta) => ({
  account,
  direction: Direction.DEBIT,
  amount,
  ...(meta ? { meta } : {}),
});

/** Construct a credit posting. @param {string} account @param {Money} amount @param {object} [meta] */
export const credit = (account, amount, meta) => ({
  account,
  direction: Direction.CREDIT,
  amount,
  ...(meta ? { meta } : {}),
});

export class JournalEntry {
  /**
   * @param {object} spec
   * @param {string} spec.flow          Business flow, e.g. "transfer", "topup.settle".
   * @param {Posting[]} spec.postings
   * @param {string} [spec.narrative]   Human-readable description.
   * @param {string} [spec.id]
   * @param {Date}   [spec.occurredAt]  When the economic event happened.
   * @param {string} [spec.reversalOf]  Entry id this one reverses.
   * @param {object} [spec.metadata]    Correlation ids, rail references, actor.
   */
  constructor({
    flow,
    postings,
    narrative = '',
    id = randomUUID(),
    occurredAt = new Date(),
    reversalOf = null,
    metadata = {},
  }) {
    if (!flow || typeof flow !== 'string') {
      throw new TypeError('A journal entry needs a `flow`');
    }
    this.id = id;
    this.flow = flow;
    this.narrative = narrative;
    this.occurredAt = occurredAt;
    this.reversalOf = reversalOf;
    this.metadata = metadata;
    this.postings = JournalEntry.#validate(postings);
    Object.freeze(this.postings);
    Object.freeze(this);
  }

  /**
   * Enforce every structural rule an entry must satisfy.
   * @param {Posting[]} postings
   * @returns {Posting[]}
   */
  static #validate(postings) {
    if (!Array.isArray(postings) || postings.length < 2) {
      throw new RangeError('A journal entry needs at least two postings');
    }

    /** @type {Map<string, bigint>} currency → signed debit-minus-credit total */
    const byCurrency = new Map();

    for (const posting of postings) {
      const { account, direction, amount } = posting;
      parseAccount(account); // throws on a malformed or unknown-root path

      if (direction !== Direction.DEBIT && direction !== Direction.CREDIT) {
        throw new RangeError(`Posting direction must be debit or credit, got "${direction}"`);
      }
      if (!Money.isMoney(amount)) {
        throw new TypeError(`Posting to ${account} must carry a Money amount`);
      }
      // A zero posting is always a bug — either a rounding error upstream or
      // a flow that should not have produced a leg at all.
      if (amount.isZero) {
        throw new RangeError(`Zero-amount posting to ${account} is not allowed`);
      }
      // Sign lives in `direction`. A negative amount would double-count it.
      if (amount.isNegative) {
        throw new RangeError(
          `Posting to ${account} has a negative amount; flip the direction instead`
        );
      }

      const delta = direction === Direction.DEBIT ? amount.minorBigInt : -amount.minorBigInt;
      byCurrency.set(amount.currency, (byCurrency.get(amount.currency) ?? 0n) + delta);
    }

    for (const [currency, net] of byCurrency) {
      if (net !== 0n) {
        throw new RangeError(
          `Journal entry does not balance in ${currency}: ` +
            `debits exceed credits by ${net} minor units`
        );
      }
    }

    return postings.map((p) => Object.freeze({ ...p }));
  }

  /** Distinct currencies this entry touches. @returns {string[]} */
  get currencies() {
    return [...new Set(this.postings.map((p) => p.amount.currency))];
  }

  /** Distinct accounts this entry touches. @returns {string[]} */
  get accounts() {
    return [...new Set(this.postings.map((p) => p.account))];
  }

  /**
   * Total debited in one currency — the entry's "size" for reporting and
   * limit checks (debits equal credits, so either side works).
   * @param {string} currency
   * @returns {Money}
   */
  totalFor(currency) {
    return this.postings
      .filter((p) => p.direction === Direction.DEBIT && p.amount.currency === currency)
      .reduce((acc, p) => acc.plus(p.amount), Money.zero(currency));
  }

  /**
   * Net signed effect on one account, in that account's natural sense
   * (positive = balance increased).
   * @param {string} account
   * @param {string} currency
   * @returns {Money}
   */
  effectOn(account, currency) {
    return this.postings
      .filter((p) => p.account === account && p.amount.currency === currency)
      .reduce(
        (acc, p) =>
          signFor(p.account, p.direction) === 1 ? acc.plus(p.amount) : acc.minus(p.amount),
        Money.zero(currency)
      );
  }

  /**
   * Build the entry that undoes this one: same postings, opposite directions.
   *
   * Reversal rather than deletion is deliberate. The original entry stays in
   * the record, the correction is visible as its own event, and the net of
   * the pair is zero — so history stays truthful and still balances.
   *
   * @param {object} [opts]
   * @param {string} [opts.reason]
   * @param {Date}   [opts.occurredAt]
   * @returns {JournalEntry}
   */
  reverse({ reason = 'reversal', occurredAt = new Date() } = {}) {
    return new JournalEntry({
      flow: `${this.flow}.reversed`,
      narrative: `Reversal of ${this.id}: ${reason}`,
      occurredAt,
      reversalOf: this.id,
      metadata: { ...this.metadata, reversalReason: reason },
      postings: this.postings.map((p) => ({
        ...p,
        direction: p.direction === Direction.DEBIT ? Direction.CREDIT : Direction.DEBIT,
      })),
    });
  }

  /** Persistence / wire form. @returns {object} */
  toJSON() {
    return {
      id: this.id,
      flow: this.flow,
      narrative: this.narrative,
      occurredAt: this.occurredAt,
      reversalOf: this.reversalOf,
      metadata: this.metadata,
      postings: this.postings.map((p) => ({
        account: p.account,
        direction: p.direction,
        amount: p.amount.minor,
        currency: p.amount.currency,
        ...(p.meta ? { meta: p.meta } : {}),
      })),
    };
  }

  /**
   * Rebuild from the stored form.
   * @param {object} doc
   * @returns {JournalEntry}
   */
  static fromJSON(doc) {
    return new JournalEntry({
      id: doc.id ?? doc._id?.toString(),
      flow: doc.flow,
      narrative: doc.narrative,
      occurredAt: doc.occurredAt,
      reversalOf: doc.reversalOf,
      metadata: doc.metadata ?? {},
      postings: doc.postings.map((p) => ({
        account: p.account,
        direction: p.direction,
        amount: Money.fromMinor(p.amount, p.currency),
        ...(p.meta ? { meta: p.meta } : {}),
      })),
    });
  }
}

/**
 * Fold postings into per-account balance deltas. Used to apply an entry to
 * cached balances and by the reconciler to rebuild balances from history.
 *
 * @param {JournalEntry[]} entries
 * @returns {Map<string, Money>} keyed by "account|CURRENCY"
 */
export const foldBalances = (entries) => {
  /** @type {Map<string, Money>} */
  const balances = new Map();
  for (const entry of entries) {
    for (const posting of entry.postings) {
      const key = `${posting.account}|${posting.amount.currency}`;
      const current = balances.get(key) ?? Money.zero(posting.amount.currency);
      balances.set(
        key,
        signFor(posting.account, posting.direction) === 1
          ? current.plus(posting.amount)
          : current.minus(posting.amount)
      );
    }
  }
  return balances;
};

export default JournalEntry;
