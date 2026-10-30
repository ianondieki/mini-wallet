import mongoose from 'mongoose';
import { Money } from '../core/money/Money.js';
import * as flows from '../core/ledger/flows.js';
import { userVault, userAvailable } from '../core/ledger/accounts.js';
import { SavingsGoal } from '../models/SavingsGoal.js';
import * as ledger from './ledgerService.js';
import * as outbox from './outboxService.js';
import { AppError } from '../utils/ApiError.js';
import { logger } from '../config/logger.js';

/**
 * Savings goals.
 *
 * Money moves between two buckets of the same customer's liability, so nothing
 * leaves the institution and no rail is involved. That makes saving instant and
 * free, and it means the overdraft guard protects a vault exactly as it
 * protects a spendable balance — the account path sits under the same
 * `liabilities:user:` prefix the conditional decrement matches on.
 */

/** How many active goals one customer may run at once. */
const MAX_ACTIVE_GOALS = 12;

/**
 * Load a goal that belongs to this customer.
 *
 * Another customer's goal is reported as missing rather than forbidden: a 403
 * would confirm the id exists, which is a small enumeration leak for no gain.
 *
 * @param {string} userId @param {string} goalId
 * @returns {Promise<import('../models/SavingsGoal.js').SavingsGoal>}
 */
const mustOwn = async (userId, goalId) => {
  const goal = await SavingsGoal.findOne({ goalId, userId });
  if (!goal) throw new AppError('Savings goal not found', 404, 'GOAL_NOT_FOUND');
  return goal;
};

/**
 * Render a goal with its balance folded in from the ledger.
 * @param {object} goal
 * @returns {Promise<object>}
 */
const present = async (goal) => {
  const saved = await ledger.getBalance(
    userVault(goal.userId, goal.goalId, goal.currency),
    goal.currency
  );
  const target = goal.targetMinor ? Money.fromMinor(goal.targetMinor, goal.currency) : null;
  const locked = goal.isLocked();

  return {
    goalId: goal.goalId,
    name: goal.name,
    currency: goal.currency,
    saved: saved.toJSON(),
    target: target ? target.toJSON() : null,
    // Basis points rather than a float, and capped so a overshoot reads as 100%.
    progressBps: target && target.isPositive
      ? Math.min(10_000, Number((saved.minorBigInt * 10_000n) / target.minorBigInt))
      : null,
    remaining: target ? Money.max(target.minus(saved), Money.zero(goal.currency)).toJSON() : null,
    deadline: goal.deadline,
    locked,
    lockedUntil: goal.lockedUntil,
    breakPenaltyBps: goal.breakPenaltyBps,
    state: goal.state,
    createdAt: goal.createdAt,
  };
};

/**
 * Every goal a customer holds, plus their totals.
 * @param {string} userId
 * @param {string} [currency]
 * @returns {Promise<object>}
 */
export const listGoals = async (userId, currency = 'KES') => {
  const goals = await SavingsGoal.find({ userId, state: 'active' }).sort({ createdAt: -1 });
  const presented = await Promise.all(goals.map(present));
  const totalSaved = presented
    .filter((g) => g.currency === currency)
    .reduce((acc, g) => acc.plus(Money.fromJSON(g.saved)), Money.zero(currency));

  return {
    currency,
    totalSaved: totalSaved.toJSON(),
    spendable: (await ledger.getBalance(userAvailable(userId, currency), currency)).toJSON(),
    goals: presented,
  };
};

/**
 * Create a goal. Creates no ledger entry — an empty goal holds no money.
 *
 * @param {object} params
 * @returns {Promise<object>}
 */
export const createGoal = async ({ userId, name, currency = 'KES', target, deadline, lock }) => {
  const active = await SavingsGoal.countDocuments({ userId, state: 'active' });
  if (active >= MAX_ACTIVE_GOALS) {
    throw new AppError(
      `You can run ${MAX_ACTIVE_GOALS} savings goals at once. Close one to add another.`,
      409,
      'GOAL_LIMIT_REACHED'
    );
  }

  let targetMinor = null;
  if (target !== undefined && target !== null && String(target).length) {
    const parsed = Money.ofRounded(String(target), currency);
    if (!parsed.isPositive) throw new AppError('Target must be positive', 400, 'INVALID_TARGET');
    targetMinor = parsed.minor;
  }

  try {
    const goal = await SavingsGoal.create({
      userId,
      name: String(name).trim(),
      currency,
      targetMinor,
      deadline: deadline ? new Date(deadline) : null,
      lockedUntil: lock?.until ? new Date(lock.until) : null,
      breakPenaltyBps: lock?.penaltyBps ?? 0,
    });
    logger.info('Savings goal created', { userId, goalId: goal.goalId });
    return present(goal);
  } catch (err) {
    if (err?.code === 11000) {
      throw new AppError('You already have a goal with that name', 409, 'GOAL_NAME_TAKEN');
    }
    throw err;
  }
};

/**
 * Move money from spendable into a goal.
 *
 * The ledger's conditional decrement is what refuses a contribution the
 * customer cannot afford, so there is no read-then-write race here.
 *
 * @param {object} params
 * @returns {Promise<object>}
 */
export const contribute = async ({ userId, goalId, amount, idempotencyKey }) => {
  const goal = await mustOwn(userId, goalId);
  if (goal.state !== 'active') {
    throw new AppError('That goal is closed', 409, 'GOAL_NOT_ACTIVE');
  }
  if (amount.currency !== goal.currency) {
    throw new AppError(
      `This goal is in ${goal.currency}`,
      400,
      'GOAL_CURRENCY_MISMATCH'
    );
  }

  const entry = flows.lockToGoal({
    userId,
    goalId,
    amount,
    metadata: { goalName: goal.name },
  });

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await ledger.post(entry, { session, idempotencyKey, idempotencyScope: userId });
      await outbox.enqueue(
        {
          type: 'savings.contributed',
          entryId: entry.id,
          userId,
          payload: { goalId, goalName: goal.name, amount: amount.toJSON() },
        },
        { session }
      );
    });
  } catch (err) {
    if (err?.code === 11000) {
      throw new AppError('Duplicate contribution ignored', 409, 'IDEMPOTENT_REPLAY');
    }
    throw err;
  } finally {
    await session.endSession();
  }

  return { entryId: entry.id, moved: amount.toJSON(), goal: await present(goal) };
};

/**
 * What breaking into a goal right now would cost. Read-only, so it takes no
 * idempotency key — the customer must be able to ask twice.
 *
 * @param {object} params
 * @returns {Promise<object>}
 */
export const quoteWithdrawal = async ({ userId, goalId, amount }) => {
  const goal = await mustOwn(userId, goalId);
  const early = goal.isLocked();
  const penalty = early ? amount.basisPoints(goal.breakPenaltyBps) : Money.zero(amount.currency);

  return {
    amount: amount.toJSON(),
    early,
    lockedUntil: goal.lockedUntil,
    penaltyBps: early ? goal.breakPenaltyBps : 0,
    penalty: penalty.toJSON(),
    youReceive: amount.minus(penalty).toJSON(),
  };
};

/**
 * Take money back out of a goal.
 *
 * `confirmPenalty` is the customer having seen the quote and agreed to it. If
 * the penalty has changed since they looked — the lock expired, say — the
 * withdrawal is refused rather than silently charging a different number.
 *
 * @param {object} params
 * @returns {Promise<object>}
 */
export const withdraw = async ({ userId, goalId, amount, confirmPenalty, idempotencyKey }) => {
  const goal = await mustOwn(userId, goalId);
  if (amount.currency !== goal.currency) {
    throw new AppError(`This goal is in ${goal.currency}`, 400, 'GOAL_CURRENCY_MISMATCH');
  }

  const early = goal.isLocked();
  const penalty = early ? amount.basisPoints(goal.breakPenaltyBps) : Money.zero(amount.currency);

  if (confirmPenalty !== undefined && confirmPenalty !== null) {
    const agreed = Money.ofRounded(String(confirmPenalty), amount.currency);
    if (!agreed.equals(penalty)) {
      throw new AppError(
        `The penalty is now ${penalty.format()}, not ${agreed.format()}. Check the quote again.`,
        409,
        'PENALTY_CHANGED',
        { penalty: penalty.toJSON() }
      );
    }
  }

  const entry = flows.releaseFromGoal({
    userId,
    goalId,
    amount,
    penalty: penalty.isPositive ? penalty : undefined,
    metadata: { goalName: goal.name, earlyBreak: early },
  });

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await ledger.post(entry, { session, idempotencyKey, idempotencyScope: userId });
      await outbox.enqueue(
        {
          type: 'savings.withdrawn',
          entryId: entry.id,
          userId,
          payload: { goalId, amount: amount.toJSON(), penalty: penalty.toJSON(), earlyBreak: early },
        },
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

  return {
    entryId: entry.id,
    released: amount.toJSON(),
    penalty: penalty.toJSON(),
    received: amount.minus(penalty).toJSON(),
    earlyBreak: early,
    goal: await present(goal),
  };
};

/**
 * Close a goal. Refuses while it still holds money — the customer has to
 * decide where that money goes, we do not decide for them.
 *
 * @param {string} userId @param {string} goalId
 * @returns {Promise<object>}
 */
export const closeGoal = async (userId, goalId) => {
  const goal = await mustOwn(userId, goalId);
  const saved = await ledger.getBalance(
    userVault(userId, goalId, goal.currency),
    goal.currency
  );
  if (saved.isPositive) {
    throw new AppError(
      `Withdraw the ${saved.format()} in this goal before closing it`,
      409,
      'VAULT_NOT_EMPTY',
      { saved: saved.toJSON() }
    );
  }
  goal.state = 'closed';
  goal.closedAt = new Date();
  await goal.save();
  return present(goal);
};

export default { listGoals, createGoal, contribute, quoteWithdrawal, withdraw, closeGoal };
