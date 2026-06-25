import mongoose from 'mongoose';
import { Wallet } from '../models/Wallet.js';
import { User } from '../models/User.js';
import { Transaction } from '../models/Transaction.js';
import { AppError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { paginate } from '../utils/paginate.js';
import { logger } from '../config/logger.js';

/**
 * Get the authenticated user's wallet balance.
 * @route GET /api/wallet/balance
 */
export const getBalance = asyncHandler(async (req, res) => {
  const wallet = await Wallet.findOne({ user: req.userId }).lean();
  if (!wallet) throw new AppError('Wallet not found', 404, 'WALLET_NOT_FOUND');

  res.json({
    success: true,
    data: { balance: wallet.balance, currency: wallet.currency },
  });
});

/**
 * Peer-to-peer transfer. Atomic across both wallets via a MongoDB
 * transaction. Overdraft is impossible because the debit is a *conditional*
 * update (`balance >= amount`) — if the guard fails, the whole transaction
 * aborts and nothing moves.
 *
 * Idempotency is enforced upstream by the idempotency middleware, which
 * stamps `req.idempotencyKey`; we persist it on the transaction so a unique
 * index blocks a concurrent duplicate that slipped past the time window.
 *
 * @route POST /api/wallet/transfer
 */
export const transfer = asyncHandler(async (req, res) => {
  const amount = Number(req.body.amount);
  const { recipientEmail, description } = req.body;

  const recipient = await User.findOne({ email: recipientEmail }).lean();
  if (!recipient) {
    throw new AppError('Recipient not found', 404, 'RECIPIENT_NOT_FOUND');
  }
  if (recipient._id.toString() === req.userId) {
    throw new AppError('You cannot transfer to yourself', 400, 'SELF_TRANSFER');
  }

  const session = await mongoose.startSession();
  let txnDoc;
  try {
    await session.withTransaction(async () => {
      // Conditional debit: only succeeds if funds are sufficient.
      const debit = await Wallet.updateOne(
        { user: req.userId, balance: { $gte: amount } },
        { $inc: { balance: -amount } },
        { session }
      );
      if (debit.modifiedCount !== 1) {
        throw new AppError('Insufficient balance', 400, 'INSUFFICIENT_FUNDS');
      }

      // Credit the recipient.
      const credit = await Wallet.updateOne(
        { user: recipient._id },
        { $inc: { balance: amount } },
        { session }
      );
      if (credit.modifiedCount !== 1) {
        throw new AppError('Recipient wallet unavailable', 409, 'RECIPIENT_WALLET_ERROR');
      }

      const created = await Transaction.create(
        [
          {
            sender: req.userId,
            receiver: recipient._id,
            amount,
            type: 'transfer',
            status: 'success',
            description: description?.trim(),
            idempotencyKey: req.idempotencyKey,
          },
        ],
        { session }
      );
      txnDoc = created[0];
    });
  } catch (err) {
    // A duplicate idempotency key races to a unique-index 11000 here.
    if (err.code === 11000) {
      throw new AppError('Duplicate transfer ignored', 409, 'IDEMPOTENT_REPLAY');
    }
    throw err;
  } finally {
    await session.endSession();
  }

  logger.info('Transfer completed', {
    txnId: txnDoc.id,
    senderId: req.userId,
    receiverId: recipient._id.toString(),
  });

  res.status(201).json({
    success: true,
    message: 'Transfer successful',
    data: {
      transaction: {
        id: txnDoc.id,
        amount,
        recipient: { name: recipient.name, email: recipient.email },
        status: txnDoc.status,
        createdAt: txnDoc.createdAt,
      },
    },
  });
});

/**
 * Paginated, filtered transaction history with per-user direction.
 * @route GET /api/wallet/transactions?page=&limit=&type=&status=
 */
export const getTransactions = asyncHandler(async (req, res) => {
  const { page, limit, type, status } = req.query;

  const filter = {
    $or: [{ sender: req.userId }, { receiver: req.userId }],
  };
  if (type) filter.type = type;
  if (status) filter.status = status;

  const { items, pagination } = await paginate(Transaction, {
    filter,
    page,
    limit,
    populate: [
      { path: 'sender', select: 'name email' },
      { path: 'receiver', select: 'name email' },
    ],
  });

  // Annotate each row with the direction from THIS user's perspective.
  const data = items.map((t) => {
    let direction;
    if (t.type === 'topup') direction = 'credit';
    else if (t.type === 'withdrawal') direction = 'debit';
    else direction = t.sender?._id?.toString() === req.userId ? 'debit' : 'credit';

    return {
      id: t._id,
      type: t.type,
      status: t.status,
      amount: t.amount,
      direction,
      description: t.description,
      sender: t.sender ? { name: t.sender.name, email: t.sender.email } : null,
      receiver: t.receiver ? { name: t.receiver.name, email: t.receiver.email } : null,
      mpesaReceiptNumber: t.mpesaReceiptNumber,
      createdAt: t.createdAt,
    };
  });

  res.json({ success: true, data: { transactions: data, pagination } });
});

/**
 * Search users by email/name to pick a transfer recipient.
 * @route GET /api/wallet/recipients?q=
 */
export const searchRecipients = asyncHandler(async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) {
    return res.json({ success: true, data: { recipients: [] } });
  }
  // Escape regex metacharacters in user input.
  const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = new RegExp(safe, 'i');

  const users = await User.find({
    _id: { $ne: req.userId },
    isActive: true,
    $or: [{ email: rx }, { name: rx }],
  })
    .select('name email')
    .limit(8)
    .lean();

  res.json({
    success: true,
    data: {
      recipients: users.map((u) => ({ id: u._id, name: u.name, email: u.email })),
    },
  });
});
