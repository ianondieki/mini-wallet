import { randomUUID } from 'node:crypto';
import { Rail, InstrumentType, RailDirection, RailStatus } from '../Rail.js';
import { Money } from '../../core/money/Money.js';

/**
 * A rail that behaves like a real one without touching a network.
 *
 * Every provider gives you a sandbox that is fast, reliable and therefore
 * nothing like production. This one is deliberately controllable: set a
 * failure rate, a latency, a currency — and drive the router, the circuit
 * breaker and the failover paths through states a sandbox will not reproduce
 * on demand.
 *
 * It is how the routing and reconciliation logic is tested without a mock in
 * sight, and how a developer runs the whole wallet locally with no credentials.
 *
 * Never registered when `NODE_ENV=production` — see `bootstrapRails`.
 */
export class SimulatorRail extends Rail {
  /**
   * @param {object} [config]
   * @param {string} [config.key]
   * @param {number} [config.failureRate]  0..1 chance of a terminal failure.
   * @param {number} [config.latencyMs]
   * @param {number} [config.feeBps]       Our fee, in basis points.
   * @param {string} [config.fixedFee]     Flat component, major units.
   * @param {number} [config.etaSeconds]
   * @param {string[]} [config.currencies]
   * @param {string[]} [config.countries]
   * @param {string[]} [config.directions]
   * @param {() => number} [config.random]  Injectable RNG for determinism.
   */
  constructor({
    key = 'simulator',
    displayName,
    failureRate = 0,
    latencyMs = 0,
    feeBps = 0,
    fixedFee = '0',
    etaSeconds = 5,
    currencies = ['KES'],
    countries = ['KE'],
    directions = [RailDirection.COLLECT, RailDirection.PAYOUT],
    instruments = [InstrumentType.MSISDN, InstrumentType.BANK_ACCOUNT],
    random = Math.random,
  } = {}) {
    super({
      key,
      displayName: displayName ?? `Simulator (${key})`,
      capabilities: {
        directions,
        instruments,
        currencies,
        countries,
        settlement: 'instant',
        supportsStatusQuery: true,
        supportsRefund: true,
      },
    });
    this.failureRate = failureRate;
    this.latencyMs = latencyMs;
    this.feeBps = feeBps;
    this.fixedFee = fixedFee;
    this.etaSeconds = etaSeconds;
    this.random = random;
    /** @type {Map<string, import('../Rail.js').RailEvent>} */
    this.sent = new Map();
  }

  /** @param {import('../Rail.js').PaymentIntent} intent */
  async quote(intent) {
    const verdict = this.supports(intent);
    if (!verdict.ok) return this.unsupported(verdict.reason);

    const fee = intent.amount
      .basisPoints(this.feeBps)
      .plus(Money.of(this.fixedFee, intent.amount.currency));

    return this.quoted({
      railCost: fee,
      customerFee: fee,
      etaSeconds: this.etaSeconds,
      successRate: 1 - this.failureRate,
    });
  }

  /** Simulate provider latency without blocking the event loop at shutdown. */
  async #delay() {
    if (this.latencyMs <= 0) return;
    await new Promise((resolve) => {
      const t = setTimeout(resolve, this.latencyMs);
      t.unref?.();
    });
  }

  /**
   * @param {import('../Rail.js').PaymentIntent} intent
   * @returns {Promise<import('../Rail.js').RailEvent>}
   */
  async #move(intent) {
    await this.#delay();
    const providerRef = `SIM-${randomUUID().slice(0, 8).toUpperCase()}`;

    const event =
      this.random() < this.failureRate
        ? {
            rail: this.key,
            status: RailStatus.FAILED,
            reference: intent.reference,
            providerRef,
            failureCode: 'SIMULATED_FAILURE',
            failureReason: 'Simulated terminal failure',
          }
        : {
            rail: this.key,
            status: RailStatus.SUCCEEDED,
            reference: intent.reference,
            providerRef,
            receipt: providerRef,
            amount: intent.amount,
          };

    this.sent.set(providerRef, event);
    return event;
  }

  /** @param {import('../Rail.js').PaymentIntent} intent */
  async collect(intent) {
    return this.#move(intent);
  }

  /** @param {import('../Rail.js').PaymentIntent} intent */
  async payout(intent) {
    return this.#move(intent);
  }

  /** @param {string} providerRef */
  async status(providerRef) {
    return (
      this.sent.get(providerRef) ?? {
        rail: this.key,
        providerRef,
        status: RailStatus.UNKNOWN,
      }
    );
  }

  /** @param {object} payload */
  parseCallback(payload) {
    return {
      rail: this.key,
      status: payload?.status ?? RailStatus.UNKNOWN,
      reference: payload?.reference,
      providerRef: payload?.providerRef,
      raw: payload,
    };
  }

  /** The simulator has no real origin to verify. */
  verifyCallback() {
    return process.env.NODE_ENV === 'production'
      ? { ok: false, reason: 'simulator is disabled in production' }
      : { ok: true };
  }
}

export default SimulatorRail;
