import { Router } from 'express';
import {
  getReconciliation,
  getTrialBalance,
  verifyAccount,
  getStuckPayments,
  reconcileStatement,
  getRailHealth,
  getDeadLetters,
} from '../controllers/opsController.js';
import { protect, authorize } from '../middleware/auth.js';

/**
 * Operator endpoints. Admin only — these expose the whole institution's
 * position, not one customer's.
 */
const router = Router();

router.use(protect, authorize('admin'));

router.get('/reconciliation', getReconciliation);
router.get('/trial-balance', getTrialBalance);
router.get('/accounts/:account/verify', verifyAccount);
router.get('/stuck', getStuckPayments);
router.get('/rails/health', getRailHealth);
router.get('/outbox/dead', getDeadLetters);
router.post('/rails/:rail/reconcile', reconcileStatement);

export default router;
