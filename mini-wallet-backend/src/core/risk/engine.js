import { Money } from '../money/Money.js';

/**
 * Transaction risk scoring.
 *
 * ## What this is for
 *
 * Two different problems wear the same clothes. **Fraud** is someone moving
 * money that is not theirs — a taken-over account, a social-engineering
 * victim being talked through a transfer. **Money laundering** is someone
 * moving money that *is* theirs through an account that should not be
 * carrying it. Both look like an ordinary transfer at the moment they are
 * submitted, and neither is detectable from that transfer alone. They are
 * detectable from its *shape against history*: how old the account is, what
 * it normally does, where the money goes and how fast it leaves again.
 *
 * So this is a weighted rules engine over a context the caller assembles.
 * Each rule returns a 0..1 intensity rather than a boolean, so "slightly
 * unusual" and "wildly unusual" are different numbers instead of the same
 * flag.
 *
 * ## Why rules rather than a model
 *
 * Every decline has to be explainable — to the customer, to a regulator, and
 * to the analyst reviewing the queue. A weighted rule set says exactly which
 * signals fired and what each contributed. That is worth more at this scale
 * than the accuracy a model would add, and the rules double as the labelled
 * features a model would eventually be trained on.
 *
 * ## Why the default is friction, not refusal
 *
 * A false positive on a real customer trying to pay rent costs more than most
 * false negatives. Ambiguous cases resolve to a step-up challenge — prove it
 * is you — and only genuinely damning combinations block outright.
 *
 * Pure and synchronous: no I/O, entirely testable.
 */

/**
 * @readonly
 * @enum {string}
 */
export const RiskDecision = Object.freeze({
  /** Let it through. */
  ALLOW: 'allow',
  /** Challenge the customer (OTP, biometric, PIN re-entry), then allow. */
  STEP_UP: 'step_up',
  /** Hold for a human analyst. Funds are not moved yet. */
  REVIEW: 'review',
  /** Refuse outright. */
  BLOCK: 'block',
});

/** Score thresholds. Tuned so that a single moderate signal never blocks. */
export const THRESHOLDS = Object.freeze({
  stepUp: 30,
  review: 60,
  block: 82,
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** Clamp to 0..1. */
const unit = (n) => Math.max(0, Math.min(1, n));

/**
 * @typedef {object} RiskContext
 * @property {object} user
 * @property {Date}   user.createdAt
 * @property {string} user.tier
 * @property {number} [user.priorTransactionCount]
 * @property {string} flow                 "transfer" | "payout" | "deposit" | "fx".
 * @property {Money}  amount
 * @property {Money}  balanceBefore
 * @property {object} [counterparty]
 * @property {string} [counterparty.id]
 * @property {boolean} [counterparty.isNew]        First time paying them.
 * @property {number} [counterparty.distinctSenders7d] How many others paid them lately.
 * @property {object} [history]
 * @property {number} [history.count24h]
 * @property {Money}  [history.volume24h]
 * @property {Money}  [history.averageAmount]      Typical transaction for this user.
 * @property {number} [history.distinctRecipients24h]
 * @property {Money}  [history.inboundLast1h]      Money that arrived in the last hour.
 * @property {number} [history.daysSinceLastActivity]
 * @property {object} [device]
 * @property {boolean} [device.isNew]
 * @property {boolean} [device.ipChangedCountry]
 * @property {Date}   [at]                 Transaction time (defaults to now).
 * @property {string} [timezone]           IANA zone for local-hour checks.
 */

/**
 * @typedef {object} RiskRule
 * @property {string} id
 * @property {number} weight      Points contributed at full intensity.
 * @property {string} description
 * @property {(ctx: RiskContext) => {intensity: number, evidence?: object}|null} evaluate
 */

/**
 * The threshold above which a transaction attracts regulatory reporting.
 * Structuring is the act of staying just below it on purpose.
 */
const REPORTING_THRESHOLD = { KES: '1000000', USD: '10000', EUR: '10000', GBP: '10000' };

/** @type {RiskRule[]} */
export const DEFAULT_RULES = [
  {
    id: 'new_account_high_value',
    weight: 22,
    description: 'A young account moving an amount it has no history for',
    evaluate(ctx) {
      const ageDays = (Date.now() - new Date(ctx.user.createdAt).getTime()) / DAY_MS;
      if (ageDays > 30) return null;
      const major = Number(ctx.amount.toDecimal());
      if (major < 10_000) return null;
      // Younger and larger both push intensity up.
      const youth = unit((30 - ageDays) / 30);
      const size = unit(major / 200_000);
      return { intensity: unit(youth * 0.6 + size * 0.6), evidence: { ageDays: Math.round(ageDays) } };
    },
  },
  {
    id: 'pass_through',
    weight: 30,
    description: 'Money arrived and is leaving again almost immediately',
    evaluate(ctx) {
      // The classic mule pattern: funds land, are forwarded within the hour,
      // and the account is left close to empty. Laundering needs the money to
      // keep moving; ordinary spending does not look like this.
      const inbound = ctx.history?.inboundLast1h;
      if (!Money.isMoney(inbound) || inbound.isZero) return null;
      if (ctx.flow === 'deposit') return null;

      const ratio = Number(ctx.amount.toDecimal()) / Number(inbound.toDecimal());
      if (ratio < 0.7) return null;

      const leftBehind = ctx.balanceBefore.minus(ctx.amount);
      const emptied = leftBehind.lessThanOrEqual(ctx.amount.basisPoints(500)); // ≤5% remains
      return {
        intensity: unit(ratio * (emptied ? 1 : 0.6)),
        evidence: { forwardedRatio: Number(ratio.toFixed(2)), emptiesAccount: emptied },
      };
    },
  },
  {
    id: 'structuring',
    weight: 26,
    description: 'Amount sits just below a reporting threshold',
    evaluate(ctx) {
      const thresholdMajor = REPORTING_THRESHOLD[ctx.amount.currency];
      if (!thresholdMajor) return null;
      const threshold = Money.of(thresholdMajor, ctx.amount.currency);
      const amount = Number(ctx.amount.toDecimal());
      const limit = Number(threshold.toDecimal());
      const ratio = amount / limit;

      // 90–99.9% of the threshold is the suspicious band. Landing there once
      // is coincidence; the weight is what makes it matter alongside volume.
      if (ratio < 0.9 || ratio >= 1) return null;
      const repeat = (ctx.history?.count24h ?? 0) >= 3 ? 1 : 0.55;
      return {
        intensity: unit(((ratio - 0.9) / 0.1) * 0.5 + 0.5) * repeat,
        evidence: { percentOfThreshold: Number((ratio * 100).toFixed(1)) },
      };
    },
  },
  {
    id: 'velocity_spike',
    weight: 18,
    description: 'Far more transactions in 24h than this account normally makes',
    evaluate(ctx) {
      const count = ctx.history?.count24h ?? 0;
      if (count < 8) return null;
      return { intensity: unit((count - 8) / 25), evidence: { count24h: count } };
    },
  },
  {
    id: 'amount_anomaly',
    weight: 16,
    description: 'Far larger than this account’s typical transaction',
    evaluate(ctx) {
      const average = ctx.history?.averageAmount;
      if (!Money.isMoney(average) || average.isZero) return null;
      const multiple = Number(ctx.amount.toDecimal()) / Number(average.toDecimal());
      if (multiple < 8) return null;
      return { intensity: unit((multiple - 8) / 40), evidence: { timesUsual: Math.round(multiple) } };
    },
  },
  {
    id: 'mule_fan_in',
    weight: 24,
    description: 'Recipient is collecting from many unrelated senders',
    evaluate(ctx) {
      const senders = ctx.counterparty?.distinctSenders7d ?? 0;
      if (senders < 12) return null;
      return { intensity: unit((senders - 12) / 40), evidence: { distinctSenders7d: senders } };
    },
  },
  {
    id: 'fan_out',
    weight: 18,
    description: 'Paying an unusual number of different recipients in a day',
    evaluate(ctx) {
      const recipients = ctx.history?.distinctRecipients24h ?? 0;
      if (recipients < 8) return null;
      return { intensity: unit((recipients - 8) / 20), evidence: { distinctRecipients24h: recipients } };
    },
  },
  {
    id: 'dormant_reactivation',
    weight: 14,
    description: 'Long-dormant account suddenly moving significant money',
    evaluate(ctx) {
      const idle = ctx.history?.daysSinceLastActivity ?? 0;
      if (idle < 90) return null;
      if (Number(ctx.amount.toDecimal()) < 5_000) return null;
      return { intensity: unit(idle / 365), evidence: { daysDormant: idle } };
    },
  },
  {
    id: 'new_device_high_value',
    weight: 20,
    description: 'Large transfer from a device we have not seen before',
    evaluate(ctx) {
      if (!ctx.device?.isNew) return null;
      const size = unit(Number(ctx.amount.toDecimal()) / 100_000);
      const travel = ctx.device.ipChangedCountry ? 0.4 : 0;
      return {
        intensity: unit(size * 0.7 + travel),
        evidence: { newDevice: true, ipChangedCountry: Boolean(ctx.device.ipChangedCountry) },
      };
    },
  },
  {
    id: 'new_payee_large',
    weight: 15,
    description: 'First payment to this recipient, and it is a large one',
    evaluate(ctx) {
      if (!ctx.counterparty?.isNew) return null;
      const major = Number(ctx.amount.toDecimal());
      if (major < 20_000) return null;
      return { intensity: unit(major / 250_000), evidence: { firstPaymentToPayee: true } };
    },
  },
  {
    id: 'odd_hour',
    weight: 8,
    description: 'Submitted in the small hours, local time',
    evaluate(ctx) {
      const at = ctx.at ?? new Date();
      const hour = Number(
        new Intl.DateTimeFormat('en-GB', {
          timeZone: ctx.timezone ?? 'Africa/Nairobi',
          hour: '2-digit',
          hour12: false,
        }).format(at)
      );
      // 01:00–04:59. On its own this means very little — it is only ever a
      // tiebreaker alongside something substantive.
      if (hour < 1 || hour > 4) return null;
      return { intensity: 0.8, evidence: { localHour: hour } };
    },
  },
];

export class RiskEngine {
  /**
   * @param {RiskRule[]} [rules]
   * @param {typeof THRESHOLDS} [thresholds]
   */
  constructor(rules = DEFAULT_RULES, thresholds = THRESHOLDS) {
    this.rules = rules;
    this.thresholds = thresholds;
  }

  /**
   * Score a transaction.
   *
   * @param {RiskContext} ctx
   * @returns {{score: number, decision: string, signals: object[], reasons: string[]}}
   */
  assess(ctx) {
    const signals = [];

    for (const rule of this.rules) {
      let result;
      try {
        result = rule.evaluate(ctx);
      } catch {
        // A rule that throws on unfamiliar context must not take down the
        // payment path. Skipping it degrades scoring; throwing would decline
        // a legitimate transaction outright.
        continue;
      }
      if (!result || result.intensity <= 0) continue;

      const intensity = unit(result.intensity);
      signals.push({
        id: rule.id,
        description: rule.description,
        intensity: Number(intensity.toFixed(3)),
        points: Number((rule.weight * intensity).toFixed(2)),
        evidence: result.evidence ?? {},
      });
    }

    // Saturating sum rather than a plain one: five weak signals should raise
    // an eyebrow, not add up to a block on their own.
    const raw = signals.reduce((sum, s) => sum + s.points, 0);
    const score = Math.round(100 * (1 - Math.exp(-raw / 55)));

    signals.sort((a, b) => b.points - a.points);

    return {
      score,
      decision: this.decide(score, ctx),
      signals,
      reasons: signals.map((s) => s.description),
    };
  }

  /**
   * Map a score to an action.
   *
   * A high-tier customer has already been diligenced, so the same score buys
   * them a challenge where a Tier 0 account would be held. That is not
   * leniency — it is where the KYC evidence is supposed to be spent.
   *
   * @param {number} score
   * @param {RiskContext} ctx
   * @returns {string}
   */
  decide(score, ctx) {
    const verified = ctx.user?.tier === 'tier_2' || ctx.user?.tier === 'tier_3';
    const t = this.thresholds;

    if (score >= t.block) return verified ? RiskDecision.REVIEW : RiskDecision.BLOCK;
    if (score >= t.review) return verified ? RiskDecision.STEP_UP : RiskDecision.REVIEW;
    if (score >= t.stepUp) return RiskDecision.STEP_UP;
    return RiskDecision.ALLOW;
  }
}

/** The engine this deployment runs. */
export const defaultRiskEngine = new RiskEngine();

export default RiskEngine;
