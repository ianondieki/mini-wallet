import mongoose from 'mongoose';

const walletSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    // Balance stored as a Number of KES. Min 0 guards against overdraft at
    // the schema level; the conditional update in transfers is the real lock.
    balance: {
      type: Number,
      default: 0,
      min: [0, 'Balance cannot be negative'],
    },
    currency: {
      type: String,
      default: 'KES',
      enum: ['KES'],
    },
  },
  {
    timestamps: true,
    // Bumps __v on every save and refuses to persist if the document was
    // modified by someone else since we read it — optimistic concurrency.
    optimisticConcurrency: true,
    versionKey: '__v',
  }
);

export const Wallet = mongoose.model('Wallet', walletSchema);
export default Wallet;
