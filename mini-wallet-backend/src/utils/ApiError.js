/**
 * Operational error carrying an HTTP status and a stable machine-readable code.
 * `isOperational` distinguishes expected errors (bad input, business rules)
 * from programmer bugs, so the global handler knows what is safe to surface.
 */
export class AppError extends Error {
  /**
   * @param {string} message  Human-readable message (safe to show in dev/prod).
   * @param {number} statusCode  HTTP status code.
   * @param {string} code  Stable error code, e.g. "INSUFFICIENT_FUNDS".
   * @param {object} [details]  Optional structured details (e.g. validation array).
   */
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details = undefined) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

export default AppError;
