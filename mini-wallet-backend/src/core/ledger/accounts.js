/**
 * Chart of accounts.
 *
 * ## Why a ledger at all
 *
 * The original design kept `Wallet.balance` as the authoritative number and
 * `Transaction` as a separate log. Nothing tied them together: if a credit
 * applied but its transaction row failed to write (or vice versa), the two
 * drifted permanently and there was no mechanism that could even *detect* it,
 * let alone explain it.
 *
 * Here the postings ARE the truth. A balance is the sum of an account's
 * postings — never a field someone increments. Any cached balance is a
 * materialised view that the reconciler re-derives and compares. Money cannot
 * be created or destroyed because every entry must balance to zero.
 *
 * ## Account naming
 *
 * Colon-delimited paths, root segment first:
 *
 *   assets:rail:mpesa:float            money we hold at Safaricom
 *   assets:rail:pesalink:settlement    money in our bank settlement account
 *   liabilities:user:<id>:available    what we owe a customer, spendable
 *   liabilities:user:<id>:reserved     owed, but earmarked for a payout in flight
 *   revenue:fees:transfer              fee income by product
 *   revenue:fx:spread                  FX margin
 *   expenses:rail:mpesa                what the rail charges us
 *   equity:opening                     opening balances / capital
 *
 * A customer balance is a LIABILITY, not an asset: their money is not ours,
 * we owe it to them. Getting this sign convention right is what makes the
 * balance sheet meaningful — and it is exactly how Wise, Monzo and Stripe
 * Treasury model stored value.
 */

/**
 * @readonly
 * @enum {string}
 */
export const AccountType = Object.freeze({
  ASSET: 'asset',
  LIABILITY: 'liability',
  EQUITY: 'equity',
  REVENUE: 'revenue',
  EXPENSE: 'expense',
});

/**
 * @readonly
 * @enum {string}
 */
export const Direction = Object.freeze({
  DEBIT: 'debit',
  CREDIT: 'credit',
});

/**
 * The side on which each account type increases.
 *
 * Debits increase assets and expenses; credits increase liabilities, equity
 * and revenue. A posting on the normal side adds to the balance, the opposite
 * side subtracts.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const NORMAL_BALANCE = Object.freeze({
  [AccountType.ASSET]: Direction.DEBIT,
  [AccountType.EXPENSE]: Direction.DEBIT,
  [AccountType.LIABILITY]: Direction.CREDIT,
  [AccountType.EQUITY]: Direction.CREDIT,
  [AccountType.REVENUE]: Direction.CREDIT,
});

/** Root path segment → account type. */
const ROOT_TO_TYPE = Object.freeze({
  assets: AccountType.ASSET,
  liabilities: AccountType.LIABILITY,
  equity: AccountType.EQUITY,
  revenue: AccountType.REVENUE,
  expenses: AccountType.EXPENSE,
});

const SEGMENT = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Validate an account path and resolve its type.
 * @param {string} path
 * @returns {{ path: string, type: string, normalBalance: string, segments: string[] }}
 */
export const parseAccount = (path) => {
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError('Account path must be a non-empty string');
  }
  const segments = path.split(':');
  const type = ROOT_TO_TYPE[segments[0]];
  if (!type) {
    throw new RangeError(
      `Unknown account root "${segments[0]}" in "${path}". ` +
        `Expected one of: ${Object.keys(ROOT_TO_TYPE).join(', ')}`
    );
  }
  if (segments.length < 2) {
    throw new RangeError(`Account "${path}" needs at least one segment below the root`);
  }
  if (!segments.every((s) => SEGMENT.test(s))) {
    throw new RangeError(`Account "${path}" has an invalid segment`);
  }
  return { path, type, normalBalance: NORMAL_BALANCE[type], segments };
};

/**
 * Signed contribution of a posting to its account's balance.
 * `+amount` when the posting is on the account's normal side, `-amount` when
 * it is on the contra side.
 *
 * @param {string} accountPath
 * @param {string} direction  A {@link Direction} member.
 * @returns {1|-1}
 */
export const signFor = (accountPath, direction) =>
  parseAccount(accountPath).normalBalance === direction ? 1 : -1;

/* ── Account path builders ───────────────────────────────────────────────
 * Every account reference in the system goes through one of these, so a
 * typo'd path is a thrown error at construction rather than an orphaned
 * balance discovered at month-end.
 * ──────────────────────────────────────────────────────────────────────── */

/** Spendable customer balance. @param {string} userId @param {string} currency */
export const userAvailable = (userId, currency) =>
  `liabilities:user:${userId}:available:${String(currency).toLowerCase()}`;

/**
 * Customer funds earmarked for an in-flight payout. Money sits here between
 * "user asked to withdraw" and "the rail confirmed settlement", so it is
 * visibly still the customer's money but is not spendable twice.
 * @param {string} userId @param {string} currency
 */
export const userReserved = (userId, currency) =>
  `liabilities:user:${userId}:reserved:${String(currency).toLowerCase()}`;

/** Our float held at a payment rail. @param {string} rail @param {string} currency */
export const railFloat = (rail, currency) =>
  `assets:rail:${rail}:float:${String(currency).toLowerCase()}`;

/**
 * Value the rail has accepted but not yet settled to us. Keeping this
 * separate from `float` is what lets the reconciler spot a rail that has
 * confirmed a payment it never actually settles.
 * @param {string} rail @param {string} currency
 */
export const railClearing = (rail, currency) =>
  `assets:rail:${rail}:clearing:${String(currency).toLowerCase()}`;

/** Fee income, bucketed by product. @param {string} product @param {string} currency */
export const feeRevenue = (product, currency) =>
  `revenue:fees:${product}:${String(currency).toLowerCase()}`;

/** FX margin income. @param {string} currency */
export const fxRevenue = (currency) => `revenue:fx:spread:${String(currency).toLowerCase()}`;

/** What a rail charges us — our cost of goods. @param {string} rail @param {string} currency */
export const railExpense = (rail, currency) =>
  `expenses:rail:${rail}:${String(currency).toLowerCase()}`;

/**
 * Losses we absorb: a failed reversal, a rail shortfall, goodwill refunds.
 * Explicitly an expense so it shows up in the P&L instead of being quietly
 * netted against customer balances.
 * @param {string} currency
 */
export const lossExpense = (currency) =>
  `expenses:losses:settlement:${String(currency).toLowerCase()}`;

/** Capital / opening balances. @param {string} currency */
export const openingEquity = (currency) =>
  `equity:opening:${String(currency).toLowerCase()}`;

/**
 * Extract the user id from a customer account path, or null if it is not one.
 * @param {string} path
 * @returns {string|null}
 */
export const userIdFromAccount = (path) => {
  const segments = String(path).split(':');
  return segments[0] === 'liabilities' && segments[1] === 'user' ? segments[2] : null;
};

export default {
  AccountType,
  Direction,
  NORMAL_BALANCE,
  parseAccount,
  signFor,
  userAvailable,
  userReserved,
  railFloat,
  railClearing,
  feeRevenue,
  fxRevenue,
  railExpense,
  lossExpense,
  openingEquity,
};
