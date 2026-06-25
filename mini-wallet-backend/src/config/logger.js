import winston from 'winston';
import fs from 'node:fs';
import path from 'node:path';

const { combine, timestamp, json, errors, colorize, printf, splat } = winston.format;

const LOG_DIR = path.resolve('logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const isProd = process.env.NODE_ENV === 'production';

/**
 * Redact sensitive keys anywhere in a logged metadata object so secrets,
 * tokens, passwords and raw amounts never land in the log files.
 */
const SENSITIVE_KEYS = new Set([
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'jwt_secret',
  'consumerSecret',
  'passkey',
  'securityCredential',
  'initiatorPassword',
  'pin',
]);

const redactFormat = winston.format((info) => {
  const redact = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    for (const key of Object.keys(obj)) {
      if (SENSITIVE_KEYS.has(key)) {
        obj[key] = '[REDACTED]';
      } else if (isProd && key === 'amount') {
        // In production we never log monetary amounts in plaintext.
        obj[key] = '[MASKED]';
      } else if (typeof obj[key] === 'object') {
        redact(obj[key]);
      }
    }
    return obj;
  };
  return redact(info);
});

const consoleFormat = combine(
  colorize(),
  timestamp({ format: 'HH:mm:ss' }),
  printf(({ level, message, timestamp: ts, ...meta }) => {
    const rest = Object.keys(meta).length
      ? ` ${JSON.stringify(meta)}`
      : '';
    return `${ts} ${level}: ${message}${rest}`;
  })
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  format: combine(
    errors({ stack: true }),
    splat(),
    redactFormat(),
    timestamp(),
    json()
  ),
  defaultMeta: { service: 'mini-wallet-api' },
  transports: [
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'combined.log'),
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5,
    }),
  ],
  exitOnError: false,
});

if (!isProd) {
  logger.add(new winston.transports.Console({ format: consoleFormat }));
}

export default logger;
