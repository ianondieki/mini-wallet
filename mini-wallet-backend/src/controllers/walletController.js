import { Money } from '../core/money/Money.js';
import { User } from '../models/User.js';
import { PaymentOrder } from '../models/PaymentOrder.js';
import * as payments from '../services/paymentService.js';
import * as ledger from '../services/ledgerService.js';
import { limitsFor, KycTier } from '../core/limits/tiers.js';
import { defaultFeeSchedule } from '../core/fees/FeeSchedule.js';
import { AppError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

/**
 * Wallet endpoints.
 *
 * These now read from the ledger rather than a balance field, but the
 * response shapes are unchanged — `balance` is still a plain number of
 * shillings and a transaction row still has `type`, `status` and `direction`.
 * The existing client keeps working untouched; the richer `Money` objects are
 * added alongside for clients that want exactness.
 *
 * The mapping between ledger flows and the legacy vocabulary is confined to
 * this file. It is a presentation concern, and it does not leak into the
 * domain.
 */

/** Default currency for clients that do not specify one. */
const DEFAULT_CURRENCY = process.env.DEFAULT_CURRENCY || 'KES';

/** Ledger flow → the `type` the existing client understands. */
const LEGACY_TYPE = {
  deposit: 'topup',
  transfer: 'transfer',
  'payout.reserve': 'withdrawal',
  'payout.release': 'withdrawal',
  'payout.settle': 'withdrawal',
  'fx.convert': 'fx',
};

/** Legacy `type` filter → the ledger flows it covers. */
const FLOW_FOR_LEGACY_TYPE = {
  topup: 'deposit',
  transfer: 'transfer',
  withdrawal: 'payout.reserve',
};

/**
 * Resolve the currency for a request, rejecting anything the customer cannot
 * legitimately hold.
 * @param {import('express').Request} req
 */
const currencyOf = (req) => String(req.query.currency || DEFAULT_CURRENCY).toUpperCase();

/**
 * Parse a user-supplied amount into Money, rejecting the many ways a bad one
 * arrives: negative, zero, non-numeric, or more precision than the currency
 * has.
 *
 * @param {unknown} value
 * @param {string} currency
 * @returns {Money}
 */
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

/** Reject a customer who is deactivated or frozen, with the specific reason. */
const assertCanTransact = (user) => {
  const verdict = user.canTransact();
  if (!verdict.ok) throw new AppError(verdict.reason, 403, verdict.code);
};

/**
 * Balance, including anything reserved for a payout in flight.
 * @route GET /api/wallet/balance
 */
export const getBalance = asyncHandler(async (req, res) => {
  const currency = currencyOf(req);
  const balances = await payments.getBalances(req.userId, currency);

  res.json({
    success: true,
    data: {
      // Legacy shape: a plain number in major units.
      balance: Number(balances.available.amount),
      currency: balances.currency,
      // Exact forms, and money that is committed but not yet gone.
      available: balances.available,
      reserved: balances.reserved,
      total: balances.total,
      balances: balances.all,
    },
  });
});

/**
 * What this customer may do right now: their tier, their headroom, and the
 * tariff. Powers the "why can't I send this?" and "what will this cost?"
 * screens without either being a guess on the client.
 *
 * @route GET /api/wallet/limits
 */
export const getLimits = asyncHandler(async (req, res) => {
  const currency = currencyOf(req);
  const tier = req.user.kycTier ?? KycTier.TIER_0;
  const [usage, limits] = await Promise.all([
    payments.getUsage(req.userId, currency),
    Promise.resolve(limitsFor(tier, currency)),
  ]);

  const headroom = (cap, used) => Money.max(cap.minus(used), Money.zero(currency)).toJSON();

  res.json({
    success: true,
    data: {
      tier,
      tierLabel: limits.label,
      currency,
      limits: {
        perTransaction: limits.perTransaction.toJSON(),
        daily: limits.daily.toJSON(),
        monthly: limits.monthly.toJSON(),
        maxBalance: limits.maxBalance.toJSON(),
      },
      used: { daily: usage.daily.toJSON(), monthly: usage.monthly.toJSON() },
      remaining: {
        daily: headroom(limits.daily, usage.daily),
        monthly: headroom(limits.monthly, usage.monthly),
        balance: headroom(limits.maxBalance, usage.balance),
      },
      tariff: defaultFeeSchedule.publish(currency),
    },
  });
});

/**
 * Price a movement before the customer commits to it.
 * @route POST /api/wallet/quote
 */
export const getQuote = asyncHandler(async (req, res) => {
  const currency = String(req.body.currency || DEFAULT_CURRENCY).toUpperCase();
  const amount = parseAmount(req.body.amount, currency);
  const flow = String(req.body.flow || 'transfer');

  const quote = await payments.quote({
    user: req.user,
    flow,
    amount,
    instrument: req.body.instrument,
  });

  res.json({ success: true, data: quote });
});

/**
 * Peer-to-peer transfer.
 * @route POST /api/wallet/transfer
 */
export const transfer = asyncHandler(async (req, res) => {
  assertCanTransact(req.user);

  const currency = String(req.body.currency || DEFAULT_CURRENCY).toUpperCase();
  const amount = parseAmount(req.body.amount, currency);
  // `recipientEmail` is what the existing client sends; `recipient` also
  // accepts a phone number.
  const identifier = req.body.recipient ?? req.body.recipientEmail;
  if (!identifier) {
    throw new AppError('A recipient email or phone number is required', 400, 'RECIPIENT_REQUIRED');
  }

  const result = await payments.transfer({
    user: req.user,
    recipientIdentifier: identifier,
    amount,
    description: req.body.description,
    idempotencyKey: req.idempotencyKey,
    device: req.device,
  });

  res.status(201).json({
    success: true,
    message: 'Transfer successful',
    data: {
      transaction: {
        id: result.id,
        amount: Number(result.amount.amount),
        fee: Number(result.fee.amount),
        total: Number(result.total.amount),
        currency,
        recipient: result.recipient,
        status: 'success',
        createdAt: result.createdAt,
      },
    },
  });
});

/**
 * Transaction history.
 *
 * In-flight payments are prepended on the first page rather than hidden until
 * they settle: a customer who has just authorised a withdrawal expects to see
 * it, and "it vanished for ten minutes" is indistinguishable from "it failed"
 * from their side.
 *
 * @route GET /api/wallet/transactions
 */
export const getTransactions = asyncHandler(async (req, res) => {
  const { page = 1, limit = 10, type, status } = req.query;
  const currency = currencyOf(req);
  const pageNumber = Math.max(1, Number.parseInt(page, 10) || 1);

  const history = await ledger.getUserHistory(req.userId, {
    page: pageNumber,
    limit,
    currency,
    flow: type ? FLOW_FOR_LEGACY_TYPE[type] : undefined,
  });

  // Names for the counterparties referenced in this page.
  const counterpartyIds = [
    ...new Set(
      history.items
        .flatMap((i) => [i.metadata?.fromUserId, i.metadata?.toUserId])
        .filter((id) => id && id !== req.userId)
    ),
  ];
  const people = await User.find({ _id: { $in: counterpartyIds } })
    .select('name email')
    .lean();
  const byId = new Map(people.map((p) => [p._id.toString(), { name: p.name, email: p.email }]));
  const self = { name: req.user.name, email: req.user.email };

  const settled = history.items.map((item) => {
    const from = item.metadata?.fromUserId;
    const to = item.metadata?.toUserId;
    return {
      id: item.id,
      type: LEGACY_TYPE[item.flow] ?? item.flow,
      status: item.flow === 'payout.release' ? 'reversed' : 'success',
      amount: Number(item.amount.amount),
      currency: item.amount.currency,
      direction: item.direction,
      description: item.metadata?.description ?? item.narrative,
      sender: from ? (from === req.userId ? self : byId.get(from) ?? null) : null,
      receiver: to ? (to === req.userId ? self : byId.get(to) ?? null) : null,
      mpesaReceiptNumber: item.metadata?.receipt ?? null,
      createdAt: item.occurredAt,
      flow: item.flow,
    };
  });

  let pending = [];
  if (pageNumber === 1 && !status) {
    const orders = await PaymentOrder.find({
      userId: req.userId,
      status: { $nin: ['succeeded', 'failed', 'reversed'] },
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    pending = orders.map((order) => ({
      id: order.orderId,
      type: order.direction === 'collect' ? 'topup' : 'withdrawal',
      status: 'pending',
      amount: Number(Money.fromMinor(order.amount.minor, order.amount.currency).toDecimal()),
      currency: order.amount.currency,
      direction: order.direction === 'collect' ? 'credit' : 'debit',
      description: order.flow === 'deposit' ? 'Wallet top-up' : 'Wallet withdrawal',
      sender: null,
      receiver: null,
      mpesaReceiptNumber: null,
      createdAt: order.createdAt,
      rail: order.rail,
      orderId: order.orderId,
    }));
  }

  const transactions = [...pending, ...settled].filter(
    (t) => !status || t.status === status
  );

  res.json({
    success: true,
    data: {
      transactions,
      pagination: {
        ...history.pagination,
        total: history.pagination.total + pending.length,
      },
    },
  });
});

/**
 * Search customers to pick a transfer recipient.
 * @route GET /api/wallet/recipients?q=
 */
export const searchRecipients = asyncHandler(async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) {
    return res.json({ success: true, data: { recipients: [] } });
  }
  // Escape regex metacharacters so a search string cannot become a pattern.
  const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = new RegExp(safe, 'i');

  const users = await User.find({
    _id: { $ne: req.userId },
    isActive: true,
    $or: [{ email: rx }, { name: rx }, { phone: rx }],
  })
    .select('name email')
    .limit(8)
    .lean();

  res.json({
    success: true,
    data: {
      recipients: users.map((u) => ({ id: u._id, name: u.name, email: u.email })),
    },
  });
});
