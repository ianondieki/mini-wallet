import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import mongoSanitize from 'express-mongo-sanitize';

import { globalLimiter } from './middleware/rateLimiter.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/auth.js';
import walletRoutes from './routes/wallet.js';
import mpesaRoutes from './routes/mpesa.js';
import paymentRoutes from './routes/payments.js';
import opsRoutes from './routes/ops.js';
import { bootstrapRails } from './rails/index.js';
import { resolveUserId } from './services/paymentService.js';

/**
 * Build and return the Express application. Kept separate from server.js so
 * it can be imported into tests/supertest without binding a port.
 * @returns {import('express').Express}
 */
export const createApp = () => {
  const app = express();

  // Register the payment rails this deployment offers. Done here rather than
  // at import time so tests can build an app with a different rail set.
  bootstrapRails({ resolveUserId });

  // Behind a reverse proxy (Nginx/Heroku/etc.) so req.ip + secure cookies work.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // ── Security headers (Helmet, incl. a conservative CSP) ───────────────
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
    })
  );

  // ── CORS: whitelist origins from env ──────────────────────────────────
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.use(
    cors({
      origin(origin, cb) {
        // Allow same-origin / server-to-server (no Origin header) + callbacks.
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        return cb(new Error('Not allowed by CORS'));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    })
  );

  // ── Body parsing + cookies ────────────────────────────────────────────
  // The raw bytes are kept for webhook signature verification: an HMAC is
  // computed over exactly what the provider sent, and re-serialising the
  // parsed body would change key order or spacing and break a valid MAC.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());

  // ── Strip MongoDB operators ($, .) from all inputs ────────────────────
  app.use(mongoSanitize({ replaceWith: '_' }));

  // ── Global rate limit ─────────────────────────────────────────────────
  app.use(globalLimiter);

  // ── Health check ──────────────────────────────────────────────────────
  app.get('/health', (_req, res) =>
    res.json({ success: true, status: 'ok', uptime: process.uptime() })
  );

  // ── Device fingerprint for the risk engine ────────────────────────────
  // Cheap signals the client cannot easily suppress. Not authentication —
  // just context for scoring, and treated as untrusted hints throughout.
  app.use((req, _res, next) => {
    req.device = {
      ip: req.ip,
      userAgent: req.get('User-Agent') ?? null,
      deviceId: req.get('X-Device-Id') ?? null,
    };
    next();
  });

  // ── API routes ────────────────────────────────────────────────────────
  app.use('/api/auth', authRoutes);
  app.use('/api/wallet', walletRoutes);
  app.use('/api/payments', paymentRoutes);
  app.use('/api/ops', opsRoutes);
  // Legacy paths — kept because Safaricom has the callback URLs registered.
  app.use('/api/mpesa', mpesaRoutes);

  // ── 404 + central error handler (must be last) ───────────────────────
  app.use(notFound);
  app.use(errorHandler);

  return app;
};

export default createApp;
