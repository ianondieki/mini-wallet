import crypto from 'node:crypto';
import axios from 'axios';
import { Rail, RailStatus } from '../Rail.js';
import { AppError } from '../../utils/ApiError.js';
import { logger } from '../../config/logger.js';

/**
 * Shared machinery for rails that are a REST API behind a bearer token.
 *
 * Banks, SACCO core-banking systems and card acquirers differ in their field
 * names and almost nothing else: authenticate, POST a transfer, receive a
 * signed webhook, poll when the webhook does not arrive. Concentrating that
 * here means each concrete adapter is just its provider's vocabulary, and the
 * parts that are easy to get dangerously wrong — token refresh races, retry
 * on non-idempotent POSTs, webhook signature comparison — are written once.
 */
export class HttpRail extends Rail {
  /**
   * @param {object} config
   * @param {string} config.key
   * @param {string} config.displayName
   * @param {object} config.capabilities
   * @param {string} config.baseUrl
   * @param {number} [config.timeoutMs]
   * @param {string} [config.webhookSecret]  HMAC key for callback verification.
   */
  constructor({ key, displayName, capabilities, baseUrl, timeoutMs = 20_000, webhookSecret }) {
    super({ key, displayName, capabilities });
    this.baseUrl = baseUrl;
    this.webhookSecret = webhookSecret;
    this.http = axios.create({ baseURL: baseUrl, timeout: timeoutMs });
    /** @type {{value: string|null, expiresAt: number}} */
    this.tokenCache = { value: null, expiresAt: 0 };
    /** @type {Promise<string>|null} Coalesces concurrent refreshes. */
    this.tokenRefresh = null;
  }

  /**
   * Obtain a provider access token. Override in the concrete adapter.
   * @returns {Promise<{token: string, expiresInSec: number}>}
   * @abstract
   */
  async authenticate() {
    throw new Error(`${this.key} has not implemented authenticate()`);
  }

  /**
   * Cached bearer token, refreshed 60s before expiry.
   *
   * Concurrent callers share one in-flight refresh. Without that, a burst of
   * requests on a cold cache fires a refresh each, and providers that
   * invalidate the previous token on issue will fail all but one of them.
   *
   * @returns {Promise<string>}
   */
  async token() {
    const now = Date.now();
    if (this.tokenCache.value && now < this.tokenCache.expiresAt - 60_000) {
      return this.tokenCache.value;
    }
    if (this.tokenRefresh) return this.tokenRefresh;

    this.tokenRefresh = (async () => {
      try {
        const { token, expiresInSec } = await this.authenticate();
        this.tokenCache = { value: token, expiresAt: Date.now() + expiresInSec * 1000 };
        return token;
      } finally {
        this.tokenRefresh = null;
      }
    })();
    return this.tokenRefresh;
  }

  /**
   * Authenticated request with bounded retries.
   *
   * Retries are allowed only on connection errors and 5xx, and only when the
   * call carries an idempotency key — retrying a POST that may already have
   * moved money is exactly the double-payment this system is built to avoid.
   *
   * @param {object} options
   * @param {string} options.method
   * @param {string} options.path
   * @param {object} [options.body]
   * @param {string} [options.idempotencyKey]
   * @param {number} [options.retries]
   * @returns {Promise<object>}
   */
  async request({ method, path, body, idempotencyKey, retries = 0 }) {
    const attempt = async (n) => {
      const token = await this.token();
      try {
        const { data } = await this.http.request({
          method,
          url: path,
          data: body,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          },
        });
        return data;
      } catch (err) {
        const status = err.response?.status;

        // A rejected token is worth exactly one retry with a fresh one.
        if (status === 401 && n === 0) {
          this.tokenCache = { value: null, expiresAt: 0 };
          return attempt(n + 1);
        }

        const transient = !status || status >= 500;
        if (transient && idempotencyKey && n < retries) {
          const backoff = 2 ** n * 250;
          logger.warn('Rail request failed — retrying', {
            rail: this.key,
            path,
            status,
            attempt: n + 1,
            backoff,
          });
          await new Promise((r) => {
            const t = setTimeout(r, backoff);
            t.unref?.();
          });
          return attempt(n + 1);
        }

        logger.error('Rail request failed', {
          rail: this.key,
          path,
          status,
          data: err.response?.data,
        });
        throw new AppError(
          err.response?.data?.message || err.response?.data?.error || `${this.displayName} request failed`,
          502,
          'RAIL_REQUEST_FAILED',
          { rail: this.key, providerStatus: status }
        );
      }
    };
    return attempt(0);
  }

  /**
   * Verify an HMAC-SHA256 webhook signature in constant time.
   *
   * Unsigned webhooks are rejected rather than trusted: a callback that
   * credits a wallet is the highest-value forgery target in the system, so a
   * rail with no configured secret simply cannot deliver events.
   *
   * @param {import('express').Request} req
   * @param {string} [headerName]
   * @returns {{ok: boolean, reason?: string}}
   */
  verifyCallback(req, headerName = 'x-signature') {
    if (!this.webhookSecret) {
      return { ok: false, reason: `${this.key} has no webhook secret configured` };
    }
    const provided = String(req.get?.(headerName) ?? '');
    if (!provided) return { ok: false, reason: 'missing signature header' };

    const expected = crypto
      .createHmac('sha256', this.webhookSecret)
      // `rawBody` is the exact bytes received; re-serialising the parsed body
      // would change key order or spacing and break an otherwise valid MAC.
      .update(req.rawBody ?? JSON.stringify(req.body ?? {}))
      .digest('hex');

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, reason: 'signature mismatch' };
    }
    return { ok: true };
  }

  /**
   * Map a provider status string onto our lifecycle via a lookup table.
   * Unrecognised values become UNKNOWN, never a guess.
   *
   * @param {string} providerStatus
   * @param {Record<string, string>} table
   * @returns {string}
   */
  static mapStatus(providerStatus, table) {
    return table[String(providerStatus).toUpperCase()] ?? RailStatus.UNKNOWN;
  }
}

export default HttpRail;
