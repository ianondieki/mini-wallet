import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';

/**
 * A named savings goal.
 *
 * Deliberately holds **no balance**. What has been saved is the balance of the
 * customer's `liabilities:user:<id>:vault:<goalId>:<ccy>` account, derived from
 * postings like every other balance in the system. This document carries only
 * the things the ledger has no opinion about: what the goal is called, what it
 * is for, when the customer wants it by, and whether they asked us to stop them
 * raiding it early.
 *
 * Keeping the money out of here is the whole point. A `saved` field on this
 * document would be a second source of truth, and the one thing this codebase
 * is built to not have.
 */
const savingsGoalSchema = new mongoose.Schema(
  {
    goalId: { type: String, required: true, unique: true, default: () => randomUUID() },
    userId: { type: String, required: true, index: true },

    name: { type: String, required: true, trim: true, maxlength: 60 },
    currency: { type: String, required: true, default: 'KES' },

    /** Optional target, in minor units. Progress is shown against it. */
    targetMinor: { type: Number, default: null, min: 1 },
    deadline: { type: Date, default: null },

    /**
     * An optional commitment device. Until `lockedUntil`, taking money out
     * costs `breakPenaltyBps` of the amount released. The customer chooses
     * this at creation; it is a promise to their future self, so it can be
     * extended but never shortened.
     */
    lockedUntil: { type: Date, default: null },
    breakPenaltyBps: { type: Number, default: 0, min: 0, max: 2000 },

    state: {
      type: String,
      enum: ['active', 'closed'],
      default: 'active',
      index: true,
    },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// A customer's goals, newest first — the list screen's only query.
savingsGoalSchema.index({ userId: 1, state: 1, createdAt: -1 });
// Names are per customer, so two people may both save for "Rent".
savingsGoalSchema.index(
  { userId: 1, name: 1 },
  { unique: true, partialFilterExpression: { state: 'active' } }
);

/** True when breaking into this goal right now would cost a penalty. */
savingsGoalSchema.methods.isLocked = function isLocked(at = new Date()) {
  return Boolean(this.lockedUntil && this.lockedUntil > at && this.breakPenaltyBps > 0);
};

export const SavingsGoal = mongoose.model('SavingsGoal', savingsGoalSchema);
export default SavingsGoal;
