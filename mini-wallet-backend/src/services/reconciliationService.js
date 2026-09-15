import { Money } from '../core/money/Money.js';
import { LedgerEntry } from '../models/LedgerEntry.js';
import { AccountBalance } from '../models/AccountBalance.js';
import { PaymentOrder, TERMINAL_ORDER_STATUSES } from '../models/PaymentOrder.js';
import { JournalEntry, foldBalances } from '../core/ledger/JournalEntry.js';
import { trialBalance } from './ledgerService.js';
import { logger } from '../config/logger.js';

/**
 * Reconciliation — the checks that make the ledger's guarantees observable.
 *
 * A double-entry ledger that nobody audits is just an expensive log. These
 * are the four questions an operations team has to be able to answer every
 * morning, and none of them could even be asked of the original design:
 *
 * 1. **Do the books balance?** Every entry balances by construction, so the
 *    trial balance must be zero. A non-zero answer means something wrote to
 *    balances outside the ledger.
 * 2. **Do cached balances match the journal?** Balances are a materialised
 *    view; replaying the postings proves they were not corrupted.
 * 3. **Is anything stuck?** A payout that never reached a terminal state is
 *    customer money in limbo, and it will not resolve itself.
 * 4. **Does the provider agree with us?** Our record of what M-Pesa holds is
 *    a claim until their statement confirms it.
 *
 * Every function returns findings rather than acting on them. Automatic
 * correction of an unexplained discrepancy is how a small bug becomes a large
 * one; the correct response to a drift is to stop and look.
 */

/**
 * Check 1 — the trial balance.
 * @param {string} [currency]
 * @returns {Promise<{ok: boolean, net: object, accounts: number}>}
 */
export const checkTrialBalance = async (currency = 'KES') => {
  const result = await trialBalance(currency);
  if (!result.balanced) {
    logger.error('TRIAL BALANCE DOES NOT SUM TO ZERO', {
      currency,
      net: result.net.toString(),
    });
  }
  return {
    ok: result.balanced,
    net: result.net.toJSON(),
    accounts: result.accounts.length,
    ...(result.balanced ? {} : { detail: result.accounts }),
  };
};

/**
 * Check 2 — replay every posting and compare against the cached balances.
 *
 * Streams the journal rather than loading it, so this stays viable as history
 * grows. It is the expensive check; run it nightly, not per request.
 *
 * @param {object} [options]
 * @param {string} [options.currency]
 * @param {Date}   [options.since]  Only replay entries from here (for a partial audit).
 * @returns {Promise<{ok: boolean, checked: number, drifts: object[]}>}
 */
export const checkBalanceIntegrity = async ({ currency = 'KES', since } = {}) => {
  const filter = { currencies: currency };
  if (since) filter.occurredAt = { $gte: since };

  /** @type {Map<string, Money>} */
  const derived = new Map();
  const cursor = LedgerEntry.find(filter).lean().cursor();

  let entryCount = 0;
  for await (const doc of cursor) {
    const entry = JournalEntry.fromJSON({ ...doc, id: doc.entryId });
    entryCount += 1;
    for (const [key, value] of foldBalances([entry])) {
      const existing = derived.get(key);
      derived.set(key, existing ? existing.plus(value) : value);
    }
  }

  const cached = await AccountBalance.find({ currency }).lean();
  const cachedMap = new Map(cached.map((row) => [`${row.account}|${row.currency}`, row]));

  const drifts = [];
  const keys = new Set([...derived.keys(), ...cachedMap.keys()]);

  for (const key of keys) {
    const [account, ccy] = key.split('|');
    if (ccy !== currency) continue;

    const expected = derived.get(key) ?? Money.zero(currency);
    const row = cachedMap.get(key);
    const actual = Money.fromMinor(row?.minor ?? 0, currency);

    if (!expected.equals(actual)) {
      drifts.push({
        account,
        currency,
        journal: expected.toJSON(),
        cached: actual.toJSON(),
        drift: actual.minus(expected).toJSON(),
        lastEntryId: row?.lastEntryId ?? null,
      });
    }
  }

  if (drifts.length > 0) {
    logger.error('Cached balances have drifted from the journal', {
      currency,
      accounts: drifts.length,
    });
  }

  return { ok: drifts.length === 0, checked: keys.size, entries: entryCount, drifts };
};

/**
 * Check 3 — payments that never reached a terminal state.
 *
 * Splits findings by how the money is exposed, because the operational
 * urgency differs sharply:
 *  - `reserved` — the customer's funds are held and they cannot spend them.
 *    This is the one that generates complaints, and it needs resolving today.
 *  - `indeterminate` — we do not know whether the rail moved money. This is
 *    the one that loses money, and it needs a human.
 *
 * @param {object} [options]
 * @param {number} [options.graceMs]  How long past `expectedBy` before flagging.
 * @param {number} [options.limit]
 * @returns {Promise<{ok: boolean, stuck: object[], summary: object}>}
 */
export const findStuckPayments = async ({ graceMs = 15 * 60 * 1000, limit = 200 } = {}) => {
  const cutoff = new Date(Date.now() - graceMs);

  const orders = await PaymentOrder.find({
    status: { $nin: TERMINAL_ORDER_STATUSES },
    $or: [{ expectedBy: { $lte: cutoff } }, { expectedBy: null, createdAt: { $lte: cutoff } }],
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();

  const stuck = orders.map((order) => ({
    orderId: order.orderId,
    userId: order.userId,
    rail: order.rail,
    providerRef: order.providerRef,
    status: order.status,
    amount: order.amount,
    ageMinutes: Math.round((Date.now() - new Date(order.createdAt).getTime()) / 60_000),
    fundsReserved: Boolean(order.reserved),
    // A rail-queryable order can often be resolved automatically; one without
    // a provider reference never left us and is safe to fail.
    resolution: order.providerRef
      ? 'query the rail for a terminal status'
      : 'no provider reference — the request never reached the rail',
  }));

  const summary = {
    total: stuck.length,
    reserved: stuck.filter((s) => s.fundsReserved).length,
    indeterminate: stuck.filter((s) => s.status === 'needs_reconciliation').length,
    oldestMinutes: stuck[0]?.ageMinutes ?? 0,
  };

  if (summary.total > 0) {
    logger.warn('Stuck payments detected', summary);
  }

  return { ok: summary.total === 0, stuck, summary };
};

/**
 * Check 4 — compare a provider statement against our own records.
 *
 * Three kinds of discrepancy, each meaning something different:
 *
 * - **missing** — the provider settled it, we have no record. Money arrived
 *   that we never credited to anyone. A customer is short.
 * - **phantom** — we recorded it, the provider has no such transaction. We
 *   credited someone for money that never arrived. We are short.
 * - **mismatched** — both have it, for different amounts.
 *
 * @param {object} params
 * @param {string} params.rail
 * @param {Array<{providerRef: string, amount: string|number, currency?: string, date?: string}>} params.statement
 * @param {Date} params.from
 * @param {Date} params.to
 * @returns {Promise<{ok: boolean, missing: object[], phantom: object[], mismatched: object[], summary: object}>}
 */
export const reconcileRailStatement = async ({ rail, statement, from, to }) => {
  const orders = await PaymentOrder.find({
    rail,
    status: 'succeeded',
    createdAt: { $gte: from, $lte: to },
  }).lean();

  const ourRefs = new Map(orders.filter((o) => o.providerRef).map((o) => [o.providerRef, o]));
  const theirRefs = new Map(statement.map((row) => [row.providerRef, row]));

  const missing = [];
  const mismatched = [];

  for (const [ref, row] of theirRefs) {
    const order = ourRefs.get(ref);
    if (!order) {
      missing.push({ providerRef: ref, amount: row.amount, date: row.date });
      continue;
    }
    const theirs = Money.ofRounded(String(row.amount), row.currency ?? order.amount.currency);
    const ours = Money.fromMinor(order.amount.minor, order.amount.currency);
    if (!theirs.equals(ours)) {
      mismatched.push({
        providerRef: ref,
        orderId: order.orderId,
        ours: ours.toJSON(),
        theirs: theirs.toJSON(),
        difference: theirs.minus(ours).toJSON(),
      });
    }
  }

  const phantom = [...ourRefs.entries()]
    .filter(([ref]) => !theirRefs.has(ref))
    .map(([ref, order]) => ({
      providerRef: ref,
      orderId: order.orderId,
      userId: order.userId,
      amount: order.amount,
    }));

  const summary = {
    rail,
    statementRows: statement.length,
    ourRecords: ourRefs.size,
    missing: missing.length,
    phantom: phantom.length,
    mismatched: mismatched.length,
  };

  if (missing.length || phantom.length || mismatched.length) {
    logger.error('Rail statement does not reconcile', summary);
  }

  return { ok: missing.length + phantom.length + mismatched.length === 0, missing, phantom, mismatched, summary };
};

/**
 * The morning report: every check, one verdict.
 *
 * `healthy` is false if *any* check fails. There is deliberately no partial
 * pass — a ledger that balances but has three stuck payouts is not a system
 * anyone should call fine.
 *
 * @param {object} [options]
 * @param {string} [options.currency]
 * @param {boolean} [options.deep]  Include the full journal replay.
 * @returns {Promise<object>}
 */
export const dailyReport = async ({ currency = 'KES', deep = true } = {}) => {
  const startedAt = Date.now();

  const [trial, integrity, stuck] = await Promise.all([
    checkTrialBalance(currency),
    deep ? checkBalanceIntegrity({ currency }) : Promise.resolve({ ok: true, skipped: true }),
    findStuckPayments(),
  ]);

  const report = {
    generatedAt: new Date().toISOString(),
    currency,
    durationMs: Date.now() - startedAt,
    healthy: trial.ok && integrity.ok && stuck.ok,
    checks: { trialBalance: trial, balanceIntegrity: integrity, stuckPayments: stuck },
  };

  logger[report.healthy ? 'info' : 'error']('Reconciliation report', {
    healthy: report.healthy,
    trialBalanceOk: trial.ok,
    driftedAccounts: integrity.drifts?.length ?? 0,
    stuckPayments: stuck.summary.total,
  });

  return report;
};

export default {
  checkTrialBalance,
  checkBalanceIntegrity,
  findStuckPayments,
  reconcileRailStatement,
  dailyReport,
};
