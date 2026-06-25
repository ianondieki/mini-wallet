import mongoose from 'mongoose';

const transactionSchema = new mongoose.Schema(
  {
    // Null for top-ups (money enters from M-Pesa, no internal sender).
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    // Required for topup/transfer; for withdrawal the receiver is the user
    // withdrawing (money leaves to their phone).
    receiver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: [1, 'Amount must be at least 1'],
    },
    type: {
      type: String,
      enum: ['topup', 'transfer', 'withdrawal'],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['pending', 'success', 'failed', 'reversed'],
      default: 'pending',
      index: true,
    },
    // M-Pesa correlation identifiers.
    mpesaCheckoutRequestId: { type: String, index: true, sparse: true },
    mpesaReceiptNumber: { type: String, index: true, sparse: true },
    mpesaConversationId: { type: String, index: true, sparse: true },

    phone: { type: String },
    description: { type: String, maxlength: 200 },

    // Sparse + unique: only documents that HAVE a key are constrained,
    // so transfers without a key don't collide on null.
    idempotencyKey: { type: String, index: true, unique: true, sparse: true },

    // Raw Safaricom callback payloads kept for audit / reconciliation.
    metadata: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

// Common query path: a user's history sorted by recency.
transactionSchema.index({ receiver: 1, createdAt: -1 });
transactionSchema.index({ sender: 1, createdAt: -1 });

export const Transaction = mongoose.model('Transaction', transactionSchema);
export default Transaction;
