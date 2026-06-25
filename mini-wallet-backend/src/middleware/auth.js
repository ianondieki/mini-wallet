import jwt from 'jsonwebtoken';
import { User } from '../models/User.js';
import { AppError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const JWT_ALGORITHM = 'HS256';

/**
 * Verify an access token, pinning the algorithm to HS256 so a forged
 * `{ "alg": "none" }` header can never bypass signature verification.
 * @param {string} token
 * @returns {object} decoded payload
 */
const verifyAccessToken = (token) =>
  jwt.verify(token, process.env.JWT_SECRET, { algorithms: [JWT_ALGORITHM] });

/** Extract a bearer token from the Authorization header, or null. */
const extractToken = (req) => {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
};

/**
 * Hard auth gate. Rejects requests without a valid access token, attaches
 * the live user document to `req.user`.
 */
export const protect = asyncHandler(async (req, _res, next) => {
  const token = extractToken(req);
  if (!token) {
    throw new AppError('Authentication required', 401, 'NO_TOKEN');
  }

  let decoded;
  try {
    decoded = verifyAccessToken(token);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw new AppError('Access token expired', 401, 'TOKEN_EXPIRED');
    }
    throw new AppError('Invalid access token', 401, 'INVALID_TOKEN');
  }

  const user = await User.findById(decoded.sub);
  if (!user || !user.isActive) {
    throw new AppError('User no longer active', 401, 'USER_INACTIVE');
  }

  req.user = user;
  req.userId = user.id;
  return next();
});

/**
 * Soft auth. Attaches `req.user` when a valid token is present but never
 * rejects — used by routes that behave differently for known users.
 */
export const optionalAuth = asyncHandler(async (req, _res, next) => {
  const token = extractToken(req);
  if (!token) return next();
  try {
    const decoded = verifyAccessToken(token);
    const user = await User.findById(decoded.sub);
    if (user && user.isActive) {
      req.user = user;
      req.userId = user.id;
    }
  } catch {
    /* ignore — optional */
  }
  return next();
});

/** Restrict a route to one or more roles (use after `protect`). */
export const authorize =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new AppError('Insufficient permissions', 403, 'FORBIDDEN'));
    }
    return next();
  };

export { JWT_ALGORITHM };
