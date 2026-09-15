import { Transaction } from '../models/Transaction.js';
import { AppError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const IDEMPOTENCY_WINDOW_MS = 60 * 1000;

/**
 * Idempotency guard for money-moving endpoints.
 *
 * Reads the `Idempotency-Key` header. If a transaction with that key was
 * created by THIS user within the last 60s, the request is treated as a
 * duplicate and the original result is returned instead of executing again.
 * The key is stamped onto `req.idempotencyKey` for the controller to persist.
 *
 * The lookup is scoped to `req.userId` (the sender) so one user's key can
 * never match — and therefore never leak or block — another user's request.
 * Uniqueness is likewise enforced per-sender by the partial index on the
 * Transaction model; this middleware just provides the fast happy-path replay.
 *
 * The header is REQUIRED for transfers/withdrawals — a missing key is a
 * client bug and we fail loudly rather than silently allowing double-spend.
 *
 * Must run AFTER `protect` so `req.userId` is populated.
 */
export const idempotency = asyncHandler(async (req, res, next) => {
  const key = req.get('Idempotency-Key');
  if (!key) {
    throw new AppError(
      'Idempotency-Key header is required for this operation',
      400,
      'IDEMPOTENCY_KEY_REQUIRED'
    );
  }
  if (!/^[\w-]{8,128}$/.test(key)) {
    throw new AppError('Malformed Idempotency-Key', 400, 'IDEMPOTENCY_KEY_INVALID');
  }

  const existing = await Transaction.findOne({
    idempotencyKey: key,
    sender: req.userId,
  }).lean();
  if (existing) {
    const age = Date.now() - new Date(existing.createdAt).getTime();
    if (age < IDEMPOTENCY_WINDOW_MS) {
      // Replay protection: surface the original transaction, not a new one.
      return res.status(200).json({
        success: true,
        message: 'Duplicate request ignored (idempotent replay)',
        code: 'IDEMPOTENT_REPLAY',
        data: { transaction: existing },
      });
    }
    // Older than the window but key already used → conflict.
    throw new AppError(
      'Idempotency-Key has already been used',
      409,
      'IDEMPOTENCY_KEY_REUSED'
    );
  }

  req.idempotencyKey = key;
  return next();
});

export default idempotency;
