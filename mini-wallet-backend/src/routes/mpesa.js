import { Router } from 'express';
import crypto from 'node:crypto';
import {
  stkPush,
  stkCallback,
  stkStatus,
  b2cWithdraw,
  b2cResult,
  b2cTimeout,
} from '../controllers/mpesaController.js';
import { protect } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { idempotency } from '../middleware/idempotency.js';
import { paymentLimiter } from '../middleware/rateLimiter.js';
import { logger } from '../config/logger.js';
import {
  topupValidator,
  withdrawValidator,
  statusParamValidator,
} from '../validators/mpesaValidators.js';

const router = Router();

// Safaricom expects a 200 ack even when we ignore a request, otherwise it
// retries aggressively. Callback guards therefore "reject" by acking + dropping.
const ACK = { ResultCode: 0, ResultDesc: 'Accepted' };

/** Constant-time string comparison that tolerates length mismatch. */
const safeEqual = (a, b) => {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
};

/**
 * Defence-in-depth secret check for the public callbacks. Opt-in: if
 * `MPESA_CALLBACK_SECRET` is set, the registered CallBack/Result URLs must
 * carry it as `?token=…` (or an `X-Callback-Token` header). When unset the
 * check is skipped so existing deployments aren't broken.
 */
const verifyCallbackSecret = (req, res, next) => {
  const expected = process.env.MPESA_CALLBACK_SECRET;
  if (!expected) return next();
  const provided = req.query.token || req.get('X-Callback-Token') || '';
  if (safeEqual(provided, expected)) return next();
  logger.warn('Rejected callback with missing/invalid secret token', { ip: req.ip });
  return res.status(200).json(ACK);
};

/**
 * Restrict public callback routes to Safaricom's source IPs.
 *
 * If the whitelist env var is empty we FAIL CLOSED in production (an
 * unconfigured whitelist must never leave the wallet-crediting callback open
 * to the internet) but allow it through in development/sandbox, where the
 * source IP varies and there is no real money at stake.
 */
const safaricomIpWhitelist = (req, res, next) => {
  const raw = process.env.SAFARICOM_IP_WHITELIST || '';
  const allow = raw.split(',').map((s) => s.trim()).filter(Boolean);

  if (allow.length === 0) {
    if (process.env.NODE_ENV === 'production') {
      logger.error(
        'Callback blocked: SAFARICOM_IP_WHITELIST is empty in production — refusing to process'
      );
      return res.status(200).json(ACK);
    }
    return next();
  }

  // req.ip respects `trust proxy`; strip IPv6-mapped IPv4 prefix.
  const ip = (req.ip || '').replace('::ffff:', '');
  if (allow.includes(ip)) return next();

  logger.warn('Rejected callback from non-whitelisted IP', { ip });
  // Still 200 so Safaricom doesn't hammer retries, but we ignore the body.
  return res.status(200).json(ACK);
};

/* ── Authenticated payment endpoints ──────────────────────────────────── */
router.post('/topup', protect, paymentLimiter, topupValidator, validate, stkPush);
router.post(
  '/withdraw',
  protect,
  paymentLimiter,
  idempotency,
  withdrawValidator,
  validate,
  b2cWithdraw
);
router.get(
  '/status/:checkoutRequestId',
  protect,
  statusParamValidator,
  validate,
  stkStatus
);

/* ── Public Safaricom callbacks (no JWT; secret + IP-whitelisted) ─────── */
router.post('/callback', verifyCallbackSecret, safaricomIpWhitelist, stkCallback);
router.post('/b2c/result', verifyCallbackSecret, safaricomIpWhitelist, b2cResult);
router.post('/b2c/timeout', verifyCallbackSecret, safaricomIpWhitelist, b2cTimeout);

export default router;
