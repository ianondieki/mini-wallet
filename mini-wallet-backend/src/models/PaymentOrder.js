import mongoose from 'mongoose';

/**
 * A payment order — the *operational* record of a payment.
 *
 * Deliberately separate from the ledger. The ledger records what is true
 * about money that has actually moved; an order records an attempt, which may
 * be pending, retried across two rails, or abandoned. Mixing the two is what
 * produced the original design's central awkwardness: a `pending` row in the
 * transaction log that had already changed a balance, so the log was
 * simultaneously a record of intent and a record of fact.
 *
 * Here: an order exists from the moment a customer asks, and carries the rail
 * state machine. Ledger entries are attached as they are posted. This is the
 * same split Stripe draws between a PaymentIntent and its balance
 * transactions.
 */

const moneySchema = new mongoose.Schema(
  { minor: { type: Number, required: true }, currency: { type: String, required: true } },
  { _id: false }
);

const paymentOrderSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true, unique: true },
    userId: { type: String, required: true, index: true },

    /** "collect" or "payout". */
    direction: { type: String, required: true, enum: ['collect', 'payout'] },
    /** Business flow: deposit, payout, transfer, fx. */
    flow: { type: String, required: true, index: true },

    amount: { type: moneySchema, required: true },
    fee: { type: moneySchema, default: null },
    /** What the rail charged us — populated from the settlement callback. */
    railCost: { type: moneySchema, default: null },

    /** Where the money is coming from or going to. */
    instrument: { type: mongoose.Schema.Types.Mixed, required: true },

    rail: { type: String, default: null, index: true },
    providerRef: { type: String, default: null, index: true, sparse: true },
    receipt: { type: String, default: null },

    status: {
      type: String,
      required: true,
      enum: [
        'pending',
        'processing',
        'awaiting_customer',
        'succeeded',
        'failed',
        'reversed',
        'unknown',
        // Held by risk, or parked because the rail outcome is indeterminate.
        'held_for_review',
        'needs_reconciliation',
      ],
      default: 'pending',
      index: true,
    },

    /** Ledger entries this order produced, in the order they were posted. */
    ledgerEntries: { type: [String], default: [] },

    /** Whether funds are currently sitting in the reserved account. */
    reserved: { type: Boolean, default: false },

    risk: {
      score: { type: Number, default: null },
      decision: { type: String, default: null },
      signals: { type: [mongoose.Schema.Types.Mixed], default: [] },
    },

    /** Each rail attempted, for post-incident analysis. */
    attempts: { type: [mongoose.Schema.Types.Mixed], default: [] },

    idempotencyKey: { type: String, default: null },
    failureCode: { type: String, default: null },
    failureReason: { type: String, default: null },

    /** When we expect a terminal state — drives the stuck-payment sweep. */
    expectedBy: { type: Date, default: null, index: true },

    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, minimize: false }
);

paymentOrderSchema.index({ userId: 1, createdAt: -1 });
// The reconciliation sweep: orders past their SLA that have not settled.
paymentOrderSchema.index({ status: 1, expectedBy: 1 });

/** Statuses after which nothing further is expected. */
export const TERMINAL_ORDER_STATUSES = ['succeeded', 'failed', 'reversed'];

export const PaymentOrder = mongoose.model('PaymentOrder', paymentOrderSchema);
export default PaymentOrder;
