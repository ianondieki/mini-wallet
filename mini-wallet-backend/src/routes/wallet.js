import { Router } from 'express';
import {
  getBalance,
  getLimits,
  getQuote,
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
  quoteValidator,
  transactionQueryValidator,
} from '../validators/walletValidators.js';

const router = Router();

router.use(protect);

router.get('/balance', getBalance);
router.get('/limits', getLimits);
router.get('/recipients', searchRecipients);
router.get('/transactions', transactionQueryValidator, validate, getTransactions);

// Quoting moves no money, so it needs no idempotency key — and must not, or a
// client could not price the same transfer twice.
router.post('/quote', quoteValidator, validate, getQuote);

router.post(
  '/transfer',
  paymentLimiter,
  idempotency(),
  transferValidator,
  validate,
  transfer
);

export default router;
