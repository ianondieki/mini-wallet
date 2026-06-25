import { validationResult } from 'express-validator';
import { AppError } from '../utils/ApiError.js';

/**
 * Collects express-validator results and throws a structured 422 if any
 * rule failed. Place after the validation chain on a route.
 */
export const validate = (req, _res, next) => {
  const result = validationResult(req);
  if (result.isEmpty()) return next();

  const details = result.array().map((e) => ({
    field: e.path,
    message: e.msg,
  }));

  return next(
    new AppError('Validation failed', 422, 'VALIDATION_ERROR', details)
  );
};

export default validate;
