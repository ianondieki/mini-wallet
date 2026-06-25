import mongoose from 'mongoose';
import crypto from 'node:crypto';

const refreshTokenSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // We store a SHA-256 hash of the token, never the token itself, so a
    // database leak cannot be replayed against the refresh endpoint.
    token: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    isRevoked: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

// TTL index — Mongo auto-purges expired tokens.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/**
 * Deterministically hash a raw refresh token for storage/lookup.
 * @param {string} raw
 * @returns {string}
 */
refreshTokenSchema.statics.hashToken = function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
};

export const RefreshToken = mongoose.model('RefreshToken', refreshTokenSchema);
export default RefreshToken;
