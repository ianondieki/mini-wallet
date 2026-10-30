import { body, param } from 'express-validator';
import { isValidKenyanPhone } from '../utils/mpesaHelpers.js';
import { amountRule, currencyRule } from './walletValidators.js';
import { InstrumentType } from '../rails/Rail.js';

/**
 * Deposit/payout request validation.
 *
 * A request may address its counterparty either with the legacy bare `phone`
 * field or with a structured `instrument`, because the wallet now reaches
 * bank accounts and SACCO members as well as mobile money. Exactly one is
 * required; which one is a client-vintage question, not a business rule.
 */

/** Present and structurally valid, whichever form was used. */
const instrumentRule = body().custom((_value, { req }) => {
  const { phone, instrument } = req.body;

  if (!phone && !instrument) {
    throw new Error('Either a phone number or an instrument is required');
  }
  if (phone && !isValidKenyanPhone(phone)) {
    throw new Error('Phone must be a valid Kenyan number (2547XXXXXXXX / 2541XXXXXXXX)');
  }
  if (!instrument) return true;

  if (typeof instrument !== 'object' || Array.isArray(instrument)) {
    throw new Error('instrument must be an object');
  }
  if (!Object.values(InstrumentType).includes(instrument.type)) {
    throw new Error(`instrument.type must be one of: ${Object.values(InstrumentType).join(', ')}`);
  }
  if (instrument.type === InstrumentType.MSISDN && !isValidKenyanPhone(instrument.msisdn ?? '')) {
    throw new Error('instrument.msisdn must be a valid Kenyan phone number');
  }
  if (
    instrument.type === InstrumentType.BANK_ACCOUNT &&
    !(instrument.bankCode && instrument.accountNumber)
  ) {
    throw new Error('a bank instrument needs bankCode and accountNumber');
  }
  if (
    instrument.type === InstrumentType.MEMBER_ACCOUNT &&
    !(instrument.institutionId && instrument.accountNumber)
  ) {
    throw new Error('a SACCO instrument needs institutionId and accountNumber');
  }
  return true;
});

export const topupValidator = [amountRule, currencyRule, instrumentRule];
export const withdrawValidator = [amountRule, currencyRule, instrumentRule];

export const statusParamValidator = [
  param(['reference', 'checkoutRequestId'])
    .trim()
    .notEmpty()
    .withMessage('a payment reference is required')
    .isLength({ max: 100 })
    .withMessage('reference too long'),
];
