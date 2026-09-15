import { Money } from '../money/Money.js';

/**
 * The pricing engine.
 *
 * Fees were previously nowhere: transfers were free and withdrawals passed
 * Safaricom's charge through implicitly. Any real wallet prices, and pricing
 * that lives in scattered `if` statements is how a customer gets charged
 * differently by two code paths for the same action.
 *
 * A schedule is an **ordered rule table**, evaluated first-match-wins like a
 * routing table. A rule matches on flow, rail, currency, customer tier and
 * amount band, then charges a fixed component plus a basis-point component,
 * clamped to optional floor and ceiling.
 *
 * Fixed + percentage + caps covers essentially every published consumer
 * tariff — M-Pesa's bands, Wise's `0.43% + 0.32`, Stripe's `2.9% + 30¢` — so
 * new pricing is a data change rather than a code change. And because
 * {@link FeeSchedule#quote} returns the rule that fired along with the
 * arithmetic, "why was I charged this?" has an exact answer instead of a
 * support ticket.
 */

/**
 * @typedef {object} FeeRule
 * @property {string} id                     Stable identifier, surfaced to the customer.
 * @property {string} [description]
 * @property {string|string[]} [flow]        e.g. "transfer", "payout", "deposit".
 * @property {string|string[]} [rail]
 * @property {string|string[]} [currency]
 * @property {string|string[]} [tier]        KYC tier keys this rule applies to.
 * @property {string} [minAmount]            Inclusive lower bound, major units.
 * @property {string} [maxAmount]            Inclusive upper bound, major units.
 * @property {string} [fixed]                Flat component, major units.
 * @property {number} [bps]                  Percentage component in basis points.
 * @property {string} [min]                  Floor on the resulting fee.
 * @property {string} [max]                  Ceiling on the resulting fee.
 * @property {boolean} [passThroughRailCost] Charge whatever the rail charged us.
 */

/** Does a rule field (absent = wildcard) match a value? */
const matches = (ruleValue, value) => {
  if (ruleValue === undefined || ruleValue === null) return true;
  const allowed = Array.isArray(ruleValue) ? ruleValue : [ruleValue];
  return allowed.includes(value);
};

export class FeeSchedule {
  /**
   * @param {FeeRule[]} rules  Ordered; the first match wins.
   */
  constructor(rules = []) {
    if (!Array.isArray(rules)) throw new TypeError('FeeSchedule expects an array of rules');
    const seen = new Set();
    for (const rule of rules) {
      if (!rule.id) throw new TypeError('Every fee rule needs an id');
      if (seen.has(rule.id)) throw new RangeError(`Duplicate fee rule id "${rule.id}"`);
      seen.add(rule.id);
    }
    this.rules = rules;
  }

  /**
   * Find the rule that governs a charge.
   * @param {object} context
   * @returns {FeeRule|null}
   */
  match({ flow, rail, currency, tier, amount }) {
    return (
      this.rules.find((rule) => {
        if (!matches(rule.flow, flow)) return false;
        if (!matches(rule.rail, rail)) return false;
        if (!matches(rule.currency, currency)) return false;
        if (!matches(rule.tier, tier)) return false;
        if (rule.minAmount && amount.lessThan(Money.of(rule.minAmount, currency))) return false;
        if (rule.maxAmount && amount.greaterThan(Money.of(rule.maxAmount, currency))) return false;
        return true;
      }) ?? null
    );
  }

  /**
   * Price a transaction.
   *
   * @param {object} context
   * @param {string} context.flow
   * @param {Money}  context.amount
   * @param {string} [context.rail]
   * @param {string} [context.tier]
   * @param {Money}  [context.railCost]  What the rail charges us, for pass-through rules.
   * @returns {{fee: Money, ruleId: string|null, breakdown: object}}
   */
  quote({ flow, amount, rail, tier, railCost }) {
    if (!Money.isMoney(amount)) throw new TypeError('quote() needs a Money amount');
    const currency = amount.currency;
    const rule = this.match({ flow, rail, currency, tier, amount });

    if (!rule) {
      // No rule means free. Defaulting to a charge would be worse: a missing
      // rule is a configuration gap, and silently inventing a fee for it is
      // how customers get billed for something nobody intended.
      return {
        fee: Money.zero(currency),
        ruleId: null,
        breakdown: { reason: 'no matching fee rule — treated as free' },
      };
    }

    if (rule.passThroughRailCost) {
      const fee = Money.isMoney(railCost) ? railCost : Money.zero(currency);
      return {
        fee,
        ruleId: rule.id,
        breakdown: { passThrough: true, railCost: fee.toJSON() },
      };
    }

    const fixed = rule.fixed ? Money.of(rule.fixed, currency) : Money.zero(currency);
    const variable = rule.bps ? amount.basisPoints(rule.bps) : Money.zero(currency);
    const raw = fixed.plus(variable);

    const floor = rule.min ? Money.of(rule.min, currency) : null;
    const ceiling = rule.max ? Money.of(rule.max, currency) : null;
    const fee = raw.clamp(floor, ceiling);

    return {
      fee,
      ruleId: rule.id,
      breakdown: {
        description: rule.description,
        fixed: fixed.toJSON(),
        bps: rule.bps ?? 0,
        variable: variable.toJSON(),
        subtotal: raw.toJSON(),
        ...(floor && raw.lessThan(floor) ? { raisedToMinimum: floor.toJSON() } : {}),
        ...(ceiling && raw.greaterThan(ceiling) ? { cappedAtMaximum: ceiling.toJSON() } : {}),
        total: fee.toJSON(),
      },
    };
  }

  /**
   * Render the whole tariff for a currency — what a published price list and
   * an in-app "our fees" screen are both built from.
   * @param {string} currency
   * @returns {object[]}
   */
  publish(currency) {
    return this.rules
      .filter((r) => matches(r.currency, currency))
      .map((r) => ({
        id: r.id,
        description: r.description,
        applies: {
          flow: r.flow ?? 'any',
          rail: r.rail ?? 'any',
          tier: r.tier ?? 'any',
          amountFrom: r.minAmount ?? null,
          amountTo: r.maxAmount ?? null,
        },
        charge: r.passThroughRailCost
          ? 'provider cost, passed through at no margin'
          : {
              fixed: r.fixed ?? '0',
              percent: r.bps ? `${(r.bps / 100).toFixed(2)}%` : '0%',
              min: r.min ?? null,
              max: r.max ?? null,
            },
      }));
  }
}

/**
 * The default published tariff.
 *
 * The shape of it is a deliberate product position: in-network transfers are
 * free because they cost us nothing (see the internal rail), and everything
 * that touches an external provider is priced to cover that provider plus a
 * capped margin. Free-where-free is what makes a wallet worth joining; the
 * cap is what stops a large transfer from being punitively priced.
 */
export const DEFAULT_FEE_RULES = [
  {
    id: 'transfer.internal.free',
    description: 'Sending to another wallet on this platform',
    flow: 'transfer',
    fixed: '0',
    bps: 0,
  },
  {
    id: 'deposit.free',
    description: 'Adding money to your wallet',
    flow: 'deposit',
    fixed: '0',
    bps: 0,
  },
  {
    id: 'payout.small',
    description: 'Withdrawal up to 1,000',
    flow: 'payout',
    currency: 'KES',
    maxAmount: '1000',
    fixed: '10.00',
    bps: 0,
  },
  {
    id: 'payout.standard',
    description: 'Withdrawal — 1% capped at 150',
    flow: 'payout',
    currency: 'KES',
    minAmount: '1000.01',
    fixed: '0',
    bps: 100,
    min: '15.00',
    max: '150.00',
  },
  {
    id: 'fx.convert',
    description: 'Currency conversion — 0.6% of the amount converted',
    flow: 'fx',
    fixed: '0',
    bps: 60,
  },
];

/** The schedule this deployment charges. */
export const defaultFeeSchedule = new FeeSchedule(DEFAULT_FEE_RULES);

export default FeeSchedule;
