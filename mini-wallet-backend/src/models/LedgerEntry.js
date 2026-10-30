import mongoose from 'mongoose';

/**
 * Persisted journal entry — **append-only**.
 *
 * There is no update path and no delete path anywhere in the codebase for
 * this collection. A correction is a new, reversing entry. That is what makes
 * the history admissible: any balance can be replayed from the entries that
 * produced it, and nothing in the past can quietly change shape.
 */

const postingSchema = new mongoose.Schema(
  {
    account: { type: String, required: true },
    direction: { type: String, required: true, enum: ['debit', 'credit'] },
    // Minor units (cents for KES). Always positive — `direction` carries sign.
    amount: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true },
    meta: { type: mongoose.Schema.Types.Mixed },
  },
  { _id: false }
);

const ledgerEntrySchema = new mongoose.Schema(
  {
    // UUID generated in the domain layer, so an entry has a stable identity
    // before it ever reaches the database.
    entryId: { type: String, required: true, unique: true },
    flow: { type: String, required: true, index: true },
    narrative: { type: String, maxlength: 280 },
    occurredAt: { type: Date, required: true, index: true },
    reversalOf: { type: String, default: null, index: true, sparse: true },
    postings: {
      type: [postingSchema],
      required: true,
      validate: [(v) => v.length >= 2, 'An entry needs at least two postings'],
    },
    // Denormalised for querying: which users and accounts this entry touched.
    accounts: { type: [String], index: true },
    userIds: { type: [String], index: true },
    currencies: { type: [String] },
    // Set for entries created by an idempotent request; the unique partial
    // index below is the last line of defence against a double-spend that
    // races past the idempotency store.
    idempotencyKey: { type: String },

    /**
     * The user the key belongs to. Idempotency keys are chosen by clients,
     * so two customers picking the same string is ordinary, not suspicious —
     * a globally unique index would let one customer's key block the other's
     * transfer, or surface its result to them.
     */
    idempotencyScope: { type: String },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, minimize: false }
);

// History queries: "this user's entries, newest first".
ledgerEntrySchema.index({ userIds: 1, occurredAt: -1 });
ledgerEntrySchema.index({ accounts: 1, occurredAt: -1 });

// One entry per (user, idempotency key) — scoped, never global. The partial
// filter keeps entries without a key out of the index entirely, so only real
// pairs are constrained.
ledgerEntrySchema.index(
  { idempotencyScope: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);

/** Close the door on mutation at the model level, not just by convention. */
const refuseMutation = function refuseMutation(next) {
  next(new Error('Ledger entries are append-only; post a reversing entry instead'));
};
ledgerEntrySchema.pre('updateOne', refuseMutation);
ledgerEntrySchema.pre('updateMany', refuseMutation);
ledgerEntrySchema.pre('findOneAndUpdate', refuseMutation);
ledgerEntrySchema.pre('deleteOne', refuseMutation);
ledgerEntrySchema.pre('deleteMany', refuseMutation);

export const LedgerEntry = mongoose.model('LedgerEntry', ledgerEntrySchema);
export default LedgerEntry;
