import mongoose from 'mongoose';

/**
 * Idempotency records — first class, rather than inferred from transactions.
 *
 * The previous implementation looked for a `Transaction` carrying the key.
 * That worked only for requests that got far enough to create one: a request
 * rejected by validation, or one that died between the rail call and the
 * database write, left no trace, so a retry ran the whole thing again. It
 * also gave a 60-second replay window and then started *rejecting* the key,
 * which turns a client's correct retry into a hard error.
 *
 * Storing the key with the response makes the guarantee the one clients
 * actually need: **the same key returns the same answer**, whatever happened
 * the first time, for as long as the record lives.
 */
const idempotencyRecordSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },

    /**
     * Scoped per user. One customer's key must never match, and therefore
     * never leak or block, another's.
     */
    userId: { type: String, required: true },

    /** Method + path, so the same key on a different endpoint is a new request. */
    endpoint: { type: String, required: true },

    /**
     * SHA-256 of the request body. A key replayed with a *different* payload
     * is a client bug — silently returning the first response would hide it,
     * and executing the second would defeat the key. Both are wrong, so it is
     * rejected explicitly.
     */
    requestHash: { type: String, required: true },

    status: {
      type: String,
      enum: ['in_progress', 'completed'],
      default: 'in_progress',
      required: true,
    },

    /** Captured response, replayed verbatim on a duplicate. */
    responseStatus: { type: Number, default: null },
    responseBody: { type: mongoose.Schema.Types.Mixed, default: null },

    /** Ledger entry this request produced, for audit. */
    entryId: { type: String, default: null },

    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, minimize: false }
);

/**
 * The claim is this unique index. Two concurrent requests with the same key
 * race to insert; exactly one wins and the loser gets a duplicate-key error,
 * which is the signal to replay rather than execute.
 */
idempotencyRecordSchema.index({ userId: 1, key: 1 }, { unique: true });

/** Mongo purges expired records on its own. */
idempotencyRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const IdempotencyRecord = mongoose.model('IdempotencyRecord', idempotencyRecordSchema);
export default IdempotencyRecord;
