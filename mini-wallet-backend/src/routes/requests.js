import { Router } from 'express';
import { create, list, approve, decline, cancel } from '../controllers/requestController.js';
import { protect } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { paymentLimiter } from '../middleware/rateLimiter.js';
import {
  createRequestValidator,
  requestIdValidator,
  groupIdValidator,
  declineValidator,
  listRequestValidator,
} from '../validators/requestValidators.js';

const router = Router();
router.use(protect);

router.get('/', listRequestValidator, validate, list);
router.post('/', createRequestValidator, validate, create);

// No idempotency middleware here: the settlement key is derived from the
// request id inside the service, so a double tap cannot double-pay regardless
// of what header the client sends. See requestService.settlementKey().
router.post('/:requestId/approve', paymentLimiter, requestIdValidator, validate, approve);
router.post('/:requestId/decline', declineValidator, validate, decline);

router.delete('/group/:groupId', groupIdValidator, validate, cancel);
router.delete('/:requestId', requestIdValidator, validate, cancel);

export default router;
