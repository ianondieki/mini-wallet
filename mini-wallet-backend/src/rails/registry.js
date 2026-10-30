import { Rail } from './Rail.js';
import { healthFor } from './health.js';
import { logger } from '../config/logger.js';

/**
 * The registry of available rails.
 *
 * Adapters register here at boot; nothing else in the system holds a direct
 * reference to a concrete adapter. That indirection is what lets a deployment
 * enable M-Pesa and PesaLink in Kenya, and a different set elsewhere, without
 * touching any business logic — and what lets the router treat rails as
 * interchangeable candidates rather than named special cases.
 */

/** @type {Map<string, Rail>} */
const rails = new Map();

/**
 * Register a rail. Re-registering the same key replaces it, which is what
 * tests and hot-reload want.
 *
 * @param {Rail} rail
 * @returns {Rail}
 */
export const register = (rail) => {
  if (!(rail instanceof Rail)) {
    throw new TypeError('register() expects a Rail instance');
  }
  if (rails.has(rail.key)) {
    logger.warn('Replacing already-registered rail', { rail: rail.key });
  }
  rails.set(rail.key, rail);
  healthFor(rail.key); // start tracking health from registration
  logger.info('Rail registered', {
    rail: rail.key,
    directions: rail.capabilities.directions,
    countries: rail.capabilities.countries,
  });
  return rail;
};

/**
 * Look up a rail, throwing if it is not registered — a missing rail is a
 * configuration error, never something to paper over.
 * @param {string} key
 * @returns {Rail}
 */
export const get = (key) => {
  const rail = rails.get(key);
  if (!rail) {
    throw new RangeError(
      `Unknown rail "${key}". Registered: ${[...rails.keys()].join(', ') || '(none)'}`
    );
  }
  return rail;
};

/** @param {string} key @returns {boolean} */
export const has = (key) => rails.has(key);

/** @returns {Rail[]} */
export const all = () => [...rails.values()];

/**
 * Rails that could structurally carry this intent, ignoring cost and health.
 * @param {import('./Rail.js').PaymentIntent} intent
 * @returns {{ eligible: Rail[], rejected: Array<{rail: string, reason: string}> }}
 */
export const candidatesFor = (intent) => {
  const eligible = [];
  const rejected = [];
  for (const rail of rails.values()) {
    const verdict = rail.supports(intent);
    if (verdict.ok) eligible.push(rail);
    else rejected.push({ rail: rail.key, reason: verdict.reason });
  }
  return { eligible, rejected };
};

/** Capability catalogue, for the public /rails endpoint. @returns {object[]} */
export const describeAll = () =>
  all().map((rail) => ({ ...rail.describe(), health: healthFor(rail.key).snapshot() }));

/** Clear the registry — test hook. */
export const clear = () => rails.clear();

export default { register, get, has, all, candidatesFor, describeAll, clear };
