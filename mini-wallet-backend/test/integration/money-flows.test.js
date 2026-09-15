import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Secrets must exist before the auth layer signs/verifies tokens.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-access-secret-please-change';
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-please-change';

const request = (await import('supertest')).default;
const { createApp } = await import('../../src/app.js');
const { User } = await import('../../src/models/User.js');
const { Wallet } = await import('../../src/models/Wallet.js');
const { Transaction } = await import('../../src/models/Transaction.js');
const { startTestDb, clearDb } = await import('./setup.js');

let db;
let app;
let skip = false;
let skipReason = '';

before(async () => {
  db = await startTestDb();
  if (db.skip) {
    skip = true;
    skipReason = db.reason;
    return;
  }
  // Ensure the partial unique idempotency index is actually built.
  await Promise.all([User.init(), Wallet.init(), Transaction.init()]);
  app = createApp();
});

after(async () => {
  if (db) await db.stop();
});

beforeEach(async () => {
  if (!skip) await clearDb();
});

/** Register a user, fund their wallet, and return { token, user }. */
const makeUser = async (overrides = {}, balance = 0) => {
  const payload = {
    name: 'Test User',
    email: `u${Math.random().toString(36).slice(2)}@example.com`,
    phone: `2547${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
    password: 'Password123',
    ...overrides,
  };
  const res = await request(app).post('/api/auth/register').send(payload);
  assert.equal(res.status, 201, `register failed: ${JSON.stringify(res.body)}`);
  const token = res.body.data.accessToken;
  const userId = res.body.data.user.id || res.body.data.user._id;
  if (balance > 0) await Wallet.updateOne({ user: userId }, { balance });
  return { token, user: res.body.data.user, userId, email: payload.email };
};

const balanceOf = async (userId) => (await Wallet.findOne({ user: userId }).lean()).balance;

const guard = (t) => {
  if (skip) {
    t.skip(skipReason);
    return true;
  }
  return false;
};

/* ── Auth ───────────────────────────────────────────────────────────────── */

test('register creates a wallet and rejects duplicate emails', async (t) => {
  if (guard(t)) return;
  const { userId, email } = await makeUser();
  const wallet = await Wallet.findOne({ user: userId }).lean();
  assert.ok(wallet, 'wallet should be created on registration');
  assert.equal(wallet.balance, 0);

  const dup = await request(app).post('/api/auth/register').send({
    name: 'Another', email, phone: '254700000001', password: 'Password123',
  });
  assert.equal(dup.status, 409);
});

test('protected routes reject requests without a token', async (t) => {
  if (guard(t)) return;
  const res = await request(app).get('/api/wallet/balance');
  assert.equal(res.status, 401);
});

/* ── Transfer ───────────────────────────────────────────────────────────── */

test('transfer moves funds between two wallets', async (t) => {
  if (guard(t)) return;
  const sender = await makeUser({}, 1000);
  const recipient = await makeUser();

  const res = await request(app)
    .post('/api/wallet/transfer')
    .set('Authorization', `Bearer ${sender.token}`)
    .set('Idempotency-Key', 'transfer-key-000001')
    .send({ recipientEmail: recipient.email, amount: 400 });

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(await balanceOf(sender.userId), 600);
  assert.equal(await balanceOf(recipient.userId), 400);
});

test('transfer is rejected when funds are insufficient (no overdraft)', async (t) => {
  if (guard(t)) return;
  const sender = await makeUser({}, 100);
  const recipient = await makeUser();

  const res = await request(app)
    .post('/api/wallet/transfer')
    .set('Authorization', `Bearer ${sender.token}`)
    .set('Idempotency-Key', 'transfer-key-000002')
    .send({ recipientEmail: recipient.email, amount: 500 });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INSUFFICIENT_FUNDS');
  assert.equal(await balanceOf(sender.userId), 100); // untouched
  assert.equal(await balanceOf(recipient.userId), 0);
});

test('transfer to self is rejected', async (t) => {
  if (guard(t)) return;
  const sender = await makeUser({}, 1000);
  const res = await request(app)
    .post('/api/wallet/transfer')
    .set('Authorization', `Bearer ${sender.token}`)
    .set('Idempotency-Key', 'transfer-key-000003')
    .send({ recipientEmail: sender.email, amount: 100 });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'SELF_TRANSFER');
});

test('a replayed Idempotency-Key does not double-spend', async (t) => {
  if (guard(t)) return;
  const sender = await makeUser({}, 1000);
  const recipient = await makeUser();
  const key = 'idempotent-replay-key-01';
  const body = { recipientEmail: recipient.email, amount: 300 };

  const first = await request(app)
    .post('/api/wallet/transfer')
    .set('Authorization', `Bearer ${sender.token}`)
    .set('Idempotency-Key', key)
    .send(body);
  assert.equal(first.status, 201);

  const replay = await request(app)
    .post('/api/wallet/transfer')
    .set('Authorization', `Bearer ${sender.token}`)
    .set('Idempotency-Key', key)
    .send(body);

  // Either the 60s replay (200) or the unique-index conflict (409) — never a
  // second debit.
  assert.ok([200, 409].includes(replay.status), `unexpected ${replay.status}`);
  assert.equal(await balanceOf(sender.userId), 700); // debited once
  assert.equal(await balanceOf(recipient.userId), 300);
});

test('the SAME idempotency key from DIFFERENT users does not collide', async (t) => {
  if (guard(t)) return;
  // Regression test for the per-user idempotency fix: a globally-unique key
  // would have leaked/blocked user B here.
  const userA = await makeUser({}, 1000);
  const userB = await makeUser({}, 1000);
  const recipient = await makeUser();
  const sharedKey = 'shared-client-key-00001';

  const a = await request(app)
    .post('/api/wallet/transfer')
    .set('Authorization', `Bearer ${userA.token}`)
    .set('Idempotency-Key', sharedKey)
    .send({ recipientEmail: recipient.email, amount: 100 });

  const b = await request(app)
    .post('/api/wallet/transfer')
    .set('Authorization', `Bearer ${userB.token}`)
    .set('Idempotency-Key', sharedKey)
    .send({ recipientEmail: recipient.email, amount: 200 });

  assert.equal(a.status, 201, `A: ${JSON.stringify(a.body)}`);
  assert.equal(b.status, 201, `B: ${JSON.stringify(b.body)}`);
  assert.equal(await balanceOf(userA.userId), 900);
  assert.equal(await balanceOf(userB.userId), 800);
  assert.equal(await balanceOf(recipient.userId), 300);
});

/* ── M-Pesa STK callback (no Daraja network involved) ───────────────────── */

const callbackBody = (checkoutId, { amount = 500, receipt = 'QGH7TEST01' } = {}) => ({
  Body: {
    stkCallback: {
      MerchantRequestID: 'mr-1',
      CheckoutRequestID: checkoutId,
      ResultCode: 0,
      ResultDesc: 'The service request is processed successfully.',
      CallbackMetadata: {
        Item: [
          { Name: 'Amount', Value: amount },
          { Name: 'MpesaReceiptNumber', Value: receipt },
          { Name: 'PhoneNumber', Value: 254712345678 },
        ],
      },
    },
  },
});

/** Seed a pending top-up the way stkPush would, and return its checkout id. */
const seedPendingTopup = async (userId, amount) => {
  const checkoutId = `ws_CO_${Math.random().toString(36).slice(2)}`;
  await Transaction.create({
    sender: null, receiver: userId, amount, type: 'topup', status: 'pending',
    phone: '254712345678', mpesaCheckoutRequestId: checkoutId,
  });
  return checkoutId;
};

test('STK success callback credits the wallet exactly once', async (t) => {
  if (guard(t)) return;
  const { userId } = await makeUser();
  const checkoutId = await seedPendingTopup(userId, 500);

  const first = await request(app).post('/api/mpesa/callback').send(callbackBody(checkoutId));
  assert.equal(first.status, 200);
  assert.equal(await balanceOf(userId), 500);

  // Safaricom retry → must NOT double-credit.
  const retry = await request(app).post('/api/mpesa/callback').send(callbackBody(checkoutId));
  assert.equal(retry.status, 200);
  assert.equal(await balanceOf(userId), 500);

  const txn = await Transaction.findOne({ mpesaCheckoutRequestId: checkoutId }).lean();
  assert.equal(txn.status, 'success');
  assert.equal(txn.mpesaReceiptNumber, 'QGH7TEST01');
});

test('STK callback credits the actually-paid amount on a mismatch', async (t) => {
  if (guard(t)) return;
  const { userId } = await makeUser();
  const checkoutId = await seedPendingTopup(userId, 500); // requested 500

  // Safaricom reports only 450 paid.
  const res = await request(app)
    .post('/api/mpesa/callback')
    .send(callbackBody(checkoutId, { amount: 450 }));
  assert.equal(res.status, 200);

  assert.equal(await balanceOf(userId), 450); // never over-credit
  const txn = await Transaction.findOne({ mpesaCheckoutRequestId: checkoutId }).lean();
  assert.equal(txn.amount, 450);
  assert.deepEqual(txn.metadata.amountMismatch, { expected: 500, paid: 450 });
});

test('STK failure callback marks the transaction failed and credits nothing', async (t) => {
  if (guard(t)) return;
  const { userId } = await makeUser();
  const checkoutId = await seedPendingTopup(userId, 500);

  const res = await request(app).post('/api/mpesa/callback').send({
    Body: { stkCallback: { CheckoutRequestID: checkoutId, ResultCode: 1032, ResultDesc: 'Cancelled by user' } },
  });
  assert.equal(res.status, 200);
  assert.equal(await balanceOf(userId), 0);
  const txn = await Transaction.findOne({ mpesaCheckoutRequestId: checkoutId }).lean();
  assert.equal(txn.status, 'failed');
});
