import mongoose from 'mongoose';
import { LedgerEntry } from '../models/LedgerEntry.js';
import { AccountBalance } from '../models/AccountBalance.js';
import { Money } from '../core/money/Money.js';
import { JournalEntry, foldBalances } from '../core/ledger/JournalEntry.js';
import { signFor, userIdFromAccount, parseAccount } from '../core/ledger/accounts.js';
import { AppError } from '../utils/ApiError.js';
import { logger } from '../config/logger.js';

/**
 * The only way anything is written to the books.
 *
 * `post()` takes a domain {@link JournalEntry} — already proven to balance —
 * and commits it together with the balance updates it implies, inside one
 * MongoDB transaction. Either the entry and every balance move, or nothing
 * does. There is no code path that writes a balance without an entry.
 *
 * Overdraft protection is a *conditional* update, not a read-then-write:
 * the decrement only matches a document whose balance is already large
 * enough. Two concurrent withdrawals of the last shilling cannot both match,
 * so the second fails cleanly rather than racing to a negative balance.
 */

/**
 * Accounts that may never go negative. Customer balances, obviously: we
 * cannot owe a customer a negative amount, and letting one drift below zero
 * is how a wallet accidentally becomes an unsecured lender.
 *
 * Treasury FX positions are deliberately NOT guarded — being short a currency
 * between trade and settlement is the normal state of an FX book, and forcing
 * it positive would misrepresent the position.
 */
const NON_NEGATIVE = /^liabilities:user:/;

/** Cap on how far a rail float may go negative before we refuse to post. */
const FLOAT_ALERT = /^assets:rail:/;

/**
 * Fold an entry into `(account, currency) → signed minor-unit delta`.
 * @param {JournalEntry} entry
 * @returns {Array<{account: string, currency: string, delta: number, postings: number}>}
 */
const deltasFor = (entry) => {
  /** @type {Map<string, {account: string, currency: string, delta: bigint, postings: number}>} */
  const map = new Map();
  for (const posting of entry.postings) {
    const currency = posting.amount.currency;
    const key = `${posting.account}|${currency}`;
    const signed = posting.amount.minorBigInt * BigInt(signFor(posting.account, posting.direction));
    const existing = map.get(key);
    if (existing) {
      existing.delta += signed;
      existing.postings += 1;
    } else {
      map.set(key, { account: posting.account, currency, delta: signed, postings: 1 });
    }
  }

  return [...map.values()].map((d) => {
    const delta = Number(d.delta);
    if (!Number.isSafeInteger(delta)) {
      throw new AppError(
        `Balance delta for ${d.account} exceeds safe integer range`,
        500,
        'LEDGER_OVERFLOW'
      );
    }
    return { ...d, delta };
  });
};

/**
 * Apply one account's delta, enforcing the non-negative guard where it applies.
 * @param {{account: string, currency: string, delta: number, postings: number}} d
 * @param {string} entryId
 * @param {import('mongoose').ClientSession} session
 */
const applyDelta = async (d, entryId, session) => {
  const { account, currency, delta, postings } = d;
  const update = {
    $inc: { minor: delta, postingCount: postings },
    $set: { lastEntryId: entryId },
    $setOnInsert: { account, currency, userId: userIdFromAccount(account) },
  };

  if (delta < 0 && NON_NEGATIVE.test(account)) {
    // Conditional decrement: only matches if the funds are actually there.
    // No row at all means a zero balance, which also correctly fails.
    const result = await AccountBalance.updateOne(
      { account, currency, minor: { $gte: -delta } },
      { $inc: { minor: delta, postingCount: postings }, $set: { lastEntryId: entryId } },
      { session }
    );
    if (result.matchedCount !== 1) {
      throw new AppError('Insufficient balance', 400, 'INSUFFICIENT_FUNDS', {
        account,
        currency,
        required: Money.fromMinor(-delta, currency).toJSON(),
      });
    }
    return;
  }

  await AccountBalance.updateOne({ account, currency }, update, { session, upsert: true });

  // A rail float going negative means we are paying out money we do not hold
  // there. It is not always wrong (settlement lag), but it must never pass
  // unnoticed.
  if (delta < 0 && FLOAT_ALERT.test(account)) {
    const row = await AccountBalance.findOne({ account, currency }).session(session).lean();
    if (row && row.minor < 0) {
      logger.error('Rail float is negative — funding shortfall', {
        account,
        currency,
        balance: row.minor,
        entryId,
      });
    }
  }
};

/**
 * Commit a journal entry and the balances it implies.
 *
 * @param {JournalEntry} entry
 * @param {object} [options]
 * @param {import('mongoose').ClientSession} [options.session]  Join an
 *   existing transaction instead of opening one — used when a posting must
 *   commit atomically with other writes (e.g. a rail transfer record).
 * @param {string} [options.idempotencyKey]
 * @returns {Promise<JournalEntry>} The entry as committed.
 */
export const post = async (entry, { session: outerSession, idempotencyKey } = {}) => {
  if (!(entry instanceof JournalEntry)) {
    throw new TypeError('ledgerService.post expects a JournalEntry');
  }

  const deltas = deltasFor(entry);
  const doc = {
    ...entry.toJSON(),
    entryId: entry.id,
    accounts: entry.accounts,
    userIds: [...new Set(entry.accounts.map(userIdFromAccount).filter(Boolean))],
    currencies: entry.currencies,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
  delete doc.id;

  /** @param {import('mongoose').ClientSession} session */
  const work = async (session) => {
    // The entry lands first: if a balance guard then rejects, the whole
    // transaction aborts and the entry goes with it.
    await LedgerEntry.create([doc], { session });
    for (const delta of deltas) {
      await applyDelta(delta, entry.id, session);
    }
  };

  if (outerSession) {
    await work(outerSession);
  } else {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(() => work(session));
    } catch (err) {
      if (err?.code === 11000) {
        throw new AppError('Duplicate ledger entry ignored', 409, 'IDEMPOTENT_REPLAY');
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }

  logger.info('Ledger entry posted', {
    entryId: entry.id,
    flow: entry.flow,
    accounts: entry.accounts.length,
  });
  return entry;
};

/**
 * Current balance of one account.
 * @param {string} account
 * @param {string} currency
 * @param {object} [opts]
 * @param {import('mongoose').ClientSession} [opts.session]
 * @returns {Promise<Money>}
 */
export const getBalance = async (account, currency, { session } = {}) => {
  parseAccount(account);
  const query = AccountBalance.findOne({ account, currency });
  if (session) query.session(session);
  const row = await query.lean();
  return Money.fromMinor(row?.minor ?? 0, currency);
};

/**
 * Every balance a user holds, keyed by "available"/"reserved" and currency.
 * @param {string} userId
 * @returns {Promise<{available: Record<string, Money>, reserved: Record<string, Money>}>}
 */
export const getUserBalances = async (userId) => {
  const rows = await AccountBalance.find({ userId }).lean();
  const out = { available: {}, reserved: {} };
  for (const row of rows) {
    const bucket = row.account.includes(':reserved:') ? 'reserved' : 'available';
    out[bucket][row.currency] = Money.fromMinor(row.minor, row.currency);
  }
  return out;
};

/**
 * Replay an account's postings from the journal and return the true balance.
 * This is the check that the cached balance cannot fake.
 *
 * @param {string} account
 * @param {string} currency
 * @returns {Promise<{derived: Money, cached: Money, drift: Money, postings: number}>}
 */
export const deriveBalance = async (account, currency) => {
  const docs = await LedgerEntry.find({ accounts: account }).lean();
  const entries = docs.map((d) => JournalEntry.fromJSON({ ...d, id: d.entryId }));
  const folded = foldBalances(entries);
  const derived = folded.get(`${account}|${currency}`) ?? Money.zero(currency);
  const cached = await getBalance(account, currency);
  return {
    derived,
    cached,
    drift: cached.minus(derived),
    postings: entries.reduce(
      (n, e) => n + e.postings.filter((p) => p.account === account).length,
      0
    ),
  };
};

/**
 * Trial balance: every account's cached balance, plus the signed total that
 * must come to zero if the books are sound.
 *
 * @param {string} [currency]
 * @returns {Promise<{accounts: object[], net: Money, balanced: boolean}>}
 */
export const trialBalance = async (currency = 'KES') => {
  const rows = await AccountBalance.find({ currency }).sort({ account: 1 }).lean();

  let net = 0n;
  const accounts = rows.map((row) => {
    const { type, normalBalance } = parseAccount(row.account);
    // Convert every natural balance to a signed debit-positive figure, which
    // is the form that must sum to zero across the whole book.
    const debitPositive = BigInt(row.minor) * (normalBalance === 'debit' ? 1n : -1n);
    net += debitPositive;
    return {
      account: row.account,
      type,
      balance: Money.fromMinor(row.minor, currency).toJSON(),
      debitPositive: Number(debitPositive),
      postingCount: row.postingCount,
    };
  });

  return {
    accounts,
    net: Money.fromMinor(Number(net), currency),
    balanced: net === 0n,
  };
};

/**
 * Paginated ledger history for a user, rendered from their point of view.
 * @param {string} userId
 * @param {object} [opts]
 * @param {number} [opts.page]
 * @param {number} [opts.limit]
 * @param {string} [opts.flow]
 * @param {string} [opts.currency]
 * @returns {Promise<{items: object[], pagination: object}>}
 */
export const getUserHistory = async (userId, { page = 1, limit = 20, flow, currency } = {}) => {
  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
  const filter = { userIds: userId };
  if (flow) filter.flow = flow;
  if (currency) filter.currencies = currency;

  const [docs, total] = await Promise.all([
    LedgerEntry.find(filter)
      .sort({ occurredAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean(),
    LedgerEntry.countDocuments(filter),
  ]);

  const items = docs.map((doc) => {
    const entry = JournalEntry.fromJSON({ ...doc, id: doc.entryId });
    const ccy = currency || entry.currencies[0];
    // Net effect on this user's spendable balance — the number they care about.
    const effect = entry.postings
      .filter((p) => userIdFromAccount(p.account) === userId && p.amount.currency === ccy)
      .reduce(
        (acc, p) =>
          signFor(p.account, p.direction) === 1 ? acc.plus(p.amount) : acc.minus(p.amount),
        Money.zero(ccy)
      );

    return {
      id: entry.id,
      flow: entry.flow,
      narrative: entry.narrative,
      occurredAt: entry.occurredAt,
      amount: effect.abs().toJSON(),
      direction: effect.isNegative ? 'debit' : 'credit',
      reversalOf: entry.reversalOf,
      metadata: entry.metadata,
    };
  });

  return {
    items,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
      hasNextPage: safePage * safeLimit < total,
      hasPrevPage: safePage > 1,
    },
  };
};

export default { post, getBalance, getUserBalances, deriveBalance, trialBalance, getUserHistory };
