import mongoose from 'mongoose';

/**
 * Materialised account balance — a **cache**, never the source of truth.
 *
 * The truth is the sum of postings in `LedgerEntry`. This collection exists
 * because summing a customer's entire history on every balance check does not
 * scale, and because a single-document conditional update is what makes
 * overdraft structurally impossible under concurrency.
 *
 * Because it is derived, it is also *checkable*: `reconciliationService`
 * replays the postings and compares. A drift is therefore a detectable,
 * alertable event rather than a silent loss — which is precisely what the
 * original free-standing `Wallet.balance` field could never offer.
 */
const accountBalanceSchema = new mongoose.Schema(
  {
    account: { type: String, required: true },
    currency: { type: String, required: true },

    /**
     * Signed balance in minor units, in the account's *natural* sense:
     * positive means "normal side". A customer's available balance of
     * 1,250.00 KES is stored as 125000 even though it is a liability held on
     * the credit side.
     */
    minor: { type: Number, required: true, default: 0 },

    /** Number of postings folded in — a cheap drift tripwire. */
    postingCount: { type: Number, required: true, default: 0 },

    /** Denormalised owner, so a user's balances are one indexed lookup. */
    userId: { type: String, default: null, index: true, sparse: true },

    /** Entry id of the most recent posting, for debugging drift. */
    lastEntryId: { type: String, default: null },
  },
  { timestamps: true }
);

// One balance row per (account, currency). The upsert in ledgerService relies
// on this being unique to avoid creating duplicate rows under a race.
accountBalanceSchema.index({ account: 1, currency: 1 }, { unique: true });

export const AccountBalance = mongoose.model('AccountBalance', accountBalanceSchema);
export default AccountBalance;
