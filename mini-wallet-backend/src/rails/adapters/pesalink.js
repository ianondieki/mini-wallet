import { HttpRail } from './HttpRail.js';
import { InstrumentType, RailDirection, RailStatus } from '../Rail.js';
import { Money } from '../../core/money/Money.js';
import { logger } from '../../config/logger.js';

/**
 * PesaLink — Kenya's instant interbank rail (IPSL, owned by the Kenya
 * Bankers Association).
 *
 * This is the rail that makes the wallet a bank-adjacent product rather than
 * a mobile-money front end: it reaches an account at any participating
 * Kenyan bank in seconds, and above roughly KES 20,000 it is materially
 * cheaper than M-Pesa B2C, which is exactly the crossover the router exists
 * to find.
 *
 * ## Confirmation of payee
 *
 * {@link PesaLinkRail#validateAccount} resolves an account number to the
 * name the bank holds, before any money moves. Misdirected payments are the
 * single largest category of irrecoverable consumer loss on push rails —
 * the UK made this check mandatory for that reason — and on a push rail
 * there is no chargeback to fall back on. It is cheap, and it is the
 * difference between a typo being an inconvenience and it being final.
 *
 * ## Status
 *
 * Written against IPSL's documented request/response shapes. It needs real
 * participant credentials to run; endpoint paths are configurable because
 * they are issued per participant.
 */

/** IPSL status vocabulary → our lifecycle. */
const STATUS_MAP = {
  PENDING: RailStatus.PROCESSING,
  PROCESSING: RailStatus.PROCESSING,
  ACCEPTED: RailStatus.PROCESSING,
  COMPLETED: RailStatus.SUCCEEDED,
  SUCCESS: RailStatus.SUCCEEDED,
  SETTLED: RailStatus.SUCCEEDED,
  REJECTED: RailStatus.FAILED,
  FAILED: RailStatus.FAILED,
  DECLINED: RailStatus.FAILED,
  REVERSED: RailStatus.REVERSED,
  RETURNED: RailStatus.REVERSED,
};

/**
 * Indicative tariff. PesaLink is a flat-ish band, which is why it overtakes
 * percentage-priced rails as amounts grow.
 */
const DEFAULT_TARIFF = [
  { upTo: 500, charge: '0.00' },
  { upTo: 10000, charge: '25.00' },
  { upTo: 100000, charge: '45.00' },
  { upTo: 999999, charge: '75.00' },
];

export class PesaLinkRail extends HttpRail {
  constructor({
    baseUrl = process.env.PESALINK_BASE_URL,
    clientId = process.env.PESALINK_CLIENT_ID,
    clientSecret = process.env.PESALINK_CLIENT_SECRET,
    senderAccount = process.env.PESALINK_SENDER_ACCOUNT,
    senderBankCode = process.env.PESALINK_SENDER_BANK_CODE,
    webhookSecret = process.env.PESALINK_WEBHOOK_SECRET,
    tariff = DEFAULT_TARIFF,
  } = {}) {
    super({
      key: 'pesalink',
      displayName: 'PesaLink (bank transfer)',
      baseUrl,
      webhookSecret,
      capabilities: {
        directions: [RailDirection.PAYOUT],
        instruments: [InstrumentType.BANK_ACCOUNT],
        currencies: ['KES'],
        countries: ['KE'],
        settlement: 'instant',
        supportsStatusQuery: true,
        supportsRefund: false,
      },
    });
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.senderAccount = senderAccount;
    this.senderBankCode = senderBankCode;
    this.tariff = tariff;
  }

  /** True when every credential this rail needs is present. */
  get configured() {
    return Boolean(this.baseUrl && this.clientId && this.clientSecret && this.senderAccount);
  }

  /** @returns {Promise<{token: string, expiresInSec: number}>} */
  async authenticate() {
    const { data } = await this.http.post('/oauth2/token', {
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    return { token: data.access_token, expiresInSec: Number(data.expires_in) || 3000 };
  }

  /** @param {import('../Rail.js').PaymentIntent} intent */
  supports(intent) {
    if (!this.configured) {
      return { ok: false, reason: 'PesaLink credentials are not configured' };
    }
    const base = super.supports(intent);
    if (!base.ok) return base;
    const { bankCode, accountNumber } = intent.instrument ?? {};
    if (!bankCode || !accountNumber) {
      return { ok: false, reason: 'PesaLink needs a bank code and account number' };
    }
    return { ok: true };
  }

  /** @param {import('../Rail.js').PaymentIntent} intent */
  async quote(intent) {
    const verdict = this.supports(intent);
    if (!verdict.ok) return this.unsupported(verdict.reason);

    const major = Number(intent.amount.toDecimal());
    const band = this.tariff.find((b) => major <= b.upTo);
    if (!band) {
      return this.unsupported(`above the PesaLink per-transaction ceiling`);
    }
    const railCost = Money.of(band.charge, 'KES');

    return this.quoted({
      railCost,
      customerFee: railCost,
      etaSeconds: 20,
      successRate: 0.97,
      limits: {
        min: Money.of('10.00', 'KES'),
        max: Money.of('999999.00', 'KES'),
      },
    });
  }

  /**
   * Confirmation of payee: resolve an account to the name the bank holds.
   *
   * Returns `{ ok: false }` rather than throwing when the bank cannot be
   * reached — a name check that is unavailable must not block a payment the
   * customer has already confirmed, it should degrade to a warning.
   *
   * @param {{bankCode: string, accountNumber: string}} instrument
   * @returns {Promise<{ok: boolean, accountName?: string, reason?: string}>}
   */
  async validateAccount({ bankCode, accountNumber }) {
    try {
      const data = await this.request({
        method: 'POST',
        path: '/accounts/validate',
        body: { bankCode, accountNumber },
      });
      return { ok: true, accountName: data.accountName ?? data.customerName };
    } catch (err) {
      logger.warn('PesaLink name enquiry unavailable', { message: err.message });
      return { ok: false, reason: err.message };
    }
  }

  /**
   * @param {import('../Rail.js').PaymentIntent} intent
   * @returns {Promise<import('../Rail.js').RailEvent>}
   */
  async payout(intent) {
    const data = await this.request({
      method: 'POST',
      path: '/transfers',
      // The reference doubles as the provider's idempotency key, so a retried
      // POST cannot become a second transfer.
      idempotencyKey: intent.reference,
      retries: 2,
      body: {
        amount: intent.amount.toDecimal(),
        currency: intent.amount.currency,
        sender: { bankCode: this.senderBankCode, accountNumber: this.senderAccount },
        recipient: {
          bankCode: intent.instrument.bankCode,
          accountNumber: intent.instrument.accountNumber,
          accountName: intent.instrument.accountName,
        },
        reference: intent.reference,
        narration: (intent.narrative ?? 'Wallet withdrawal').slice(0, 64),
      },
    });

    return {
      rail: this.key,
      status: HttpRail.mapStatus(data.status, STATUS_MAP),
      reference: intent.reference,
      providerRef: data.transactionId ?? data.id,
      amount: intent.amount,
      raw: data,
    };
  }

  /** @param {string} providerRef */
  async status(providerRef) {
    const data = await this.request({ method: 'GET', path: `/transfers/${providerRef}` });
    return {
      rail: this.key,
      providerRef,
      status: HttpRail.mapStatus(data.status, STATUS_MAP),
      receipt: data.receiptNumber,
      failureReason: data.failureReason,
      raw: data,
    };
  }

  /** @param {object} payload */
  parseCallback(payload) {
    if (!payload?.transactionId && !payload?.reference) {
      return { rail: this.key, status: RailStatus.UNKNOWN, raw: payload };
    }
    return {
      rail: this.key,
      status: HttpRail.mapStatus(payload.status, STATUS_MAP),
      reference: payload.reference,
      providerRef: payload.transactionId,
      receipt: payload.receiptNumber,
      amount:
        payload.amount !== undefined
          ? Money.ofRounded(String(payload.amount), payload.currency ?? 'KES')
          : undefined,
      failureCode: payload.errorCode,
      failureReason: payload.failureReason,
      raw: payload,
    };
  }
}

export default PesaLinkRail;
