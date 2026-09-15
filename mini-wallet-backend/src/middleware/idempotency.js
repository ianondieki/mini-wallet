import crypto from 'node:crypto';
import { IdempotencyRecord } from '../models/IdempotencyRecord.js';
import { AppError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { logger } from '../config/logger.js';

/**
 * Idempotency for money-moving endpoints.
 *
 * A client retrying a transfer after a timeout has no way to know whether the
 * first attempt reached us. Without this, the honest retry is a double
 * payment. With it, the retry returns the original response.
 *
 * The guarantee: **one key, one execution, one answer**, for as long as the
 * record lives.
 *
 * ## How
 *
 * 1. Claim the key by inserting a record. The unique index makes this the
 *    atomic step, so concurrent retries cannot both proceed.
 * 2. If the claim fails, the key already exists:
 *    - different request body → 422, a client bug worth surfacing;
 *    - still running → 409, tell them to retry shortly;
 *    - finished → replay the stored response verbatim.
 * 3. On completion, store the response.
 *
 * ## The 5xx nuance
 *
 * A completed record is kept for 4xx responses — a validation failure is
 * deterministic, so replaying it is correct. It is **released** for 5xx and
 * for thrown errors, because those may be transient and the client must be
 * able to genuinely retry. Pinning a server error to the key would make a
 * recoverable blip permanent for that request.
 */

/** How long a key is honoured. Stripe uses 24h; matching it is uncontroversial. */
const RETENTION_MS = 24 * 60 * 60 * 1000;

/** Stable hash of the request payload. */
const hashRequest = (req) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(req.body ?? {}))
    .digest('hex');

/**
 * @param {object} [options]
 * @param {boolean} [options.required]  Reject a request with no key (default true).
 * @returns {import('express').RequestHandler}
 */
export const idempotency = ({ required = true } = {}) =>
  asyncHandler(async (req, res, next) => {
    const key = req.get('Idempotency-Key');

    if (!key) {
      if (!required) return next();
      throw new AppError(
        'Idempotency-Key header is required for this operation',
        400,
        'IDEMPOTENCY_KEY_REQUIRED'
      );
    }
    if (!/^[\w-]{8,128}$/.test(key)) {
      throw new AppError('Malformed Idempotency-Key', 400, 'IDEMPOTENCY_KEY_INVALID');
    }
    if (!req.userId) {
      // Scoping depends on the authenticated user; running unscoped would let
      // one customer's key collide with another's.
      throw new AppError('Idempotency requires authentication', 401, 'NO_TOKEN');
    }

    const endpoint = `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`;
    const requestHash = hashRequest(req);

    try {
      await IdempotencyRecord.create({
        key,
        userId: req.userId,
        endpoint,
        requestHash,
        status: 'in_progress',
        expiresAt: new Date(Date.now() + RETENTION_MS),
      });
    } catch (err) {
      if (err?.code !== 11000) throw err;
      return replayOrReject({ req, res, key, endpoint, requestHash });
    }

    // We own the key. Capture the response so a retry can be served from it.
    req.idempotencyKey = key;
    captureResponse({ req, res, key });
    return next();
  });

/**
 * Serve, or refuse, a request whose key is already taken.
 * @returns {Promise<void>}
 */
const replayOrReject = async ({ req, res, key, endpoint, requestHash }) => {
  const existing = await IdempotencyRecord.findOne({ userId: req.userId, key }).lean();

  // TTL removal between the failed insert and this read — treat as fresh.
  if (!existing) {
    throw new AppError('Idempotency key is in flux; please retry', 409, 'IDEMPOTENCY_RETRY');
  }

  if (existing.endpoint !== endpoint || existing.requestHash !== requestHash) {
    throw new AppError(
      'This Idempotency-Key was already used with a different request. ' +
        'Use a new key for a new request.',
      422,
      'IDEMPOTENCY_KEY_REUSED'
    );
  }

  if (existing.status === 'in_progress') {
    throw new AppError(
      'A request with this Idempotency-Key is still being processed',
      409,
      'IDEMPOTENCY_IN_PROGRESS'
    );
  }

  logger.info('Replaying idempotent response', { key, userId: req.userId, endpoint });
  res.set('Idempotent-Replay', 'true');
  res.status(existing.responseStatus ?? 200).json(existing.responseBody);
};

/**
 * Wrap `res.json` so the outcome is persisted against the key — or the claim
 * released, when the failure is one worth retrying.
 */
const captureResponse = ({ req, res, key }) => {
  const originalJson = res.json.bind(res);

  res.json = (body) => {
    const status = res.statusCode;

    // Fire-and-forget: the customer's response must not wait on bookkeeping,
    // and a failure to record is logged rather than surfaced.
    const persist =
      status >= 500
        ? IdempotencyRecord.deleteOne({ userId: req.userId, key })
        : IdempotencyRecord.updateOne(
            { userId: req.userId, key },
            {
              status: 'completed',
              responseStatus: status,
              responseBody: body,
              ...(req.ledgerEntryId ? { entryId: req.ledgerEntryId } : {}),
            }
          );

    persist.catch((err) =>
      logger.error('Failed to record idempotent response', { key, message: err.message })
    );

    return originalJson(body);
  };

  // A thrown error never reaches res.json, so release the claim there too.
  res.on('finish', () => {
    if (res.statusCode >= 500) {
      IdempotencyRecord.deleteOne({ userId: req.userId, key }).catch(() => {});
    }
  });
};

export default idempotency;
