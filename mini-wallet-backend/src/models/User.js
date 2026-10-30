import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { isValidKenyanPhone, formatPhone } from '../utils/mpesaHelpers.js';
import { KycTier, TIER_ORDER } from '../core/limits/tiers.js';

const BCRYPT_ROUNDS = 12;

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: 2,
      maxlength: 80,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email format'],
    },
    phone: {
      type: String,
      required: [true, 'Phone is required'],
      unique: true,
      trim: true,
      validate: {
        validator: isValidKenyanPhone,
        message: 'Phone must be a valid Kenyan number (2547XXXXXXXX)',
      },
      set: (v) => formatPhone(v) || v, // store normalised
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: 8,
      select: false, // never returned unless explicitly requested
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    role: {
      type: String,
      enum: ['user', 'admin'],
      default: 'user',
    },

    /**
     * KYC tier. Everything a customer is allowed to do flows from this — see
     * core/limits/tiers.js. New accounts start at TIER_0, which is enough to
     * transact at low value immediately; more evidence unlocks more headroom.
     */
    kycTier: {
      type: String,
      enum: TIER_ORDER,
      default: KycTier.TIER_0,
      index: true,
    },

    /** Audit trail of verification steps, for compliance review. */
    kyc: {
      idVerifiedAt: { type: Date, default: null },
      addressVerifiedAt: { type: Date, default: null },
      livenessVerifiedAt: { type: Date, default: null },
      enhancedReviewAt: { type: Date, default: null },
      /** Set when sanctions/PEP screening last ran clean. */
      screenedAt: { type: Date, default: null },
    },

    /**
     * Set by compliance to stop a customer transacting without deleting them.
     * Distinct from `isActive`, which is the customer's own account state:
     * a frozen account can still be logged into and inspected by its owner,
     * which is what a regulator expects during an investigation.
     */
    isFrozen: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.password;
        delete ret.__v;
        return ret;
      },
    },
  }
);

/** Hash the password before save whenever it has changed. */
userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(BCRYPT_ROUNDS);
  this.password = await bcrypt.hash(this.password, salt);
  return next();
});

/**
 * Compare a plaintext candidate against the stored hash.
 * @param {string} candidate
 * @returns {Promise<boolean>}
 */
userSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.password);
};

/**
 * Whether this customer may move money right now. Separating this from the
 * limit check keeps the reason specific: "frozen" and "over your daily limit"
 * are very different conversations with the customer.
 * @returns {{ok: boolean, reason?: string, code?: string}}
 */
userSchema.methods.canTransact = function canTransact() {
  if (!this.isActive) return { ok: false, reason: 'Account is deactivated', code: 'ACCOUNT_DISABLED' };
  if (this.isFrozen) {
    return { ok: false, reason: 'Account is under review', code: 'ACCOUNT_FROZEN' };
  }
  return { ok: true };
};

export const User = mongoose.model('User', userSchema);
export default User;
