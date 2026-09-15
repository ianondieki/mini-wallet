import { Money } from '../money/Money.js';

/**
 * KYC tiers and transaction limits.
 *
 * ## Why limits are a core concern, not a feature
 *
 * A stored-value provider is only permitted to hold customer funds under
 * limits tied to how well it knows the customer. In Kenya that is CBK's
 * risk-based tiering; the EU, Nigeria and India all have the same structure
 * with different numbers. A wallet without enforced tier limits is not a
 * cautious product — it is an unlicensable one.
 *
 * The tiering also solves a genuine product problem: demanding a passport
 * before someone can hold 500 shillings loses the customer. Tiers let
 * onboarding be instant and cheap at low value, and ask for more only when
 * the customer's own usage makes it necessary.
 *
 * ## Numbers
 *
 * The defaults below are shaped on Kenya's published mobile-money thresholds
 * and are **indicative**. They are configuration, not constants, because they
 * change by regulation and by the licence a given deployment holds — override
 * them with the limits in your own licence before going live.
 */

/**
 * @readonly
 * @enum {string}
 */
export const KycTier = Object.freeze({
  /** Phone number only. Enough to receive and spend small amounts. */
  TIER_0: 'tier_0',
  /** Government ID captured and matched. */
  TIER_1: 'tier_1',
  /** ID plus proof of address, verified. */
  TIER_2: 'tier_2',
  /** Enhanced due diligence — businesses, high value, source-of-funds evidence. */
  TIER_3: 'tier_3',
});

/** Tier ordering, for "is at least" comparisons. */
export const TIER_ORDER = Object.freeze([
  KycTier.TIER_0,
  KycTier.TIER_1,
  KycTier.TIER_2,
  KycTier.TIER_3,
]);

/**
 * Limits per tier, in major units, keyed by currency.
 *
 * - `perTransaction` — single-transaction ceiling.
 * - `daily` — rolling 24-hour outbound total.
 * - `monthly` — rolling 30-day outbound total.
 * - `maxBalance` — the most the customer may hold at rest.
 */
export const TIER_LIMITS = Object.freeze({
  [KycTier.TIER_0]: {
    label: 'Basic (phone verified)',
    requirements: ['Verified phone number'],
    KES: { perTransaction: '5000', daily: '10000', monthly: '30000', maxBalance: '25000' },
    USD: { perTransaction: '40', daily: '80', monthly: '250', maxBalance: '200' },
    allowedFlows: ['deposit', 'transfer', 'payout'],
  },
  [KycTier.TIER_1]: {
    label: 'Verified (ID)',
    requirements: ['Government ID', 'Selfie liveness match'],
    KES: { perTransaction: '150000', daily: '300000', monthly: '1000000', maxBalance: '300000' },
    USD: { perTransaction: '1200', daily: '2400', monthly: '8000', maxBalance: '2400' },
    allowedFlows: ['deposit', 'transfer', 'payout', 'fx'],
  },
  [KycTier.TIER_2]: {
    label: 'Full (ID + address)',
    requirements: ['Government ID', 'Selfie liveness match', 'Proof of address'],
    KES: { perTransaction: '250000', daily: '500000', monthly: '3000000', maxBalance: '500000' },
    USD: { perTransaction: '2000', daily: '4000', monthly: '24000', maxBalance: '4000' },
    allowedFlows: ['deposit', 'transfer', 'payout', 'fx'],
  },
  [KycTier.TIER_3]: {
    label: 'Enhanced (business / high value)',
    requirements: [
      'Registration documents',
      'Beneficial ownership',
      'Source of funds evidence',
      'Enhanced due diligence review',
    ],
    KES: { perTransaction: '2000000', daily: '5000000', monthly: '50000000', maxBalance: '10000000' },
    USD: { perTransaction: '16000', daily: '40000', monthly: '400000', maxBalance: '80000' },
    allowedFlows: ['deposit', 'transfer', 'payout', 'fx'],
  },
});

/**
 * Resolve a tier's limits in a currency, falling back to the lowest tier for
 * an unknown tier. Failing *closed* matters: an unrecognised tier must get
 * the most restrictive treatment, never the most permissive.
 *
 * @param {string} tier
 * @param {string} currency
 * @returns {{perTransaction: Money, daily: Money, monthly: Money, maxBalance: Money, allowedFlows: string[], label: string}}
 */
export const limitsFor = (tier, currency) => {
  const config = TIER_LIMITS[tier] ?? TIER_LIMITS[KycTier.TIER_0];
  const amounts = config[currency];
  if (!amounts) {
    throw new RangeError(
      `No ${currency} limits configured for ${tier}. Add them to TIER_LIMITS before ` +
        'enabling this currency.'
    );
  }
  return {
    label: config.label,
    allowedFlows: config.allowedFlows,
    perTransaction: Money.of(amounts.perTransaction, currency),
    daily: Money.of(amounts.daily, currency),
    monthly: Money.of(amounts.monthly, currency),
    maxBalance: Money.of(amounts.maxBalance, currency),
  };
};

/** True when `tier` is at least `required`. */
export const tierAtLeast = (tier, required) =>
  TIER_ORDER.indexOf(tier) >= TIER_ORDER.indexOf(required);

/**
 * The lowest tier that would permit an amount — what the "upgrade to send
 * this" prompt is built from.
 *
 * @param {Money} amount
 * @returns {string|null}
 */
export const tierRequiredFor = (amount) => {
  for (const tier of TIER_ORDER) {
    try {
      if (amount.lessThanOrEqual(limitsFor(tier, amount.currency).perTransaction)) return tier;
    } catch {
      return null; // currency not configured for this tier
    }
  }
  return null;
};

/**
 * @typedef {object} LimitUsage
 * @property {Money} daily     Outbound total in the last 24 hours.
 * @property {Money} monthly   Outbound total in the last 30 days.
 * @property {Money} balance   Current balance, before this transaction.
 */

/**
 * @typedef {object} LimitViolation
 * @property {string} limit     Which limit was hit.
 * @property {Money}  cap
 * @property {Money}  used
 * @property {Money}  attempted
 * @property {Money}  available
 * @property {string} message   Customer-safe explanation.
 * @property {string} [upgradeTo] Tier that would permit it.
 */

/**
 * Check a transaction against a customer's tier.
 *
 * Returns **every** violation rather than the first, so the customer is told
 * once what is wrong instead of discovering it one rejection at a time.
 *
 * @param {object} params
 * @param {string} params.tier
 * @param {string} params.flow
 * @param {Money}  params.amount        Amount leaving the customer (or arriving, for deposits).
 * @param {LimitUsage} params.usage
 * @param {boolean} [params.inbound]    True for deposits — checks the balance cap, not the spend caps.
 * @returns {{allowed: boolean, violations: LimitViolation[], remaining: object, tier: string}}
 */
export const checkLimits = ({ tier, flow, amount, usage, inbound = false }) => {
  const currency = amount.currency;
  const limits = limitsFor(tier, currency);
  /** @type {LimitViolation[]} */
  const violations = [];

  if (!limits.allowedFlows.includes(flow)) {
    violations.push({
      limit: 'flow',
      cap: Money.zero(currency),
      used: Money.zero(currency),
      attempted: amount,
      available: Money.zero(currency),
      message: `${limits.label} accounts cannot use ${flow}`,
      upgradeTo: TIER_ORDER.find((t) => TIER_LIMITS[t].allowedFlows.includes(flow)),
    });
  }

  if (amount.greaterThan(limits.perTransaction)) {
    violations.push({
      limit: 'perTransaction',
      cap: limits.perTransaction,
      used: Money.zero(currency),
      attempted: amount,
      available: limits.perTransaction,
      message: `Single transactions are capped at ${limits.perTransaction.format()} on your account`,
      upgradeTo: tierRequiredFor(amount) ?? undefined,
    });
  }

  if (inbound) {
    // A deposit is limited by how much the customer is allowed to hold, not
    // by their spending caps.
    const resulting = usage.balance.plus(amount);
    if (resulting.greaterThan(limits.maxBalance)) {
      const headroom = Money.max(limits.maxBalance.minus(usage.balance), Money.zero(currency));
      violations.push({
        limit: 'maxBalance',
        cap: limits.maxBalance,
        used: usage.balance,
        attempted: amount,
        available: headroom,
        message: `Your balance cannot exceed ${limits.maxBalance.format()}. You can add up to ${headroom.format()}.`,
        upgradeTo: TIER_ORDER.find(
          (t) => t !== tier && limitsFor(t, currency).maxBalance.greaterThanOrEqual(resulting)
        ),
      });
    }
  } else {
    const daily = usage.daily.plus(amount);
    if (daily.greaterThan(limits.daily)) {
      const headroom = Money.max(limits.daily.minus(usage.daily), Money.zero(currency));
      violations.push({
        limit: 'daily',
        cap: limits.daily,
        used: usage.daily,
        attempted: amount,
        available: headroom,
        message: `That would exceed your daily limit of ${limits.daily.format()}. You have ${headroom.format()} left today.`,
      });
    }

    const monthly = usage.monthly.plus(amount);
    if (monthly.greaterThan(limits.monthly)) {
      const headroom = Money.max(limits.monthly.minus(usage.monthly), Money.zero(currency));
      violations.push({
        limit: 'monthly',
        cap: limits.monthly,
        used: usage.monthly,
        attempted: amount,
        available: headroom,
        message: `That would exceed your 30-day limit of ${limits.monthly.format()}. You have ${headroom.format()} left.`,
      });
    }
  }

  return {
    allowed: violations.length === 0,
    violations,
    tier,
    remaining: {
      perTransaction: limits.perTransaction.toJSON(),
      daily: Money.max(limits.daily.minus(usage.daily), Money.zero(currency)).toJSON(),
      monthly: Money.max(limits.monthly.minus(usage.monthly), Money.zero(currency)).toJSON(),
      balanceHeadroom: Money.max(
        limits.maxBalance.minus(usage.balance),
        Money.zero(currency)
      ).toJSON(),
    },
  };
};

export default { KycTier, TIER_LIMITS, limitsFor, checkLimits, tierAtLeast, tierRequiredFor };
