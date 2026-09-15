import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Money } from '../../../src/core/money/Money.js';
import { SimulatorRail } from '../../../src/rails/adapters/simulator.js';
import { InternalRail } from '../../../src/rails/adapters/internal.js';
import { register, clear, candidatesFor } from '../../../src/rails/registry.js';
import { RailHealth, BreakerState, healthFor, resetAllHealth } from '../../../src/rails/health.js';
import { rank, route, execute, explain, canFailOver, RoutingPolicy } from '../../../src/rails/router.js';
import { RailDirection, RailStatus, InstrumentType } from '../../../src/rails/Rail.js';
import { AppError } from '../../../src/utils/ApiError.js';

const KES = (v) => Money.of(v, 'KES');

/** A payout intent to a Kenyan mobile number. */
const payoutIntent = (amount = KES('1000.00'), overrides = {}) => ({
  direction: RailDirection.PAYOUT,
  amount,
  instrument: { type: InstrumentType.MSISDN, msisdn: '254712345678' },
  country: 'KE',
  reference: 'REF-123',
  ...overrides,
});

beforeEach(() => {
  clear();
  resetAllHealth();
});

describe('registry', () => {
  test('separates eligible rails from structurally impossible ones', () => {
    register(new SimulatorRail({ key: 'ke-rail', currencies: ['KES'], countries: ['KE'] }));
    register(new SimulatorRail({ key: 'ug-rail', currencies: ['UGX'], countries: ['UG'] }));

    const { eligible, rejected } = candidatesFor(payoutIntent());
    assert.deepEqual(eligible.map((r) => r.key), ['ke-rail']);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason, /does not settle KES|does not operate in KE/);
  });

  test('rejects anything that is not a Rail', () => {
    assert.throws(() => register({ key: 'fake' }), /expects a Rail instance/);
  });
});

describe('routing policies', () => {
  beforeEach(() => {
    // Cheap but slow, versus expensive but fast.
    register(new SimulatorRail({ key: 'cheap', feeBps: 10, etaSeconds: 3600 }));
    register(new SimulatorRail({ key: 'fast', feeBps: 300, etaSeconds: 5 }));
  });

  test('CHEAPEST picks the lower fee', async () => {
    const winner = await route(payoutIntent(), { policy: RoutingPolicy.CHEAPEST });
    assert.equal(winner.rail, 'cheap');
  });

  test('FASTEST picks the lower ETA', async () => {
    const winner = await route(payoutIntent(), { policy: RoutingPolicy.FASTEST });
    assert.equal(winner.rail, 'fast');
  });

  test('ranking exposes why a rail won', async () => {
    const { ranked } = await rank(payoutIntent(), { policy: RoutingPolicy.CHEAPEST });
    assert.equal(ranked.length, 2);
    assert.ok(ranked[0].score >= ranked[1].score, 'results are sorted by score');
    assert.deepEqual(Object.keys(ranked[0].breakdown).sort(), ['cost', 'reliability', 'speed']);
  });

  test('the fee actually differs with amount, so routing can change', async () => {
    const small = await explain(payoutIntent(KES('100.00')), { policy: RoutingPolicy.CHEAPEST });
    const large = await explain(payoutIntent(KES('100000.00')), { policy: RoutingPolicy.CHEAPEST });
    assert.notEqual(small.options[0].customerFee.minor, large.options[0].customerFee.minor);
  });

  test('`only` and `exclude` constrain the candidate set', async () => {
    const onlyFast = await route(payoutIntent(), { only: ['fast'] });
    assert.equal(onlyFast.rail, 'fast');
    const notFast = await route(payoutIntent(), { exclude: ['fast'] });
    assert.equal(notFast.rail, 'cheap');
  });
});

describe('the internal rail wins for on-platform recipients', () => {
  test('a free instant rail beats a priced one without a special case', async () => {
    register(new SimulatorRail({ key: 'mpesa-ish', feeBps: 200, etaSeconds: 30 }));
    register(
      new InternalRail({ resolveUserId: async () => 'recipient-user-id' })
    );

    const winner = await route(payoutIntent(), { policy: RoutingPolicy.BALANCED });
    assert.equal(winner.rail, 'internal');
    assert.ok(winner.quote.customerFee.isZero, 'in-network transfers are free');
    assert.equal(winner.quote.etaSeconds, 0);
  });

  test('falls back to an external rail when the recipient is not a customer', async () => {
    register(new SimulatorRail({ key: 'mpesa-ish', feeBps: 200 }));
    register(new InternalRail({ resolveUserId: async () => null }));

    const winner = await route(payoutIntent());
    assert.equal(winner.rail, 'mpesa-ish');
  });
});

describe('no route', () => {
  test('throws NO_ROUTE with the reason each rail was excluded', async () => {
    register(new SimulatorRail({ key: 'ug-only', currencies: ['UGX'], countries: ['UG'] }));
    await assert.rejects(
      () => route(payoutIntent()),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'NO_ROUTE');
        assert.equal(err.statusCode, 503);
        assert.ok(err.details.rejected.length > 0, 'explains what was ruled out');
        return true;
      }
    );
  });

  test('a rail is skipped when the amount is outside its limits', async () => {
    class Capped extends SimulatorRail {
      async quote(intent) {
        const q = await super.quote(intent);
        return { ...q, limits: { max: KES('500.00') } };
      }
    }
    register(new Capped({ key: 'capped' }));
    const { ranked, rejected } = await rank(payoutIntent(KES('10000.00')));
    assert.equal(ranked.length, 0);
    assert.match(rejected.find((r) => r.rail === 'capped').reason, /above maximum/);
  });
});

describe('circuit breaker', () => {
  test('opens after sustained failures and refuses traffic', () => {
    const health = new RailHealth('flaky', { minimumSamples: 4, failureThreshold: 0.5 });
    for (let i = 0; i < 3; i += 1) health.record(false);
    assert.equal(health.state, BreakerState.CLOSED, 'not enough samples yet');
    health.record(false);
    assert.equal(health.state, BreakerState.OPEN);
    assert.equal(health.available, false);
  });

  test('half-opens after the cooldown and closes on successful probes', () => {
    let now = 1_000_000;
    const health = new RailHealth(
      'flaky',
      { minimumSamples: 2, failureThreshold: 0.5, cooldownMs: 30_000, probesToClose: 2 },
      () => now
    );
    health.record(false);
    health.record(false);
    assert.equal(health.state, BreakerState.OPEN);

    now += 29_000;
    assert.equal(health.available, false, 'still cooling down');

    now += 2_000;
    assert.equal(health.available, true, 'a probe is allowed through');
    assert.equal(health.state, BreakerState.HALF_OPEN);

    health.record(true);
    assert.equal(health.state, BreakerState.HALF_OPEN, 'one probe is not enough');
    health.record(true);
    assert.equal(health.state, BreakerState.CLOSED);
  });

  test('a failed probe re-opens the breaker immediately', () => {
    let now = 0;
    const health = new RailHealth('flaky', { minimumSamples: 2, cooldownMs: 10 }, () => now);
    health.record(false);
    health.record(false);
    now += 20;
    assert.equal(health.available, true);
    health.record(false);
    assert.equal(health.state, BreakerState.OPEN);
  });

  test('the router routes around an open breaker', async () => {
    register(new SimulatorRail({ key: 'broken', feeBps: 0 }));
    register(new SimulatorRail({ key: 'working', feeBps: 500 }));

    const health = healthFor('broken');
    for (let i = 0; i < 20; i += 1) health.record(false);
    assert.equal(health.available, false);

    // 'broken' is free and would otherwise win outright on cost.
    const winner = await route(payoutIntent(), { policy: RoutingPolicy.CHEAPEST });
    assert.equal(winner.rail, 'working');
  });
});

describe('failover safety — the rule that prevents double payment', () => {
  test('a collection may always be retried elsewhere', () => {
    const intent = payoutIntent(KES('100.00'), { direction: RailDirection.COLLECT });
    assert.equal(canFailOver(intent, { status: RailStatus.UNKNOWN }), true);
    assert.equal(canFailOver(intent, { status: RailStatus.FAILED }), true);
  });

  test('a payout may be retried only on a definitive failure', () => {
    const intent = payoutIntent();
    assert.equal(canFailOver(intent, { status: RailStatus.FAILED }), true);
    assert.equal(canFailOver(intent, { status: RailStatus.UNKNOWN }), false);
    assert.equal(canFailOver(intent, { status: RailStatus.PROCESSING }), false);
    assert.equal(
      canFailOver(intent, { status: RailStatus.FAILED, retryable: false }),
      false,
      'a rail can veto its own retry'
    );
  });

  test('execute fails over a definitively rejected payout', async () => {
    register(new SimulatorRail({ key: 'rejects', failureRate: 1, feeBps: 0 }));
    register(new SimulatorRail({ key: 'accepts', failureRate: 0, feeBps: 500 }));

    const result = await execute(payoutIntent(), { policy: RoutingPolicy.CHEAPEST });
    assert.equal(result.event.status, RailStatus.SUCCEEDED);
    assert.equal(result.rail, 'accepts');
    assert.equal(result.attempts.length, 2, 'tried the cheap one first');
  });

  test('execute refuses to retry a payout whose outcome is unknown', async () => {
    class Hangs extends SimulatorRail {
      async payout() {
        throw new Error('socket hang up');
      }
    }
    register(new Hangs({ key: 'hangs', feeBps: 0 }));
    register(new SimulatorRail({ key: 'healthy', feeBps: 500 }));

    await assert.rejects(
      () => execute(payoutIntent(), { policy: RoutingPolicy.CHEAPEST }),
      (err) => {
        assert.equal(err.code, 'PAYOUT_INDETERMINATE');
        assert.match(err.message, /queued for reconciliation/);
        return true;
      }
    );
  });

  test('a thrown collection IS retried on another rail', async () => {
    class Hangs extends SimulatorRail {
      async collect() {
        throw new Error('socket hang up');
      }
    }
    register(new Hangs({ key: 'hangs', feeBps: 0 }));
    register(new SimulatorRail({ key: 'healthy', feeBps: 500 }));

    const intent = payoutIntent(KES('100.00'), { direction: RailDirection.COLLECT });
    const result = await execute(intent, { policy: RoutingPolicy.CHEAPEST });
    assert.equal(result.rail, 'healthy');
  });

  test('failed attempts feed the breaker', async () => {
    register(new SimulatorRail({ key: 'rejects', failureRate: 1, feeBps: 0 }));
    register(new SimulatorRail({ key: 'accepts', failureRate: 0, feeBps: 500 }));

    for (let i = 0; i < 10; i += 1) {
      await execute(payoutIntent(), { policy: RoutingPolicy.CHEAPEST });
    }
    assert.equal(healthFor('rejects').available, false, 'the failing rail was taken out');
  });

  test('gives up once every rail has been tried', async () => {
    register(new SimulatorRail({ key: 'a', failureRate: 1 }));
    register(new SimulatorRail({ key: 'b', failureRate: 1 }));

    await assert.rejects(
      () => execute(payoutIntent(), { maxAttempts: 5 }),
      (err) => {
        // Either every rail was exhausted, or the breakers opened first —
        // both are correct refusals to keep hammering a broken provider.
        assert.ok(['ALL_RAILS_FAILED', 'NO_ROUTE'].includes(err.code), err.code);
        return true;
      }
    );
  });
});

describe('quote resilience', () => {
  test('a rail that throws while quoting is excluded, not fatal', async () => {
    class Broken extends SimulatorRail {
      async quote() {
        throw new Error('provider exploded');
      }
    }
    register(new Broken({ key: 'broken' }));
    register(new SimulatorRail({ key: 'fine' }));

    const { ranked, rejected } = await rank(payoutIntent());
    assert.deepEqual(ranked.map((r) => r.rail), ['fine']);
    assert.match(rejected.find((r) => r.rail === 'broken').reason, /quote failed/);
  });

  test('explain renders a customer-facing comparison', async () => {
    register(new SimulatorRail({ key: 'a', feeBps: 100, etaSeconds: 10 }));
    register(new SimulatorRail({ key: 'b', feeBps: 200, etaSeconds: 5 }));

    const result = await explain(payoutIntent(KES('1000.00')));
    assert.equal(result.options.length, 2);
    assert.equal(result.amount.amount, '1000.00');
    assert.ok(result.chosen);
    for (const option of result.options) {
      assert.ok(option.customerFee.amount, 'every option is priced');
      assert.equal(typeof option.etaSeconds, 'number');
    }
  });
});
