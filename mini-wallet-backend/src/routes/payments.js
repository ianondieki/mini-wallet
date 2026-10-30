import { Router } from 'express';
import { deposit, payout, getOrder, listRails } from '../controllers/paymentsController.js';
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
 * Rail-agnostic payment endpoints. The customer supplies an instrument; the
 * router decides what carries it.
 */
const router = Router();

// The capability catalogue is not customer data, but it is not anonymous
// either — a client should be authenticated before enumerating our rails.
router.get('/rails', protect, listRails);

router.post(
  '/deposit',
  protect,
  paymentLimiter,
  idempotency(),
  topupValidator,
  validate,
  deposit
);

router.post(
  '/payout',
  protect,
  paymentLimiter,
  idempotency(),
  withdrawValidator,
  validate,
  payout
);

router.get('/orders/:reference', protect, statusParamValidator, validate, getOrder);

export default router;
