import { Router } from 'express';
import {
  getBalance,
  transfer,
  getTransactions,
  searchRecipients,
} from '../controllers/walletController.js';
import { protect } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { idempotency } from '../middleware/idempotency.js';
import { paymentLimiter } from '../middleware/rateLimiter.js';
import {
  transferValidator,
  transactionQueryValidator,
} from '../validators/walletValidators.js';

const router = Router();

// Everything here requires authentication.
router.use(protect);

router.get('/balance', getBalance);
router.get('/recipients', searchRecipients);
router.get('/transactions', transactionQueryValidator, validate, getTransactions);
router.post(
  '/transfer',
  paymentLimiter,
  idempotency,
  transferValidator,
  validate,
  transfer
);

export default router;
