import { body, query } from 'express-validator';

export const transferValidator = [
  body('recipientEmail')
    .trim()
    .isEmail()
    .withMessage('Valid recipient email is required')
    .normalizeEmail(),
  body('amount')
    .isInt({ min: 1, max: 1_000_000 })
    .withMessage('Amount must be a positive integer (1 - 1,000,000)'),
  body('description')
    .optional()
    .trim()
    .isLength({ max: 200 })
    .withMessage('Description must be 200 characters or fewer'),
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
];
