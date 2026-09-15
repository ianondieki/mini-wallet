import { Router } from 'express';
import { deposit, payout, getOrder } from '../controllers/paymentsController.js';
import { railCallback } from '../controllers/webhookController.js';
import { protect } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { idempotency } from '../middleware/idempotency.js';
import { paymentLimiter } from '../middleware/rateLimiter.js';
import {
  topupValidator,
  withdrawValidator,
  statusParamValidator,
} from '../validators/mpesaValidators.js';

/**
 * M-Pesa compatibility routes.
 *
 * These paths are kept for two reasons, and the second is the important one:
 *
 * 1. The existing client calls them.
 * 2. **Safaricom has them registered.** The callback URLs are configured on
 *    the Daraja side against a live short code. Moving them is a production
 *    change coordinated with Safaricom, not a refactor — and until that
 *    happens, a payment that lands here and 404s is money we have taken and
 *    not credited.
 *
 * They are now thin: the handlers are the rail-agnostic ones, and the
 * callbacks go through the M-Pesa adapter's own authentication and parsing
 * rather than the hand-rolled IP check that used to live in this file.
 *
 * New integrations should use /api/payments.
 */
const router = Router();

/* ── Authenticated endpoints ──────────────────────────────────────────── */

router.post('/topup', protect, paymentLimiter, idempotency({ required: false }), topupValidator, validate, deposit);

router.post('/withdraw', protect, paymentLimiter, idempotency(), withdrawValidator, validate, payout);

router.get('/status/:checkoutRequestId', protect, statusParamValidator, validate, getOrder);

/* ── Public Safaricom callbacks ───────────────────────────────────────────
 * Unauthenticated by JWT — Safaricom has no credential to present. The rail
 * adapter verifies them instead (shared secret + source IP allowlist, failing
 * closed in production), and an unverified callback is acknowledged and
 * dropped rather than rejected, so Safaricom does not retry forever.
 * ──────────────────────────────────────────────────────────────────────── */

router.post('/callback', railCallback('mpesa'));
router.post('/b2c/result', railCallback('mpesa'));
router.post('/b2c/timeout', railCallback('mpesa', { treatAsFailure: true }));

export default router;
