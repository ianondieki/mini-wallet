import mongoose from 'mongoose';
import { logger } from './logger.js';

mongoose.set('strictQuery', true);

/**
 * Connect to MongoDB with bounded exponential-ish retry. Resolves once
 * connected; throws after exhausting all attempts so the caller can exit.
 *
 * @param {string} uri
 * @param {object} [opts]
 * @param {number} [opts.retries=5]
 * @param {number} [opts.delayMs=2000]
 * @returns {Promise<typeof mongoose>}
 */
export const connectDB = async (uri, { retries = 5, delayMs = 2000 } = {}) => {
  if (!uri) throw new Error('MONGO_URI is not defined');

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const conn = await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 5000,
        maxPoolSize: 20,
      });
      logger.info('MongoDB connected', { host: conn.connection.host });
      return conn;
    } catch (err) {
      logger.error('MongoDB connection failed', {
        attempt,
        retries,
        message: err.message,
      });
      if (attempt === retries) throw err;
      const wait = delayMs * attempt;
      logger.warn(`Retrying MongoDB connection in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error('Exhausted MongoDB connection retries');
};

mongoose.connection.on('disconnected', () =>
  logger.warn('MongoDB disconnected')
);
mongoose.connection.on('reconnected', () =>
  logger.info('MongoDB reconnected')
);
mongoose.connection.on('error', (err) =>
  logger.error('MongoDB connection error', { message: err.message })
);

export const disconnectDB = async () => {
  await mongoose.connection.close(false);
  logger.info('MongoDB connection closed');
};

export default connectDB;
