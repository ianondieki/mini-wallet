import { register, clear, all, get, has, candidatesFor, describeAll } from './registry.js';
import { MpesaRail } from './adapters/mpesa.js';
import { PesaLinkRail } from './adapters/pesalink.js';
import { fineractRailsFromEnv } from './adapters/fineract.js';
import { InternalRail } from './adapters/internal.js';
import { SimulatorRail } from './adapters/simulator.js';
import { logger } from '../config/logger.js';

/**
 * Rail bootstrap.
 *
 * Which rails a deployment runs is configuration, not code: a Kenyan
 * deployment brings up M-Pesa and PesaLink, a SACCO-partnership deployment
 * adds a Fineract rail per institution, and a developer with no credentials
 * gets the simulator. Nothing downstream changes — the router simply has a
 * different set of candidates to choose between.
 */

/**
 * Register every rail this deployment should offer.
 *
 * @param {object} deps
 * @param {(instrument: import('./Rail.js').Instrument) => Promise<string|null>} deps.resolveUserId
 *   Used by the internal rail to detect on-platform recipients.
 * @param {boolean} [deps.includeSimulator]
 * @returns {import('./Rail.js').Rail[]}
 */
export const bootstrapRails = ({ resolveUserId, includeSimulator } = {}) => {
  clear();

  // Always first: an on-platform recipient should never be paid over an
  // external rail, and the router can only see that option if it is registered.
  if (resolveUserId) register(new InternalRail({ resolveUserId }));

  if (process.env.MPESA_CONSUMER_KEY && process.env.MPESA_SHORT_CODE) {
    register(new MpesaRail());
  } else {
    logger.warn('M-Pesa not registered — MPESA_CONSUMER_KEY/MPESA_SHORT_CODE missing');
  }

  const pesalink = new PesaLinkRail();
  if (pesalink.configured) register(pesalink);

  for (const sacco of fineractRailsFromEnv()) {
    if (sacco.configured) register(sacco);
  }

  // The simulator must never be reachable in production: it would settle
  // payouts that never happened.
  const wantSimulator = includeSimulator ?? process.env.ENABLE_RAIL_SIMULATOR === 'true';
  if (wantSimulator && process.env.NODE_ENV !== 'production') {
    register(new SimulatorRail());
  }

  logger.info('Rails bootstrapped', { rails: all().map((r) => r.key) });
  return all();
};

export {
  register,
  clear,
  all,
  get,
  has,
  candidatesFor,
  describeAll,
  MpesaRail,
  PesaLinkRail,
  InternalRail,
  SimulatorRail,
};
export * from './Rail.js';
export * from './router.js';
export default { bootstrapRails, register, all, get };
