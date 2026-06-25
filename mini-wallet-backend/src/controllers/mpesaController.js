import mongoose from 'mongoose';
import { Wallet } from '../models/Wallet.js';
import { Transaction } from '../models/Transaction.js';
import { darajaPost } from '../config/mpesa.js';
import { AppError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { logger } from '../config/logger.js';
import {
  getTimestamp,
  getPassword,
  formatPhone,
  maskPhone,
} from '../utils/mpesaHelpers.js';

/* ──────────────────────────────────────────────────────────────────────────
 * STK PUSH (Lipa Na M-Pesa Online) — top up wallet
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Initiate an STK Push. A `pending` transaction is recorded BEFORE the push
 * so the callback always has a row to reconcile against, even if the client
 * disconnects. Returns the checkoutRequestId for the client to poll.
 *
 * @route POST /api/mpesa/topup
 */
export const stkPush = asyncHandler(async (req, res) => {
  const amount = Number(req.body.amount);
  const phone = formatPhone(req.body.phone);
  if (!phone) throw new AppError('Invalid phone number', 400, 'INVALID_PHONE');

  const shortCode = process.env.MPESA_SHORT_CODE;
  const timestamp = getTimestamp();
  const password = getPassword(shortCode, process.env.MPESA_PASSKEY, timestamp);

  // Record intent first.
  const txn = await Transaction.create({
    sender: null,
    receiver: req.userId,
    amount,
    type: 'topup',
    status: 'pending',
    phone,
    description: 'Wallet top-up via M-Pesa',
  });

  const payload = {
    BusinessShortCode: shortCode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: amount,
    PartyA: phone,
    PartyB: shortCode,
    PhoneNumber: phone,
    CallBackURL: process.env.MPESA_CALLBACK_URL,
    AccountReference: `WALLET-${req.userId.slice(-6)}`,
    TransactionDesc: 'Wallet top-up',
  };

  let daraja;
  try {
    daraja = await darajaPost('/mpesa/stkpush/v1/processrequest', payload);
  } catch (err) {
    // Couldn't even reach Daraja → mark the pending row failed.
    txn.status = 'failed';
    txn.metadata = { error: err.message };
    await txn.save();
    throw err;
  }

  txn.mpesaCheckoutRequestId = daraja.CheckoutRequestID;
  txn.mpesaConversationId = daraja.MerchantRequestID;
  await txn.save();

  logger.info('STK push initiated', {
    txnId: txn.id,
    checkoutRequestId: daraja.CheckoutRequestID,
    phone: maskPhone(phone),
  });

  res.status(201).json({
    success: true,
    message: 'STK push sent. Check your phone to enter your M-Pesa PIN.',
    data: {
      checkoutRequestId: daraja.CheckoutRequestID,
      merchantRequestId: daraja.MerchantRequestID,
      customerMessage: daraja.CustomerMessage,
    },
  });
});

/**
 * Public STK callback. Idempotent: the wallet is only credited if the
 * pending transaction is flipped to `success` by THIS invocation (guarded
 * by a conditional update), so Safaricom retries can't double-credit.
 *
 * Always responds 200 with { ResultCode: 0 } as Daraja requires.
 *
 * @route POST /api/mpesa/callback  (no auth; IP-whitelisted at the route)
 */
export const stkCallback = asyncHandler(async (req, res) => {
  const ACCEPT = { ResultCode: 0, ResultDesc: 'Accepted' };
  const cb = req.body?.Body?.stkCallback;

  // Acknowledge malformed payloads without crashing.
  if (!cb?.CheckoutRequestID) {
    logger.warn('STK callback missing CheckoutRequestID', { body: req.body });
    return res.status(200).json(ACCEPT);
  }

  const checkoutRequestId = cb.CheckoutRequestID;
  logger.info('STK callback received', {
    checkoutRequestId,
    resultCode: cb.ResultCode,
  });

  const txn = await Transaction.findOne({ mpesaCheckoutRequestId: checkoutRequestId });
  if (!txn) {
    logger.warn('STK callback for unknown transaction', { checkoutRequestId });
    return res.status(200).json(ACCEPT);
  }

  // Store the raw payload for audit regardless of outcome.
  txn.metadata = { ...(txn.metadata || {}), callback: req.body };

  // ── Failure path ────────────────────────────────────────────────────
  if (cb.ResultCode !== 0) {
    if (txn.status === 'pending') {
      txn.status = 'failed';
      await txn.save();
    }
    logger.info('STK push failed', { checkoutRequestId, desc: cb.ResultDesc });
    return res.status(200).json(ACCEPT);
  }

  // ── Success path ────────────────────────────────────────────────────
  const meta = Object.fromEntries(
    (cb.CallbackMetadata?.Item || []).map((i) => [i.Name, i.Value])
  );
  const receipt = meta.MpesaReceiptNumber;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // Flip pending → success atomically; only the first caller wins.
      const claim = await Transaction.updateOne(
        { _id: txn._id, status: 'pending' },
        {
          status: 'success',
          mpesaReceiptNumber: receipt,
          metadata: txn.metadata,
        },
        { session }
      );
      if (claim.modifiedCount === 1) {
        // We own the credit — apply it once.
        await Wallet.updateOne(
          { user: txn.receiver },
          { $inc: { balance: txn.amount } },
          { session }
        );
        logger.info('Wallet credited from top-up', {
          txnId: txn.id,
          userId: txn.receiver.toString(),
          receipt,
        });
      } else {
        logger.info('Duplicate STK success callback ignored', { checkoutRequestId });
      }
    });
  } finally {
    await session.endSession();
  }

  return res.status(200).json(ACCEPT);
});

/**
 * Query the live status of an STK push and reconcile with our DB record.
 * @route GET /api/mpesa/status/:checkoutRequestId
 */
export const stkStatus = asyncHandler(async (req, res) => {
  const { checkoutRequestId } = req.params;

  const txn = await Transaction.findOne({
    mpesaCheckoutRequestId: checkoutRequestId,
    receiver: req.userId, // scope to caller — no peeking at others' payments
  }).lean();
  if (!txn) throw new AppError('Transaction not found', 404, 'TXN_NOT_FOUND');

  // If the callback already settled it, trust the DB and skip the query.
  if (txn.status === 'success' || txn.status === 'failed') {
    return res.json({
      success: true,
      data: {
        status: txn.status,
        amount: txn.amount,
        receipt: txn.mpesaReceiptNumber || null,
        source: 'db',
      },
    });
  }

  // Otherwise ask Daraja directly.
  const shortCode = process.env.MPESA_SHORT_CODE;
  const timestamp = getTimestamp();
  const password = getPassword(shortCode, process.env.MPESA_PASSKEY, timestamp);

  let result;
  try {
    result = await darajaPost('/mpesa/stkpushquery/v1/query', {
      BusinessShortCode: shortCode,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    });
  } catch {
    // Daraja often errors with "still being processed" — treat as pending.
    return res.json({
      success: true,
      data: { status: 'pending', amount: txn.amount, source: 'pending' },
    });
  }

  const resultCode = Number(result.ResultCode);
  const status = resultCode === 0 ? 'success' : resultCode === 1032 ? 'failed' : 'pending';

  res.json({
    success: true,
    data: {
      status,
      amount: txn.amount,
      resultDesc: result.ResultDesc,
      source: 'daraja',
    },
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * B2C — withdraw from wallet to phone
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Withdraw to an M-Pesa number. The wallet is debited FIRST (conditional,
 * race-safe) and a `pending` withdrawal recorded; then B2C is triggered.
 * If the B2C request itself fails, the debit is reversed immediately. The
 * asynchronous B2C result callback then confirms or reverses.
 *
 * @route POST /api/mpesa/withdraw
 */
export const b2cWithdraw = asyncHandler(async (req, res) => {
  const amount = Number(req.body.amount);
  const phone = formatPhone(req.body.phone);
  if (!phone) throw new AppError('Invalid phone number', 400, 'INVALID_PHONE');

  // 1. Debit first (conditional → no overdraft, no race).
  const session = await mongoose.startSession();
  let txn;
  try {
    await session.withTransaction(async () => {
      const debit = await Wallet.updateOne(
        { user: req.userId, balance: { $gte: amount } },
        { $inc: { balance: -amount } },
        { session }
      );
      if (debit.modifiedCount !== 1) {
        throw new AppError('Insufficient balance', 400, 'INSUFFICIENT_FUNDS');
      }
      const created = await Transaction.create(
        [
          {
            sender: req.userId,
            receiver: req.userId,
            amount,
            type: 'withdrawal',
            status: 'pending',
            phone,
            description: 'Wallet withdrawal to M-Pesa',
            idempotencyKey: req.idempotencyKey,
          },
        ],
        { session }
      );
      txn = created[0];
    });
  } catch (err) {
    if (err.code === 11000) {
      throw new AppError('Duplicate withdrawal ignored', 409, 'IDEMPOTENT_REPLAY');
    }
    throw err;
  } finally {
    await session.endSession();
  }

  // 2. Trigger B2C. On transport failure, reverse the debit at once.
  const payload = {
    InitiatorName: process.env.MPESA_INITIATOR_NAME,
    SecurityCredential: process.env.MPESA_INITIATOR_PASSWORD,
    CommandID: 'BusinessPayment',
    Amount: amount,
    PartyA: process.env.MPESA_SHORT_CODE,
    PartyB: phone,
    Remarks: 'Wallet withdrawal',
    QueueTimeOutURL: process.env.MPESA_B2C_QUEUE_URL,
    ResultURL: process.env.MPESA_B2C_RESULT_URL,
    Occasion: `WD-${txn.id.slice(-6)}`,
  };

  try {
    const daraja = await darajaPost(process.env.MPESA_B2C_URL, payload);
    txn.mpesaConversationId = daraja.ConversationID;
    await txn.save();
  } catch (err) {
    await reverseTransaction(txn._id, { reason: 'B2C request failed' });
    throw err;
  }

  logger.info('B2C withdrawal initiated', {
    txnId: txn.id,
    phone: maskPhone(phone),
  });

  res.status(201).json({
    success: true,
    message: 'Withdrawal initiated. You will receive the funds shortly.',
    data: { transactionId: txn.id, status: 'pending' },
  });
});

/**
 * Reverse a pending withdrawal: refund the wallet and mark it reversed.
 * Idempotent on the transaction status.
 * @param {import('mongoose').Types.ObjectId} txnId
 * @param {object} info
 */
const reverseTransaction = async (txnId, info = {}) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const txn = await Transaction.findById(txnId).session(session);
      if (!txn || txn.status !== 'pending') return;
      await Wallet.updateOne(
        { user: txn.sender },
        { $inc: { balance: txn.amount } },
        { session }
      );
      txn.status = 'reversed';
      txn.metadata = { ...(txn.metadata || {}), reversal: info };
      await txn.save({ session });
    });
    logger.warn('Withdrawal reversed', { txnId: txnId.toString(), ...info });
  } finally {
    await session.endSession();
  }
};

/**
 * B2C result callback. ResultCode 0 → confirm; anything else → reverse.
 * @route POST /api/mpesa/b2c/result  (no auth; IP-whitelisted)
 */
export const b2cResult = asyncHandler(async (req, res) => {
  const ACCEPT = { ResultCode: 0, ResultDesc: 'Accepted' };
  const result = req.body?.Result;
  if (!result?.ConversationID) {
    logger.warn('B2C result missing ConversationID', { body: req.body });
    return res.status(200).json(ACCEPT);
  }

  const txn = await Transaction.findOne({ mpesaConversationId: result.ConversationID });
  if (!txn) {
    logger.warn('B2C result for unknown transaction', {
      conversationId: result.ConversationID,
    });
    return res.status(200).json(ACCEPT);
  }

  if (Number(result.ResultCode) === 0) {
    if (txn.status === 'pending') {
      const meta = Object.fromEntries(
        (result.ResultParameters?.ResultParameter || []).map((i) => [i.Key, i.Value])
      );
      txn.status = 'success';
      txn.mpesaReceiptNumber = meta.TransactionReceipt;
      txn.metadata = { ...(txn.metadata || {}), b2cResult: req.body };
      await txn.save();
      logger.info('B2C withdrawal confirmed', { txnId: txn.id });
    }
  } else {
    await reverseTransaction(txn._id, {
      reason: 'B2C failed',
      resultDesc: result.ResultDesc,
    });
  }

  return res.status(200).json(ACCEPT);
});

/**
 * B2C queue-timeout callback. Safaricom couldn't process in time → reverse.
 * @route POST /api/mpesa/b2c/timeout  (no auth; IP-whitelisted)
 */
export const b2cTimeout = asyncHandler(async (req, res) => {
  const result = req.body?.Result;
  logger.warn('B2C queue timeout', { conversationId: result?.ConversationID });
  if (result?.ConversationID) {
    const txn = await Transaction.findOne({ mpesaConversationId: result.ConversationID });
    if (txn) await reverseTransaction(txn._id, { reason: 'B2C queue timeout' });
  }
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
});
