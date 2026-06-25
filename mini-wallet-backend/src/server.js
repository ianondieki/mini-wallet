import 'dotenv/config';
import { createApp } from './app.js';
import { connectDB, disconnectDB } from './config/db.js';
import { logger } from './config/logger.js';

const PORT = process.env.PORT || 3000;
const SHUTDOWN_TIMEOUT_MS = 5000;

/** Fail fast if critical secrets are missing. */
const requiredEnv = ['MONGO_URI', 'JWT_SECRET', 'JWT_REFRESH_SECRET'];
const missing = requiredEnv.filter((k) => !process.env[k]);
if (missing.length) {
  logger.error('Missing required environment variables', { missing });
  process.exit(1);
}

const start = async () => {
  await connectDB(process.env.MONGO_URI);
  const app = createApp();
  const server = app.listen(PORT, () =>
    logger.info(`Server listening on port ${PORT}`, { env: process.env.NODE_ENV })
  );

  /**
   * Graceful shutdown: stop accepting connections, drain in-flight requests
   * (bounded by SHUTDOWN_TIMEOUT_MS), close the DB, then exit.
   * @param {string} signal
   */
  const shutdown = async (signal) => {
    logger.info(`${signal} received — shutting down gracefully`);

    const forceTimer = setTimeout(() => {
      logger.error('Shutdown timed out — forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();

    server.close(async (err) => {
      if (err) {
        logger.error('Error closing HTTP server', { message: err.message });
        process.exit(1);
      }
      logger.info('HTTP server closed — no longer accepting connections');
      try {
        await disconnectDB();
        clearTimeout(forceTimer);
        logger.info('Shutdown complete');
        process.exit(0);
      } catch (e) {
        logger.error('Error during DB shutdown', { message: e.message });
        process.exit(1);
      }
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { reason: String(reason) });
  });
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception — exiting', { message: err.message, stack: err.stack });
    process.exit(1);
  });
};

start().catch((err) => {
  logger.error('Fatal startup error', { message: err.message, stack: err.stack });
  process.exit(1);
});
