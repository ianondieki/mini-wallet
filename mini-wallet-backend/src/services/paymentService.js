import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { Money } from '../core/money/Money.js';
import * as flows from '../core/ledger/flows.js';
import { userAvailable, userReserved, feeRevenue } from '../core/ledger/accounts.js';
import { defaultFeeSchedule } from '../core/fees/FeeSchedule.js';
import { checkLimits, KycTier } from '../core/limits/tiers.js';
import { defaultRiskEngine, RiskDecision } from '../core/risk/engine.js';
import { RailDirection, RailStatus, InstrumentType, isTerminal } from '../rails/Rail.js';
import { execute as executeOnRail, explain as explainRoute, RoutingPolicy } from '../rails/router.js';
import { get as getRail, has as hasRail } from '../rails/registry.js';
import * as ledger from './ledgerService.js';
import * as outbox from './outboxService.js';
import { LedgerEntry } from '../models/LedgerEntry.js';
import { PaymentOrder } from '../models/PaymentOrder.js';
import { User } from '../models/User.js';
import { AppError } from '../utils/ApiError.js';
import { logger } from '../config/logger.js';
import { formatPhone } from '../utils/mpesaHelpers.js';

/**
 * Payment orchestration — the use-case layer.
 *
 * Every money movement passes through the same sequence, in this order and
 * for these reasons:
 *
 *   1. **Limits** — cheap, deterministic, and a regulatory hard stop. No
 *      point scoring risk on a transaction the licence forbids.
 *   2. **Risk** — needs history, so it runs second, and it can only add
 *      friction, never grant permission a limit refused.
 *   3. **Price** — quoted before anything moves, so the customer sees the
 *      total they will actually pay.
 *   4. **Route** — pick a rail, but only for money leaving the network.
 *   5. **Post** — the ledger entry and its outbox event commit together.
 *
 * Controllers do none of this. They parse a request, call one function here,
 * and render the result — which is what keeps the rules in one reviewable
 * place rather than duplicated across every endpoint that moves money.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/* ──────────────────────────────────────────────────────────────────────────
 * Context gathering
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Outbound volume over the rolling windows the tier limits are stated in.
 *
 * Aggregated from the journal rather than a running counter, because a
 * counter is one more thing that can drift out of step with the money.
 *
 * @param {string} userId
 * @param {string} currency
 * @returns {Promise<{daily: Money, monthly: Money, balance: Money}>}
 */
export const getUsage = async (userId, currency) => {
  const account = userAvailable(userId, currency);
  const since = new Date(Date.now() - 30 * DAY_MS);

  const [rows, balance] = await Promise.all([
    LedgerEntry.aggregate([
      { $match: { accounts: account, occurredAt: { $gte: since } } },
      { $unwind: '$postings' },
      {
        $match: {
          'postings.account': account,
          'postings.currency': currency,
          // A debit on a customer account is money leaving them.
          'postings.direction': 'debit',
        },
      },
      {
        $group: {
          _id: null,
          monthly: { $sum: '$postings.amount' },
          daily: {
            $sum: {
              $cond: [
                { $gte: ['$occurredAt', new Date(Date.now() - DAY_MS)] },
                '$postings.amount',
                0,
              ],
            },
          },
        },
      },
    ]),
    ledger.getBalance(account, currency),
  ]);

  const totals = rows[0] ?? { daily: 0, monthly: 0 };
  return {
    daily: Money.fromMinor(totals.daily, currency),
    monthly: Money.fromMinor(totals.monthly, currency),
    balance,
  };
};

/**
 * Assemble the behavioural history the risk engine scores against.
 * @param {object} params
 * @returns {Promise<import('../core/risk/engine.js').RiskContext>}
 */
const buildRiskContext = async ({ user, flow, amount, counterpartyId, device, balance }) => {
  const currency = amount.currency;
  const account = userAvailable(user.id, currency);
  const since24h = new Date(Date.now() - DAY_MS);

  const [recent, inbound, counterpartyStats, priorPayments] = await Promise.all([
    // What this account has been doing in the last day.
    LedgerEntry.aggregate([
      { $match: { accounts: account, occurredAt: { $gte: since24h } } },
      { $unwind: '$postings' },
      { $match: { 'postings.account': account, 'postings.direction': 'debit' } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          total: { $sum: '$postings.amount' },
          recipients: { $addToSet: '$metadata.toUserId' },
        },
      },
    ]),
    // Money that arrived from OTHER PEOPLE in the last hour — the
    // pass-through signal. Restricted to transfers on purpose: a customer who
    // tops up their own wallet and immediately spends it is describing the
    // ordinary use of a wallet, not a mule. Counting their own deposits here
    // would fire this rule on a large share of perfectly normal traffic.
    LedgerEntry.aggregate([
      {
        $match: {
          accounts: account,
          flow: 'transfer',
          occurredAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) },
        },
      },
      { $unwind: '$postings' },
      { $match: { 'postings.account': account, 'postings.direction': 'credit' } },
      { $group: { _id: null, total: { $sum: '$postings.amount' } } },
    ]),
    // How many different people have been paying this recipient lately.
    counterpartyId
      ? LedgerEntry.aggregate([
          {
            $match: {
              accounts: userAvailable(counterpartyId, currency),
              occurredAt: { $gte: new Date(Date.now() - 7 * DAY_MS) },
            },
          },
          { $group: { _id: null, senders: { $addToSet: '$metadata.fromUserId' } } },
        ])
      : Promise.resolve([]),
    // Has this user paid this counterparty before?
    counterpartyId
      ? LedgerEntry.countDocuments({
          'metadata.fromUserId': user.id,
          'metadata.toUserId': counterpartyId,
        })
      : Promise.resolve(0),
  ]);

  const stats = recent[0] ?? { count: 0, total: 0, recipients: [] };
  const lastEntry = await LedgerEntry.findOne({ accounts: account })
    .sort({ occurredAt: -1 })
    .skip(0)
    .lean();

  return {
    user: { createdAt: user.createdAt, tier: user.kycTier ?? KycTier.TIER_0 },
    flow,
    amount,
    balanceBefore: balance,
    counterparty: {
      id: counterpartyId,
      isNew: counterpartyId ? priorPayments === 0 : undefined,
      distinctSenders7d: counterpartyStats[0]?.senders?.filter(Boolean).length ?? 0,
    },
    history: {
      count24h: stats.count,
      volume24h: Money.fromMinor(stats.total, currency),
      averageAmount:
        stats.count > 0
          ? Money.fromMinor(Math.round(stats.total / stats.count), currency)
          : undefined,
      distinctRecipients24h: stats.recipients.filter(Boolean).length,
      inboundLast1h: Money.fromMinor(inbound[0]?.total ?? 0, currency),
      daysSinceLastActivity: lastEntry
        ? Math.floor((Date.now() - new Date(lastEntry.occurredAt).getTime()) / DAY_MS)
        : 0,
    },
    device,
    at: new Date(),
  };
};

/* ──────────────────────────────────────────────────────────────────────────
 * Gatekeeping
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Run the limit and risk gates. Throws when the transaction must not proceed,
 * returns the risk assessment when it may.
 *
 * @param {object} params
 * @returns {Promise<{risk: object, usage: object}>}
 */
const gate = async ({
  user,
  flow,
  amount,
  counterpartyId,
  device,
  inbound = false,
  // What the *risk engine* should call this movement, when that differs from
  // what the licence calls it. A refund is an outbound transfer for limits
  // and pricing, but the risk rules need to know it is a refund — see the
  // pass_through rule.
  riskFlow = flow,
}) => {
  const currency = amount.currency;
  const tier = user.kycTier ?? KycTier.TIER_0;
  const usage = await getUsage(user.id, currency);

  const limits = checkLimits({ tier, flow, amount, usage, inbound });
  if (!limits.allowed) {
    throw new AppError(limits.violations[0].message, 403, 'LIMIT_EXCEEDED', {
      violations: limits.violations.map((v) => ({
        limit: v.limit,
        cap: v.cap.toJSON(),
        available: v.available.toJSON(),
        message: v.message,
        upgradeTo: v.upgradeTo,
      })),
      remaining: limits.remaining,
    });
  }

  // Affordability, before risk. The ledger's conditional decrement remains
  // the authoritative, race-safe guard, but checking here means a customer
  // who simply does not have the money gets told exactly that — rather than
  // being asked to pass a step-up challenge for a transaction that was going
  // to fail anyway.
  if (!inbound) {
    const { fee } = defaultFeeSchedule.quote({ flow, amount, tier });
    const required = amount.plus(fee);
    if (usage.balance.lessThan(required)) {
      throw new AppError('Insufficient balance', 400, 'INSUFFICIENT_FUNDS', {
        required: required.toJSON(),
        available: usage.balance.toJSON(),
        shortfall: required.minus(usage.balance).toJSON(),
      });
    }
  }

  const risk = defaultRiskEngine.assess(
    await buildRiskContext({
      user,
      flow: riskFlow,
      amount,
      counterpartyId,
      device,
      balance: usage.balance,
    })
  );

  if (risk.decision === RiskDecision.BLOCK) {
    logger.warn('Transaction blocked by risk engine', {
      userId: user.id,
      score: risk.score,
      signals: risk.signals.map((s) => s.id),
    });
    // Deliberately vague to the customer: naming the signals teaches an
    // attacker exactly which threshold to stay under.
    throw new AppError(
      'We cannot process this transaction right now. Please contact support.',
      403,
      'RISK_BLOCKED',
      { reference: randomUUID() }
    );
  }

  if (risk.decision === RiskDecision.REVIEW) {
    throw new AppError(
      'This transaction is being reviewed and will complete shortly.',
      202,
      'RISK_REVIEW',
      { score: risk.score }
    );
  }

  if (risk.decision === RiskDecision.STEP_UP) {
    // The caller decides how to challenge; the gate only demands it.
    throw new AppError(
      'Please confirm this transaction to continue.',
      401,
      'STEP_UP_REQUIRED',
      { score: risk.score, reasons: risk.reasons }
    );
  }

  return { risk, usage };
};

/* ──────────────────────────────────────────────────────────────────────────
 * Directory
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Find a customer by phone or email. Used by the internal rail to detect an
 * on-platform recipient, and by transfers to resolve the payee.
 *
 * @param {import('../rails/Rail.js').Instrument} instrument
 * @returns {Promise<string|null>}
 */
export const resolveUserId = async (instrument) => {
  if (!instrument) return null;
  if (instrument.type === InstrumentType.INTERNAL && instrument.userId) {
    return instrument.userId;
  }
  const phone = formatPhone(instrument.msisdn ?? '');
  if (!phone) return null;
  const user = await User.findOne({ phone, isActive: true }).select('_id').lean();
  return user?._id?.toString() ?? null;
};

/**
 * Resolve a transfer recipient from an email or phone number.
 * @param {string} identifier
 * @returns {Promise<{id: string, name: string, email: string}>}
 */
export const resolveRecipient = async (identifier) => {
  const value = String(identifier ?? '').trim();
  const phone = formatPhone(value);
  const query = phone ? { phone } : { email: value.toLowerCase() };

  const user = await User.findOne({ ...query, isActive: true })
    .select('name email phone')
    .lean();
  if (!user) throw new AppError('Recipient not found', 404, 'RECIPIENT_NOT_FOUND');
  return { id: user._id.toString(), name: user.name, email: user.email };
};

/* ──────────────────────────────────────────────────────────────────────────
 * Quoting
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Price a movement before committing to it, so the customer sees the total
 * and the rail options before they confirm.
 *
 * @param {object} params
 * @param {object} params.user
 * @param {string} params.flow
 * @param {Money}  params.amount
 * @param {import('../rails/Rail.js').Instrument} [params.instrument]
 * @returns {Promise<object>}
 */
export const quote = async ({ user, flow, amount, instrument }) => {
  const tier = user.kycTier ?? KycTier.TIER_0;
  const usage = await getUsage(user.id, amount.currency);
  const limits = checkLimits({ tier, flow, amount, usage, inbound: flow === 'deposit' });

  let routing = null;
  if (flow === 'payout' && instrument) {
    routing = await explainRoute(
      {
        direction: RailDirection.PAYOUT,
        amount,
        instrument,
        country: instrument.country ?? 'KE',
        reference: `QUOTE-${randomUUID().slice(0, 8)}`,
      },
      { policy: RoutingPolicy.BALANCED }
    ).catch(() => null);
  }

  const railCost = routing?.options?.[0]
    ? Money.fromJSON(routing.options[0].customerFee)
    : undefined;
  const priced = defaultFeeSchedule.quote({
    flow,
    amount,
    rail: routing?.chosen,
    tier,
    railCost,
  });

  return {
    amount: amount.toJSON(),
    fee: priced.fee.toJSON(),
    total: amount.plus(priced.fee).toJSON(),
    feeRule: priced.ruleId,
    feeBreakdown: priced.breakdown,
    allowed: limits.allowed,
    violations: limits.violations.map((v) => ({ limit: v.limit, message: v.message, upgradeTo: v.upgradeTo })),
    remaining: limits.remaining,
    routing,
  };
};

/* ──────────────────────────────────────────────────────────────────────────
 * Transfer — wallet to wallet
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Move money between two customers. Settles instantly and atomically: no rail
 * is involved, so there is nothing to wait for and nothing to reverse.
 *
 * @param {object} params
 * @param {object} params.user            Authenticated sender.
 * @param {string} params.recipientIdentifier  Email or phone.
 * @param {Money}  params.amount
 * @param {string} [params.description]
 * @param {string} [params.idempotencyKey]
 * @param {object} [params.device]
 * @returns {Promise<object>}
 */
export const transfer = async ({
  user,
  recipientIdentifier,
  amount,
  description,
  idempotencyKey,
  device,
}) => {
  const recipient = await resolveRecipient(recipientIdentifier);
  if (recipient.id === user.id) {
    throw new AppError('You cannot transfer to yourself', 400, 'SELF_TRANSFER');
  }

  const { risk } = await gate({
    user,
    flow: 'transfer',
    amount,
    counterpartyId: recipient.id,
    device,
  });

  const { fee } = defaultFeeSchedule.quote({
    flow: 'transfer',
    amount,
    tier: user.kycTier ?? KycTier.TIER_0,
  });

  const entry = flows.transfer({
    fromUserId: user.id,
    toUserId: recipient.id,
    amount,
    fee,
    metadata: {
      description: description?.trim(),
      riskScore: risk.score,
      // Denormalised for the counterparty aggregations in buildRiskContext.
      fromUserId: user.id,
      toUserId: recipient.id,
    },
  });

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await ledger.post(entry, { session, idempotencyKey, idempotencyScope: user.id });
      // Committed with the money: if the transfer rolls back, so does this.
      await outbox.enqueue(
        {
          type: 'transfer.completed',
          entryId: entry.id,
          userId: user.id,
          payload: {
            entryId: entry.id,
            from: user.id,
            to: recipient.id,
            amount: amount.toJSON(),
            fee: fee.toJSON(),
          },
        },
        { session }
      );
    });
  } catch (err) {
    if (err?.code === 11000) {
      throw new AppError('Duplicate transfer ignored', 409, 'IDEMPOTENT_REPLAY');
    }
    throw err;
  } finally {
    await session.endSession();
  }

  logger.info('Transfer completed', {
    entryId: entry.id,
    from: user.id,
    to: recipient.id,
    amount: amount.toString(),
  });

  return {
    id: entry.id,
    amount: amount.toJSON(),
    fee: fee.toJSON(),
    total: amount.plus(fee).toJSON(),
    recipient: { name: recipient.name, email: recipient.email },
    status: 'succeeded',
    createdAt: entry.occurredAt,
  };
};

/* ──────────────────────────────────────────────────────────────────────────
 * Split payments — one debit, many credits
 * ────────────────────────────────────────────────────────────────────────── */

/** Most people a single split may pay. Past this it is a payroll run. */
const MAX_SPLIT_RECIPIENTS = 20;

/**
 * Resolve a list of recipient identifiers, rejecting the sender and any
 * duplicate. Order is preserved so the caller's shares still line up.
 *
 * @param {string} senderId
 * @param {string[]} identifiers
 * @returns {Promise<Array<{id: string, name: string, email: string}>>}
 */
const resolveMany = async (senderId, identifiers) => {
  const people = await Promise.all(identifiers.map((id) => resolveRecipient(id)));
  const seen = new Set();
  for (const person of people) {
    if (person.id === senderId) {
      throw new AppError('You cannot include yourself in a split', 400, 'SELF_TRANSFER');
    }
    if (seen.has(person.id)) {
      throw new AppError(
        `${person.name} appears twice in this split`,
        400,
        'DUPLICATE_RECIPIENT'
      );
    }
    seen.add(person.id);
  }
  return people;
};

/**
 * Pay several people at once, as a single journal entry.
 *
 * Two things make this worth having rather than a loop over
 * {@link transfer}. First, **atomicity**: paying four people in four
 * transfers can leave two paid and two not, and there is no sensible way to
 * unwind that from a client. One entry either posts in full or not at all.
 * Second, **exactness**: an even split of 100.00 three ways is not
 * 33.33 × 3, and dividing with floats either loses a cent or invents one.
 * `Money#split` uses largest-remainder apportionment, so the shares always
 * add back up to the total.
 *
 * Pricing is deliberately per-split, not per-leg: charging each recipient as
 * a separate transfer would make splitting four ways cost four times as much
 * as sending four times, which is backwards. (In the default tariff
 * in-network transfers are free anyway, so this only bites a deployment that
 * prices them.)
 *
 * @param {object}   params
 * @param {object}   params.user
 * @param {string[]} params.recipients   Emails or phone numbers.
 * @param {Money}    [params.amount]     Total, when splitting evenly.
 * @param {Money[]}  [params.shares]     Exact per-recipient amounts instead.
 * @param {string}   [params.description]
 * @param {string}   [params.idempotencyKey]
 * @param {object}   [params.device]
 * @returns {Promise<object>}
 */
export const splitPayment = async ({
  user,
  recipients,
  amount,
  shares,
  description,
  idempotencyKey,
  device,
}) => {
  if (!Array.isArray(recipients) || recipients.length < 2) {
    throw new AppError('A split needs at least two recipients', 400, 'SPLIT_TOO_SMALL');
  }
  if (recipients.length > MAX_SPLIT_RECIPIENTS) {
    throw new AppError(
      `A split can pay at most ${MAX_SPLIT_RECIPIENTS} people at once`,
      400,
      'SPLIT_TOO_LARGE'
    );
  }

  const people = await resolveMany(user.id, recipients);

  // Either the caller gave exact shares, or we apportion the total evenly.
  let amounts;
  let total;
  if (shares) {
    if (shares.length !== people.length) {
      throw new AppError(
        'Give one share per recipient, or no shares at all for an even split',
        400,
        'SHARE_COUNT_MISMATCH'
      );
    }
    amounts = shares;
    total = shares.reduce((acc, s) => acc.plus(s), Money.zero(shares[0].currency));
  } else {
    amounts = amount.split(people.length);
    total = amount;
  }

  const { risk } = await gate({
    user,
    flow: 'transfer',
    amount: total,
    // No single counterparty, so the velocity signals that key off one are
    // simply absent rather than misattributed to the first recipient.
    counterpartyId: null,
    device,
  });

  const { fee } = defaultFeeSchedule.quote({
    flow: 'transfer',
    amount: total,
    tier: user.kycTier ?? KycTier.TIER_0,
  });

  const entry = flows.splitTransfer({
    fromUserId: user.id,
    shares: people.map((person, i) => ({ userId: person.id, amount: amounts[i] })),
    fee,
    narrative: `Split of ${total} between ${people.length} people`,
    metadata: {
      description: description?.trim(),
      riskScore: risk.score,
      fromUserId: user.id,
    },
  });

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await ledger.post(entry, { session, idempotencyKey, idempotencyScope: user.id });
      await outbox.enqueue(
        {
          type: 'transfer.split.completed',
          entryId: entry.id,
          userId: user.id,
          payload: {
            entryId: entry.id,
            from: user.id,
            total: total.toJSON(),
            fee: fee.toJSON(),
            shares: people.map((person, i) => ({
              to: person.id,
              amount: amounts[i].toJSON(),
            })),
          },
        },
        { session }
      );
    });
  } catch (err) {
    if (err?.code === 11000) {
      throw new AppError('Duplicate split ignored', 409, 'IDEMPOTENT_REPLAY');
    }
    throw err;
  } finally {
    await session.endSession();
  }

  logger.info('Split payment completed', {
    entryId: entry.id,
    from: user.id,
    recipients: people.length,
    total: total.toString(),
  });

  return {
    id: entry.id,
    total: total.toJSON(),
    fee: fee.toJSON(),
    charged: total.plus(fee).toJSON(),
    shares: people.map((person, i) => ({
      recipient: { name: person.name, email: person.email },
      amount: amounts[i].toJSON(),
    })),
    status: 'succeeded',
    createdAt: entry.occurredAt,
  };
};

/* ──────────────────────────────────────────────────────────────────────────
 * Refunds — giving money back
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * How long after a transfer a *full* refund also returns the fee the payer
 * paid. Outside this window the principal comes back but the fee does not:
 * the transfer happened, it cost us to carry, and a payee who can hand back
 * the platform's revenue indefinitely is a hole in the P&L.
 */
const FEE_REFUND_WINDOW_HOURS = Number(process.env.FEE_REFUND_WINDOW_HOURS || 24);

/** Flows a refund can be issued against. */
const REFUNDABLE_FLOWS = new Set(['transfer', 'transfer.split']);

/**
 * Sum the postings of an entry that move money in one direction on one
 * account. Postings carry positive minor units and a direction, so this is
 * just a filtered fold — no sign juggling.
 *
 * @param {object} entry   A persisted LedgerEntry (lean document).
 * @param {string} account
 * @param {'debit'|'credit'} direction
 * @param {string} currency
 * @returns {Money}
 */
const sumPostings = (entry, account, direction, currency) =>
  (entry.postings ?? [])
    .filter((p) => p.account === account && p.direction === direction)
    .reduce((acc, p) => acc.plus(Money.fromMinor(p.amount, p.currency)), Money.zero(currency));

/**
 * Give back money that was received.
 *
 * A refund is **not** a reversal. A reversal says the entry should never have
 * existed and is reserved for our own mistakes; it is posted by operations and
 * mirrors the original exactly. A refund says the payment was real and the
 * payee has chosen to return it — so it is a new, forward movement, initiated
 * by the payee, and it shows up in both parties' history as its own event.
 * Conflating the two is how a ledger ends up unable to answer "did this
 * customer actually pay us in March?".
 *
 * Partial refunds are allowed and may be repeated, up to what was received.
 * The cap is derived from the ledger — the postings of the original entry
 * minus the principal of every refund already issued against it — so two
 * concurrent partial refunds cannot together exceed the original. (The
 * ledger's conditional decrement is still the authority on whether the payee
 * can afford it.)
 *
 * @param {object} params
 * @param {object} params.user          The payee, giving money back.
 * @param {string} params.entryId       The transfer being refunded.
 * @param {Money}  [params.amount]      Defaults to everything still refundable.
 * @param {string} [params.reason]
 * @param {string} [params.idempotencyKey]
 * @param {object} [params.device]
 * @returns {Promise<object>}
 */
/**
 * Work out what a customer may still refund on a payment they received, and
 * why. Shared by the refund endpoint and the read-only quote in front of it,
 * so the number the customer is shown is the number that will be enforced.
 *
 * @param {object} params
 * @param {object} params.user
 * @param {string} params.entryId
 * @returns {Promise<object>}
 */
const assessRefund = async ({ user, entryId }) => {
  const original = await LedgerEntry.findOne({ entryId }).lean();
  if (!original) throw new AppError('Transaction not found', 404, 'ENTRY_NOT_FOUND');
  if (!REFUNDABLE_FLOWS.has(original.flow)) {
    throw new AppError(
      'Only a transfer can be refunded. A deposit or withdrawal is reversed through support.',
      409,
      'NOT_REFUNDABLE'
    );
  }

  const payerId = original.metadata?.fromUserId ?? null;
  if (!payerId) {
    throw new AppError('That transaction has no identifiable payer', 409, 'NOT_REFUNDABLE');
  }
  if (payerId === user.id) {
    throw new AppError(
      'You sent this payment. Only the person who received it can refund it.',
      403,
      'NOT_THE_PAYEE'
    );
  }

  const currency = original.currencies?.[0] ?? 'KES';
  const payeeAccount = userAvailable(user.id, currency);
  const received = sumPostings(original, payeeAccount, 'credit', currency);
  if (!received.isPositive) {
    throw new AppError('You did not receive this payment', 403, 'NOT_THE_PAYEE');
  }

  // What is left to give back: received, less the principal of every refund
  // already posted against this entry. The principal is the debit against
  // *this* payee — a fee refund debits fee revenue, not the payee, so it is
  // correctly excluded.
  const priorRefunds = await LedgerEntry.find({
    flow: 'refund',
    'metadata.refundOf': entryId,
    userIds: user.id,
  }).lean();
  const alreadyRefunded = priorRefunds.reduce(
    (acc, e) => acc.plus(sumPostings(e, payeeAccount, 'debit', currency)),
    Money.zero(currency)
  );

  const originalFee = sumPostings(original, feeRevenue('transfer', currency), 'credit', currency)
    .plus(sumPostings(original, feeRevenue('split', currency), 'credit', currency));
  const ageHours = (Date.now() - new Date(original.occurredAt).getTime()) / 3_600_000;

  return {
    original,
    payerId,
    currency,
    payeeAccount,
    received,
    alreadyRefunded,
    refundable: received.minus(alreadyRefunded),
    originalFee,
    feeWindowOpen: ageHours <= FEE_REFUND_WINDOW_HOURS,
  };
};

/**
 * The read-only form: how much of a received payment is still refundable, and
 * whether the fee would come back with it. Powers the confirmation screen.
 *
 * @param {object} params
 * @param {object} params.user
 * @param {string} params.entryId
 * @returns {Promise<object>}
 */
export const refundableAmount = async ({ user, entryId }) => {
  const a = await assessRefund({ user, entryId });
  return {
    entryId,
    received: a.received.toJSON(),
    alreadyRefunded: a.alreadyRefunded.toJSON(),
    refundable: a.refundable.toJSON(),
    fullyRefunded: !a.refundable.isPositive,
    originalFee: a.originalFee.toJSON(),
    feeReturnedOnFullRefund: a.originalFee.isPositive && a.feeWindowOpen,
    feeRefundWindowHours: FEE_REFUND_WINDOW_HOURS,
    occurredAt: a.original.occurredAt,
    narrative: a.original.narrative,
  };
};

export const refundTransfer = async ({
  user,
  entryId,
  amount,
  reason,
  idempotencyKey,
  device,
}) => {
  const {
    original, payerId, currency, received, alreadyRefunded, refundable,
    originalFee, feeWindowOpen,
  } = await assessRefund({ user, entryId });
  if (!refundable.isPositive) {
    throw new AppError('This payment has already been refunded in full', 409, 'ALREADY_REFUNDED');
  }

  const principal = amount ?? refundable;
  if (principal.currency !== currency) {
    throw new AppError(`That payment was in ${currency}`, 400, 'CURRENCY_MISMATCH');
  }
  if (principal.greaterThan(refundable)) {
    throw new AppError(
      `You can refund at most ${refundable.format()} of this payment`,
      400,
      'REFUND_EXCEEDS_PAYMENT',
      {
        received: received.toJSON(),
        alreadyRefunded: alreadyRefunded.toJSON(),
        refundable: refundable.toJSON(),
      }
    );
  }

  // The fee comes back only on a full, prompt refund — and only the share of
  // it this payee's leg carried, which for an ordinary transfer is all of it
  // and for a split is proportional to what they received.
  const isFull = principal.equals(refundable) && alreadyRefunded.isZero;

  let feeRefund = Money.zero(currency);
  if (originalFee.isPositive && isFull && feeWindowOpen) {
    const totalToRecipients = (original.metadata?.toUserIds ?? [original.metadata?.toUserId])
      .filter(Boolean)
      .reduce(
        (acc, id) => acc.plus(sumPostings(original, userAvailable(id, currency), 'credit', currency)),
        Money.zero(currency)
      );
    // Apportion by what each payee received, so N partial payees cannot
    // together claim back more fee than was ever charged.
    feeRefund = totalToRecipients.isPositive
      ? originalFee.allocate([
          Number(received.minor),
          Number(totalToRecipients.minus(received).minor),
        ])[0]
      : originalFee;
  }

  // A refund is money leaving this customer's balance, so it is gated like
  // any other outbound movement: the limits are regulatory and apply to the
  // direction of travel, not the intent behind it.
  const { risk } = await gate({
    user,
    flow: 'transfer',
    riskFlow: 'refund',
    amount: principal,
    counterpartyId: payerId,
    device,
  });

  const entry = flows.refund({
    fromUserId: user.id,
    toUserId: payerId,
    amount: principal,
    feeRefund: feeRefund.isPositive ? feeRefund : undefined,
    refundOf: entryId,
    reason: reason?.trim(),
    metadata: {
      description: reason?.trim(),
      riskScore: risk.score,
      partial: !isFull,
    },
  });

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await ledger.post(entry, { session, idempotencyKey, idempotencyScope: user.id });
      await outbox.enqueue(
        {
          type: 'refund.completed',
          entryId: entry.id,
          userId: user.id,
          payload: {
            entryId: entry.id,
            refundOf: entryId,
            from: user.id,
            to: payerId,
            amount: principal.toJSON(),
            feeRefund: feeRefund.toJSON(),
          },
        },
        { session }
      );
    });
  } catch (err) {
    if (err?.code === 11000) {
      throw new AppError('Duplicate refund ignored', 409, 'IDEMPOTENT_REPLAY');
    }
    throw err;
  } finally {
    await session.endSession();
  }

  logger.info('Refund completed', {
    entryId: entry.id,
    refundOf: entryId,
    from: user.id,
    to: payerId,
    amount: principal.toString(),
  });

  return {
    id: entry.id,
    refundOf: entryId,
    amount: principal.toJSON(),
    feeRefund: feeRefund.toJSON(),
    returned: principal.plus(feeRefund).toJSON(),
    full: isFull,
    remainingRefundable: refundable.minus(principal).toJSON(),
    status: 'succeeded',
    createdAt: entry.occurredAt,
  };
};

/* ──────────────────────────────────────────────────────────────────────────
 * Deposit — money in
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Ask a rail to collect money into the wallet.
 *
 * **No ledger entry is posted here.** An unapproved STK prompt is an
 * intention, not value; crediting it would inflate both our assets and our
 * liabilities with money that may never arrive. The ledger is written when
 * the rail confirms, in {@link handleRailEvent}.
 *
 * @param {object} params
 * @returns {Promise<object>}
 */
export const initiateDeposit = async ({ user, amount, instrument, idempotencyKey, device }) => {
  await gate({ user, flow: 'deposit', amount, device, inbound: true });

  const orderId = randomUUID();
  const order = await PaymentOrder.create({
    orderId,
    userId: user.id,
    direction: RailDirection.COLLECT,
    flow: 'deposit',
    amount: { minor: amount.minor, currency: amount.currency },
    instrument,
    status: 'pending',
    idempotencyKey,
    expectedBy: new Date(Date.now() + 5 * 60 * 1000),
  });

  const intent = {
    direction: RailDirection.COLLECT,
    amount,
    instrument,
    country: instrument.country ?? 'KE',
    reference: orderId,
    narrative: 'Wallet top-up',
  };

  try {
    const { event, rail, attempts } = await executeOnRail(intent, {
      policy: RoutingPolicy.MOST_RELIABLE,
    });
    await PaymentOrder.updateOne(
      { orderId },
      {
        $set: {
          rail,
          providerRef: event.providerRef,
          status: event.status,
          attempts,
        },
      }
    );
    return {
      orderId,
      status: event.status,
      rail,
      providerRef: event.providerRef,
      message: event.raw?.customerMessage ?? 'Check your phone to authorise the payment.',
    };
  } catch (err) {
    await PaymentOrder.updateOne(
      { orderId },
      { $set: { status: 'failed', failureReason: err.message } }
    );
    throw err;
  } finally {
    void order;
  }
};

/* ──────────────────────────────────────────────────────────────────────────
 * Payout — money out
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Send money out of the wallet.
 *
 * Funds are **reserved** before the rail is called, then settled or released
 * when it answers. The previous design debited outright and relied on a
 * compensating write if the rail rejected the request — if that write was
 * lost, the customer was simply short. Here the money is visibly still theirs
 * until it demonstrably leaves.
 *
 * @param {object} params
 * @returns {Promise<object>}
 */
export const initiatePayout = async ({ user, amount, instrument, idempotencyKey, device }) => {
  const { risk } = await gate({ user, flow: 'payout', amount, device });

  const orderId = randomUUID();
  const intent = {
    direction: RailDirection.PAYOUT,
    amount,
    instrument,
    country: instrument.country ?? 'KE',
    reference: orderId,
    narrative: 'Wallet withdrawal',
  };

  // Price against the rail that will actually carry it.
  const routing = await explainRoute(intent, { policy: RoutingPolicy.BALANCED });
  const railCost = routing.options[0] ? Money.fromJSON(routing.options[0].customerFee) : undefined;
  const { fee } = defaultFeeSchedule.quote({
    flow: 'payout',
    amount,
    rail: routing.chosen,
    tier: user.kycTier ?? KycTier.TIER_0,
    railCost,
  });

  // 1. Reserve. A short balance fails here, before any rail is told anything.
  const reserveEntry = flows.reservePayout({
    userId: user.id,
    amount,
    fee,
    metadata: { orderId, riskScore: risk.score, fromUserId: user.id },
  });

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await ledger.post(reserveEntry, { session, idempotencyKey, idempotencyScope: user.id });
      await PaymentOrder.create(
        [
          {
            orderId,
            userId: user.id,
            direction: RailDirection.PAYOUT,
            flow: 'payout',
            amount: { minor: amount.minor, currency: amount.currency },
            fee: { minor: fee.minor, currency: fee.currency },
            instrument,
            status: 'pending',
            reserved: true,
            ledgerEntries: [reserveEntry.id],
            risk: { score: risk.score, decision: risk.decision, signals: risk.signals },
            idempotencyKey,
            expectedBy: new Date(Date.now() + 10 * 60 * 1000),
          },
        ],
        { session }
      );
    });
  } catch (err) {
    if (err?.code === 11000) {
      throw new AppError('Duplicate withdrawal ignored', 409, 'IDEMPOTENT_REPLAY');
    }
    throw err;
  } finally {
    await session.endSession();
  }

  // 2. Send. Anything indeterminate leaves the reservation in place for the
  //    reconciler rather than guessing.
  let result;
  try {
    result = await executeOnRail(intent, { policy: RoutingPolicy.BALANCED });
  } catch (err) {
    if (err.code === 'PAYOUT_INDETERMINATE') {
      await PaymentOrder.updateOne(
        { orderId },
        { $set: { status: 'needs_reconciliation', failureReason: err.message } }
      );
      throw err;
    }
    await failOrder({ orderId, reason: err.message });
    throw err;
  }

  await PaymentOrder.updateOne(
    { orderId },
    {
      $set: {
        rail: result.rail,
        providerRef: result.event.providerRef,
        status: result.event.status,
        attempts: result.attempts,
      },
    }
  );

  // 3. Some rails settle synchronously; most answer later by webhook.
  if (isTerminal(result.event.status)) {
    await handleRailEvent({ ...result.event, reference: orderId });
  }

  const settled = await PaymentOrder.findOne({ orderId }).lean();
  return {
    orderId,
    status: settled?.status ?? result.event.status,
    rail: result.rail,
    amount: amount.toJSON(),
    fee: fee.toJSON(),
    total: amount.plus(fee).toJSON(),
    providerRef: result.event.providerRef ?? null,
  };
};

/**
 * Mark an order failed, releasing its reservation if it has one.
 *
 * A payout holds reserved funds that must go back to the customer. A deposit
 * never moved anything, so there is nothing to reverse — but it still has to
 * reach a terminal state, or it sits in the stuck-payment sweep forever.
 *
 * @param {object} params
 * @param {string} params.orderId
 * @param {string} params.reason
 */
const failOrder = async ({ orderId, reason }) => {
  const order = await PaymentOrder.findOne({ orderId }).lean();
  if (!order) return;

  if (!order.reserved) {
    await PaymentOrder.updateOne(
      { orderId, status: { $nin: ['succeeded', 'failed', 'reversed'] } },
      { $set: { status: 'failed', failureReason: reason } }
    );
    logger.info('Order failed with nothing to reverse', { orderId, reason });
    return;
  }

  await releaseReservation({ order, reason });
};

/**
 * Return a reservation to the customer's spendable balance.
 * @param {object} params
 * @param {object} params.order
 * @param {string} params.reason
 */
const releaseReservation = async ({ order, reason }) => {
  const orderId = order.orderId;

  const amount = Money.fromMinor(order.amount.minor, order.amount.currency);
  const fee = order.fee ? Money.fromMinor(order.fee.minor, order.fee.currency) : undefined;
  const entry = flows.releasePayout({ userId: order.userId, amount, fee, reason, metadata: { orderId } });

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // Claim the release: only the first caller flips `reserved`, so a
      // retried webhook cannot refund the same reservation twice.
      const claim = await PaymentOrder.updateOne(
        { orderId, reserved: true },
        {
          $set: { reserved: false, status: 'failed', failureReason: reason },
          $push: { ledgerEntries: entry.id },
        },
        { session }
      );
      if (claim.modifiedCount !== 1) return;

      await ledger.post(entry, { session });
      await outbox.enqueue(
        {
          type: 'payout.failed',
          entryId: entry.id,
          userId: order.userId,
          payload: { orderId, amount: amount.toJSON(), reason },
        },
        { session }
      );
    });
  } finally {
    await session.endSession();
  }
  logger.warn('Payout reservation released', { orderId, reason });
};

/* ──────────────────────────────────────────────────────────────────────────
 * Rail events
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Apply a rail's verdict to the ledger.
 *
 * Idempotent by construction: the order's `status` and `reserved` flags are
 * flipped by a conditional update, and only the caller that wins that update
 * posts the entry. A provider retrying its webhook ten times credits once.
 *
 * @param {import('../rails/Rail.js').RailEvent} event
 * @returns {Promise<{handled: boolean, reason?: string}>}
 */
export const handleRailEvent = async (event) => {
  const order = await PaymentOrder.findOne(
    event.reference
      ? { orderId: event.reference }
      : { providerRef: event.providerRef, rail: event.rail }
  ).lean();

  if (!order) {
    logger.warn('Rail event for an unknown order', {
      rail: event.rail,
      providerRef: event.providerRef,
    });
    return { handled: false, reason: 'unknown order' };
  }

  if (['succeeded', 'failed', 'reversed'].includes(order.status)) {
    return { handled: false, reason: 'already terminal' };
  }

  if (!isTerminal(event.status)) {
    await PaymentOrder.updateOne({ orderId: order.orderId }, { $set: { status: event.status } });
    return { handled: true, reason: 'still in flight' };
  }

  if (event.status === RailStatus.SUCCEEDED) return settleOrder(order, event);

  await failOrder({
    orderId: order.orderId,
    reason: event.failureReason ?? 'rail declined',
  });
  return { handled: true };
};

/**
 * Post the ledger entry for a rail that confirmed.
 * @param {object} order
 * @param {import('../rails/Rail.js').RailEvent} event
 */
const settleOrder = async (order, event) => {
  const currency = order.amount.currency;
  // Trust what the rail says actually moved, not what we asked it to move.
  const amount = event.amount ?? Money.fromMinor(order.amount.minor, currency);
  const fee = order.fee ? Money.fromMinor(order.fee.minor, currency) : undefined;

  // The internal rail is not a rail: it has no float, because nothing leaves
  // the institution. Settling it like one would credit an asset nobody funds
  // and — far worse — never credit the person being paid. The router picks it
  // whenever a payout turns out to be addressed to another customer, which is
  // exactly what it is for, so this case is normal rather than exceptional.
  const recipientUserId = event.raw?.recipientUserId ?? null;
  if (order.direction === RailDirection.PAYOUT && order.rail === 'internal') {
    if (!recipientUserId || recipientUserId === order.userId) {
      logger.error('Internal payout settled without a usable recipient — parked', {
        orderId: order.orderId,
        recipientUserId,
      });
      await PaymentOrder.updateOne(
        { orderId: order.orderId, status: { $nin: ['succeeded', 'failed', 'reversed'] } },
        {
          $set: {
            status: 'needs_reconciliation',
            failureReason: 'internal payout had no recipient to credit',
          },
        }
      );
      return { handled: false, reason: 'internal payout without a recipient' };
    }
  }

  const entry =
    order.direction === RailDirection.COLLECT
      ? flows.deposit({
          userId: order.userId,
          rail: order.rail,
          amount,
          railCost: event.railCost,
          metadata: { orderId: order.orderId, receipt: event.receipt, toUserId: order.userId },
        })
      : order.rail === 'internal'
        ? flows.settleInternalPayout({
            fromUserId: order.userId,
            toUserId: recipientUserId,
            amount,
            fee,
            metadata: { orderId: order.orderId, receipt: event.receipt },
          })
        : flows.settlePayout({
            userId: order.userId,
            rail: order.rail,
            amount,
            fee,
            railCost: event.railCost,
            metadata: { orderId: order.orderId, receipt: event.receipt, fromUserId: order.userId },
          });

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // Conditional claim — the same webhook delivered twice settles once.
      const claim = await PaymentOrder.updateOne(
        { orderId: order.orderId, status: { $nin: ['succeeded', 'failed', 'reversed'] } },
        {
          $set: {
            status: 'succeeded',
            reserved: false,
            receipt: event.receipt ?? null,
            amount: { minor: amount.minor, currency },
          },
          $push: { ledgerEntries: entry.id },
        },
        { session }
      );
      if (claim.modifiedCount !== 1) return;

      await ledger.post(entry, { session });
      await outbox.enqueue(
        {
          type: order.direction === RailDirection.COLLECT ? 'deposit.settled' : 'payout.settled',
          entryId: entry.id,
          userId: order.userId,
          payload: {
            orderId: order.orderId,
            amount: amount.toJSON(),
            receipt: event.receipt,
            rail: order.rail,
          },
        },
        { session }
      );
    });
  } finally {
    await session.endSession();
  }

  logger.info('Rail settlement posted', {
    orderId: order.orderId,
    rail: order.rail,
    amount: amount.toString(),
  });
  return { handled: true };
};

/**
 * Ask the rail directly what happened — the authority of last resort when a
 * webhook never arrives.
 *
 * @param {string} orderId
 * @returns {Promise<object>}
 */
export const refreshOrderStatus = async (orderId) => {
  const order = await PaymentOrder.findOne({ orderId }).lean();
  if (!order) throw new AppError('Order not found', 404, 'ORDER_NOT_FOUND');
  if (['succeeded', 'failed', 'reversed'].includes(order.status) || !order.providerRef) {
    return order;
  }
  if (!hasRail(order.rail)) return order;

  const event = await getRail(order.rail).status(order.providerRef);
  if (isTerminal(event.status)) {
    await handleRailEvent({ ...event, reference: orderId });
  }
  return PaymentOrder.findOne({ orderId }).lean();
};

/* ──────────────────────────────────────────────────────────────────────────
 * Read models
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * A customer's balances, including anything reserved for a payout in flight.
 * @param {string} userId
 * @param {string} [currency]
 * @returns {Promise<object>}
 */
export const getBalances = async (userId, currency = 'KES') => {
  const balances = await ledger.getUserBalances(userId);
  const available = balances.available[currency] ?? Money.zero(currency);
  const reserved = balances.reserved[currency] ?? Money.zero(currency);

  return {
    currency,
    available: available.toJSON(),
    reserved: reserved.toJSON(),
    total: available.plus(reserved).toJSON(),
    // Every currency the customer holds, for a multi-currency client.
    all: Object.fromEntries(
      Object.entries(balances.available).map(([ccy, money]) => [ccy, money.toJSON()])
    ),
  };
};

export { userAvailable, userReserved };
export default {
  transfer,
  initiateDeposit,
  initiatePayout,
  handleRailEvent,
  refreshOrderStatus,
  quote,
  getBalances,
  getUsage,
  resolveUserId,
  resolveRecipient,
};
