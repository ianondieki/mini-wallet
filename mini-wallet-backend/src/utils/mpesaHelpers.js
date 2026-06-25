/**
 * Daraja-specific helpers: timestamp generation, STK password encoding,
 * phone normalisation/validation, and PII masking for logs.
 */

/**
 * Daraja timestamp in the format YYYYMMDDHHmmss (server local time).
 * @returns {string}
 */
export const getTimestamp = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}` +
    `${pad(d.getMonth() + 1)}` +
    `${pad(d.getDate())}` +
    `${pad(d.getHours())}` +
    `${pad(d.getMinutes())}` +
    `${pad(d.getSeconds())}`
  );
};

/**
 * Lipa Na M-Pesa Online password: base64(ShortCode + Passkey + Timestamp).
 * @param {string} shortCode
 * @param {string} passkey
 * @param {string} timestamp  Output of getTimestamp().
 * @returns {string}
 */
export const getPassword = (shortCode, passkey, timestamp) =>
  Buffer.from(`${shortCode}${passkey}${timestamp}`).toString('base64');

/**
 * Normalise a Kenyan MSISDN to the 2547XXXXXXXX / 2541XXXXXXXX form Daraja expects.
 * Accepts 07.., 01.., +2547.., 2547.. and 7..-style inputs.
 * @param {string} input
 * @returns {string|null} Normalised number, or null if it cannot be normalised.
 */
export const formatPhone = (input) => {
  if (typeof input !== 'string') return null;
  let p = input.replace(/[\s+]/g, '');
  if (/^0(7|1)\d{8}$/.test(p)) p = `254${p.slice(1)}`;        // 07.. / 01..
  else if (/^(7|1)\d{8}$/.test(p)) p = `254${p}`;             // 7.. / 1..
  return /^254(7|1)\d{8}$/.test(p) ? p : null;
};

/**
 * True when the value is a valid normalised Kenyan MSISDN.
 * @param {string} input
 * @returns {boolean}
 */
export const isValidKenyanPhone = (input) => formatPhone(input) !== null;

/**
 * Mask all but the last 4 digits of a phone number for safe logging.
 * @param {string} phone
 * @returns {string}
 */
export const maskPhone = (phone) => {
  if (!phone || phone.length < 4) return '****';
  return `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}`;
};
