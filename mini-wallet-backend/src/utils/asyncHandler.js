/**
 * Wraps an async Express handler so any rejected promise is forwarded to
 * `next()` and reaches the central error handler — no try/catch boilerplate.
 *
 * @param {(req, res, next) => Promise<any>} fn
 * @returns {(req, res, next) => void}
 */
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export default asyncHandler;
