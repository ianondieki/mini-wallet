import { Money } from '../core/money/Money.js';
import * as savings from '../services/savingsService.js';
import { AppError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

/**
 * Savings goals.
 *
 * Contributing and withdrawing move money between two buckets of the same
 * customer's balance, so neither touches a payment rail and neither can fail
 * halfway. They are still idempotent: a client that retries after a timeout
 * must not set money aside twice.
 */

const DEFAULT_CURRENCY = process.env.DEFAULT_CURRENCY || 'KES';

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

const assertCanTransact = (user) => {
  const verdict = user.canTransact();
  if (!verdict.ok) throw new AppError(verdict.reason, 403, verdict.code);
};

/** @route GET /api/savings/goals */
export const list = asyncHandler(async (req, res) => {
  const currency = String(req.query.currency || DEFAULT_CURRENCY).toUpperCase();
  res.json({ success: true, data: await savings.listGoals(req.userId, currency) });
});

/** @route POST /api/savings/goals */
export const create = asyncHandler(async (req, res) => {
  const goal = await savings.createGoal({
    userId: req.userId,
    name: req.body.name,
    currency: String(req.body.currency || DEFAULT_CURRENCY).toUpperCase(),
    target: req.body.target,
    deadline: req.body.deadline,
    lock: req.body.lock,
  });
  res.status(201).json({ success: true, message: 'Savings goal created', data: { goal } });
});

/** @route POST /api/savings/goals/:goalId/contribute */
export const contribute = asyncHandler(async (req, res) => {
  assertCanTransact(req.user);
  const currency = String(req.body.currency || DEFAULT_CURRENCY).toUpperCase();
  const result = await savings.contribute({
    userId: req.userId,
    goalId: req.params.goalId,
    amount: parseAmount(req.body.amount, currency),
    idempotencyKey: req.idempotencyKey,
  });
  res.status(201).json({ success: true, message: 'Money set aside', data: result });
});

/** @route GET /api/savings/goals/:goalId/withdrawal-quote?amount= */
export const quote = asyncHandler(async (req, res) => {
  const currency = String(req.query.currency || DEFAULT_CURRENCY).toUpperCase();
  const result = await savings.quoteWithdrawal({
    userId: req.userId,
    goalId: req.params.goalId,
    amount: parseAmount(req.query.amount, currency),
  });
  res.json({ success: true, data: result });
});

/** @route POST /api/savings/goals/:goalId/withdraw */
export const withdraw = asyncHandler(async (req, res) => {
  assertCanTransact(req.user);
  const currency = String(req.body.currency || DEFAULT_CURRENCY).toUpperCase();
  const result = await savings.withdraw({
    userId: req.userId,
    goalId: req.params.goalId,
    amount: parseAmount(req.body.amount, currency),
    confirmPenalty: req.body.confirmPenalty,
    idempotencyKey: req.idempotencyKey,
  });
  res.status(201).json({
    success: true,
    message: result.earlyBreak ? 'Withdrawn early, penalty applied' : 'Withdrawn',
    data: result,
  });
});

/** @route DELETE /api/savings/goals/:goalId */
export const close = asyncHandler(async (req, res) => {
  const goal = await savings.closeGoal(req.userId, req.params.goalId);
  res.json({ success: true, message: 'Savings goal closed', data: { goal } });
});
