import * as reconciliation from '../services/reconciliationService.js';
import * as ledgerService from '../services/ledgerService.js';
import * as outbox from '../services/outboxService.js';
import { healthSnapshot } from '../rails/health.js';
import { asyncHandler } from '../utils/asyncHandler.js';

/**
 * Operator endpoints.
 *
 * Admin-only, and read-mostly on purpose. These surface the checks that make
 * the ledger's guarantees observable — the trial balance, drift between the
 * journal and cached balances, payments stuck in flight, rail health and
 * undelivered events.
 *
 * There is deliberately no "fix it" endpoint. The correct response to an
 * unexplained discrepancy is to look at it, not to have a button that makes
 * it disappear.
 */

/**
 * The morning report: every check, one verdict.
 * @route GET /api/ops/reconciliation
 */
export const getReconciliation = asyncHandler(async (req, res) => {
  const report = await reconciliation.dailyReport({
    currency: String(req.query.currency || 'KES').toUpperCase(),
    // The full journal replay is expensive; opt in explicitly.
    deep: req.query.deep !== 'false',
  });
  res.status(report.healthy ? 200 : 409).json({ success: report.healthy, data: report });
});

/**
 * Trial balance — every account, and the total that must be zero.
 * @route GET /api/ops/trial-balance
 */
export const getTrialBalance = asyncHandler(async (req, res) => {
  const result = await ledgerService.trialBalance(
    String(req.query.currency || 'KES').toUpperCase()
  );
  res.json({
    success: result.balanced,
    data: {
      balanced: result.balanced,
      net: result.net.toJSON(),
      accounts: result.accounts,
    },
  });
});

/**
 * Replay one account's postings and compare against its cached balance.
 * @route GET /api/ops/accounts/:account/verify
 */
export const verifyAccount = asyncHandler(async (req, res) => {
  const currency = String(req.query.currency || 'KES').toUpperCase();
  const result = await ledgerService.deriveBalance(req.params.account, currency);
  res.json({
    success: result.drift.isZero,
    data: {
      account: req.params.account,
      currency,
      journal: result.derived.toJSON(),
      cached: result.cached.toJSON(),
      drift: result.drift.toJSON(),
      postings: result.postings,
    },
  });
});

/**
 * Payments that never reached a terminal state.
 * @route GET /api/ops/stuck
 */
export const getStuckPayments = asyncHandler(async (req, res) => {
  const result = await reconciliation.findStuckPayments({
    graceMs: Number(req.query.graceMinutes ?? 15) * 60_000,
  });
  res.json({ success: result.ok, data: result });
});

/**
 * Compare a provider statement against our records.
 * @route POST /api/ops/rails/:rail/reconcile
 */
export const reconcileStatement = asyncHandler(async (req, res) => {
  const result = await reconciliation.reconcileRailStatement({
    rail: req.params.rail,
    statement: Array.isArray(req.body.statement) ? req.body.statement : [],
    from: new Date(req.body.from ?? Date.now() - 24 * 60 * 60 * 1000),
    to: new Date(req.body.to ?? Date.now()),
  });
  res.status(result.ok ? 200 : 409).json({ success: result.ok, data: result });
});

/**
 * Rail circuit-breaker state and observed reliability.
 * @route GET /api/ops/rails/health
 */
export const getRailHealth = asyncHandler(async (_req, res) => {
  res.json({ success: true, data: { rails: healthSnapshot() } });
});

/**
 * Events that exhausted their retries — something that should have been told
 * about a money movement never was.
 * @route GET /api/ops/outbox/dead
 */
export const getDeadLetters = asyncHandler(async (_req, res) => {
  const events = await outbox.deadLetters();
  res.json({ success: events.length === 0, data: { count: events.length, events } });
});
