import { AppError } from '../utils/ApiError.js';
import { logger } from '../config/logger.js';

/** 404 handler for unmatched routes. */
export const notFound = (req, _res, next) => {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404, 'NOT_FOUND'));
};

/**
 * Translate any thrown error into the standard response envelope:
 *   { success: false, message, code, [details], [stack in dev] }
 *
 * Handles Mongoose CastError / ValidationError / duplicate key (11000),
 * JWT errors, and our own AppError. Unknown errors are masked in prod.
 */
// eslint-disable-next-line no-unused-vars -- Express needs the 4-arg signature.
export const errorHandler = (err, req, res, _next) => {
  const isProd = process.env.NODE_ENV === 'production';
  let { statusCode, code, message, details } = err;

  // ── Map known error types ────────────────────────────────────────────
  if (err.name === 'CastError') {
    statusCode = 400;
    code = 'INVALID_ID';
    message = `Invalid value for field "${err.path}"`;
  } else if (err.name === 'ValidationError') {
    statusCode = 422;
    code = 'VALIDATION_ERROR';
    message = 'Validation failed';
    details = Object.values(err.errors).map((e) => ({
      field: e.path,
      message: e.message,
    }));
  } else if (err.code === 11000) {
    statusCode = 409;
    code = 'DUPLICATE_KEY';
    const field = Object.keys(err.keyValue || { field: '' })[0];
    message = `A record with this ${field} already exists`;
  } else if (err.name === 'VersionError') {
    // Optimistic concurrency conflict on the wallet.
    statusCode = 409;
    code = 'CONCURRENCY_CONFLICT';
    message = 'The resource was modified concurrently, please retry';
  } else if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    code = 'INVALID_TOKEN';
    message = 'Invalid token';
  } else if (err.name === 'TokenExpiredError') {
    statusCode = 401;
    code = 'TOKEN_EXPIRED';
    message = 'Token expired';
  }

  statusCode = statusCode || 500;
  code = code || 'INTERNAL_ERROR';
  message = message || 'Something went wrong';

  // ── Log: 5xx as error, everything else as warn ───────────────────────
  const logPayload = {
    code,
    statusCode,
    method: req.method,
    path: req.originalUrl,
    userId: req.userId,
  };
  if (statusCode >= 500) {
    logger.error(message, { ...logPayload, stack: err.stack });
  } else {
    logger.warn(message, logPayload);
  }

  // ── Respond ───────────────────────────────────────────────────────────
  const body = { success: false, message, code };
  if (details) body.details = details;
  if (!isProd && statusCode >= 500) body.stack = err.stack;

  // Never leak internals of an unexpected 500 in production.
  if (isProd && statusCode >= 500 && !err.isOperational) {
    body.message = 'Internal server error';
  }

  res.status(statusCode).json(body);
};

export default errorHandler;
