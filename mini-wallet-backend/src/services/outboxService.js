import { randomUUID } from 'node:crypto';
import { OutboxEvent } from '../models/OutboxEvent.js';
import { logger } from '../config/logger.js';

/**
 * Outbox producer and dispatcher.
 *
 * {@link enqueue} is called inside the money-moving transaction; {@link dispatch}
 * runs on a timer and delivers what committed.
 */

/** Handlers by event type. @type {Map<string, Array<(event: object) => Promise<void>>>} */
const handlers = new Map();

/** Stop retrying after this many attempts and park the event for a human. */
const MAX_ATTEMPTS = 8;

/** Claim at most this many events per dispatch tick. */
const BATCH_SIZE = 25;

/**
 * Backoff before attempt `n`: 2s, 4s, 8s … capped at an hour, so a provider
 * that is down for a while is retried patiently rather than hammered.
 * @param {number} attempts
 * @returns {Date}
 */
const backoffFrom = (attempts) =>
  new Date(Date.now() + Math.min(2 ** attempts * 1000, 60 * 60 * 1000));

/**
 * Subscribe to an event type. Handlers must be idempotent: delivery is
 * at-least-once, so the same event can legitimately arrive twice.
 *
 * @param {string} type
 * @param {(event: object) => Promise<void>} handler
 */
export const on = (type, handler) => {
  if (!handlers.has(type)) handlers.set(type, []);
  handlers.get(type).push(handler);
};

/** Remove every handler — test hook. */
export const clearHandlers = () => handlers.clear();

/**
 * Record an event for later delivery.
 *
 * Pass the `session` of the transaction that is moving the money. Without it
 * the event is no longer transactional and the guarantee is lost.
 *
 * @param {object} event
 * @param {string} event.type
 * @param {object} event.payload
 * @param {string} [event.entryId]
 * @param {string} [event.userId]
 * @param {object} [options]
 * @param {import('mongoose').ClientSession} [options.session]
 * @returns {Promise<string>} The event id.
 */
export const enqueue = async ({ type, payload, entryId, userId }, { session } = {}) => {
  const eventId = randomUUID();
  await OutboxEvent.create(
    [{ eventId, type, payload, entryId, userId, status: 'pending' }],
    { session }
  );
  return eventId;
};

/**
 * Deliver one claimed event to every handler registered for its type.
 * @param {object} event
 */
const deliver = async (event) => {
  const registered = handlers.get(event.type) ?? [];
  if (registered.length === 0) {
    // Nothing is listening. That is a legitimate state (a deployment that
    // does not use webhooks), so mark it delivered rather than retrying
    // forever against nobody.
    logger.debug('No handler for outbox event — discarding', { type: event.type });
    return;
  }
  // Sequential: one handler failing must not leave the others' outcome
  // ambiguous, and the whole event is retried as a unit anyway.
  for (const handler of registered) {
    await handler(event);
  }
};

/**
 * Deliver one batch of due events.
 *
 * Events are claimed with an atomic `findOneAndUpdate`, so several dispatcher
 * instances can run concurrently without delivering the same event twice.
 *
 * @param {object} [options]
 * @param {number} [options.batchSize]
 * @returns {Promise<{claimed: number, delivered: number, failed: number, dead: number}>}
 */
export const dispatch = async ({ batchSize = BATCH_SIZE } = {}) => {
  const stats = { claimed: 0, delivered: 0, failed: 0, dead: 0 };

  for (let i = 0; i < batchSize; i += 1) {
    const event = await OutboxEvent.findOneAndUpdate(
      { status: 'pending', nextAttemptAt: { $lte: new Date() } },
      { $set: { status: 'delivering' }, $inc: { attempts: 1 } },
      { sort: { nextAttemptAt: 1 }, new: true }
    ).lean();

    if (!event) break; // nothing due
    stats.claimed += 1;

    try {
      await deliver(event);
      await OutboxEvent.updateOne(
        { _id: event._id },
        { $set: { status: 'delivered', deliveredAt: new Date(), lastError: null } }
      );
      stats.delivered += 1;
    } catch (err) {
      const exhausted = event.attempts >= MAX_ATTEMPTS;
      await OutboxEvent.updateOne(
        { _id: event._id },
        {
          $set: {
            status: exhausted ? 'dead' : 'pending',
            nextAttemptAt: backoffFrom(event.attempts),
            lastError: err.message?.slice(0, 500),
          },
        }
      );
      if (exhausted) {
        stats.dead += 1;
        // A dead event is a real incident: something that should have been
        // told about a money movement never was.
        logger.error('Outbox event exhausted its retries', {
          eventId: event.eventId,
          type: event.type,
          attempts: event.attempts,
          error: err.message,
        });
      } else {
        stats.failed += 1;
        logger.warn('Outbox delivery failed — will retry', {
          eventId: event.eventId,
          type: event.type,
          attempt: event.attempts,
        });
      }
    }
  }

  return stats;
};

/**
 * Recover events abandoned mid-flight by a process that died while holding
 * the `delivering` claim. Without this they would never be retried.
 *
 * @param {number} [staleAfterMs]
 * @returns {Promise<number>} How many were released.
 */
export const recoverStuck = async (staleAfterMs = 5 * 60 * 1000) => {
  const result = await OutboxEvent.updateMany(
    { status: 'delivering', updatedAt: { $lte: new Date(Date.now() - staleAfterMs) } },
    { $set: { status: 'pending', nextAttemptAt: new Date() } }
  );
  if (result.modifiedCount > 0) {
    logger.warn('Recovered stuck outbox events', { count: result.modifiedCount });
  }
  return result.modifiedCount;
};

/**
 * Run the dispatcher on an interval. Returns a stop function.
 * @param {object} [options]
 * @param {number} [options.intervalMs]
 * @returns {() => void}
 */
export const startDispatcher = ({ intervalMs = 2000 } = {}) => {
  let running = false;
  const tick = async () => {
    if (running) return; // never overlap ticks
    running = true;
    try {
      await recoverStuck();
      await dispatch();
    } catch (err) {
      logger.error('Outbox dispatcher tick failed', { message: err.message });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref(); // must not hold the process open at shutdown
  logger.info('Outbox dispatcher started', { intervalMs });
  return () => clearInterval(timer);
};

/** Events parked for human attention. @returns {Promise<object[]>} */
export const deadLetters = () =>
  OutboxEvent.find({ status: 'dead' }).sort({ updatedAt: -1 }).limit(100).lean();

export default { on, enqueue, dispatch, startDispatcher, recoverStuck, deadLetters, clearHandlers };
