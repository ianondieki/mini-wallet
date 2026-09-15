import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getTimestamp,
  getPassword,
  formatPhone,
  isValidKenyanPhone,
  maskPhone,
} from '../../src/utils/mpesaHelpers.js';

test('formatPhone normalises every accepted Kenyan format to 2547/2541XXXXXXXX', () => {
  assert.equal(formatPhone('0712345678'), '254712345678');
  assert.equal(formatPhone('0112345678'), '254112345678');
  assert.equal(formatPhone('712345678'), '254712345678');
  assert.equal(formatPhone('+254712345678'), '254712345678');
  assert.equal(formatPhone('254712345678'), '254712345678');
  assert.equal(formatPhone('  254 712 345 678 '), '254712345678');
});

test('formatPhone rejects invalid numbers', () => {
  assert.equal(formatPhone('0812345678'), null); // 08 prefix not allowed
  assert.equal(formatPhone('071234567'), null); // too short
  assert.equal(formatPhone('07123456789'), null); // too long
  assert.equal(formatPhone('abcdshjdfg'), null);
  assert.equal(formatPhone(''), null);
  assert.equal(formatPhone(undefined), null);
  assert.equal(formatPhone(254712345678), null); // not a string
});

test('isValidKenyanPhone mirrors formatPhone', () => {
  assert.equal(isValidKenyanPhone('0712345678'), true);
  assert.equal(isValidKenyanPhone('0812345678'), false);
});

test('getPassword is base64(shortcode + passkey + timestamp)', () => {
  const ts = '20240101120000';
  const pwd = getPassword('174379', 'passkey', ts);
  assert.equal(pwd, Buffer.from(`174379passkey${ts}`).toString('base64'));
  // round-trips back to the plaintext concatenation
  assert.equal(Buffer.from(pwd, 'base64').toString(), `174379passkey${ts}`);
});

test('getTimestamp returns East Africa Time regardless of the host timezone', () => {
  // Midnight UTC is 03:00 in Nairobi (UTC+3, no DST).
  assert.equal(getTimestamp(new Date('2026-01-15T00:00:00Z')), '20260115030000');
  // 22:30 UTC rolls over to the next day at 01:30 EAT.
  assert.equal(getTimestamp(new Date('2026-01-15T22:30:45Z')), '20260116013045');
});

test('getTimestamp always produces a 14-digit YYYYMMDDHHmmss string', () => {
  assert.match(getTimestamp(), /^\d{14}$/);
});

test('maskPhone hides all but the last four digits', () => {
  assert.equal(maskPhone('254712345678'), '********5678');
  assert.equal(maskPhone('5678'), '5678'); // length 4 → nothing to mask
  assert.equal(maskPhone('12'), '****'); // too short
  assert.equal(maskPhone(''), '****');
  assert.equal(maskPhone(null), '****');
});
