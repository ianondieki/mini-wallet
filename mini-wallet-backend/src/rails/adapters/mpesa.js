import crypto from 'node:crypto';
import { Rail, InstrumentType, RailDirection, RailStatus } from '../Rail.js';
import { Money } from '../../core/money/Money.js';
import { darajaPost } from '../../config/mpesa.js';
import { getTimestamp, getPassword, formatPhone, maskPhone } from '../../utils/mpesaHelpers.js';
import { logger } from '../../config/logger.js';

/**
 * Safaricom M-Pesa (Daraja) as a rail.
 *
 * The Daraja mechanics here are the ones the wallet already ran in
 * production — STK Push to collect, B2C to pay out, the same callback
 * reconciliation. What changed is that they now sit behind {@link Rail}
 * instead of inside the controllers, so M-Pesa is a *candidate* the router
 * can weigh and route around rather than the only thing the wallet knows how
 * to do.
 *
 * Tariffs are indicative defaults and are meant to be overridden from the
 * tariff actually signed with Safaricom — they feed least-cost routing, so a
 * wrong number here quietly sends money down the wrong rail.
 */

/**
 * Safaricom's B2C charge bands, in KES. `upTo` is inclusive; the last band
 * carries the ceiling. Override with MPESA_B2C_TARIFF as JSON.
 */
const DEFAULT_B2C_TARIFF = [
  { upTo: 100, charge: '0.00' },
  { upTo: 1500, charge: '15.00' },
  { upTo: 5000, charge: '25.00' },
  { upTo: 20000, charge: '45.00' },
  { upTo: 150000, charge: '65.00' },
  { upTo: Infinity, charge: '110.00' },
];

/** Paybill collection is typically free to the customer and charged to us. */
const DEFAULT_C2B_TARIFF = [{ upTo: Infinity, charge: '0.00' }];

/**
 * Read a tariff table from the environment, falling back to the defaults.
 * @param {string} envKey
 * @param {Array<{upTo: number, charge: string}>} fallback
 */
const loadTariff = (envKey, fallback) => {
  const raw = process.env[envKey];
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('empty');
    return parsed.map((b) => ({ upTo: b.upTo === null ? Infinity : Number(b.upTo), charge: String(b.charge) }));
  } catch (err) {
    logger.error('Invalid tariff JSON — using defaults', { envKey, message: err.message });
    return fallback;
  }
};

/**
 * Charge for an amount under a band table.
 * @param {Money} amount
 * @param {Array<{upTo: number, charge: string}>} tariff
 * @returns {Money}
 */
const chargeFor = (amount, tariff) => {
  const major = Number(amount.toDecimal());
  const band = tariff.find((b) => major <= b.upTo) ?? tariff[tariff.length - 1];
  return Money.of(band.charge, amount.currency);
};

/** Safaricom result codes that mean "definitively did not happen". */
const TERMINAL_FAILURE_CODES = new Set([
  1, // insufficient funds on the customer's side
  1001, // unable to lock subscriber
  1019, // transaction expired
  1032, // cancelled by user
  1037, // timeout — customer never responded to the prompt
  2001, // wrong PIN
]);

export class MpesaRail extends Rail {
  constructor() {
    super({
      key: 'mpesa',
      displayName: 'M-Pesa',
      capabilities: {
        directions: [RailDirection.COLLECT, RailDirection.PAYOUT],
        instruments: [InstrumentType.MSISDN],
        currencies: ['KES'],
        countries: ['KE'],
        settlement: 'instant',
        supportsStatusQuery: true,
        supportsRefund: false,
      },
    });
    this.b2cTariff = loadTariff('MPESA_B2C_TARIFF', DEFAULT_B2C_TARIFF);
    this.c2bTariff = loadTariff('MPESA_C2B_TARIFF', DEFAULT_C2B_TARIFF);
  }

  /** @param {import('../Rail.js').PaymentIntent} intent */
  supports(intent) {
    const base = super.supports(intent);
    if (!base.ok) return base;
    if (!formatPhone(intent.instrument?.msisdn)) {
      return { ok: false, reason: 'M-Pesa needs a valid Kenyan mobile number' };
    }
    return { ok: true };
  }

  /**
   * @param {import('../Rail.js').PaymentIntent} intent
   * @returns {Promise<import('../Rail.js').RailQuote>}
   */
  async quote(intent) {
    const verdict = this.supports(intent);
    if (!verdict.ok) return this.unsupported(verdict.reason);

    const payout = intent.direction === RailDirection.PAYOUT;
    const railCost = chargeFor(intent.amount, payout ? this.b2cTariff : this.c2bTariff);

    return this.quoted({
      railCost,
      // We pass the rail's cost through unchanged. The fee engine applies our
      // own margin on top; the router compares like for like.
      customerFee: railCost,
      etaSeconds: payout ? 30 : 90, // a collection waits on the customer's PIN
      successRate: payout ? 0.985 : 0.93,
      limits: {
        min: Money.of('10.00', 'KES'),
        // Safaricom's per-transaction ceiling for a paybill/B2C.
        max: Money.of(process.env.MPESA_MAX_TRANSACTION || '250000.00', 'KES'),
      },
    });
  }

  /**
   * STK Push — prompt the customer for their PIN.
   * @param {import('../Rail.js').PaymentIntent} intent
   * @returns {Promise<import('../Rail.js').RailEvent>}
   */
  async collect(intent) {
    const phone = formatPhone(intent.instrument.msisdn);
    const shortCode = process.env.MPESA_SHORT_CODE;
    const timestamp = getTimestamp();

    const response = await darajaPost('/mpesa/stkpush/v1/processrequest', {
      BusinessShortCode: shortCode,
      Password: getPassword(shortCode, process.env.MPESA_PASSKEY, timestamp),
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      // Daraja rejects a decimal amount; STK is whole shillings only.
      Amount: Math.round(Number(intent.amount.toDecimal())),
      PartyA: phone,
      PartyB: shortCode,
      PhoneNumber: phone,
      CallBackURL: process.env.MPESA_CALLBACK_URL,
      AccountReference: (intent.reference ?? 'WALLET').slice(0, 12),
      TransactionDesc: (intent.narrative ?? 'Wallet top-up').slice(0, 20),
    });

    logger.info('M-Pesa STK push sent', {
      checkoutRequestId: response.CheckoutRequestID,
      phone: maskPhone(phone),
    });

    return {
      rail: this.key,
      // The push is out but the customer has not entered their PIN yet.
      status: RailStatus.AWAITING_CUSTOMER,
      reference: intent.reference,
      providerRef: response.CheckoutRequestID,
      amount: intent.amount,
      raw: { merchantRequestId: response.MerchantRequestID, customerMessage: response.CustomerMessage },
    };
  }

  /**
   * B2C — send money to a customer's M-Pesa.
   * @param {import('../Rail.js').PaymentIntent} intent
   * @returns {Promise<import('../Rail.js').RailEvent>}
   */
  async payout(intent) {
    const phone = formatPhone(intent.instrument.msisdn);

    const response = await darajaPost(process.env.MPESA_B2C_URL || '/mpesa/b2c/v1/paymentrequest', {
      InitiatorName: process.env.MPESA_INITIATOR_NAME,
      SecurityCredential: process.env.MPESA_INITIATOR_PASSWORD,
      CommandID: 'BusinessPayment',
      Amount: Math.round(Number(intent.amount.toDecimal())),
      PartyA: process.env.MPESA_SHORT_CODE,
      PartyB: phone,
      Remarks: (intent.narrative ?? 'Wallet withdrawal').slice(0, 100),
      QueueTimeOutURL: process.env.MPESA_B2C_QUEUE_URL,
      ResultURL: process.env.MPESA_B2C_RESULT_URL,
      Occasion: (intent.reference ?? '').slice(0, 20),
    });

    logger.info('M-Pesa B2C initiated', {
      conversationId: response.ConversationID,
      phone: maskPhone(phone),
    });

    return {
      rail: this.key,
      status: RailStatus.PROCESSING,
      reference: intent.reference,
      providerRef: response.ConversationID,
      amount: intent.amount,
      raw: { originatorConversationId: response.OriginatorConversationID },
    };
  }

  /**
   * Query an STK push. Daraja's "still being processed" error is a normal
   * intermediate state, not a failure — treating it as one would fail live
   * payments that are about to succeed.
   *
   * @param {string} providerRef  CheckoutRequestID.
   * @returns {Promise<import('../Rail.js').RailEvent>}
   */
  async status(providerRef) {
    const shortCode = process.env.MPESA_SHORT_CODE;
    const timestamp = getTimestamp();
    try {
      const result = await darajaPost('/mpesa/stkpushquery/v1/query', {
        BusinessShortCode: shortCode,
        Password: getPassword(shortCode, process.env.MPESA_PASSKEY, timestamp),
        Timestamp: timestamp,
        CheckoutRequestID: providerRef,
      });
      const code = Number(result.ResultCode);
      return {
        rail: this.key,
        providerRef,
        status: this.#statusFromResultCode(code),
        failureCode: code === 0 ? undefined : String(code),
        failureReason: code === 0 ? undefined : result.ResultDesc,
        raw: result,
      };
    } catch (err) {
      return {
        rail: this.key,
        providerRef,
        status: RailStatus.UNKNOWN,
        failureReason: err.message,
      };
    }
  }

  /**
   * Map a Daraja result code onto our lifecycle.
   * @param {number} code
   * @returns {string}
   */
  #statusFromResultCode(code) {
    if (code === 0) return RailStatus.SUCCEEDED;
    if (TERMINAL_FAILURE_CODES.has(code)) return RailStatus.FAILED;
    // Anything unrecognised is genuinely unknown. Guessing "failed" here
    // would release a reservation for money that may yet move.
    return RailStatus.UNKNOWN;
  }

  /**
   * Normalise either callback shape — STK (`Body.stkCallback`) or B2C
   * (`Result`) — into a {@link RailEvent}.
   *
   * Total by construction: an unrecognised payload yields UNKNOWN so the
   * webhook is still acknowledged and Safaricom stops retrying.
   *
   * @param {object} payload
   * @returns {import('../Rail.js').RailEvent}
   */
  parseCallback(payload) {
    const stk = payload?.Body?.stkCallback;
    if (stk?.CheckoutRequestID) return this.#parseStkCallback(stk, payload);

    const b2c = payload?.Result;
    if (b2c?.ConversationID) return this.#parseB2cResult(b2c, payload);

    return { rail: this.key, status: RailStatus.UNKNOWN, raw: payload };
  }

  /** @param {object} stk @param {object} raw */
  #parseStkCallback(stk, raw) {
    const code = Number(stk.ResultCode);
    const base = {
      rail: this.key,
      providerRef: stk.CheckoutRequestID,
      raw,
    };
    if (code !== 0) {
      return {
        ...base,
        status: this.#statusFromResultCode(code),
        failureCode: String(code),
        failureReason: stk.ResultDesc,
      };
    }

    const meta = Object.fromEntries(
      (stk.CallbackMetadata?.Item ?? []).map((i) => [i.Name, i.Value])
    );
    return {
      ...base,
      status: RailStatus.SUCCEEDED,
      receipt: meta.MpesaReceiptNumber,
      // Trust the amount Safaricom says was PAID, not what we asked for. If
      // they diverge, over-crediting is the expensive mistake.
      amount:
        meta.Amount !== undefined ? Money.ofRounded(String(meta.Amount), 'KES') : undefined,
    };
  }

  /** @param {object} result @param {object} raw */
  #parseB2cResult(result, raw) {
    const code = Number(result.ResultCode);
    const params = Object.fromEntries(
      (result.ResultParameters?.ResultParameter ?? []).map((i) => [i.Key, i.Value])
    );
    if (code !== 0) {
      return {
        rail: this.key,
        providerRef: result.ConversationID,
        status: RailStatus.FAILED,
        failureCode: String(code),
        failureReason: result.ResultDesc,
        raw,
      };
    }
    return {
      rail: this.key,
      providerRef: result.ConversationID,
      status: RailStatus.SUCCEEDED,
      receipt: params.TransactionReceipt,
      amount:
        params.TransactionAmount !== undefined
          ? Money.ofRounded(String(params.TransactionAmount), 'KES')
          : undefined,
      railCost:
        params.B2CChargesPaidAccountAvailableFunds !== undefined
          ? undefined // not a charge figure; left out rather than guessed
          : undefined,
      raw,
    };
  }

  /**
   * Safaricom signs nothing, so authentication is a shared secret on the
   * registered callback URL plus their published source IPs.
   *
   * An unset allowlist FAILS CLOSED in production: an open endpoint that
   * credits wallets is the single most valuable thing an attacker could find.
   *
   * @param {import('express').Request} req
   * @returns {{ok: boolean, reason?: string}}
   */
  verifyCallback(req) {
    const expected = process.env.MPESA_CALLBACK_SECRET;
    if (expected) {
      const provided = String(req.query?.token || req.get?.('X-Callback-Token') || '');
      const a = Buffer.from(provided);
      const b = Buffer.from(expected);
      const match = a.length === b.length && crypto.timingSafeEqual(a, b);
      if (!match) return { ok: false, reason: 'bad callback token' };
    }

    const allow = (process.env.SAFARICOM_IP_WHITELIST || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (allow.length === 0) {
      if (process.env.NODE_ENV === 'production') {
        return { ok: false, reason: 'SAFARICOM_IP_WHITELIST is empty in production' };
      }
      return { ok: true }; // sandbox source IPs vary; no real money at stake
    }

    const ip = String(req.ip || '').replace('::ffff:', '');
    return allow.includes(ip) ? { ok: true } : { ok: false, reason: `IP ${ip} not allowed` };
  }
}

export default MpesaRail;
