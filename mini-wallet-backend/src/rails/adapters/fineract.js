import { HttpRail } from './HttpRail.js';
import { InstrumentType, RailDirection, RailStatus } from '../Rail.js';
import { Money } from '../../core/money/Money.js';

/**
 * SACCOs and microfinance institutions, via Apache Fineract.
 *
 * ## Why Fineract specifically
 *
 * "Integrate with microfinance" has no single counterparty — there are
 * thousands of SACCOs and MFIs and none of them will build an API for us.
 * But a large share of them already run **Apache Fineract** (directly, or
 * through Musoni and the other Mifos distributions), and Fineract has one
 * documented REST API with a stable shape.
 *
 * So integrating with the *platform* rather than the institution turns a
 * thousand bespoke integrations into one adapter plus a row of configuration
 * per institution. That reach — a member can move money between their SACCO
 * share account and their wallet — is the part a mobile-money-only wallet
 * structurally cannot offer.
 *
 * ## Mechanics
 *
 * Fineract models a member's savings account as the funding source. A deposit
 * into the wallet is a `withdrawal` from their savings account, and a payout
 * from the wallet is a `deposit` into it — the direction inverts because we
 * are describing it from the member's side of their SACCO account, which is
 * an easy and expensive thing to get backwards.
 *
 * Multi-tenanted: every request carries the institution's tenant id.
 *
 * Written against Fineract's documented v1 API; needs per-institution
 * credentials to run.
 */

const STATUS_MAP = {
  SUBMITTED: RailStatus.PROCESSING,
  PENDING: RailStatus.PROCESSING,
  APPROVED: RailStatus.SUCCEEDED,
  POSTED: RailStatus.SUCCEEDED,
  COMPLETED: RailStatus.SUCCEEDED,
  REJECTED: RailStatus.FAILED,
  FAILED: RailStatus.FAILED,
  REVERSED: RailStatus.REVERSED,
};

export class FineractRail extends HttpRail {
  /**
   * @param {object} config
   * @param {string} config.institutionId  Our key for this SACCO/MFI.
   * @param {string} config.displayName
   * @param {string} config.baseUrl        e.g. https://sacco.example/fineract-provider/api/v1
   * @param {string} config.tenantId       Fineract-Platform-TenantId.
   * @param {string} config.username
   * @param {string} config.password
   * @param {string} [config.currency]
   * @param {string} [config.country]
   * @param {string} [config.webhookSecret]
   * @param {number} [config.feeBps]       Our margin, in basis points.
   */
  constructor({
    institutionId,
    displayName,
    baseUrl,
    tenantId,
    username,
    password,
    currency = 'KES',
    country = 'KE',
    webhookSecret,
    feeBps = 0,
  }) {
    super({
      key: `sacco:${institutionId}`,
      displayName: displayName ?? `SACCO ${institutionId}`,
      baseUrl,
      webhookSecret,
      capabilities: {
        directions: [RailDirection.COLLECT, RailDirection.PAYOUT],
        instruments: [InstrumentType.MEMBER_ACCOUNT],
        currencies: [currency],
        countries: [country],
        // Core-banking postings clear on the institution's own cycle, not ours.
        settlement: 'same_day',
        supportsStatusQuery: true,
        supportsRefund: false,
      },
    });
    this.institutionId = institutionId;
    this.tenantId = tenantId;
    this.username = username;
    this.password = password;
    this.currency = currency;
    this.feeBps = feeBps;
    this.http.defaults.headers.common['Fineract-Platform-TenantId'] = tenantId;
  }

  get configured() {
    return Boolean(this.baseUrl && this.tenantId && this.username && this.password);
  }

  /**
   * Fineract issues a self-service OAuth token; basic auth is the fallback
   * for deployments that have not enabled it.
   * @returns {Promise<{token: string, expiresInSec: number}>}
   */
  async authenticate() {
    const { data } = await this.http.post('/authentication', {
      username: this.username,
      password: this.password,
    });
    // `base64EncodedAuthenticationKey` is what Fineract returns for basic auth.
    return {
      token: data.accessToken ?? data.base64EncodedAuthenticationKey,
      expiresInSec: Number(data.expiresIn) || 1800,
    };
  }

  /** @param {import('../Rail.js').PaymentIntent} intent */
  supports(intent) {
    if (!this.configured) {
      return { ok: false, reason: `${this.displayName} credentials are not configured` };
    }
    const base = super.supports(intent);
    if (!base.ok) return base;
    const { institutionId, accountNumber } = intent.instrument ?? {};
    if (institutionId !== this.institutionId) {
      return { ok: false, reason: `member is not with ${this.displayName}` };
    }
    if (!accountNumber) {
      return { ok: false, reason: 'a member savings account id is required' };
    }
    return { ok: true };
  }

  /** @param {import('../Rail.js').PaymentIntent} intent */
  async quote(intent) {
    const verdict = this.supports(intent);
    if (!verdict.ok) return this.unsupported(verdict.reason);

    // The institution charges us nothing per posting; our margin is the fee.
    const customerFee = intent.amount.basisPoints(this.feeBps);
    return this.quoted({
      railCost: Money.zero(intent.amount.currency),
      customerFee,
      // Honest about the cycle: this is not an instant rail, and the router
      // should only pick it when speed is not what is being optimised for.
      etaSeconds: 4 * 60 * 60,
      successRate: 0.96,
      limits: { min: Money.of('1.00', this.currency) },
    });
  }

  /**
   * Post a transaction against the member's savings account.
   * @param {import('../Rail.js').PaymentIntent} intent
   * @param {'deposit'|'withdrawal'} command
   * @returns {Promise<import('../Rail.js').RailEvent>}
   */
  async #postTransaction(intent, command) {
    const accountId = intent.instrument.accountNumber;
    const data = await this.request({
      method: 'POST',
      path: `/savingsaccounts/${accountId}/transactions?command=${command}`,
      idempotencyKey: intent.reference,
      retries: 2,
      body: {
        transactionAmount: intent.amount.toDecimal(),
        transactionDate: new Date().toISOString().slice(0, 10),
        dateFormat: 'yyyy-MM-dd',
        locale: 'en',
        note: (intent.narrative ?? 'Wallet transfer').slice(0, 120),
        // Echoed back on webhooks so we can correlate.
        externalId: intent.reference,
      },
    });

    return {
      rail: this.key,
      status: HttpRail.mapStatus(data.status ?? 'POSTED', STATUS_MAP),
      reference: intent.reference,
      providerRef: String(data.resourceId ?? data.savingsId ?? ''),
      amount: intent.amount,
      raw: data,
    };
  }

  /**
   * Pull funds from the member's savings account into their wallet — a
   * withdrawal on the SACCO's books.
   * @param {import('../Rail.js').PaymentIntent} intent
   */
  async collect(intent) {
    return this.#postTransaction(intent, 'withdrawal');
  }

  /**
   * Push wallet funds into the member's savings account — a deposit on the
   * SACCO's books.
   * @param {import('../Rail.js').PaymentIntent} intent
   */
  async payout(intent) {
    return this.#postTransaction(intent, 'deposit');
  }

  /** @param {string} providerRef */
  async status(providerRef) {
    const data = await this.request({
      method: 'GET',
      path: `/savingsaccounts/transactions/${providerRef}`,
    });
    return {
      rail: this.key,
      providerRef,
      status: data.reversed ? RailStatus.REVERSED : RailStatus.SUCCEEDED,
      raw: data,
    };
  }

  /** @param {object} payload */
  parseCallback(payload) {
    if (!payload?.externalId && !payload?.resourceId) {
      return { rail: this.key, status: RailStatus.UNKNOWN, raw: payload };
    }
    return {
      rail: this.key,
      status: HttpRail.mapStatus(payload.status, STATUS_MAP),
      reference: payload.externalId,
      providerRef: String(payload.resourceId ?? ''),
      amount:
        payload.amount !== undefined
          ? Money.ofRounded(String(payload.amount), this.currency)
          : undefined,
      raw: payload,
    };
  }
}

/**
 * Build a rail per institution from `SACCO_INSTITUTIONS` — a JSON array, so
 * onboarding a new SACCO is configuration rather than a deploy.
 *
 * @returns {FineractRail[]}
 */
export const fineractRailsFromEnv = () => {
  const raw = process.env.SACCO_INSTITUTIONS;
  if (!raw) return [];
  try {
    return JSON.parse(raw).map((cfg) => new FineractRail(cfg));
  } catch {
    return [];
  }
};

export default FineractRail;
