import { body, query } from 'express-validator';
import { isValidKenyanPhone } from '../utils/mpesaHelpers.js';
import { SUPPORTED_CURRENCIES } from '../core/money/currencies.js';

/**
 * Request validation.
 *
 * Deliberately shallow: these check that a field is *present and plausible*.
 * Whether an amount is affordable, within the customer's tier, or priced
 * correctly is decided by the domain — duplicating those rules here would
 * mean two places to keep in step, and the validator would inevitably drift
 * out of date with the licence.
 *
 * The upper bound below is a sanity guard against a fat-fingered or malicious
 * payload, not a business limit. The real ceiling is the customer's KYC tier.
 */

const SANITY_MAX = 10_000_000;

/**
 * Amount must be a positive number. Precision beyond the currency's minor
 * unit is rounded by the controller, not rejected here — a client sending
 * 10.999 means 11.00, and failing that is pedantry.
 */
const amountRule = body('amount')
  .exists()
  .withMessage('amount is required')
  .bail()
  .isFloat({ min: 0.01, max: SANITY_MAX })
  .withMessage(`amount must be a positive number up to ${SANITY_MAX.toLocaleString()}`);

const currencyRule = body('currency')
  .optional()
  .trim()
  .toUpperCase()
  .isIn(SUPPORTED_CURRENCIES)
  .withMessage(`currency must be one of: ${SUPPORTED_CURRENCIES.join(', ')}`);

export const transferValidator = [
  // Either field identifies the payee; `recipientEmail` is the older name.
  body().custom((_value, { req }) => {
    if (!req.body.recipient && !req.body.recipientEmail) {
      throw new Error('A recipient email or phone number is required');
    }
    return true;
  }),
  body('recipientEmail').optional().trim().isEmail().withMessage('recipientEmail must be a valid email'),
  body('recipient')
    .optional()
    .trim()
    .custom((v) => isValidKenyanPhone(v) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))
    .withMessage('recipient must be a valid email or Kenyan phone number'),
  amountRule,
  currencyRule,
  body('description')
    .optional()
    .trim()
    .isLength({ max: 200 })
    .withMessage('Description must be 200 characters or fewer'),
];

export const quoteValidator = [
  amountRule,
  currencyRule,
  body('flow')
    .optional()
    .trim()
    .isIn(['transfer', 'payout', 'deposit', 'fx'])
    .withMessage('flow must be transfer, payout, deposit or fx'),
];

export const transactionQueryValidator = [
  query('page').optional().isInt({ min: 1 }).withMessage('page must be >= 1'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('limit must be 1-100'),
  query('type')
    .optional()
    .isIn(['topup', 'transfer', 'withdrawal'])
    .withMessage('type must be topup, transfer or withdrawal'),
  query('status')
    .optional()
    .isIn(['pending', 'success', 'failed', 'reversed'])
    .withMessage('invalid status'),
  query('currency')
    .optional()
    .trim()
    .toUpperCase()
    .isIn(SUPPORTED_CURRENCIES)
    .withMessage('unsupported currency'),
];

export { amountRule, currencyRule };
