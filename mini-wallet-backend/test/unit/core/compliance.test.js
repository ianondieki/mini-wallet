import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Money } from '../../../src/core/money/Money.js';
import { FeeSchedule, defaultFeeSchedule } from '../../../src/core/fees/FeeSchedule.js';
import {
  KycTier,
  checkLimits,
  limitsFor,
  tierAtLeast,
  tierRequiredFor,
} from '../../../src/core/limits/tiers.js';
import { RiskEngine, RiskDecision, defaultRiskEngine } from '../../../src/core/risk/engine.js';

const KES = (v) => Money.of(v, 'KES');

describe('FeeSchedule', () => {
  test('first matching rule wins, like a routing table', () => {
    const schedule = new FeeSchedule([
      { id: 'promo', flow: 'payout', maxAmount: '100', fixed: '0' },
      { id: 'standard', flow: 'payout', fixed: '50' },
    ]);
    assert.equal(schedule.quote({ flow: 'payout', amount: KES('50') }).ruleId, 'promo');
    assert.equal(schedule.quote({ flow: 'payout', amount: KES('500') }).ruleId, 'standard');
  });

  test('charges fixed plus basis points', () => {
    const schedule = new FeeSchedule([{ id: 'r', flow: 'payout', fixed: '10.00', bps: 150 }]);
    // 10.00 + 1.5% of 1,000.00 = 25.00
    assert.equal(schedule.quote({ flow: 'payout', amount: KES('1000.00') }).fee.toDecimal(), '25.00');
  });

  test('clamps to a floor and a ceiling', () => {
    const schedule = new FeeSchedule([
      { id: 'capped', flow: 'payout', bps: 100, min: '20.00', max: '150.00' },
    ]);
    assert.equal(schedule.quote({ flow: 'payout', amount: KES('100.00') }).fee.toDecimal(), '20.00');
    assert.equal(schedule.quote({ flow: 'payout', amount: KES('5000.00') }).fee.toDecimal(), '50.00');
    assert.equal(schedule.quote({ flow: 'payout', amount: KES('900000.00') }).fee.toDecimal(), '150.00');
  });

  test('a missing rule means free, never an invented charge', () => {
    const quote = new FeeSchedule([]).quote({ flow: 'payout', amount: KES('100') });
    assert.ok(quote.fee.isZero);
    assert.equal(quote.ruleId, null);
  });

  test('pass-through rules charge exactly what the rail charged us', () => {
    const schedule = new FeeSchedule([{ id: 'pt', flow: 'payout', passThroughRailCost: true }]);
    const quote = schedule.quote({ flow: 'payout', amount: KES('1000'), railCost: KES('37.00') });
    assert.equal(quote.fee.toDecimal(), '37.00');
    assert.equal(quote.breakdown.passThrough, true);
  });

  test('every charge is explainable down to the arithmetic', () => {
    const quote = defaultFeeSchedule.quote({ flow: 'payout', amount: KES('10000.00') });
    assert.ok(quote.ruleId, 'a rule is always named');
    assert.equal(quote.breakdown.bps, 100);
    assert.equal(quote.breakdown.variable.amount, '100.00');
    assert.equal(quote.breakdown.total.amount, quote.fee.toDecimal());
  });

  test('the default tariff makes in-network transfers free', () => {
    assert.ok(defaultFeeSchedule.quote({ flow: 'transfer', amount: KES('50000') }).fee.isZero);
    assert.ok(defaultFeeSchedule.quote({ flow: 'deposit', amount: KES('50000') }).fee.isZero);
  });

  test('the withdrawal cap actually binds on large amounts', () => {
    const big = defaultFeeSchedule.quote({ flow: 'payout', amount: KES('250000.00') });
    assert.equal(big.fee.toDecimal(), '150.00', '1% would be 2,500 — the cap holds');
  });

  test('rejects duplicate or unidentified rules', () => {
    assert.throws(() => new FeeSchedule([{ flow: 'x' }]), /needs an id/);
    assert.throws(() => new FeeSchedule([{ id: 'a' }, { id: 'a' }]), /Duplicate fee rule/);
  });

  test('publishes a human-readable tariff', () => {
    const published = defaultFeeSchedule.publish('KES');
    assert.ok(published.length > 0);
    for (const row of published) {
      assert.ok(row.id && row.applies, 'every published row is complete');
    }
  });
});

describe('KYC tiers and limits', () => {
  const usage = (over = {}) => ({
    daily: KES('0'),
    monthly: KES('0'),
    balance: KES('0'),
    ...over,
  });

  test('a normal transaction inside every limit is allowed', () => {
    const result = checkLimits({
      tier: KycTier.TIER_1,
      flow: 'payout',
      amount: KES('5000'),
      usage: usage(),
    });
    assert.equal(result.allowed, true);
    assert.deepEqual(result.violations, []);
  });

  test('enforces the per-transaction ceiling and names the tier that would allow it', () => {
    const result = checkLimits({
      tier: KycTier.TIER_0,
      flow: 'payout',
      amount: KES('20000'),
      usage: usage(),
    });
    assert.equal(result.allowed, false);
    const violation = result.violations.find((v) => v.limit === 'perTransaction');
    assert.ok(violation);
    assert.equal(violation.upgradeTo, KycTier.TIER_1);
  });

  test('enforces the rolling daily limit and reports the headroom left', () => {
    const result = checkLimits({
      tier: KycTier.TIER_0,
      flow: 'payout',
      amount: KES('4000'),
      usage: usage({ daily: KES('8000') }),
    });
    assert.equal(result.allowed, false);
    const violation = result.violations.find((v) => v.limit === 'daily');
    assert.equal(violation.available.toDecimal(), '2000.00');
    assert.match(violation.message, /2,000/);
  });

  test('enforces the rolling 30-day limit', () => {
    const result = checkLimits({
      tier: KycTier.TIER_0,
      flow: 'payout',
      amount: KES('2000'),
      usage: usage({ monthly: KES('29000') }),
    });
    assert.ok(result.violations.some((v) => v.limit === 'monthly'));
  });

  test('a deposit is checked against the balance cap, not the spend caps', () => {
    const result = checkLimits({
      tier: KycTier.TIER_0,
      flow: 'deposit',
      amount: KES('5000'),
      usage: usage({ balance: KES('24000'), daily: KES('9999') }),
      inbound: true,
    });
    const violation = result.violations.find((v) => v.limit === 'maxBalance');
    assert.ok(violation, 'the balance cap binds');
    assert.equal(violation.available.toDecimal(), '1000.00');
    assert.ok(!result.violations.some((v) => v.limit === 'daily'), 'spend caps do not apply inbound');
  });

  test('reports every violation at once rather than one at a time', () => {
    const result = checkLimits({
      tier: KycTier.TIER_0,
      flow: 'payout',
      amount: KES('9000'),
      usage: usage({ daily: KES('9000'), monthly: KES('29000') }),
    });
    const hit = result.violations.map((v) => v.limit).sort();
    assert.deepEqual(hit, ['daily', 'monthly', 'perTransaction']);
  });

  test('an unknown tier fails closed to the most restrictive limits', () => {
    const rogue = checkLimits({
      tier: 'tier_platinum_unlimited',
      flow: 'payout',
      amount: KES('20000'),
      usage: usage(),
    });
    assert.equal(rogue.allowed, false, 'an unrecognised tier must not be privileged');
  });

  test('tier comparison and lookup behave', () => {
    assert.ok(tierAtLeast(KycTier.TIER_2, KycTier.TIER_1));
    assert.ok(!tierAtLeast(KycTier.TIER_0, KycTier.TIER_1));
    assert.equal(tierRequiredFor(KES('1000')), KycTier.TIER_0);
    assert.equal(tierRequiredFor(KES('200000')), KycTier.TIER_2);
    assert.equal(limitsFor(KycTier.TIER_2, 'KES').perTransaction.toDecimal(), '250000.00');
  });

  test('an unconfigured currency is refused rather than silently unlimited', () => {
    assert.throws(() => limitsFor(KycTier.TIER_1, 'GHS'), /No GHS limits configured/);
  });
});

describe('risk engine', () => {
  /** A long-standing customer doing something ordinary. */
  const baseline = (over = {}) => ({
    user: {
      createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
      tier: KycTier.TIER_1,
    },
    flow: 'transfer',
    amount: KES('2500'),
    balanceBefore: KES('40000'),
    counterparty: { id: 'payee-1', isNew: false, distinctSenders7d: 2 },
    history: {
      count24h: 2,
      averageAmount: KES('3000'),
      distinctRecipients24h: 1,
      inboundLast1h: Money.zero('KES'),
      daysSinceLastActivity: 1,
    },
    device: { isNew: false },
    at: new Date('2026-03-04T14:00:00+03:00'),
    ...over,
  });

  test('ordinary activity is allowed and scores near zero', () => {
    const result = defaultRiskEngine.assess(baseline());
    assert.equal(result.decision, RiskDecision.ALLOW);
    assert.ok(result.score < 10, `expected a low score, got ${result.score}`);
    assert.deepEqual(result.signals, [], 'nothing should fire on a normal transfer');
  });

  test('detects the pass-through mule pattern', () => {
    const result = defaultRiskEngine.assess(
      baseline({
        amount: KES('98000'),
        balanceBefore: KES('100000'),
        history: { ...baseline().history, inboundLast1h: KES('100000') },
      })
    );
    const signal = result.signals.find((s) => s.id === 'pass_through');
    assert.ok(signal, 'pass-through should fire');
    assert.equal(signal.evidence.emptiesAccount, true);
    assert.notEqual(result.decision, RiskDecision.ALLOW);
  });

  test('detects structuring just under the reporting threshold', () => {
    const result = defaultRiskEngine.assess(
      baseline({ amount: KES('985000'), balanceBefore: KES('2000000'), history: { ...baseline().history, count24h: 4 } })
    );
    const signal = result.signals.find((s) => s.id === 'structuring');
    assert.ok(signal, 'structuring should fire at 98.5% of the threshold');
    assert.ok(signal.evidence.percentOfThreshold > 90);
  });

  test('does not call a transaction over the threshold structuring', () => {
    const result = defaultRiskEngine.assess(
      baseline({ amount: KES('1200000'), balanceBefore: KES('2000000') })
    );
    assert.ok(
      !result.signals.some((s) => s.id === 'structuring'),
      'above the threshold is reported, not structured'
    );
  });

  test('detects a mule collection account by fan-in', () => {
    const result = defaultRiskEngine.assess(
      baseline({ counterparty: { id: 'payee-x', isNew: true, distinctSenders7d: 45 } })
    );
    assert.ok(result.signals.some((s) => s.id === 'mule_fan_in'));
  });

  test('detects velocity spikes and fan-out', () => {
    const result = defaultRiskEngine.assess(
      baseline({ history: { ...baseline().history, count24h: 30, distinctRecipients24h: 25 } })
    );
    const ids = result.signals.map((s) => s.id);
    assert.ok(ids.includes('velocity_spike'));
    assert.ok(ids.includes('fan_out'));
  });

  test('a brand new account moving real money is flagged', () => {
    const result = defaultRiskEngine.assess(
      baseline({
        user: { createdAt: new Date(), tier: KycTier.TIER_0 },
        amount: KES('150000'),
        balanceBefore: KES('200000'),
      })
    );
    assert.ok(result.signals.some((s) => s.id === 'new_account_high_value'));
    assert.notEqual(result.decision, RiskDecision.ALLOW);
  });

  test('a weak signal alone never blocks', () => {
    const result = defaultRiskEngine.assess(
      baseline({ at: new Date('2026-03-04T03:00:00+03:00') })
    );
    assert.ok(result.signals.some((s) => s.id === 'odd_hour'));
    assert.equal(result.decision, RiskDecision.ALLOW, 'an odd hour on its own is not suspicious');
  });

  test('verified customers get friction where unverified ones get held', () => {
    const damning = {
      amount: KES('99000'),
      balanceBefore: KES('100000'),
      counterparty: { id: 'x', isNew: true, distinctSenders7d: 60 },
      history: {
        count24h: 35,
        averageAmount: KES('500'),
        distinctRecipients24h: 28,
        inboundLast1h: KES('100000'),
        daysSinceLastActivity: 200,
      },
      device: { isNew: true, ipChangedCountry: true },
      at: new Date('2026-03-04T03:00:00+03:00'),
    };

    const unverified = defaultRiskEngine.assess(
      baseline({ ...damning, user: { createdAt: new Date(), tier: KycTier.TIER_0 } })
    );
    const verified = defaultRiskEngine.assess(
      baseline({ ...damning, user: { createdAt: new Date(), tier: KycTier.TIER_3 } })
    );

    assert.equal(unverified.decision, RiskDecision.BLOCK);
    assert.equal(verified.decision, RiskDecision.REVIEW, 'diligence buys a review, not a block');
    assert.ok(unverified.score >= 82);
  });

  test('every decision is explainable', () => {
    const result = defaultRiskEngine.assess(
      baseline({
        amount: KES('98000'),
        balanceBefore: KES('100000'),
        history: { ...baseline().history, inboundLast1h: KES('100000'), count24h: 15 },
      })
    );
    assert.ok(result.reasons.length > 0);
    for (const signal of result.signals) {
      assert.ok(signal.description, 'each signal explains itself');
      assert.ok(signal.points > 0);
      assert.ok(signal.intensity > 0 && signal.intensity <= 1);
    }
    // Ordered by contribution, so the top reason is the real one.
    const points = result.signals.map((s) => s.points);
    assert.deepEqual(points, [...points].sort((a, b) => b - a));
  });

  test('a rule that throws is skipped, not fatal', () => {
    const engine = new RiskEngine([
      { id: 'explodes', weight: 50, description: 'boom', evaluate() { throw new Error('boom'); } },
      { id: 'fine', weight: 10, description: 'ok', evaluate() { return { intensity: 1 }; } },
    ]);
    const result = engine.assess(baseline());
    assert.deepEqual(result.signals.map((s) => s.id), ['fine']);
  });

  test('scoring saturates so weak signals cannot stack into a block', () => {
    const engine = new RiskEngine(
      Array.from({ length: 12 }, (_, i) => ({
        id: `weak_${i}`,
        weight: 8,
        description: 'weak signal',
        evaluate: () => ({ intensity: 0.3 }),
      }))
    );
    const result = engine.assess(baseline());
    assert.ok(result.score < 82, `twelve weak signals should not block, scored ${result.score}`);
  });
});
