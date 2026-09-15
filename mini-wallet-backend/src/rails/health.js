/**
 * Per-rail health tracking and circuit breaking.
 *
 * Payment providers do not fail cleanly. They fail slowly: timeouts, 502s,
 * a B2C queue that accepts requests and never resolves them. The damaging
 * response is to keep sending money into that — each attempt ties up customer
 * funds in a reservation and lengthens the queue.
 *
 * So each rail carries a breaker over a sliding window of recent outcomes.
 * Enough failures and it opens: the router stops choosing that rail and
 * routes around it. After a cooldown it half-opens and lets a single probe
 * through, closing again only if that probe succeeds. A rail with a second
 * option behind it degrades instead of breaking.
 *
 * State is per-process and deliberately in-memory: it is a fast local
 * heuristic, not a distributed consensus. Every instance learns the same
 * thing within seconds because they all see the same failures.
 */

/**
 * @readonly
 * @enum {string}
 */
export const BreakerState = Object.freeze({
  /** Healthy — traffic flows. */
  CLOSED: 'closed',
  /** Tripped — traffic is refused. */
  OPEN: 'open',
  /** Cooled down — one probe allowed. */
  HALF_OPEN: 'half_open',
});

const DEFAULTS = {
  /** Outcomes retained per rail. */
  windowSize: 50,
  /** Failure ratio (0..1) that trips the breaker. */
  failureThreshold: 0.5,
  /** Don't judge a rail on fewer outcomes than this. */
  minimumSamples: 8,
  /** How long to stay open before probing, in ms. */
  cooldownMs: 30_000,
  /** Consecutive probe successes needed to fully close. */
  probesToClose: 2,
};

export class RailHealth {
  /**
   * @param {string} rail
   * @param {Partial<typeof DEFAULTS>} [options]
   * @param {() => number} [now]  Injectable clock, so tests need no timers.
   */
  constructor(rail, options = {}, now = Date.now) {
    this.rail = rail;
    this.options = { ...DEFAULTS, ...options };
    this.now = now;
    /** @type {Array<{ok: boolean, at: number, latencyMs: number}>} */
    this.window = [];
    this.state = BreakerState.CLOSED;
    this.openedAt = 0;
    this.consecutiveProbeSuccesses = 0;
  }

  /**
   * Record an outcome and update the breaker.
   * @param {boolean} ok
   * @param {number} [latencyMs]
   */
  record(ok, latencyMs = 0) {
    this.window.push({ ok, at: this.now(), latencyMs });
    if (this.window.length > this.options.windowSize) this.window.shift();

    if (this.state === BreakerState.HALF_OPEN) {
      if (ok) {
        this.consecutiveProbeSuccesses += 1;
        if (this.consecutiveProbeSuccesses >= this.options.probesToClose) this.#close();
      } else {
        this.#open();
      }
      return;
    }

    if (this.state === BreakerState.CLOSED && this.#shouldTrip()) this.#open();
  }

  /** @returns {boolean} */
  #shouldTrip() {
    if (this.window.length < this.options.minimumSamples) return false;
    return this.failureRate >= this.options.failureThreshold;
  }

  #open() {
    this.state = BreakerState.OPEN;
    this.openedAt = this.now();
    this.consecutiveProbeSuccesses = 0;
  }

  #close() {
    this.state = BreakerState.CLOSED;
    this.consecutiveProbeSuccesses = 0;
    // Clear the window so a freshly recovered rail is not re-tripped by the
    // failures that opened it in the first place.
    this.window = [];
  }

  /**
   * Whether the router may send traffic to this rail right now. Reading this
   * also performs the open → half-open transition once the cooldown elapses.
   * @returns {boolean}
   */
  get available() {
    if (this.state === BreakerState.OPEN) {
      if (this.now() - this.openedAt >= this.options.cooldownMs) {
        this.state = BreakerState.HALF_OPEN;
        this.consecutiveProbeSuccesses = 0;
        return true; // let a probe through
      }
      return false;
    }
    return true;
  }

  /** Observed failure ratio over the window, 0 when there is no data. */
  get failureRate() {
    if (this.window.length === 0) return 0;
    return this.window.filter((o) => !o.ok).length / this.window.length;
  }

  /** Observed success ratio; an unproven rail is assumed good. */
  get successRate() {
    if (this.window.length === 0) return 1;
    return 1 - this.failureRate;
  }

  /** Mean latency over the window, in ms. */
  get averageLatencyMs() {
    if (this.window.length === 0) return 0;
    return Math.round(
      this.window.reduce((sum, o) => sum + o.latencyMs, 0) / this.window.length
    );
  }

  /** Force the breaker closed — for an operator override. */
  reset() {
    this.#close();
  }

  /** @returns {object} */
  snapshot() {
    return {
      rail: this.rail,
      state: this.state,
      available: this.state !== BreakerState.OPEN,
      samples: this.window.length,
      successRate: Number(this.successRate.toFixed(4)),
      averageLatencyMs: this.averageLatencyMs,
      openedAt: this.openedAt || null,
    };
  }
}

/** Health trackers keyed by rail. */
const trackers = new Map();

/**
 * Get (creating on first use) the health tracker for a rail.
 * @param {string} rail
 * @param {Partial<typeof DEFAULTS>} [options]
 * @returns {RailHealth}
 */
export const healthFor = (rail, options) => {
  if (!trackers.has(rail)) trackers.set(rail, new RailHealth(rail, options));
  return trackers.get(rail);
};

/** Health of every known rail. @returns {object[]} */
export const healthSnapshot = () => [...trackers.values()].map((t) => t.snapshot());

/** Drop all health state — test hook. */
export const resetAllHealth = () => trackers.clear();

export default { RailHealth, BreakerState, healthFor, healthSnapshot, resetAllHealth };
