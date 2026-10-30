import { Router } from 'express';
import {
  list, create, contribute, quote, withdraw, close,
} from '../controllers/savingsController.js';
import { protect } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { idempotency } from '../middleware/idempotency.js';
import { paymentLimiter } from '../middleware/rateLimiter.js';
import {
  createGoalValidator, contributeValidator, withdrawValidator, quoteValidator, goalIdValidator,
} from '../validators/savingsValidators.js';

const router = Router();
router.use(protect);

router.get('/goals', list);
router.post('/goals', createGoalValidator, validate, create);

// Read-only, so no idempotency key — the customer must be able to ask twice.
router.get('/goals/:goalId/withdrawal-quote', quoteValidator, validate, quote);

router.post('/goals/:goalId/contribute',
  paymentLimiter, idempotency(), contributeValidator, validate, contribute);
router.post('/goals/:goalId/withdraw',
  paymentLimiter, idempotency(), withdrawValidator, validate, withdraw);

router.delete('/goals/:goalId', goalIdValidator, validate, close);

export default router;
