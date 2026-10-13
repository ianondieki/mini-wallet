import { Money } from '../core/money/Money.js';
import { MoneyRequest } from '../models/MoneyRequest.js';
import { User } from '../models/User.js';
import * as payments from './paymentService.js';
import { AppError } from '../utils/ApiError.js';
import { logger } from '../config/logger.js';
import { randomUUID } from 'node:crypto';

/**
 * Money requests, and the bill splits built out of them.
 *
 * The product question this answers is the other direction of a transfer: not
 * "send 500 to Asha" but "Asha, you owe me 500". Which matters because the
 * common case — somebody paid for everyone and now wants settling up — cannot
 * be expressed as a payment at all. The payer is the one who has to act, and
 * they have to be able to say no.
 *
 * Nothing here posts to the ledger. An approval delegates to
 * {@link payments.transfer}, so a settled request is priced, limited, risk
 * scored and recorded exactly like a transfer the payer initiated themselves —
 * there is no second, softer path into the books.
 */

/** How long a request stays actionable. */
const EXPIRY_DAYS = Number(process.env.REQUEST_EXPIRY_DAYS || 7);

/** Most people one bill may be split between. */
const MAX_PARTICIPANTS = 20;

/**
 * The idempotency key under which a request settles.
 *
 * Derived from the request rather than supplied by the client, and scoped to
 * the payer, so the unique `(idempotencyScope, idempotencyKey)` index on the
 * ledger makes paying the same request twice impossible — across retries,
 * across devices, and across a crash between the transfer and the state
 * update below.
 *
 * @param {string} requestId
 */
const settlementKey = (requestId) => `money-request:${requestId}`;

/**
 * Shape a request for the API, with the counterparty's name resolved.
 * @param {object} request
 * @param {Map<string, object>} people
 * @param {string} viewerId
 */
const present = (request, people, viewerId) => {
  const outgoing = request.fromUserId === viewerId;
  const counterpartyId = outgoing ? request.toUserId : request.fromUserId;
  const counterparty = people.get(counterpartyId) ?? null;
  const expired = request.state === 'pending' && request.expiresAt <= new Date();

  return {
    requestId: request.requestId,
    groupId: request.groupId,
    // From the viewer's side: did I ask, or was I asked?
    role: outgoing ? 'requester' : 'payer',
    amount: Money.fromMinor(request.amountMinor, request.currency).toJSON(),
    note: request.note,
    // `expired` is derived, never stored — a background job that has not run
    // yet must not make a stale request look payable.
    state: expired ? 'expired' : request.state,
    actionable: !expired && request.state === 'pending',
    counterparty: counterparty
      ? { id: counterpartyId, name: counterparty.name, email: counterparty.email }
      : null,
    expiresAt: request.expiresAt,
    settledEntryId: request.settledEntryId,
    settledAt: request.settledAt,
    declineReason: request.declineReason,
    createdAt: request.createdAt,
  };
};

/**
 * Resolve the names for a page of requests in one query.
 * @param {object[]} requests
 * @param {string} viewerId
 */
const withPeople = async (requests, viewerId) => {
  const ids = [
    ...new Set(
      requests.flatMap((r) => [r.fromUserId, r.toUserId]).filter((id) => id !== viewerId)
    ),
  ];
  const users = await User.find({ _id: { $in: ids } }).select('name email').lean();
  const people = new Map(
    users.map((u) => [u._id.toString(), { name: u.name, email: u.email }])
  );
  return requests.map((r) => present(r, people, viewerId));
};

/**
 * Ask one or more people for money.
 *
 * With `shares`, each participant is asked for their own figure. Without, the
 * total is apportioned evenly using largest-remainder, so the shares add back
 * up to the bill exactly — a 100.00 dinner split three ways is 33.34 / 33.33 /
 * 33.33 and never 99.99.
 *
 * @param {object}   params
 * @param {object}   params.user          The requester.
 * @param {string[]} params.participants  Emails or phone numbers.
 * @param {Money}    [params.amount]      Total to split evenly.
 * @param {Money[]}  [params.shares]      Exact amount per participant instead.
 * @param {string}   [params.note]
 * @returns {Promise<object>}
 */
export const createRequests = async ({ user, participants, amount, shares, note }) => {
  if (!Array.isArray(participants) || participants.length === 0) {
    throw new AppError('Name at least one person to ask', 400, 'NO_PARTICIPANTS');
  }
  if (participants.length > MAX_PARTICIPANTS) {
    throw new AppError(
      `A bill can be split between at most ${MAX_PARTICIPANTS} people`,
      400,
      'TOO_MANY_PARTICIPANTS'
    );
  }

  const people = await Promise.all(participants.map((p) => payments.resolveRecipient(p)));
  const seen = new Set();
  for (const person of people) {
    if (person.id === user.id) {
      throw new AppError('You cannot ask yourself for money', 400, 'SELF_REQUEST');
    }
    if (seen.has(person.id)) {
      throw new AppError(`${person.name} appears twice on this bill`, 400, 'DUPLICATE_PARTICIPANT');
    }
    seen.add(person.id);
  }

  let amounts;
  if (shares) {
    if (shares.length !== people.length) {
      throw new AppError(
        'Give one share per person, or no shares at all for an even split',
        400,
        'SHARE_COUNT_MISMATCH'
      );
    }
    amounts = shares;
  } else {
    if (!amount?.isPositive) {
      throw new AppError('A total is required for an even split', 400, 'INVALID_AMOUNT');
    }
    // The requester's own share is not a request — they already paid. So the
    // bill divides between everyone at the table, the requester included, and
    // only the others are asked.
    amounts = amount.split(people.length + 1).slice(1);
  }

  const groupId = randomUUID();
  const expiresAt = new Date(Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const created = await MoneyRequest.insertMany(
    people.map((person, i) => ({
      groupId,
      fromUserId: user.id,
      toUserId: person.id,
      currency: amounts[i].currency,
      amountMinor: amounts[i].minor,
      note: note?.trim() || null,
      expiresAt,
    }))
  );

  logger.info('Money requests created', { groupId, from: user.id, count: created.length });

  const total = amounts.reduce((acc, a) => acc.plus(a), Money.zero(amounts[0].currency));
  return {
    groupId,
    requested: total.toJSON(),
    // The requester's own share of an even split, so the UI can show the
    // whole bill rather than just the part they are chasing.
    yourShare: shares ? null : amount.minus(total).toJSON(),
    expiresAt,
    requests: await withPeople(created.map((r) => r.toObject()), user.id),
  };
};

/**
 * Everything a customer has asked for and been asked for.
 * @param {string} userId
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export const listRequests = async (userId, { currency = 'KES', limit = 50 } = {}) => {
  const [incoming, outgoing] = await Promise.all([
    MoneyRequest.find({ toUserId: userId }).sort({ createdAt: -1 }).limit(limit).lean(),
    MoneyRequest.find({ fromUserId: userId }).sort({ createdAt: -1 }).limit(limit).lean(),
  ]);

  const [asked, asking] = await Promise.all([
    withPeople(incoming, userId),
    withPeople(outgoing, userId),
  ]);

  const sum = (rows) =>
    rows
      .filter((r) => r.actionable && r.amount.currency === currency)
      .reduce((acc, r) => acc.plus(Money.fromJSON(r.amount)), Money.zero(currency));

  return {
    currency,
    // The two numbers a customer actually wants: what I owe, what I am owed.
    youOwe: sum(asked).toJSON(),
    owedToYou: sum(asking).toJSON(),
    incoming: asked,
    outgoing: asking,
  };
};

/**
 * Load a request the caller is allowed to see.
 *
 * A request belonging to neither party reads as missing rather than
 * forbidden — a 403 would confirm the id is real.
 */
const mustSee = async (userId, requestId) => {
  const request = await MoneyRequest.findOne({
    requestId,
    $or: [{ fromUserId: userId }, { toUserId: userId }],
  });
  if (!request) throw new AppError('Request not found', 404, 'REQUEST_NOT_FOUND');
  return request;
};

/**
 * Pay a request.
 *
 * The request is claimed with a conditional update before any money moves, so
 * two concurrent approvals cannot both reach the transfer. If the transfer
 * then fails for a reason the payer can fix — not enough money, a limit — the
 * claim is released and the request goes back to pending, because a declined
 * card should not consume the bill.
 *
 * @param {object} params
 * @returns {Promise<object>}
 */
export const approve = async ({ user, requestId, device }) => {
  const claimed = await MoneyRequest.findOneAndUpdate(
    { requestId, toUserId: user.id, state: 'pending', expiresAt: { $gt: new Date() } },
    { $set: { state: 'settling' } },
    { new: true }
  );

  if (!claimed) {
    // Say precisely what happened instead of a bare 409: "already paid" and
    // "expired" need different things from the customer.
    const existing = await mustSee(user.id, requestId);
    if (existing.toUserId !== user.id) {
      throw new AppError('You cannot pay a request you created', 403, 'NOT_THE_PAYER');
    }
    if (existing.state === 'paid') {
      throw new AppError('You have already paid this request', 409, 'ALREADY_PAID', {
        entryId: existing.settledEntryId,
      });
    }
    if (existing.state === 'settling') {
      throw new AppError('This payment is already going through', 409, 'SETTLEMENT_IN_PROGRESS');
    }
    if (existing.state === 'cancelled') {
      throw new AppError('This request was cancelled', 409, 'REQUEST_CANCELLED');
    }
    if (existing.state === 'declined') {
      throw new AppError('You declined this request', 409, 'REQUEST_DECLINED');
    }
    throw new AppError('This request has expired', 409, 'REQUEST_EXPIRED');
  }

  const amount = Money.fromMinor(claimed.amountMinor, claimed.currency);
  const requester = await User.findById(claimed.fromUserId).select('name email').lean();

  let result;
  try {
    result = await payments.transfer({
      user,
      recipientIdentifier: requester?.email ?? claimed.fromUserId,
      amount,
      description: claimed.note ? `Request: ${claimed.note}` : 'Money request',
      // Derived, not client-supplied: see settlementKey().
      idempotencyKey: settlementKey(requestId),
      device,
    });
  } catch (err) {
    if (err?.code === 'IDEMPOTENT_REPLAY') {
      // The transfer had already committed under this key — a crash between
      // the two writes, now resolved. Finish the state change rather than
      // telling the customer their payment failed.
      claimed.state = 'paid';
      claimed.settledAt = new Date();
      await claimed.save();
      throw new AppError('You have already paid this request', 409, 'ALREADY_PAID');
    }
    claimed.state = 'pending';
    await claimed.save();
    throw err;
  }

  claimed.state = 'paid';
  claimed.settledEntryId = result.id;
  claimed.settledAt = new Date();
  await claimed.save();

  logger.info('Money request paid', { requestId, payer: user.id, entryId: result.id });

  return {
    requestId,
    paid: amount.toJSON(),
    fee: result.fee,
    entryId: result.id,
    requester: { name: requester?.name ?? null, email: requester?.email ?? null },
    settledAt: claimed.settledAt,
  };
};

/**
 * Say no. Kept as a first-class action rather than leaving requests to rot:
 * the requester needs to know, and an unanswered bill is ambiguous.
 *
 * @param {object} params
 * @returns {Promise<object>}
 */
export const decline = async ({ user, requestId, reason }) => {
  const request = await mustSee(user.id, requestId);
  if (request.toUserId !== user.id) {
    throw new AppError('Only the person asked can decline a request', 403, 'NOT_THE_PAYER');
  }
  if (!request.isActionable()) {
    throw new AppError(
      `This request is ${request.state === 'pending' ? 'expired' : request.state}`,
      409,
      'REQUEST_NOT_ACTIONABLE'
    );
  }
  request.state = 'declined';
  request.declineReason = reason?.trim() || null;
  await request.save();
  return { requestId, state: 'declined', declineReason: request.declineReason };
};

/**
 * Withdraw a request you made. Cancels only your own, and only the ones that
 * have not already been paid.
 *
 * @param {object} params
 * @returns {Promise<object>}
 */
export const cancel = async ({ user, requestId, groupId }) => {
  if (groupId) {
    const result = await MoneyRequest.updateMany(
      { groupId, fromUserId: user.id, state: 'pending' },
      { $set: { state: 'cancelled' } }
    );
    if (result.matchedCount === 0) {
      throw new AppError('No open requests to cancel', 404, 'REQUEST_NOT_FOUND');
    }
    return { groupId, cancelled: result.modifiedCount };
  }

  const request = await mustSee(user.id, requestId);
  if (request.fromUserId !== user.id) {
    throw new AppError('Only the person who asked can cancel a request', 403, 'NOT_THE_REQUESTER');
  }
  if (request.state === 'paid') {
    throw new AppError(
      'This request has been paid. Refund it instead.',
      409,
      'ALREADY_PAID',
      { entryId: request.settledEntryId }
    );
  }
  if (request.state === 'settling') {
    throw new AppError('This payment is going through right now', 409, 'SETTLEMENT_IN_PROGRESS');
  }
  request.state = 'cancelled';
  await request.save();
  return { requestId, state: 'cancelled' };
};

export default { createRequests, listRequests, approve, decline, cancel };
