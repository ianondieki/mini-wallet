import axios from 'axios';
import { logger } from './logger.js';
import { AppError } from '../utils/ApiError.js';

/**
 * Daraja integration layer.
 *
 * Holds a single in-memory OAuth token and refreshes it lazily, a safety
 * window BEFORE it actually expires, so we never send a request with a
 * token that dies mid-flight and we never request a fresh token per call.
 */

const SAFETY_WINDOW_MS = 60 * 1000; // refresh 60s before expiry

const tokenCache = {
  value: null,
  expiresAt: 0, // epoch ms
};

/** Shared axios instance pointed at the configured Daraja base URL. */
const daraja = axios.create({
  baseURL: process.env.MPESA_BASE_URL,
  timeout: 15000,
});

/**
 * Get a valid Daraja OAuth bearer token, using the cache when still fresh.
 * @returns {Promise<string>}
 */
export const getAccessToken = async () => {
  const now = Date.now();
  if (tokenCache.value && now < tokenCache.expiresAt - SAFETY_WINDOW_MS) {
    return tokenCache.value;
  }

  const key = process.env.MPESA_CONSUMER_KEY;
  const secret = process.env.MPESA_CONSUMER_SECRET;
  if (!key || !secret) {
    throw new AppError('M-Pesa credentials not configured', 500, 'MPESA_CONFIG_ERROR');
  }

  const auth = Buffer.from(`${key}:${secret}`).toString('base64');
  try {
    const { data } = await daraja.get(
      '/oauth/v1/generate?grant_type=client_credentials',
      { headers: { Authorization: `Basic ${auth}` } }
    );
    const expiresInSec = Number.parseInt(data.expires_in, 10) || 3599;
    tokenCache.value = data.access_token;
    tokenCache.expiresAt = now + expiresInSec * 1000;
    logger.debug('Daraja OAuth token refreshed', { expiresInSec });
    return tokenCache.value;
  } catch (err) {
    logger.error('Daraja OAuth request failed', {
      status: err.response?.status,
      data: err.response?.data,
    });
    throw new AppError('Failed to authenticate with M-Pesa', 502, 'MPESA_AUTH_FAILED');
  }
};

/** Force-clear the cached token (used by tests / on auth errors). */
export const clearTokenCache = () => {
  tokenCache.value = null;
  tokenCache.expiresAt = 0;
};

/**
 * Make an authenticated POST to a Daraja endpoint, mapping transport
 * failures to a clean AppError.
 *
 * @param {string} path  Daraja path, e.g. "/mpesa/stkpush/v1/processrequest".
 * @param {object} body
 * @returns {Promise<object>} Daraja response body.
 */
export const darajaPost = async (path, body) => {
  const token = await getAccessToken();
  try {
    const { data } = await daraja.post(path, body, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return data;
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    logger.error('Daraja request failed', { path, status, data });
    // Daraja returns errorCode/errorMessage on validation problems.
    const message = data?.errorMessage || data?.ResultDesc || 'M-Pesa request failed';
    throw new AppError(message, 502, 'MPESA_REQUEST_FAILED', {
      darajaStatus: status,
      darajaCode: data?.errorCode,
    });
  }
};

export { daraja };
export default { getAccessToken, darajaPost, clearTokenCache };
