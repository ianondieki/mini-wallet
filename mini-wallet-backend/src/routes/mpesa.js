import { Router } from 'express';
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

/**
 * Restrict public callback routes to Safaricom's source IPs. If the
 * whitelist env var is empty the check is skipped (useful locally / in
 * sandbox where the source IP varies).
 */
const safaricomIpWhitelist = (req, res, next) => {
  const raw = process.env.SAFARICOM_IP_WHITELIST || '';
  const allow = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (allow.length === 0) return next();

  // req.ip respects `trust proxy`; strip IPv6-mapped IPv4 prefix.
  const ip = (req.ip || '').replace('::ffff:', '');
  if (allow.includes(ip)) return next();

  logger.warn('Rejected callback from non-whitelisted IP', { ip });
  // Still 200 so Safaricom doesn't hammer retries, but we ignore the body.
  return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
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

/* ── Public Safaricom callbacks (no JWT; IP-whitelisted) ──────────────── */
router.post('/callback', safaricomIpWhitelist, stkCallback);
router.post('/b2c/result', safaricomIpWhitelist, b2cResult);
router.post('/b2c/timeout', safaricomIpWhitelist, b2cTimeout);

export default router;
