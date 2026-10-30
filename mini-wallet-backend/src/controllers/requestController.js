import { Money } from '../core/money/Money.js';
import * as requests from '../services/requestService.js';
import { AppError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

/**
 * Money requests and bill splits.
 *
 * The asking direction of a wallet. A request is a claim, not a movement, so
 * none of these endpoints touch the ledger directly — approving one delegates
 * to the same transfer path a customer-initiated payment takes.
 */

const DEFAULT_CURRENCY = process.env.DEFAULT_CURRENCY || 'KES';

/** Parse a client amount into Money, with the same errors as the wallet. */
const parseAmount = (value, currency) => {
  let amount;
  try {
    amount = Money.ofRounded(String(value), currency);
  } catch (err) {
    throw new AppError(`Invalid amount: ${err.message}`, 400, 'INVALID_AMOUNT');
  }
  if (!amount.isPositive) {
    throw new AppError('Amount must be greater than zero', 400, 'INVALID_AMOUNT');
  }
  return amount;
};

/**
 * Ask people for money.
 *
 * `total` splits a bill evenly between the requester and everyone named — so
 * a 1,200 dinner with three friends asks each of them for 300 and leaves the
 * requester's own 300 alone. `shares` asks each person for an exact figure
 * instead.
 *
 * @route POST /api/requests
 */
export const create = asyncHandler(async (req, res) => {
  const currency = String(req.body.currency || DEFAULT_CURRENCY).toUpperCase();
  const exact = Array.isArray(req.body.shares) && req.body.shares.length > 0;

  const result = await requests.createRequests({
    user: req.user,
    participants: req.body.participants,
    amount: exact ? undefined : parseAmount(req.body.total, currency),
    shares: exact ? req.body.shares.map((s) => parseAmount(s, currency)) : undefined,
    note: req.body.note,
  });

  res.status(201).json({ success: true, message: 'Request sent', data: result });
});

/**
 * What I owe and what I am owed.
 * @route GET /api/requests
 */
export const list = asyncHandler(async (req, res) => {
  const currency = String(req.query.currency || DEFAULT_CURRENCY).toUpperCase();
  const data = await requests.listRequests(req.userId, { currency });
  res.json({ success: true, data });
});

/**
 * Pay a request.
 * @route POST /api/requests/:requestId/approve
 */
export const approve = asyncHandler(async (req, res) => {
  const verdict = req.user.canTransact();
  if (!verdict.ok) throw new AppError(verdict.reason, 403, verdict.code);

  const data = await requests.approve({
    user: req.user,
    requestId: req.params.requestId,
    device: req.device,
  });
  res.status(201).json({ success: true, message: 'Request paid', data });
});

/**
 * Decline a request.
 * @route POST /api/requests/:requestId/decline
 */
export const decline = asyncHandler(async (req, res) => {
  const data = await requests.decline({
    user: req.user,
    requestId: req.params.requestId,
    reason: req.body?.reason,
  });
  res.json({ success: true, message: 'Request declined', data });
});

/**
 * Withdraw a request you made, or the whole bill it belongs to.
 * @route DELETE /api/requests/:requestId
 * @route DELETE /api/requests/group/:groupId
 */
export const cancel = asyncHandler(async (req, res) => {
  const data = await requests.cancel({
    user: req.user,
    requestId: req.params.requestId,
    groupId: req.params.groupId,
  });
  res.json({ success: true, message: 'Request cancelled', data });
});
