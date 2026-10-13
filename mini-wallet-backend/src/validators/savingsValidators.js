import { body, param, query } from 'express-validator';
import { SUPPORTED_CURRENCIES } from '../core/money/currencies.js';

/**
 * Shallow checks only. Whether a contribution is affordable, and what an early
 * break costs, are the domain's business — duplicating them here would mean
 * two places to keep in step.
 */

const SANITY_MAX = 10_000_000;

const amount = (loc) =>
  loc
    .exists()
    .withMessage('amount is required')
    .bail()
    .isFloat({ min: 0.01, max: SANITY_MAX })
    .withMessage(`amount must be a positive number up to ${SANITY_MAX.toLocaleString()}`);

const currency = body('currency')
  .optional()
  .trim()
  .toUpperCase()
  .isIn(SUPPORTED_CURRENCIES)
  .withMessage(`currency must be one of: ${SUPPORTED_CURRENCIES.join(', ')}`);

export const goalIdValidator = [
  param('goalId').trim().notEmpty().isLength({ max: 64 }).withMessage('invalid goal id'),
];

export const createGoalValidator = [
  body('name').trim().isLength({ min: 1, max: 60 }).withMessage('name must be 1-60 characters'),
  currency,
  body('target').optional({ nullable: true }).isFloat({ min: 0.01, max: SANITY_MAX })
    .withMessage('target must be a positive number'),
  body('deadline').optional({ nullable: true }).isISO8601().withMessage('deadline must be a date'),
  body('lock.until').optional({ nullable: true }).isISO8601()
    .withMessage('lock.until must be a date'),
  // 2000 bps = 20%. A commitment device that can cost more than a fifth of the
  // money is a trap, not a nudge.
  body('lock.penaltyBps').optional({ nullable: true }).isInt({ min: 0, max: 2000 })
    .withMessage('lock.penaltyBps must be between 0 and 2000 (20%)'),
  body('lock').custom((lock) => {
    if (lock && lock.penaltyBps > 0 && !lock.until) {
      throw new Error('a break penalty needs a lock.until date');
    }
    if (lock?.until && new Date(lock.until) <= new Date()) {
      throw new Error('lock.until must be in the future');
    }
    return true;
  }),
];

export const contributeValidator = [...goalIdValidator, amount(body('amount')), currency];

export const withdrawValidator = [
  ...goalIdValidator,
  amount(body('amount')),
  currency,
  body('confirmPenalty').optional({ nullable: true }).isFloat({ min: 0 })
    .withMessage('confirmPenalty must be a number'),
];

export const quoteValidator = [
  ...goalIdValidator,
  amount(query('amount')),
  query('currency').optional().trim().toUpperCase().isIn(SUPPORTED_CURRENCIES),
];
