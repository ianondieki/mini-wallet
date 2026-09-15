import { Money } from '../core/money/Money.js';

/**
 * The payment rail interface.
 *
 * ## Why
 *
 * M-Pesa was wired straight into the controllers: `stkPush` built a Daraja
 * payload inline, `b2cWithdraw` knew Safaricom's field names, and the wallet's
 * idea of "paying out" *was* B2C. Adding a bank, a SACCO or a card acquirer
 * meant duplicating that controller for each one, and the choice of provider
 * would have been hardcoded at the call site.
 *
 * A rail is anything that can move value in or out of the wallet: a mobile
 * money operator, a bank, a microfinance core-banking system, a card
 * acquirer, an aggregator. They differ enormously in mechanics and not at all
 * in what the wallet needs from them — quote it, send it, tell me what
 * happened. That shared shape is this interface.
 *
 * Everything above this line speaks `Money`, `PaymentIntent` and `RailEvent`.
 * Everything below translates to whatever the provider actually wants. The
 * router then picks between implementations at runtime on cost, speed and
 * health, which is only possible because they are interchangeable.
 */

/**
 * How value is addressed on the far side of a rail.
 * @readonly
 * @enum {string}
 */
export const InstrumentType = Object.freeze({
  /** Mobile money, addressed by phone number. */
  MSISDN: 'msisdn',
  /** Bank account, addressed by bank code + account number. */
  BANK_ACCOUNT: 'bank_account',
  /** SACCO / microfinance member account. */
  MEMBER_ACCOUNT: 'member_account',
  /** Payment card (PAN held by the acquirer, we only ever see a token). */
  CARD_TOKEN: 'card_token',
  /** Another wallet on this platform — settles internally, no rail. */
  INTERNAL: 'internal',
});

/**
 * Direction of travel, from the wallet's point of view.
 * @readonly
 * @enum {string}
 */
export const RailDirection = Object.freeze({
  /** Money coming in — a deposit. */
  COLLECT: 'collect',
  /** Money going out — a payout. */
  PAYOUT: 'payout',
});

/**
 * Normalised lifecycle state. Every provider's bespoke status vocabulary maps
 * onto exactly these, so the rest of the system never learns a provider's
 * private language.
 * @readonly
 * @enum {string}
 */
export const RailStatus = Object.freeze({
  /** Accepted by us, not yet sent. */
  PENDING: 'pending',
  /** Sent; the provider has it and is working. */
  PROCESSING: 'processing',
  /** Waiting on the customer (e.g. an unapproved STK prompt). */
  AWAITING_CUSTOMER: 'awaiting_customer',
  /** Terminal success — value has moved. */
  SUCCEEDED: 'succeeded',
  /** Terminal failure — value has NOT moved and will not. */
  FAILED: 'failed',
  /** Terminal — the provider reversed it after the fact. */
  REVERSED: 'reversed',
  /** Non-terminal and unknown; must be resolved by query or reconciliation. */
  UNKNOWN: 'unknown',
});

/** States after which nothing more will happen on its own. */
export const TERMINAL_STATUSES = Object.freeze([
  RailStatus.SUCCEEDED,
  RailStatus.FAILED,
  RailStatus.REVERSED,
]);

/** @param {string} status */
export const isTerminal = (status) => TERMINAL_STATUSES.includes(status);

/**
 * @typedef {object} Instrument
 * @property {string} type          An {@link InstrumentType}.
 * @property {string} [msisdn]      E.164-ish phone number, for mobile money.
 * @property {string} [bankCode]    Clearing/SWIFT/BIC code, for banks.
 * @property {string} [accountNumber]
 * @property {string} [accountName]
 * @property {string} [token]       Card token — never a raw PAN.
 * @property {string} [institutionId] SACCO / MFI identifier.
 */

/**
 * A request to move value, stated in the wallet's terms and not any
 * provider's.
 *
 * @typedef {object} PaymentIntent
 * @property {string} direction     A {@link RailDirection}.
 * @property {Money}  amount        Gross amount to move.
 * @property {Instrument} instrument Where the money comes from or goes to.
 * @property {string} country       ISO 3166-1 alpha-2, e.g. "KE".
 * @property {string} [speed]       "instant" | "standard" — a preference.
 * @property {string} [reference]   Our own correlation id.
 * @property {string} [narrative]
 */

/**
 * What a rail says a given intent would cost and take.
 *
 * @typedef {object} RailQuote
 * @property {string}  rail         Rail key.
 * @property {boolean} supported
 * @property {string}  [reason]     Why not, when unsupported.
 * @property {Money}   [railCost]   What the provider charges US.
 * @property {Money}   [customerFee] What we would charge the customer.
 * @property {number}  [etaSeconds] Expected time to terminal state.
 * @property {number}  [successRate] Observed 0..1 reliability.
 * @property {object}  [limits]     { min: Money, max: Money }
 */

/**
 * A normalised provider event — from a webhook or a status query.
 *
 * @typedef {object} RailEvent
 * @property {string} rail
 * @property {string} status         A {@link RailStatus}.
 * @property {string} [reference]    Our correlation id, when the provider echoes it.
 * @property {string} [providerRef]  The provider's own id.
 * @property {string} [receipt]      Customer-visible receipt number.
 * @property {Money}  [amount]       What actually moved, per the provider.
 * @property {Money}  [railCost]     What the provider actually charged us.
 * @property {string} [failureCode]
 * @property {string} [failureReason]
 * @property {object} [raw]          Untouched provider payload, for audit.
 */

/**
 * Base class every adapter extends.
 *
 * Unimplemented capabilities throw rather than returning a falsy value, so a
 * rail that cannot do something fails loudly at development time instead of
 * silently doing nothing in production.
 *
 * @abstract
 */
export class Rail {
  /**
   * @param {object} config
   * @param {string} config.key            Stable identifier, e.g. "mpesa".
   * @param {string} config.displayName
   * @param {object} config.capabilities   See {@link Rail#capabilities}.
   */
  constructor({ key, displayName, capabilities }) {
    if (new.target === Rail) throw new TypeError('Rail is abstract');
    if (!key) throw new TypeError('A rail needs a key');
    this.key = key;
    this.displayName = displayName ?? key;
    /**
     * @type {{
     *   directions: string[],
     *   instruments: string[],
     *   currencies: string[],
     *   countries: string[],
     *   settlement: string,
     *   supportsStatusQuery: boolean,
     *   supportsRefund: boolean
     * }}
     */
    this.capabilities = {
      directions: [],
      instruments: [],
      currencies: [],
      countries: [],
      settlement: 'instant',
      supportsStatusQuery: false,
      supportsRefund: false,
      ...capabilities,
    };
  }

  /**
   * Cheap structural check: could this rail carry this intent at all?
   * Cost and health are the router's business, not this method's.
   *
   * @param {PaymentIntent} intent
   * @returns {{ ok: boolean, reason?: string }}
   */
  supports(intent) {
    const c = this.capabilities;
    if (!c.directions.includes(intent.direction)) {
      return { ok: false, reason: `${this.key} does not support ${intent.direction}` };
    }
    if (!c.instruments.includes(intent.instrument?.type)) {
      return { ok: false, reason: `${this.key} cannot reach a ${intent.instrument?.type}` };
    }
    if (!c.currencies.includes(intent.amount?.currency)) {
      return { ok: false, reason: `${this.key} does not settle ${intent.amount?.currency}` };
    }
    if (intent.country && !c.countries.includes(intent.country)) {
      return { ok: false, reason: `${this.key} does not operate in ${intent.country}` };
    }
    return { ok: true };
  }

  /**
   * Price and time an intent. Must not perform side effects — the router
   * calls this across every candidate rail before choosing one.
   *
   * @param {PaymentIntent} intent
   * @returns {Promise<RailQuote>}
   * @abstract
   */
  // eslint-disable-next-line no-unused-vars
  async quote(intent) {
    throw new Error(`${this.key} has not implemented quote()`);
  }

  /**
   * Pull money in. Returns as soon as the provider has accepted the request;
   * the outcome arrives later as a {@link RailEvent}.
   *
   * @param {PaymentIntent} intent
   * @returns {Promise<RailEvent>}
   * @abstract
   */
  // eslint-disable-next-line no-unused-vars
  async collect(intent) {
    throw new Error(`${this.key} has not implemented collect()`);
  }

  /**
   * Push money out. Same contract as {@link Rail#collect}.
   *
   * @param {PaymentIntent} intent
   * @returns {Promise<RailEvent>}
   * @abstract
   */
  // eslint-disable-next-line no-unused-vars
  async payout(intent) {
    throw new Error(`${this.key} has not implemented payout()`);
  }

  /**
   * Ask the provider what happened to a transfer. The authority of last
   * resort when a webhook never arrives.
   *
   * @param {string} providerRef
   * @returns {Promise<RailEvent>}
   */
  // eslint-disable-next-line no-unused-vars
  async status(providerRef) {
    throw new Error(`${this.key} has not implemented status()`);
  }

  /**
   * Translate a raw provider webhook into a {@link RailEvent}.
   *
   * Implementations must be **total**: a payload they do not recognise
   * returns `RailStatus.UNKNOWN` rather than throwing, because a thrown
   * parser means a webhook we never acknowledge and a provider that retries
   * forever.
   *
   * @param {object} payload
   * @returns {RailEvent}
   */
  // eslint-disable-next-line no-unused-vars
  parseCallback(payload) {
    throw new Error(`${this.key} has not implemented parseCallback()`);
  }

  /**
   * Verify a webhook actually came from the provider. Signature check, IP
   * allowlist, shared secret — whatever the provider offers.
   *
   * The default is a **deny**: a rail that has not thought about webhook
   * authentication does not get to credit customer wallets. Adapters must
   * opt in explicitly.
   *
   * @param {object} _req  Express request (headers, body, ip).
   * @returns {{ ok: boolean, reason?: string }}
   */
  verifyCallback(_req) {
    return { ok: false, reason: `${this.key} has not implemented verifyCallback()` };
  }

  /**
   * Convenience: build an unsupported quote.
   * @param {string} reason
   * @returns {RailQuote}
   */
  unsupported(reason) {
    return { rail: this.key, supported: false, reason };
  }

  /**
   * Convenience: build a supported quote with sane defaults.
   * @param {Partial<RailQuote>} fields
   * @returns {RailQuote}
   */
  quoted(fields) {
    return {
      rail: this.key,
      supported: true,
      etaSeconds: 60,
      successRate: 0.99,
      ...fields,
    };
  }

  /** Describe this rail for the capabilities endpoint. @returns {object} */
  describe() {
    return { key: this.key, displayName: this.displayName, capabilities: this.capabilities };
  }
}

/**
 * Assert a value is Money in an expected currency — adapters use this on the
 * amounts they build from provider payloads.
 * @param {Money} amount
 * @param {string} label
 */
export const requireMoney = (amount, label) => {
  if (!Money.isMoney(amount)) throw new TypeError(`${label} must be a Money instance`);
  return amount;
};

export default Rail;
