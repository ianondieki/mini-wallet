import { Rail, InstrumentType, RailDirection, RailStatus } from '../Rail.js';
import { Money } from '../../core/money/Money.js';

/**
 * The on-platform rail: both parties hold balances with us.
 *
 * Nothing leaves the institution, so there is no provider, no settlement lag
 * and no cost. Modelling it as a rail rather than a special case is the point:
 * when someone sends money to a number that turns out to belong to another
 * customer, the router sees a free, instant option alongside the M-Pesa quote
 * and picks it automatically.
 *
 * That is the whole economic argument for a network — it is why Wise, Revolut
 * and Chime make in-network transfers free — and here it falls out of routing
 * rather than needing a rule.
 */
export class InternalRail extends Rail {
  /**
   * @param {object} deps
   * @param {(instrument: import('../Rail.js').Instrument) => Promise<string|null>} deps.resolveUserId
   *   Maps an instrument to a local user id, or null if they are not a customer.
   */
  constructor({ resolveUserId }) {
    super({
      key: 'internal',
      displayName: 'Wallet-to-wallet',
      capabilities: {
        directions: [RailDirection.PAYOUT],
        instruments: [InstrumentType.INTERNAL, InstrumentType.MSISDN],
        currencies: ['KES', 'UGX', 'TZS', 'RWF', 'NGN', 'GHS', 'ZAR', 'USD', 'EUR', 'GBP'],
        countries: ['KE', 'UG', 'TZ', 'RW', 'NG', 'GH', 'ZA', 'US', 'GB'],
        settlement: 'instant',
        supportsStatusQuery: true,
        supportsRefund: true,
      },
    });
    this.resolveUserId = resolveUserId;
  }

  /**
   * Only usable when the counterparty is actually one of our customers.
   * @param {import('../Rail.js').PaymentIntent} intent
   */
  async quote(intent) {
    const base = super.supports(intent);
    if (!base.ok) return this.unsupported(base.reason);

    const recipientId = await this.resolveUserId(intent.instrument);
    if (!recipientId) {
      return this.unsupported('recipient does not hold a wallet with us');
    }

    return this.quoted({
      railCost: Money.zero(intent.amount.currency),
      customerFee: Money.zero(intent.amount.currency),
      etaSeconds: 0,
      successRate: 1,
      limits: {},
      // Handed back so the service can post the transfer without resolving twice.
      recipientUserId: recipientId,
    });
  }

  /**
   * There is no external call to make. The caller posts the ledger entry; this
   * only confirms the route is valid and immediate.
   * @param {import('../Rail.js').PaymentIntent} intent
   * @returns {Promise<import('../Rail.js').RailEvent>}
   */
  async payout(intent) {
    const recipientId = await this.resolveUserId(intent.instrument);
    if (!recipientId) {
      return {
        rail: this.key,
        status: RailStatus.FAILED,
        reference: intent.reference,
        failureCode: 'NOT_A_CUSTOMER',
        failureReason: 'Recipient does not hold a wallet with us',
      };
    }
    return {
      rail: this.key,
      status: RailStatus.SUCCEEDED,
      reference: intent.reference,
      providerRef: intent.reference,
      amount: intent.amount,
      raw: { recipientUserId: recipientId, settledInternally: true },
    };
  }

  /** Internal transfers are settled the moment they are posted. */
  async status(providerRef) {
    return { rail: this.key, providerRef, status: RailStatus.SUCCEEDED };
  }

  /** No provider, so no webhooks to parse or authenticate. */
  parseCallback(payload) {
    return { rail: this.key, status: RailStatus.UNKNOWN, raw: payload };
  }
}

export default InternalRail;
