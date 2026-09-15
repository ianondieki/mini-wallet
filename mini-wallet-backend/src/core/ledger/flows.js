import { Money } from '../money/Money.js';
import { JournalEntry, debit, credit } from './JournalEntry.js';
import {
  userAvailable,
  userReserved,
  railFloat,
  railClearing,
  feeRevenue,
  fxRevenue,
  railExpense,
  lossExpense,
  openingEquity,
} from './accounts.js';

/**
 * Posting rules — every way money is allowed to move, as balanced entries.
 *
 * This module is the entire business vocabulary of the ledger. Nothing else in
 * the codebase is permitted to hand-assemble postings; services call a flow
 * here and hand the resulting entry to the ledger writer. That keeps the
 * number of ways the books can be touched small, reviewable and testable, and
 * it means a new product is a new function here rather than balance-mutating
 * code scattered across controllers.
 *
 * Fees are always posted as their own legs rather than netted into the
 * principal, so gross volume and revenue are both directly readable off the
 * ledger instead of being reverse-engineered later.
 *
 * Every function returns an unsaved {@link JournalEntry}; persistence is the
 * caller's concern.
 */

/** Treasury FX position account — see {@link fxConvert}. */
const fxPosition = (currency) =>
  `liabilities:treasury:fx_position:${String(currency).toLowerCase()}`;

/** Guard that an amount is present, positive Money. */
const requirePositive = (amount, label) => {
  if (!Money.isMoney(amount)) throw new TypeError(`${label} must be a Money instance`);
  if (!amount.isPositive) throw new RangeError(`${label} must be positive`);
  return amount;
};

/** Treat a missing/zero fee as "no fee legs". */
const optionalFee = (fee) => (Money.isMoney(fee) && fee.isPositive ? fee : null);

/* ──────────────────────────────────────────────────────────────────────────
 * Funding in
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Customer funds their wallet and the rail has **confirmed** the money.
 *
 * Note there is deliberately no entry for "top-up initiated". An STK push
 * that the customer has not yet approved is an intention, not value; posting
 * it would inflate both our assets and our liabilities with money that may
 * never arrive. The ledger only ever records settled economic events.
 *
 * @param {object} p
 * @param {string} p.userId
 * @param {string} p.rail        Rail key, e.g. "mpesa".
 * @param {Money}  p.amount      Gross amount the customer paid.
 * @param {Money}  [p.fee]       Our fee, deducted from the credited balance.
 * @param {Money}  [p.railCost]  What the rail charges us (our expense).
 * @param {object} [p.metadata]
 * @returns {JournalEntry}
 */
export const deposit = ({ userId, rail, amount, fee, railCost, metadata = {} }) => {
  requirePositive(amount, 'amount');
  const ccy = amount.currency;
  const charged = optionalFee(fee);
  const cost = optionalFee(railCost);

  const postings = [
    // Money arrived in our float at the rail; we now owe it to the customer.
    debit(railFloat(rail, ccy), amount),
    credit(userAvailable(userId, ccy), amount),
  ];

  if (charged) {
    postings.push(
      debit(userAvailable(userId, ccy), charged),
      credit(feeRevenue(`deposit.${rail}`, ccy), charged)
    );
  }
  if (cost) {
    // The rail keeps its charge out of our float — an expense to us, not to
    // the customer, so it never touches their balance.
    postings.push(debit(railExpense(rail, ccy), cost), credit(railFloat(rail, ccy), cost));
  }

  return new JournalEntry({
    flow: 'deposit',
    narrative: `Deposit of ${amount} via ${rail}`,
    postings,
    metadata: { ...metadata, userId, rail },
  });
};

/* ──────────────────────────────────────────────────────────────────────────
 * Internal movement
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Peer-to-peer transfer between two customer balances.
 *
 * This never touches a rail: both sides are our own liabilities, so it
 * settles instantly and costs us nothing. That is the structural reason
 * in-network transfers can be free while payouts cannot.
 *
 * @param {object} p
 * @param {string} p.fromUserId
 * @param {string} p.toUserId
 * @param {Money}  p.amount   Amount the recipient receives.
 * @param {Money}  [p.fee]    Charged to the sender on top of the amount.
 * @param {object} [p.metadata]
 * @returns {JournalEntry}
 */
export const transfer = ({ fromUserId, toUserId, amount, fee, metadata = {} }) => {
  requirePositive(amount, 'amount');
  if (fromUserId === toUserId) throw new RangeError('Cannot transfer to the same user');
  const ccy = amount.currency;
  const charged = optionalFee(fee);

  const postings = [
    debit(userAvailable(fromUserId, ccy), amount),
    credit(userAvailable(toUserId, ccy), amount),
  ];
  if (charged) {
    postings.push(
      debit(userAvailable(fromUserId, ccy), charged),
      credit(feeRevenue('transfer', ccy), charged)
    );
  }

  return new JournalEntry({
    flow: 'transfer',
    narrative: `Transfer of ${amount}`,
    postings,
    metadata: { ...metadata, fromUserId, toUserId },
  });
};

/* ──────────────────────────────────────────────────────────────────────────
 * Payout out — a two-phase flow
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Phase 1 — reserve funds for a payout that is about to be sent.
 *
 * The money moves from the customer's *available* balance to their *reserved*
 * balance. It is still visibly theirs — which matters if the payout fails —
 * but it can no longer be spent twice while the rail is deciding. The
 * original code debited the balance outright and relied on a compensating
 * write if the rail rejected the request; if that compensation was lost the
 * customer was simply short.
 *
 * @param {object} p
 * @param {string} p.userId
 * @param {Money}  p.amount  Amount to be paid out.
 * @param {Money}  [p.fee]   Reserved alongside the principal.
 * @param {object} [p.metadata]
 * @returns {JournalEntry}
 */
export const reservePayout = ({ userId, amount, fee, metadata = {} }) => {
  requirePositive(amount, 'amount');
  const ccy = amount.currency;
  const charged = optionalFee(fee);
  const total = charged ? amount.plus(charged) : amount;

  return new JournalEntry({
    flow: 'payout.reserve',
    narrative: `Reserve ${total} for payout`,
    postings: [
      debit(userAvailable(userId, ccy), total),
      credit(userReserved(userId, ccy), total),
    ],
    metadata: { ...metadata, userId, principal: amount.toJSON(), fee: charged?.toJSON() ?? null },
  });
};

/**
 * Phase 2a — the rail confirmed the payout. Release the reservation, take the
 * fee as revenue and reduce our float by what actually left.
 *
 * @param {object} p
 * @param {string} p.userId
 * @param {string} p.rail
 * @param {Money}  p.amount
 * @param {Money}  [p.fee]
 * @param {Money}  [p.railCost]
 * @param {object} [p.metadata]
 * @returns {JournalEntry}
 */
export const settlePayout = ({ userId, rail, amount, fee, railCost, metadata = {} }) => {
  requirePositive(amount, 'amount');
  const ccy = amount.currency;
  const charged = optionalFee(fee);
  const cost = optionalFee(railCost);
  const total = charged ? amount.plus(charged) : amount;

  const postings = [
    debit(userReserved(userId, ccy), total),
    credit(railFloat(rail, ccy), amount),
  ];
  if (charged) postings.push(credit(feeRevenue(`payout.${rail}`, ccy), charged));
  if (cost) {
    postings.push(debit(railExpense(rail, ccy), cost), credit(railFloat(rail, ccy), cost));
  }

  return new JournalEntry({
    flow: 'payout.settle',
    narrative: `Payout of ${amount} via ${rail} settled`,
    postings,
    metadata: { ...metadata, userId, rail },
  });
};

/**
 * Phase 2b — the rail rejected or timed out. Return the reservation to the
 * customer's spendable balance in full; we charge nothing for work we did not
 * do.
 *
 * @param {object} p
 * @param {string} p.userId
 * @param {Money}  p.amount
 * @param {Money}  [p.fee]
 * @param {string} [p.reason]
 * @param {object} [p.metadata]
 * @returns {JournalEntry}
 */
export const releasePayout = ({ userId, amount, fee, reason = 'payout failed', metadata = {} }) => {
  requirePositive(amount, 'amount');
  const ccy = amount.currency;
  const charged = optionalFee(fee);
  const total = charged ? amount.plus(charged) : amount;

  return new JournalEntry({
    flow: 'payout.release',
    narrative: `Release ${total} — ${reason}`,
    postings: [
      debit(userReserved(userId, ccy), total),
      credit(userAvailable(userId, ccy), total),
    ],
    metadata: { ...metadata, userId, reason },
  });
};

/* ──────────────────────────────────────────────────────────────────────────
 * FX
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Convert between two of a customer's balances.
 *
 * Each currency balances independently against a **treasury FX position**
 * account. After the trade the book is long the sold currency and short the
 * bought one; the treasury squares that off in the market on its own cycle.
 * Our margin is realised immediately as the difference between what the
 * customer received and what the mid-market rate would have given them —
 * which is exactly the number Wise publishes, and the only honest way to
 * report an FX spread.
 *
 * @param {object} p
 * @param {string} p.userId
 * @param {Money}  p.from       Amount debited from the source balance.
 * @param {Money}  p.to         Amount credited to the destination balance.
 * @param {Money}  p.midMarket  What `from` is worth at mid — must be in the
 *                              destination currency and ≥ `to`.
 * @param {object} [p.metadata]
 * @returns {JournalEntry}
 */
export const fxConvert = ({ userId, from, to, midMarket, metadata = {} }) => {
  requirePositive(from, 'from');
  requirePositive(to, 'to');
  requirePositive(midMarket, 'midMarket');
  if (from.currency === to.currency) {
    throw new RangeError('fxConvert needs two different currencies');
  }
  if (midMarket.currency !== to.currency) {
    throw new RangeError('midMarket must be quoted in the destination currency');
  }
  if (midMarket.lessThan(to)) {
    throw new RangeError('Customer cannot receive more than the mid-market amount');
  }

  const spread = midMarket.minus(to);
  const postings = [
    // Sold-currency leg.
    debit(userAvailable(userId, from.currency), from),
    credit(fxPosition(from.currency), from),
    // Bought-currency leg.
    debit(fxPosition(to.currency), midMarket),
    credit(userAvailable(userId, to.currency), to),
  ];
  if (spread.isPositive) postings.push(credit(fxRevenue(to.currency), spread));

  return new JournalEntry({
    flow: 'fx.convert',
    narrative: `Convert ${from} to ${to}`,
    postings,
    metadata: { ...metadata, userId, spread: spread.toJSON() },
  });
};

/* ──────────────────────────────────────────────────────────────────────────
 * Treasury & corrections
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The rail swept its float to our bank account (or the reverse).
 * @param {object} p
 * @param {string} p.rail
 * @param {Money}  p.amount
 * @param {object} [p.metadata]
 * @returns {JournalEntry}
 */
export const railSettlement = ({ rail, amount, metadata = {} }) => {
  requirePositive(amount, 'amount');
  const ccy = amount.currency;
  return new JournalEntry({
    flow: 'treasury.rail_settlement',
    narrative: `Settlement of ${amount} from ${rail}`,
    postings: [
      debit(railClearing(rail, ccy), amount),
      credit(railFloat(rail, ccy), amount),
    ],
    metadata: { ...metadata, rail },
  });
};

/**
 * Seed an account with an opening balance. Restricted to migration and
 * treasury funding — the offsetting leg is equity, so the money is declared
 * rather than invented.
 *
 * @param {object} p
 * @param {string} p.account
 * @param {Money}  p.amount
 * @param {string} [p.reason]
 * @param {object} [p.metadata]
 * @returns {JournalEntry}
 */
export const openingBalance = ({ account, amount, reason = 'opening balance', metadata = {} }) => {
  requirePositive(amount, 'amount');
  const ccy = amount.currency;
  return new JournalEntry({
    flow: 'opening_balance',
    narrative: reason,
    postings: [debit(openingEquity(ccy), amount), credit(account, amount)],
    metadata,
  });
};

/**
 * Absorb a shortfall we cannot recover — a rail that took money and never
 * delivered, a goodwill refund, an unrecoverable reversal.
 *
 * Booking it as an explicit expense is the point: the loss lands in the P&L
 * where someone has to look at it, instead of being quietly netted out of a
 * customer balance where it would look like an accounting error.
 *
 * @param {object} p
 * @param {string} p.account  Account being made whole.
 * @param {Money}  p.amount
 * @param {string} p.reason
 * @param {object} [p.metadata]
 * @returns {JournalEntry}
 */
export const writeOff = ({ account, amount, reason, metadata = {} }) => {
  requirePositive(amount, 'amount');
  const ccy = amount.currency;
  return new JournalEntry({
    flow: 'writeoff',
    narrative: `Write-off: ${reason}`,
    postings: [debit(lossExpense(ccy), amount), credit(account, amount)],
    metadata: { ...metadata, reason },
  });
};

export default {
  deposit,
  transfer,
  reservePayout,
  settlePayout,
  releasePayout,
  fxConvert,
  railSettlement,
  openingBalance,
  writeOff,
};
