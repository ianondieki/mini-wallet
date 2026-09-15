import rateLimit from 'express-rate-limit';

/**
 * Rate limiting.
 *
 * Every limit is configurable from the environment, with the production
 * defaults below. That is not just for tests: the right numbers genuinely
 * differ by deployment. Five auth attempts per 15 minutes *per IP* is sound
 * for consumer traffic off mobile networks, and far too tight behind a shared
 * corporate NAT or a single-egress test runner, where hundreds of distinct
 * users arrive as one address.
 *
 * Values are read once at module load, so a process must be restarted to
 * change them.
 */

/**
 * Parse a positive number from the environment, falling back to the default.
 * A malformed value takes the default rather than becoming `NaN`, which
 * express-rate-limit would treat as "no limit at all" — failing open on a
 * brute-force control is the one outcome worth being careful about here.
 *
 * @param {string|undefined} value
 * @param {number} fallback
 * @returns {number}
 */
const positive = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Shared JSON error shape for throttled requests, so the client always
 * receives the standard { success, message, code } envelope.
 * @param {string} code
 */
const limitHandler = (code) => (_req, res) =>
  res.status(429).json({
    success: false,
    message: 'Too many requests, please slow down and try again later.',
    code,
  });

/**
 * Build a limiter. Exported so its behaviour can be tested directly rather
 * than by hammering a real endpoint.
 *
 * @param {object} options
 * @param {number} options.windowMs
 * @param {number} options.max
 * @param {string} options.code          Stable error code for the 429.
 * @param {Function} [options.keyGenerator]
 * @returns {import('express').RequestHandler}
 */
export const createLimiter = ({ windowMs, max, code, keyGenerator }) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: limitHandler(code),
    ...(keyGenerator ? { keyGenerator } : {}),
  });

const MINUTE = 60 * 1000;
const FIFTEEN_MINUTES = 15 * MINUTE;

/** Global safety net. Default: 100 requests / 15 min per IP. */
export const globalLimiter = createLimiter({
  windowMs: positive(process.env.RATE_LIMIT_GLOBAL_WINDOW_MS, FIFTEEN_MINUTES),
  max: positive(process.env.RATE_LIMIT_GLOBAL_MAX, 100),
  code: 'RATE_LIMIT_GLOBAL',
});

/** Auth routes. Default: 5 / 15 min per IP — brute-force resistance. */
export const authLimiter = createLimiter({
  windowMs: positive(process.env.RATE_LIMIT_AUTH_WINDOW_MS, FIFTEEN_MINUTES),
  max: positive(process.env.RATE_LIMIT_AUTH_MAX, 5),
  code: 'RATE_LIMIT_AUTH',
});

/**
 * Refresh endpoint. Default: 30 / 15 min per IP — looser than login, because
 * genuine multi-tab clients rotate often, but still caps abuse of the
 * unauthenticated, cookie-driven rotation path.
 */
export const refreshLimiter = createLimiter({
  windowMs: positive(process.env.RATE_LIMIT_REFRESH_WINDOW_MS, FIFTEEN_MINUTES),
  max: positive(process.env.RATE_LIMIT_REFRESH_MAX, 30),
  code: 'RATE_LIMIT_REFRESH',
});

/**
 * Payment routes. Default: 10 / min keyed PER USER (falling back to IP for
 * unauthenticated edge cases), so one customer cannot be throttled by
 * another behind the same address. Must run after `protect`.
 */
export const paymentLimiter = createLimiter({
  windowMs: positive(process.env.RATE_LIMIT_PAYMENT_WINDOW_MS, MINUTE),
  max: positive(process.env.RATE_LIMIT_PAYMENT_MAX, 10),
  code: 'RATE_LIMIT_PAYMENT',
  keyGenerator: (req) => req.userId || req.ip,
});
