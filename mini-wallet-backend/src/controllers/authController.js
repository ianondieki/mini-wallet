import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { User } from '../models/User.js';
import { Wallet } from '../models/Wallet.js';
import { RefreshToken } from '../models/RefreshToken.js';
import { AppError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { logger } from '../config/logger.js';
import { maskPhone } from '../utils/mpesaHelpers.js';

const JWT_ALGORITHM = 'HS256';
const REFRESH_COOKIE = 'refreshToken';

/** Sign a short-lived access token. */
const signAccessToken = (user) =>
  jwt.sign({ role: user.role }, process.env.JWT_SECRET, {
    subject: user.id,
    algorithm: JWT_ALGORITHM,
    expiresIn: process.env.JWT_ACCESS_EXPIRES || '15m',
  });

/** Sign a long-lived refresh token. */
const signRefreshToken = (user) =>
  jwt.sign({ type: 'refresh' }, process.env.JWT_REFRESH_SECRET, {
    subject: user.id,
    algorithm: JWT_ALGORITHM,
    expiresIn: process.env.JWT_REFRESH_EXPIRES || '7d',
  });

/** httpOnly cookie options for the refresh token. */
const refreshCookieOptions = () => {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'strict' : 'lax',
    path: '/api/auth',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7d
  };
};

/**
 * Persist a hashed refresh token record so it can be rotated/revoked.
 * @param {string} userId
 * @param {string} rawToken
 */
const storeRefreshToken = async (userId, rawToken) => {
  const decoded = jwt.decode(rawToken);
  await RefreshToken.create({
    user: userId,
    token: RefreshToken.hashToken(rawToken),
    expiresAt: new Date(decoded.exp * 1000),
  });
};

/**
 * Issue a fresh access+refresh pair, store the refresh token, set the cookie.
 * @returns {Promise<string>} the access token
 */
const issueTokens = async (res, user) => {
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  await storeRefreshToken(user.id, refreshToken);
  res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions());
  return accessToken;
};

/**
 * Register a new user and atomically create their wallet.
 * @route POST /api/auth/register
 */
export const register = asyncHandler(async (req, res) => {
  const { name, email, phone, password } = req.body;

  const session = await mongoose.startSession();
  let user;
  try {
    await session.withTransaction(async () => {
      const created = await User.create([{ name, email, phone, password }], { session });
      user = created[0];
      await Wallet.create([{ user: user._id, balance: 0 }], { session });
    });
  } finally {
    await session.endSession();
  }

  const accessToken = await issueTokens(res, user);
  logger.info('User registered', { userId: user.id, phone: maskPhone(user.phone) });

  res.status(201).json({
    success: true,
    message: 'Account created',
    data: { user: user.toJSON(), accessToken },
  });
});

/**
 * Authenticate with email + password.
 * @route POST /api/auth/login
 */
export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  // Explicitly select the password (select:false on the schema).
  const user = await User.findOne({ email }).select('+password');
  if (!user || !(await user.comparePassword(password))) {
    // Generic message — do not reveal whether the email exists.
    throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
  }
  if (!user.isActive) {
    throw new AppError('Account is deactivated', 403, 'ACCOUNT_DISABLED');
  }

  const accessToken = await issueTokens(res, user);
  logger.info('User logged in', { userId: user.id });

  res.json({
    success: true,
    message: 'Logged in',
    data: { user: user.toJSON(), accessToken },
  });
});

/**
 * Silently rotate tokens using the httpOnly refresh cookie. The presented
 * refresh token is verified, looked up (by hash), revoked, and replaced.
 * @route POST /api/auth/refresh
 */
export const refresh = asyncHandler(async (req, res) => {
  const raw = req.cookies?.[REFRESH_COOKIE];
  if (!raw) throw new AppError('No refresh token', 401, 'NO_REFRESH_TOKEN');

  let decoded;
  try {
    decoded = jwt.verify(raw, process.env.JWT_REFRESH_SECRET, {
      algorithms: [JWT_ALGORITHM],
    });
  } catch {
    throw new AppError('Invalid refresh token', 401, 'INVALID_REFRESH_TOKEN');
  }

  const hashed = RefreshToken.hashToken(raw);
  const stored = await RefreshToken.findOne({ token: hashed });

  if (!stored || stored.isRevoked) {
    // Token reuse detection: a revoked token being replayed is suspicious —
    // nuke every session for that user as a defensive measure.
    if (stored?.isRevoked) {
      await RefreshToken.updateMany({ user: decoded.sub }, { isRevoked: true });
      logger.warn('Refresh token reuse detected; all sessions revoked', {
        userId: decoded.sub,
      });
    }
    throw new AppError('Refresh token not recognised', 401, 'REFRESH_TOKEN_REVOKED');
  }

  const user = await User.findById(decoded.sub);
  if (!user || !user.isActive) {
    throw new AppError('User no longer active', 401, 'USER_INACTIVE');
  }

  // Rotate: revoke the old, issue a new pair.
  stored.isRevoked = true;
  await stored.save();
  const accessToken = await issueTokens(res, user);

  res.json({
    success: true,
    message: 'Token refreshed',
    data: { user: user.toJSON(), accessToken },
  });
});

/**
 * Revoke the current refresh token and clear the cookie.
 * @route POST /api/auth/logout
 */
export const logout = asyncHandler(async (req, res) => {
  const raw = req.cookies?.[REFRESH_COOKIE];
  if (raw) {
    await RefreshToken.updateOne(
      { token: RefreshToken.hashToken(raw) },
      { isRevoked: true }
    );
  }
  res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(), maxAge: undefined });
  res.json({ success: true, message: 'Logged out', code: 'LOGGED_OUT' });
});

/**
 * Return the authenticated user's profile.
 * @route GET /api/auth/me
 */
export const me = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { user: req.user.toJSON() } });
});
