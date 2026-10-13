import { body, param, query } from 'express-validator';
import { isValidKenyanPhone } from '../utils/mpesaHelpers.js';
import { SUPPORTED_CURRENCIES } from '../core/money/currencies.js';

const SANITY_MAX = 10_000_000;
const MAX_PARTICIPANTS = 20;

const isIdentifier = (v) =>
  isValidKenyanPhone(v) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v ?? '').trim());

export const createRequestValidator = [
  body('participants')
    .isArray({ min: 1, max: MAX_PARTICIPANTS })
    .withMessage(`participants must be a list of 1-${MAX_PARTICIPANTS} emails or phone numbers`)
    .bail()
    .custom((list) => {
      if (!list.every(isIdentifier)) {
        throw new Error('every participant must be a valid email or Kenyan phone number');
      }
      return true;
    }),
  body('currency').optional().trim().toUpperCase().isIn(SUPPORTED_CURRENCIES)
    .withMessage(`currency must be one of: ${SUPPORTED_CURRENCIES.join(', ')}`),
  body().custom((_v, { req }) => {
    const exact = Array.isArray(req.body.shares) && req.body.shares.length > 0;
    const even = req.body.total !== undefined && req.body.total !== null;
    if (exact && even) {
      throw new Error('Send either total (split evenly) or shares (exact), not both');
    }
    if (!exact && !even) throw new Error('total or shares is required');
    return true;
  }),
  body('total').optional().isFloat({ min: 0.01, max: SANITY_MAX })
    .withMessage('total must be a positive number'),
  body('shares').optional().isArray({ min: 1, max: MAX_PARTICIPANTS })
    .bail()
    .custom((shares, { req }) => {
      if (shares.length !== (req.body.participants?.length ?? -1)) {
        throw new Error('give one share per participant');
      }
      if (!shares.every((s) => Number(s) >= 0.01 && Number(s) <= SANITY_MAX)) {
        throw new Error('every share must be a positive amount');
      }
      return true;
    }),
  body('note').optional().trim().isLength({ max: 140 })
    .withMessage('note must be 140 characters or fewer'),
];

export const requestIdValidator = [
  param('requestId').trim().isUUID().withMessage('invalid request id'),
];

export const groupIdValidator = [
  param('groupId').trim().isUUID().withMessage('invalid bill id'),
];

export const declineValidator = [
  ...requestIdValidator,
  body('reason').optional().trim().isLength({ max: 140 })
    .withMessage('reason must be 140 characters or fewer'),
];

export const listRequestValidator = [
  query('currency').optional().trim().toUpperCase().isIn(SUPPORTED_CURRENCIES),
];
