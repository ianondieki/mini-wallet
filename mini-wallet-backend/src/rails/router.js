import { Money } from '../core/money/Money.js';
import { RailDirection, RailStatus, isTerminal } from './Rail.js';
import { candidatesFor, get as getRail } from './registry.js';
import { healthFor } from './health.js';
import { AppError } from '../utils/ApiError.js';
import { logger } from '../config/logger.js';

/**
 * Smart routing — choosing which rail carries a given payment.
 *
 * With one integration there is no decision to make. With several there is,
 * and it is worth real money: the cheapest rail for a 50-shilling payout is
 * rarely the cheapest for a 500,000-shilling one, an instant rail is worth
 * paying for on a withdrawal and worthless on a scheduled disbursement, and a
 * rail that is currently failing is worth nothing at any price.
 *
 * So every candidate rail is quoted in parallel and scored on cost, speed and
 * observed reliability, weighted by a policy. This is least-cost routing, the
 * same mechanism aggregators like Thunes and Onafriq sell as their core
 * product, and it is only possible because {@link Rail} made the rails
 * interchangeable.
 *
 * ## Failover has a hard safety rule
 *
 * Retrying a *collection* on another rail is harmless — worst case the
 * customer is asked twice and pays once. Retrying a *payout* is not: if the
 * first rail actually sent the money and merely failed to tell us, a retry
 * pays twice and the second payment is unrecoverable.
 *
 * Failover on a payout is therefore permitted **only** when the rail returned
 * a definitively terminal failure. A timeout, a 502, or any `UNKNOWN` state
 * means we do not know whether value moved, and the transfer is parked for
 * reconciliation instead of retried. Losing a few seconds is recoverable;
 * double-paying is not.
 */

/**
 * Routing policies as scoring weights. Each weight is a preference, not a
 * hard constraint — a policy never forces a broken rail to be chosen.
 * @readonly
 */
export const RoutingPolicy = Object.freeze({
  /** Minimise what the customer pays. Default for large, unhurried payouts. */
  CHEAPEST: { cost: 0.7, speed: 0.1, reliability: 0.2 },
  /** Minimise time to settlement. Default for withdrawals. */
  FASTEST: { cost: 0.1, speed: 0.7, reliability: 0.2 },
  /** Favour the rail most likely to work first time. */
  MOST_RELIABLE: { cost: 0.15, speed: 0.15, reliability: 0.7 },
  /** Sensible default. */
  BALANCED: { cost: 0.4, speed: 0.3, reliability: 0.3 },
});

/** Give up on a quote that takes longer than this. */
const QUOTE_TIMEOUT_MS = 3_000;

/**
 * Normalise values to 0..1 where 1 is best (lowest input).
 * A single candidate, or an all-equal set, scores 1 across the board rather
 * than dividing by zero.
 *
 * @param {number[]} values
 * @returns {number[]}
 */
const normaliseLowerIsBetter = (values) => {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!Number.isFinite(min) || max === min) return values.map(() => 1);
  return values.map((v) => 1 - (v - min) / (max - min));
};

/**
 * Race a promise against a timeout, resolving to `fallback` if it loses.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {T} fallback
 * @returns {Promise<T>}
 */
const withTimeout = (promise, ms, fallback) =>
  Promise.race([
    promise,
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(fallback), ms);
      t.unref?.();
    }),
  ]);

/**
 * Quote every eligible, healthy rail and rank them.
 *
 * @param {import('./Rail.js').PaymentIntent} intent
 * @param {object} [options]
 * @param {object} [options.policy]     A {@link RoutingPolicy} member.
 * @param {string[]} [options.only]     Restrict to these rail keys.
 * @param {string[]} [options.exclude]  Never consider these rail keys.
 * @returns {Promise<{ranked: object[], rejected: object[]}>}
 */
export const rank = async (intent, { policy = RoutingPolicy.BALANCED, only, exclude = [] } = {}) => {
  const { eligible, rejected } = candidatesFor(intent);

  const considered = eligible.filter((rail) => {
    if (only && !only.includes(rail.key)) {
      rejected.push({ rail: rail.key, reason: 'not in the requested rail set' });
      return false;
    }
    if (exclude.includes(rail.key)) {
      rejected.push({ rail: rail.key, reason: 'excluded for this attempt' });
      return false;
    }
    if (!healthFor(rail.key).available) {
      rejected.push({ rail: rail.key, reason: 'circuit breaker is open' });
      return false;
    }
    return true;
  });

  // Quote in parallel: one slow provider must not hold up the decision.
  const quotes = await Promise.all(
    considered.map(async (rail) => {
      try {
        const quote = await withTimeout(
          Promise.resolve(rail.quote(intent)),
          QUOTE_TIMEOUT_MS,
          rail.unsupported('quote timed out')
        );
        return { rail, quote };
      } catch (err) {
        logger.warn('Rail quote failed', { rail: rail.key, message: err.message });
        return { rail, quote: rail.unsupported(`quote failed: ${err.message}`) };
      }
    })
  );

  const usable = [];
  for (const { rail, quote } of quotes) {
    if (!quote.supported) {
      rejected.push({ rail: rail.key, reason: quote.reason ?? 'unsupported' });
      continue;
    }
    // A quote that prices outside its own limits is not a real option.
    const limits = quote.limits ?? {};
    if (limits.min && intent.amount.lessThan(limits.min)) {
      rejected.push({ rail: rail.key, reason: `below minimum of ${limits.min}` });
      continue;
    }
    if (limits.max && intent.amount.greaterThan(limits.max)) {
      rejected.push({ rail: rail.key, reason: `above maximum of ${limits.max}` });
      continue;
    }
    usable.push({ rail, quote });
  }

  if (usable.length === 0) return { ranked: [], rejected };

  // Blend the rail's own claimed success rate with what we have actually
  // observed. A provider's marketing number loses to our measurement.
  const health = usable.map(({ rail }) => healthFor(rail.key));
  const costs = usable.map(({ quote }) =>
    quote.customerFee ? quote.customerFee.minor : (quote.railCost?.minor ?? 0)
  );
  const etas = usable.map(({ quote }, i) => {
    const observed = health[i].averageLatencyMs / 1000;
    return observed > 0 ? (quote.etaSeconds + observed) / 2 : quote.etaSeconds;
  });

  const costScores = normaliseLowerIsBetter(costs);
  const speedScores = normaliseLowerIsBetter(etas);

  const ranked = usable
    .map(({ rail, quote }, i) => {
      const reliability = Math.min(quote.successRate ?? 1, health[i].successRate);
      const score =
        policy.cost * costScores[i] +
        policy.speed * speedScores[i] +
        policy.reliability * reliability;
      return {
        rail: rail.key,
        adapter: rail,
        quote,
        score: Number(score.toFixed(6)),
        breakdown: {
          cost: Number(costScores[i].toFixed(4)),
          speed: Number(speedScores[i].toFixed(4)),
          reliability: Number(reliability.toFixed(4)),
        },
      };
    })
    .sort((a, b) => b.score - a.score);

  return { ranked, rejected };
};

/**
 * Pick the single best rail for an intent.
 *
 * @param {import('./Rail.js').PaymentIntent} intent
 * @param {object} [options]  As {@link rank}.
 * @returns {Promise<object>} The winning ranked entry.
 * @throws {AppError} NO_ROUTE when nothing can carry it.
 */
export const route = async (intent, options = {}) => {
  const { ranked, rejected } = await rank(intent, options);
  if (ranked.length === 0) {
    throw new AppError(
      'No payment rail can currently handle this transfer',
      503,
      'NO_ROUTE',
      { rejected }
    );
  }
  const [winner, ...rest] = ranked;
  logger.info('Rail selected', {
    rail: winner.rail,
    score: winner.score,
    breakdown: winner.breakdown,
    alternatives: rest.map((r) => `${r.rail}:${r.score}`),
  });
  return winner;
};

/**
 * Decide whether a failed attempt may be retried on another rail.
 *
 * @param {import('./Rail.js').PaymentIntent} intent
 * @param {{ status?: string, retryable?: boolean }} outcome
 * @returns {boolean}
 */
export const canFailOver = (intent, outcome) => {
  // Collections are safe to retry: the customer is simply asked again.
  if (intent.direction === RailDirection.COLLECT) return true;

  // Payouts may only be retried when the rail was explicit that nothing
  // moved. Anything ambiguous is left for reconciliation.
  return outcome?.status === RailStatus.FAILED && outcome?.retryable !== false;
};

/**
 * Route and execute, failing over where it is safe to do so.
 *
 * Health is recorded for every attempt, so repeated failures here are what
 * eventually open a rail's breaker and take it out of rotation.
 *
 * @param {import('./Rail.js').PaymentIntent} intent
 * @param {object} [options]
 * @param {object} [options.policy]
 * @param {number} [options.maxAttempts]
 * @returns {Promise<{event: import('./Rail.js').RailEvent, rail: string, quote: object, attempts: object[]}>}
 */
export const execute = async (intent, { policy, maxAttempts = 3 } = {}) => {
  const tried = [];
  const attempts = [];

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const choice = await route(intent, { policy, exclude: tried });
    const health = healthFor(choice.rail);
    const startedAt = Date.now();
    tried.push(choice.rail);

    try {
      const event =
        intent.direction === RailDirection.COLLECT
          ? await choice.adapter.collect(intent)
          : await choice.adapter.payout(intent);

      const latency = Date.now() - startedAt;
      const failed = event.status === RailStatus.FAILED;
      health.record(!failed, latency);
      attempts.push({ rail: choice.rail, status: event.status, latencyMs: latency });

      if (!failed) {
        return { event, rail: choice.rail, quote: choice.quote, attempts };
      }
      if (!canFailOver(intent, event)) {
        return { event, rail: choice.rail, quote: choice.quote, attempts };
      }
      logger.warn('Rail rejected the transfer — failing over', {
        rail: choice.rail,
        reason: event.failureReason,
      });
    } catch (err) {
      const latency = Date.now() - startedAt;
      health.record(false, latency);
      attempts.push({ rail: choice.rail, error: err.message, latencyMs: latency });

      // A thrown error on a payout means we never got a verdict. We do not
      // know whether money moved, so we must not send it again.
      if (!canFailOver(intent, { status: RailStatus.UNKNOWN })) {
        throw new AppError(
          'Payout outcome is unknown and cannot be safely retried; it has been ' +
            'queued for reconciliation.',
          502,
          'PAYOUT_INDETERMINATE',
          { rail: choice.rail, attempts, cause: err.message }
        );
      }
      logger.warn('Rail attempt threw — failing over', {
        rail: choice.rail,
        message: err.message,
      });
    }
  }

  throw new AppError('Every available rail failed', 502, 'ALL_RAILS_FAILED', { attempts });
};

/**
 * Human-readable comparison of the options for an amount — powers the
 * "why this fee?" breakdown in the client.
 *
 * @param {import('./Rail.js').PaymentIntent} intent
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export const explain = async (intent, options = {}) => {
  const { ranked, rejected } = await rank(intent, options);
  return {
    amount: intent.amount.toJSON(),
    direction: intent.direction,
    chosen: ranked[0]?.rail ?? null,
    options: ranked.map((r) => ({
      rail: r.rail,
      displayName: r.adapter.displayName,
      customerFee: r.quote.customerFee?.toJSON() ?? Money.zero(intent.amount.currency).toJSON(),
      etaSeconds: r.quote.etaSeconds,
      score: r.score,
      breakdown: r.breakdown,
    })),
    unavailable: rejected,
  };
};

export { getRail, isTerminal };
export default { rank, route, execute, explain, canFailOver, RoutingPolicy };
