import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';

/**
 * One person asking another for money.
 *
 * This is the half of a wallet that a ledger alone cannot express. A request
 * is not a movement — nothing has happened yet — so it has no postings and no
 * balance. It is an *intention with two parties*, and it needs a state machine
 * because the person who created it is not the person who completes it.
 *
 * Several requests created together share a `groupId`. That is what turns "ask
 * four friends for 500 each" into one bill the requester can watch fill up,
 * while each friend still sees, approves, or declines only their own share.
 *
 * When a request is approved the resulting transfer is an ordinary ledger
 * entry like any other, and `settledEntryId` points at it. The books stay the
 * single source of truth for money; this collection only records who asked.
 */
const moneyRequestSchema = new mongoose.Schema(
  {
    requestId: { type: String, required: true, unique: true, default: () => randomUUID() },

    /** Requests created in one go — a split bill — share this. */
    groupId: { type: String, required: true, index: true },

    /** Who asked, and will receive the money. */
    fromUserId: { type: String, required: true, index: true },
    /** Who was asked, and would pay. */
    toUserId: { type: String, required: true, index: true },

    currency: { type: String, required: true, default: 'KES' },
    amountMinor: { type: Number, required: true, min: 1 },
    note: { type: String, trim: true, maxlength: 140, default: null },

    /**
     * `settling` is held only for the moment between claiming a request and
     * the transfer committing. It exists so two taps on Pay cannot both
     * proceed; the ledger's per-(payer, request) uniqueness is the real
     * guarantee, and this is the cheap guard in front of it.
     */
    state: {
      type: String,
      enum: ['pending', 'settling', 'paid', 'declined', 'cancelled'],
      default: 'pending',
      index: true,
    },

    /** A request nobody answers should stop being actionable by itself. */
    expiresAt: { type: Date, required: true },

    settledEntryId: { type: String, default: null },
    settledAt: { type: Date, default: null },
    declineReason: { type: String, trim: true, maxlength: 140, default: null },
  },
  { timestamps: true }
);

// The two list screens: "who owes me" and "what I owe".
moneyRequestSchema.index({ toUserId: 1, state: 1, createdAt: -1 });
moneyRequestSchema.index({ fromUserId: 1, state: 1, createdAt: -1 });

/** True when this request can still be acted on. */
moneyRequestSchema.methods.isActionable = function isActionable(at = new Date()) {
  return this.state === 'pending' && this.expiresAt > at;
};

export const MoneyRequest = mongoose.model('MoneyRequest', moneyRequestSchema);
export default MoneyRequest;
