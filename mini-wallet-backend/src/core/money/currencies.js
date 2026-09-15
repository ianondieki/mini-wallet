/**
 * Currency registry.
 *
 * Every currency declares its `exponent` — the number of decimal places in
 * its minor unit. KES/USD are 2 (cents), UGX/JPY are 0 (no subdivision in
 * practice), BHD/KWD are 3. Money arithmetic is done entirely in minor units
 * so this table is the single source of truth for scaling.
 *
 * Adding a currency here is the ONLY step needed to make the ledger, the fee
 * engine and the FX layer handle it — nothing downstream hardcodes "cents".
 */

/**
 * @typedef {object} Currency
 * @property {string} code      ISO 4217 alphabetic code.
 * @property {number} exponent  Decimal places in the minor unit.
 * @property {string} symbol    Display symbol.
 * @property {string} name      Human-readable name.
 */

/** @type {Readonly<Record<string, Currency>>} */
export const CURRENCIES = Object.freeze({
  KES: { code: 'KES', exponent: 2, symbol: 'KSh', name: 'Kenyan Shilling' },
  UGX: { code: 'UGX', exponent: 0, symbol: 'USh', name: 'Ugandan Shilling' },
  TZS: { code: 'TZS', exponent: 2, symbol: 'TSh', name: 'Tanzanian Shilling' },
  RWF: { code: 'RWF', exponent: 0, symbol: 'FRw', name: 'Rwandan Franc' },
  NGN: { code: 'NGN', exponent: 2, symbol: '₦', name: 'Nigerian Naira' },
  GHS: { code: 'GHS', exponent: 2, symbol: 'GH₵', name: 'Ghanaian Cedi' },
  ZAR: { code: 'ZAR', exponent: 2, symbol: 'R', name: 'South African Rand' },
  USD: { code: 'USD', exponent: 2, symbol: '$', name: 'US Dollar' },
  EUR: { code: 'EUR', exponent: 2, symbol: '€', name: 'Euro' },
  GBP: { code: 'GBP', exponent: 2, symbol: '£', name: 'Pound Sterling' },
});

/** Currency codes this deployment is licensed to hold balances in. */
export const SUPPORTED_CURRENCIES = Object.freeze(Object.keys(CURRENCIES));

/**
 * Look up a currency, throwing on anything unknown. Failing loudly here is
 * deliberate: a typo'd currency code must never silently become a new,
 * unbacked balance bucket.
 *
 * @param {string} code
 * @returns {Currency}
 */
export const getCurrency = (code) => {
  const currency = CURRENCIES[String(code).toUpperCase()];
  if (!currency) {
    throw new RangeError(
      `Unsupported currency "${code}". Supported: ${SUPPORTED_CURRENCIES.join(', ')}`
    );
  }
  return currency;
};

/** True when `code` is a currency this system can hold. */
export const isSupportedCurrency = (code) =>
  Object.hasOwn(CURRENCIES, String(code).toUpperCase());

export default CURRENCIES;
