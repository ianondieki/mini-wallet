import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

/**
 * Access token lives in memory only (never localStorage) so an XSS payload
 * can't trivially exfiltrate it. The refresh token is an httpOnly cookie
 * managed entirely by the backend.
 */
let accessToken = null;
/** Optional callback invoked when refresh fails (wired by AuthContext). */
let onAuthFailure = null;

export const setAccessToken = (token) => {
  accessToken = token || null;
};
export const getAccessToken = () => accessToken;
export const setAuthFailureHandler = (fn) => {
  onAuthFailure = fn;
};

const api = axios.create({
  baseURL: API_URL,
  withCredentials: true, // send/receive the refresh cookie
  headers: { 'Content-Type': 'application/json' },
});

/** Attach the bearer token to every request. */
api.interceptors.request.use((config) => {
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

/* ── Single-flight refresh: queue concurrent 401s behind one refresh ─── */
let isRefreshing = false;
let queue = [];

const flushQueue = (error, token = null) => {
  queue.forEach(({ resolve, reject }) => (error ? reject(error) : resolve(token)));
  queue = [];
};

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const { response, config } = error;
    const original = config || {};

    // Don't try to refresh for auth endpoints themselves. A 401 from login or
    // register means bad input, not an expired session — surface it directly.
    const url = original.url || '';
    const isAuthEndpoint = [
      '/api/auth/refresh',
      '/api/auth/login',
      '/api/auth/register',
      '/api/auth/logout',
    ].some((p) => url.includes(p));
    if (response?.status !== 401 || original._retry || isAuthEndpoint) {
      return Promise.reject(normalizeError(error));
    }

    original._retry = true;

    if (isRefreshing) {
      // Wait for the in-flight refresh, then replay.
      return new Promise((resolve, reject) => {
        queue.push({ resolve, reject });
      })
        .then((token) => {
          original.headers.Authorization = `Bearer ${token}`;
          return api(original);
        })
        .catch((err) => Promise.reject(err));
    }

    isRefreshing = true;
    try {
      const { data } = await api.post('/api/auth/refresh');
      const newToken = data?.data?.accessToken;
      setAccessToken(newToken);
      flushQueue(null, newToken);
      original.headers.Authorization = `Bearer ${newToken}`;
      return api(original);
    } catch (refreshErr) {
      flushQueue(refreshErr, null);
      setAccessToken(null);
      if (onAuthFailure) onAuthFailure();
      return Promise.reject(normalizeError(refreshErr));
    } finally {
      isRefreshing = false;
    }
  }
);

/**
 * Collapse an axios error into a thin object carrying the backend's
 * { message, code } envelope so UI code never reaches into response internals.
 */
const normalizeError = (error) => {
  const data = error.response?.data;
  const message =
    data?.message || error.message || 'Something went wrong. Please try again.';
  const err = new Error(message);
  err.code = data?.code || 'NETWORK_ERROR';
  err.status = error.response?.status;
  err.details = data?.details;
  return err;
};

export default api;
