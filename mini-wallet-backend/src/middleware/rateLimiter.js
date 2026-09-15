import rateLimit from 'express-rate-limit';

/**
 * Shared JSON error shape for throttled requests so the client always
 * receives the standard { success, message, code } envelope.
 */
const limitHandler = (code) => (req, res) =>
  res.status(429).json({
    success: false,
    message: 'Too many requests, please slow down and try again later.',
    code,
  });

/** Global safety net: 100 requests / 15 min per IP. */
export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler('RATE_LIMIT_GLOBAL'),
});

/** Auth routes: 5 requests / 15 min per IP (brute-force resistance). */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  handler: limitHandler('RATE_LIMIT_AUTH'),
});

/**
 * Refresh endpoint: 30 requests / 15 min per IP. Looser than login (genuine
 * multi-tab clients rotate often) but still caps abuse of the unauthenticated,
 * cookie-driven rotation path.
 */
export const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler('RATE_LIMIT_REFRESH'),
});

/**
 * Payment routes: 10 requests / min keyed PER USER (falls back to IP for
 * unauthenticated edge cases). Must run after `protect`.
 */
export const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId || req.ip,
  handler: limitHandler('RATE_LIMIT_PAYMENT'),
});
