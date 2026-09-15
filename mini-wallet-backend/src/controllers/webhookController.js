import * as payments from '../services/paymentService.js';
import { get as getRail, has as hasRail } from '../rails/registry.js';
import { RailStatus } from '../rails/Rail.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { logger } from '../config/logger.js';

/**
 * Inbound rail callbacks.
 *
 * One handler for every provider. The adapter authenticates the request and
 * translates the payload; this decides what to do with the result. Adding a
 * rail therefore adds no routing and no endpoint — only an adapter.
 *
 * ## Why almost everything returns 200
 *
 * Providers retry on a non-2xx, often aggressively and for a long time. A
 * rejected callback that answers 401 teaches the provider to keep hammering
 * an endpoint that will never accept it, and on Safaricom's side a failed
 * delivery can put the whole callback queue behind it.
 *
 * So a callback we refuse is **acknowledged and dropped**: logged, not acted
 * on, and answered 200. The provider stops retrying, and the money is caught
 * by reconciliation instead — which is exactly what reconciliation is for.
 */

/** What Safaricom expects; harmless to other providers. */
const ACK = { ResultCode: 0, ResultDesc: 'Accepted' };

/**
 * Build a callback handler for a named rail.
 *
 * @param {string} railKey
 * @param {object} [options]
 * @param {boolean} [options.treatAsFailure]  For queue-timeout endpoints.
 * @returns {import('express').RequestHandler}
 */
export const railCallback = (railKey, { treatAsFailure = false } = {}) =>
  asyncHandler(async (req, res) => {
    if (!hasRail(railKey)) {
      logger.error('Callback for an unregistered rail', { rail: railKey });
      return res.status(200).json(ACK);
    }
    const rail = getRail(railKey);

    // 1. Authenticate. The default implementation denies, so a rail that has
    //    not implemented this cannot credit anything.
    const verdict = rail.verifyCallback(req);
    if (!verdict.ok) {
      logger.warn('Rejected rail callback', { rail: railKey, reason: verdict.reason, ip: req.ip });
      return res.status(200).json(ACK);
    }

    // 2. Translate. parseCallback is total: it returns UNKNOWN rather than
    //    throwing, so a malformed payload cannot wedge the endpoint.
    let event;
    try {
      event = rail.parseCallback(req.body);
    } catch (err) {
      logger.error('Rail callback parser threw', { rail: railKey, message: err.message });
      return res.status(200).json(ACK);
    }

    if (treatAsFailure && event.status !== RailStatus.SUCCEEDED) {
      event = {
        ...event,
        status: RailStatus.FAILED,
        failureReason: event.failureReason ?? 'provider queue timeout',
      };
    }

    if (event.status === RailStatus.UNKNOWN) {
      logger.warn('Unrecognised rail callback payload', { rail: railKey });
      return res.status(200).json(ACK);
    }

    // 3. Apply. Idempotent: the order's status is flipped by a conditional
    //    update, so a provider retrying ten times settles once.
    try {
      const result = await payments.handleRailEvent(event);
      logger.info('Rail callback processed', {
        rail: railKey,
        status: event.status,
        providerRef: event.providerRef,
        handled: result.handled,
        reason: result.reason,
      });
    } catch (err) {
      // Acknowledge anyway. Retrying will not help if our own write failed,
      // and reconciliation will find it.
      logger.error('Failed to apply rail callback', {
        rail: railKey,
        providerRef: event.providerRef,
        message: err.message,
      });
    }

    return res.status(200).json(ACK);
  });

export default railCallback;
