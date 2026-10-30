import { Money } from '../core/money/Money.js';
import { PaymentOrder } from '../models/PaymentOrder.js';
import * as payments from '../services/paymentService.js';
import { describeAll } from '../rails/registry.js';
import { InstrumentType, RailStatus } from '../rails/Rail.js';
import { AppError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { formatPhone } from '../utils/mpesaHelpers.js';

/**
 * Deposits and payouts.
 *
 * Rail-agnostic: the customer supplies an *instrument* — a phone number, a
 * bank account, a SACCO membership — and the router decides what carries it.
 * The M-Pesa-shaped endpoints are kept as a thin compatibility layer over the
 * same functions, because the existing client and, more importantly, the
 * callback URLs registered with Safaricom both point at those paths.
 */

const DEFAULT_CURRENCY = process.env.DEFAULT_CURRENCY || 'KES';

/** Our lifecycle → the `success|failed|pending` the existing client polls for. */
const LEGACY_STATUS = {
  [RailStatus.SUCCEEDED]: 'success',
  [RailStatus.FAILED]: 'failed',
  [RailStatus.REVERSED]: 'failed',
  succeeded: 'success',
  failed: 'failed',
  reversed: 'failed',
};
const toLegacyStatus = (status) => LEGACY_STATUS[status] ?? 'pending';

/** @param {unknown} value @param {string} currency @returns {Money} */
const parseAmount = (value, currency) => {
  let amount;
  try {
    amount = Money.ofRounded(String(value), currency);
  } catch (err) {
    throw new AppError(`Invalid amount: ${err.message}`, 400, 'INVALID_AMOUNT');
  }
  if (!amount.isPositive) {
    throw new AppError('Amount must be greater than zero', 400, 'INVALID_AMOUNT');
  }
  return amount;
};

/**
 * Build an instrument from a request body, accepting either the explicit
 * `instrument` object or the legacy bare `phone` field.
 *
 * @param {object} body
 * @returns {import('../rails/Rail.js').Instrument}
 */
const parseInstrument = (body) => {
  if (body.instrument && typeof body.instrument === 'object') {
    const instrument = { ...body.instrument };
    if (instrument.type === InstrumentType.MSISDN) {
      const phone = formatPhone(instrument.msisdn);
      if (!phone) throw new AppError('Invalid phone number', 400, 'INVALID_PHONE');
      instrument.msisdn = phone;
    }
    return instrument;
  }

  const phone = formatPhone(body.phone);
  if (!phone) throw new AppError('Invalid phone number', 400, 'INVALID_PHONE');
  return { type: InstrumentType.MSISDN, msisdn: phone, country: 'KE' };
};

/** Reject a deactivated or frozen customer with the specific reason. */
const assertCanTransact = (user) => {
  const verdict = user.canTransact();
  if (!verdict.ok) throw new AppError(verdict.reason, 403, verdict.code);
};

/**
 * Start a deposit. Nothing is credited here — the ledger is written when the
 * rail confirms the money actually arrived.
 *
 * @route POST /api/payments/deposit
 * @route POST /api/mpesa/topup  (compatibility)
 */
export const deposit = asyncHandler(async (req, res) => {
  assertCanTransact(req.user);
  const currency = String(req.body.currency || DEFAULT_CURRENCY).toUpperCase();
  const amount = parseAmount(req.body.amount, currency);
  const instrument = parseInstrument(req.body);

  const result = await payments.initiateDeposit({
    user: req.user,
    amount,
    instrument,
    idempotencyKey: req.idempotencyKey,
    device: req.device,
  });

  res.status(201).json({
    success: true,
    message: result.message,
    data: {
      orderId: result.orderId,
      rail: result.rail,
      status: toLegacyStatus(result.status),
      // The existing client polls on `checkoutRequestId`.
      checkoutRequestId: result.providerRef,
      providerRef: result.providerRef,
      customerMessage: result.message,
    },
  });
});

/**
 * Start a payout. Funds are reserved before the rail is called and only
 * settle once it confirms.
 *
 * @route POST /api/payments/payout
 * @route POST /api/mpesa/withdraw  (compatibility)
 */
export const payout = asyncHandler(async (req, res) => {
  assertCanTransact(req.user);
  const currency = String(req.body.currency || DEFAULT_CURRENCY).toUpperCase();
  const amount = parseAmount(req.body.amount, currency);
  const instrument = parseInstrument(req.body);

  const result = await payments.initiatePayout({
    user: req.user,
    amount,
    instrument,
    idempotencyKey: req.idempotencyKey,
    device: req.device,
  });

  res.status(201).json({
    success: true,
    message:
      result.status === 'succeeded'
        ? 'Withdrawal complete.'
        : 'Withdrawal initiated. You will receive the funds shortly.',
    data: {
      orderId: result.orderId,
      transactionId: result.orderId, // legacy field name
      rail: result.rail,
      status: toLegacyStatus(result.status),
      amount: Number(result.amount.amount),
      fee: Number(result.fee.amount),
      total: Number(result.total.amount),
      currency,
    },
  });
});

/**
 * Status of a payment, by our order id or the provider's reference.
 *
 * Falls back to querying the rail when the stored state is not yet terminal,
 * so a lost webhook resolves itself the moment the customer looks.
 *
 * @route GET /api/payments/orders/:reference
 * @route GET /api/mpesa/status/:checkoutRequestId  (compatibility)
 */
export const getOrder = asyncHandler(async (req, res) => {
  const reference = req.params.reference ?? req.params.checkoutRequestId;

  const order = await PaymentOrder.findOne({
    userId: req.userId, // scope to the caller — no peeking at others' payments
    $or: [{ orderId: reference }, { providerRef: reference }],
  }).lean();

  if (!order) throw new AppError('Transaction not found', 404, 'TXN_NOT_FOUND');

  const fresh = ['succeeded', 'failed', 'reversed'].includes(order.status)
    ? order
    : await payments.refreshOrderStatus(order.orderId);

  const amount = Money.fromMinor(fresh.amount.minor, fresh.amount.currency);
  res.json({
    success: true,
    data: {
      orderId: fresh.orderId,
      status: toLegacyStatus(fresh.status),
      detailedStatus: fresh.status,
      amount: Number(amount.toDecimal()),
      currency: amount.currency,
      receipt: fresh.receipt ?? null,
      rail: fresh.rail,
      failureReason: fresh.failureReason ?? null,
      source: fresh === order ? 'db' : 'rail',
    },
  });
});

/**
 * The rails this deployment can route over, with live health.
 *
 * Public because it is a capability catalogue, not customer data — and a
 * client that knows which instruments are reachable can collect the right
 * details up front instead of failing at submission.
 *
 * @route GET /api/payments/rails
 */
export const listRails = asyncHandler(async (_req, res) => {
  res.json({ success: true, data: { rails: describeAll() } });
});
