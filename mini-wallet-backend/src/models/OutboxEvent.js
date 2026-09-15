import mongoose from 'mongoose';

/**
 * Transactional outbox.
 *
 * Anything that must happen *because* money moved — a webhook to a merchant,
 * a push notification, a ledger export — cannot be done inline. If the HTTP
 * call is made before the commit it may fire for a transaction that then
 * rolls back; if it is made after, a crash in between loses it silently.
 *
 * So the intent to deliver is written **inside the same transaction as the
 * ledger entry**. It commits or rolls back with the money, exactly. A
 * separate dispatcher then delivers it and marks it done, retrying until it
 * succeeds. That gives at-least-once delivery of real events only, with no
 * distributed transaction and no message broker.
 *
 * Consumers must therefore be idempotent — every event carries a stable
 * `eventId` for exactly that.
 */
const outboxEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true },
    type: { type: String, required: true, index: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },

    status: {
      type: String,
      enum: ['pending', 'delivering', 'delivered', 'dead'],
      default: 'pending',
      required: true,
    },

    attempts: { type: Number, default: 0 },
    /** When this becomes eligible for delivery — drives exponential backoff. */
    nextAttemptAt: { type: Date, default: () => new Date(), index: true },
    lastError: { type: String, default: null },
    deliveredAt: { type: Date, default: null },

    /** Correlation back to what produced it. */
    entryId: { type: String, default: null, index: true, sparse: true },
    userId: { type: String, default: null, index: true, sparse: true },
  },
  { timestamps: true, minimize: false }
);

/** The dispatcher's claim query: due, undelivered work, oldest first. */
outboxEventSchema.index({ status: 1, nextAttemptAt: 1 });

export const OutboxEvent = mongoose.model('OutboxEvent', outboxEventSchema);
export default OutboxEvent;
