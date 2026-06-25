import { body, param } from 'express-validator';
import { isValidKenyanPhone } from '../utils/mpesaHelpers.js';

const amountRule = (field) =>
  body(field)
    .isInt({ min: 10, max: 150000 })
    .withMessage(`${field} must be an integer between 10 and 150000`);

const phoneRule = body('phone')
  .trim()
  .custom((v) => isValidKenyanPhone(v))
  .withMessage('Phone must be a valid Kenyan number (2547XXXXXXXX / 2541XXXXXXXX)');

export const topupValidator = [amountRule('amount'), phoneRule];

export const withdrawValidator = [amountRule('amount'), phoneRule];

export const statusParamValidator = [
  param('checkoutRequestId')
    .trim()
    .notEmpty()
    .withMessage('checkoutRequestId is required')
    .isLength({ max: 100 })
    .withMessage('checkoutRequestId too long'),
];
