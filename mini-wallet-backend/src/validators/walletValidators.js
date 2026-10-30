import { body, param, query } from 'express-validator';
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

/** An email or a Kenyan phone number — the two ways a payee is named. */
const isIdentifier = (v) =>
  isValidKenyanPhone(v) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v ?? '').trim());

export const splitValidator = [
  body('recipients')
    .isArray({ min: 2, max: 20 })
    .withMessage('recipients must be a list of 2-20 emails or phone numbers')
    .bail()
    .custom((list) => {
      if (!list.every(isIdentifier)) {
        throw new Error('every recipient must be a valid email or Kenyan phone number');
      }
      return true;
    }),
  currencyRule,
  // Exactly one of the two ways to say who gets what. Accepting both would
  // leave the server choosing which one the customer meant.
  body().custom((_v, { req }) => {
    const exact = Array.isArray(req.body.shares) && req.body.shares.length > 0;
    const even = req.body.amount !== undefined && req.body.amount !== null;
    if (exact && even) {
      throw new Error('Send either amount (split evenly) or shares (exact), not both');
    }
    if (!exact && !even) throw new Error('amount or shares is required');
    return true;
  }),
  body('amount').optional().isFloat({ min: 0.01, max: SANITY_MAX })
    .withMessage(`amount must be a positive number up to ${SANITY_MAX.toLocaleString()}`),
  body('shares').optional().isArray({ min: 2, max: 20 })
    .withMessage('shares must be a list of 2-20 amounts')
    .bail()
    .custom((shares, { req }) => {
      if (shares.length !== (req.body.recipients?.length ?? -1)) {
        throw new Error('give one share per recipient');
      }
      if (!shares.every((s) => Number(s) >= 0.01 && Number(s) <= SANITY_MAX)) {
        throw new Error('every share must be a positive amount');
      }
      return true;
    }),
  body('description').optional().trim().isLength({ max: 200 })
    .withMessage('Description must be 200 characters or fewer'),
];

export const refundValidator = [
  body('entryId').trim().isUUID().withMessage('entryId must be the id of a transfer'),
  currencyRule,
  // Absent means "refund everything still outstanding", which is the common
  // case and must stay distinguishable from a zero.
  body('amount').optional({ nullable: true }).isFloat({ min: 0.01, max: SANITY_MAX })
    .withMessage('amount must be a positive number'),
  body('reason').optional().trim().isLength({ max: 140 })
    .withMessage('reason must be 140 characters or fewer'),
];

export const entryIdValidator = [
  param('entryId').trim().isUUID().withMessage('invalid transaction id'),
];

export { amountRule, currencyRule };
