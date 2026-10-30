import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Secrets and rail credentials must exist before the app is built: createApp()
// bootstraps the rail registry, and the M-Pesa adapter only registers when its
// credentials are present.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-access-secret-please-change';
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-please-change';
process.env.MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY || 'test-key';
process.env.MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET || 'test-secret';
process.env.MPESA_SHORT_CODE = process.env.MPESA_SHORT_CODE || '174379';
// Empty allowlist + non-production means callbacks are accepted, which is what
// lets these tests exercise settlement without impersonating Safaricom's IPs.
process.env.SAFARICOM_IP_WHITELIST = '';
process.env.MPESA_CALLBACK_SECRET = '';
// Every test registers its own users, so the whole suite arrives from one IP
// and would trip the production auth limit (5 per 15 min) within seconds.
// That is the limiter working correctly on traffic it was never meant to
// describe. Raised here; the limiter's own behaviour is tested directly in
// test/unit/rateLimiter.test.js.
process.env.RATE_LIMIT_AUTH_MAX = '100000';
process.env.RATE_LIMIT_GLOBAL_MAX = '100000';
process.env.RATE_LIMIT_PAYMENT_MAX = '100000';
process.env.RATE_LIMIT_REFRESH_MAX = '100000';

const request = (await import('supertest')).default;
const { createApp } = await import('../../src/app.js');
const { User } = await import('../../src/models/User.js');
const { LedgerEntry } = await import('../../src/models/LedgerEntry.js');
const { AccountBalance } = await import('../../src/models/AccountBalance.js');
const { PaymentOrder } = await import('../../src/models/PaymentOrder.js');
const { IdempotencyRecord } = await import('../../src/models/IdempotencyRecord.js');
const { Money } = await import('../../src/core/money/Money.js');
const { openingBalance } = await import('../../src/core/ledger/flows.js');
const { userAvailable, userReserved } = await import('../../src/core/ledger/accounts.js');
const ledger = await import('../../src/services/ledgerService.js');
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
  // Force the unique/partial indexes to build — several guarantees under test
  // (idempotency, one balance row per account) are enforced by them.
  await Promise.all([
    User.init(),
    LedgerEntry.init(),
    AccountBalance.init(),
    PaymentOrder.init(),
    IdempotencyRecord.init(),
  ]);
  app = createApp();
});

after(async () => {
  if (db) await db.stop();
});

beforeEach(async () => {
  if (!skip) await clearDb();
});

const guard = (t) => {
  if (skip) {
    t.skip(skipReason);
    return true;
  }
  return false;
};

/* ── Helpers ────────────────────────────────────────────────────────────── */

const KES = (v) => Money.of(String(v), 'KES');

/** Register a user through the API and return their credentials. */
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

  const userId = res.body.data.user.id || res.body.data.user._id;
  if (balance > 0) await fund(userId, balance);

  return { token: res.body.data.accessToken, userId, email: payload.email, phone: payload.phone };
};

/** Seed a balance the only way the ledger permits: a declared opening entry. */
const fund = async (userId, amount) =>
  ledger.post(
    openingBalance({
      account: userAvailable(userId, 'KES'),
      amount: KES(amount),
      reason: 'test fixture',
      metadata: { toUserId: userId },
    })
  );

/** Spendable balance, as a plain number of shillings. */
const balanceOf = async (userId) =>
  Number((await ledger.getBalance(userAvailable(userId, 'KES'), 'KES')).toDecimal());

/** Balance held against a payout in flight. */
const reservedOf = async (userId) =>
  Number((await ledger.getBalance(userReserved(userId, 'KES'), 'KES')).toDecimal());

/**
 * The invariant every money test must leave true: the books balance.
 * Asserted after each flow rather than once at the end, so a failure points
 * at the operation that broke it.
 */
const assertBooksBalance = async () => {
  const trial = await ledger.trialBalance('KES');
  assert.ok(
    trial.balanced,
    `trial balance is out by ${trial.net} — ${JSON.stringify(trial.accounts, null, 2)}`
  );
};

const auth = (token) => ({ Authorization: `Bearer ${token}` });

/* ── Registration ───────────────────────────────────────────────────────── */

describe('registration', () => {
  test('a new account starts at zero without a balance row existing', async (t) => {
    if (guard(t)) return;
    const { userId, token } = await makeUser();

    // No wallet document, and no AccountBalance row either — a balance is the
    // sum of postings, and there are none.
    assert.equal(await balanceOf(userId), 0);
    assert.equal(await AccountBalance.countDocuments({ userId }), 0);

    const res = await request(app).get('/api/wallet/balance').set(auth(token));
    assert.equal(res.status, 200);
    assert.equal(res.body.data.balance, 0);
    assert.equal(res.body.data.currency, 'KES');
  });

  test('duplicate emails are rejected', async (t) => {
    if (guard(t)) return;
    const { email } = await makeUser();
    const dup = await request(app).post('/api/auth/register').send({
      name: 'Another',
      email,
      phone: '254700000001',
      password: 'Password123',
    });
    assert.equal(dup.status, 409);
  });

  test('new accounts start at the lowest KYC tier', async (t) => {
    if (guard(t)) return;
    const { userId } = await makeUser();
    const user = await User.findById(userId).lean();
    assert.equal(user.kycTier, 'tier_0');
  });

  test('protected routes reject requests without a token', async (t) => {
    if (guard(t)) return;
    const res = await request(app).get('/api/wallet/balance');
    assert.equal(res.status, 401);
  });
});

/* ── Transfer ───────────────────────────────────────────────────────────── */

describe('transfer', () => {
  test('moves funds between two customers and leaves the books balanced', async (t) => {
    if (guard(t)) return;
    const sender = await makeUser({}, 1000);
    const recipient = await makeUser();

    const res = await request(app)
      .post('/api/wallet/transfer')
      .set(auth(sender.token))
      .set('Idempotency-Key', 'transfer-key-000001')
      .send({ recipientEmail: recipient.email, amount: 400 });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(await balanceOf(sender.userId), 600);
    assert.equal(await balanceOf(recipient.userId), 400);
    await assertBooksBalance();
  });

  test('is rejected when funds are insufficient, with nothing moved', async (t) => {
    if (guard(t)) return;
    const sender = await makeUser({}, 100);
    const recipient = await makeUser();

    const res = await request(app)
      .post('/api/wallet/transfer')
      .set(auth(sender.token))
      .set('Idempotency-Key', 'transfer-key-000002')
      .send({ recipientEmail: recipient.email, amount: 500 });

    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, 'INSUFFICIENT_FUNDS');
    assert.equal(await balanceOf(sender.userId), 100);
    assert.equal(await balanceOf(recipient.userId), 0);
    await assertBooksBalance();
  });

  test('can be addressed by phone number as well as email', async (t) => {
    if (guard(t)) return;
    const sender = await makeUser({}, 1000);
    const recipient = await makeUser();

    const res = await request(app)
      .post('/api/wallet/transfer')
      .set(auth(sender.token))
      .set('Idempotency-Key', 'transfer-key-byphone1')
      .send({ recipient: recipient.phone, amount: 250 });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(await balanceOf(recipient.userId), 250);
  });

  test('transfer to self is rejected', async (t) => {
    if (guard(t)) return;
    const sender = await makeUser({}, 1000);
    const res = await request(app)
      .post('/api/wallet/transfer')
      .set(auth(sender.token))
      .set('Idempotency-Key', 'transfer-key-000003')
      .send({ recipientEmail: sender.email, amount: 100 });

    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'SELF_TRANSFER');
  });

  test('posts exactly one balanced journal entry', async (t) => {
    if (guard(t)) return;
    const sender = await makeUser({}, 1000);
    const recipient = await makeUser();

    await request(app)
      .post('/api/wallet/transfer')
      .set(auth(sender.token))
      .set('Idempotency-Key', 'transfer-key-000004')
      .send({ recipientEmail: recipient.email, amount: 400 });

    const entries = await LedgerEntry.find({ flow: 'transfer' }).lean();
    assert.equal(entries.length, 1);

    const debits = entries[0].postings
      .filter((p) => p.direction === 'debit')
      .reduce((n, p) => n + p.amount, 0);
    const credits = entries[0].postings
      .filter((p) => p.direction === 'credit')
      .reduce((n, p) => n + p.amount, 0);
    assert.equal(debits, credits, 'the stored entry must balance');
  });

  test('the ledger is append-only', async (t) => {
    if (guard(t)) return;
    const sender = await makeUser({}, 1000);
    const recipient = await makeUser();
    await request(app)
      .post('/api/wallet/transfer')
      .set(auth(sender.token))
      .set('Idempotency-Key', 'transfer-key-000005')
      .send({ recipientEmail: recipient.email, amount: 100 });

    const entry = await LedgerEntry.findOne({ flow: 'transfer' });
    await assert.rejects(
      () => LedgerEntry.updateOne({ entryId: entry.entryId }, { $set: { narrative: 'tampered' } }),
      /append-only/
    );
    await assert.rejects(
      () => LedgerEntry.deleteOne({ entryId: entry.entryId }),
      /append-only/
    );
  });
});

/* ── Limits ─────────────────────────────────────────────────────────────── */

describe('KYC limits', () => {
  test('a transfer above the tier-0 per-transaction cap is refused', async (t) => {
    if (guard(t)) return;
    // Tier 0 allows 5,000 per transaction.
    const sender = await makeUser({}, 20000);
    const recipient = await makeUser();

    const res = await request(app)
      .post('/api/wallet/transfer')
      .set(auth(sender.token))
      .set('Idempotency-Key', 'limit-key-0000001')
      .send({ recipientEmail: recipient.email, amount: 6000 });

    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.code, 'LIMIT_EXCEEDED');
    assert.equal(await balanceOf(sender.userId), 20000, 'nothing moved');
  });

  test('raising the tier raises the ceiling', async (t) => {
    if (guard(t)) return;
    const sender = await makeUser({}, 20000);
    const recipient = await makeUser();
    await User.updateOne({ _id: sender.userId }, { kycTier: 'tier_1' });

    const res = await request(app)
      .post('/api/wallet/transfer')
      .set(auth(sender.token))
      .set('Idempotency-Key', 'limit-key-0000002')
      .send({ recipientEmail: recipient.email, amount: 6000 });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(await balanceOf(recipient.userId), 6000);
  });

  test('the limits endpoint reports headroom and the tariff', async (t) => {
    if (guard(t)) return;
    const { token } = await makeUser({}, 1000);
    const recipient = await makeUser();
    await request(app)
      .post('/api/wallet/transfer')
      .set(auth(token))
      .set('Idempotency-Key', 'limit-key-0000003')
      .send({ recipientEmail: recipient.email, amount: 400 });

    const res = await request(app).get('/api/wallet/limits').set(auth(token));
    assert.equal(res.status, 200);
    assert.equal(res.body.data.tier, 'tier_0');
    assert.equal(res.body.data.used.daily.amount, '400.00');
    assert.equal(res.body.data.remaining.daily.amount, '9600.00');
    assert.ok(Array.isArray(res.body.data.tariff));
  });

  test('a frozen account cannot transact but can still be inspected', async (t) => {
    if (guard(t)) return;
    const sender = await makeUser({}, 1000);
    const recipient = await makeUser();
    await User.updateOne({ _id: sender.userId }, { isFrozen: true });

    const transfer = await request(app)
      .post('/api/wallet/transfer')
      .set(auth(sender.token))
      .set('Idempotency-Key', 'frozen-key-0000001')
      .send({ recipientEmail: recipient.email, amount: 100 });
    assert.equal(transfer.status, 403);
    assert.equal(transfer.body.code, 'ACCOUNT_FROZEN');

    const balance = await request(app).get('/api/wallet/balance').set(auth(sender.token));
    assert.equal(balance.status, 200, 'the customer can still see their own money');
  });
});

/* ── Idempotency ────────────────────────────────────────────────────────── */

describe('idempotency', () => {
  test('a replayed key returns the original response without double-spending', async (t) => {
    if (guard(t)) return;
    const sender = await makeUser({}, 1000);
    const recipient = await makeUser();
    const key = 'idempotent-replay-key-01';
    const body = { recipientEmail: recipient.email, amount: 300 };

    const first = await request(app)
      .post('/api/wallet/transfer')
      .set(auth(sender.token))
      .set('Idempotency-Key', key)
      .send(body);
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const replay = await request(app)
      .post('/api/wallet/transfer')
      .set(auth(sender.token))
      .set('Idempotency-Key', key)
      .send(body);

    assert.equal(replay.status, 201, 'the stored response is replayed verbatim');
    assert.equal(replay.headers['idempotent-replay'], 'true');
    assert.deepEqual(replay.body.data.transaction.id, first.body.data.transaction.id);
    assert.equal(await balanceOf(sender.userId), 700, 'debited exactly once');
    assert.equal(await balanceOf(recipient.userId), 300);
    await assertBooksBalance();
  });

  test('the same key with a different payload is rejected, not silently replayed', async (t) => {
    if (guard(t)) return;
    const sender = await makeUser({}, 1000);
    const a = await makeUser();
    const b = await makeUser();
    const key = 'reused-key-000000001';

    const first = await request(app)
      .post('/api/wallet/transfer')
      .set(auth(sender.token))
      .set('Idempotency-Key', key)
      .send({ recipientEmail: a.email, amount: 100 });
    assert.equal(first.status, 201);

    const second = await request(app)
      .post('/api/wallet/transfer')
      .set(auth(sender.token))
      .set('Idempotency-Key', key)
      .send({ recipientEmail: b.email, amount: 900 });

    assert.equal(second.status, 422);
    assert.equal(second.body.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal(await balanceOf(b.userId), 0, 'the second request never ran');
  });

  test('the same key from different users does not collide', async (t) => {
    if (guard(t)) return;
    const userA = await makeUser({}, 1000);
    const userB = await makeUser({}, 1000);
    const recipient = await makeUser();
    const sharedKey = 'shared-client-key-00001';

    const a = await request(app)
      .post('/api/wallet/transfer')
      .set(auth(userA.token))
      .set('Idempotency-Key', sharedKey)
      .send({ recipientEmail: recipient.email, amount: 100 });

    const b = await request(app)
      .post('/api/wallet/transfer')
      .set(auth(userB.token))
      .set('Idempotency-Key', sharedKey)
      .send({ recipientEmail: recipient.email, amount: 200 });

    assert.equal(a.status, 201, `A: ${JSON.stringify(a.body)}`);
    assert.equal(b.status, 201, `B: ${JSON.stringify(b.body)}`);
    assert.equal(await balanceOf(userA.userId), 900);
    assert.equal(await balanceOf(userB.userId), 800);
    assert.equal(await balanceOf(recipient.userId), 300);
    await assertBooksBalance();
  });

  test('a missing key is refused on a money-moving endpoint', async (t) => {
    if (guard(t)) return;
    const sender = await makeUser({}, 1000);
    const recipient = await makeUser();
    const res = await request(app)
      .post('/api/wallet/transfer')
      .set(auth(sender.token))
      .send({ recipientEmail: recipient.email, amount: 100 });

    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'IDEMPOTENCY_KEY_REQUIRED');
  });
});

/* ── Deposit settlement via the M-Pesa callback ─────────────────────────── */

describe('deposit settlement', () => {
  /** A Daraja STK callback body. */
  const stkCallback = (checkoutId, { amount = 500, receipt = 'QGH7TEST01' } = {}) => ({
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

  /** Seed the order an STK push would have created, awaiting the customer. */
  const seedPendingDeposit = async (userId, amount) => {
    const checkoutId = `ws_CO_${Math.random().toString(36).slice(2)}`;
    await PaymentOrder.create({
      orderId: `order-${Math.random().toString(36).slice(2)}`,
      userId,
      direction: 'collect',
      flow: 'deposit',
      amount: { minor: KES(amount).minor, currency: 'KES' },
      instrument: { type: 'msisdn', msisdn: '254712345678' },
      rail: 'mpesa',
      providerRef: checkoutId,
      status: 'awaiting_customer',
    });
    return checkoutId;
  };

  test('credits the wallet exactly once, even when Safaricom retries', async (t) => {
    if (guard(t)) return;
    const { userId } = await makeUser();
    const checkoutId = await seedPendingDeposit(userId, 500);

    const first = await request(app).post('/api/mpesa/callback').send(stkCallback(checkoutId));
    assert.equal(first.status, 200);
    assert.equal(await balanceOf(userId), 500);

    const retry = await request(app).post('/api/mpesa/callback').send(stkCallback(checkoutId));
    assert.equal(retry.status, 200);
    assert.equal(await balanceOf(userId), 500, 'a retried callback must not double-credit');

    const order = await PaymentOrder.findOne({ providerRef: checkoutId }).lean();
    assert.equal(order.status, 'succeeded');
    assert.equal(order.receipt, 'QGH7TEST01');
    assert.equal(await LedgerEntry.countDocuments({ flow: 'deposit' }), 1);
    await assertBooksBalance();
  });

  test('credits the amount actually paid, never the amount requested', async (t) => {
    if (guard(t)) return;
    const { userId } = await makeUser();
    const checkoutId = await seedPendingDeposit(userId, 500);

    const res = await request(app)
      .post('/api/mpesa/callback')
      .send(stkCallback(checkoutId, { amount: 450 }));

    assert.equal(res.status, 200);
    assert.equal(await balanceOf(userId), 450, 'never over-credit');
    await assertBooksBalance();
  });

  test('a cancelled push credits nothing and reaches a terminal state', async (t) => {
    if (guard(t)) return;
    const { userId } = await makeUser();
    const checkoutId = await seedPendingDeposit(userId, 500);

    const res = await request(app)
      .post('/api/mpesa/callback')
      .send({
        Body: {
          stkCallback: {
            CheckoutRequestID: checkoutId,
            ResultCode: 1032,
            ResultDesc: 'Request cancelled by user',
          },
        },
      });

    assert.equal(res.status, 200);
    assert.equal(await balanceOf(userId), 0);
    const order = await PaymentOrder.findOne({ providerRef: checkoutId }).lean();
    assert.equal(order.status, 'failed', 'a failed deposit must not sit pending forever');
    assert.equal(await LedgerEntry.countDocuments({ flow: 'deposit' }), 0, 'no entry for money that never arrived');
  });

  test('a callback for an unknown payment is acknowledged and ignored', async (t) => {
    if (guard(t)) return;
    const res = await request(app).post('/api/mpesa/callback').send(stkCallback('ws_CO_nothere'));
    // Acknowledged so Safaricom stops retrying; nothing is credited.
    assert.equal(res.status, 200);
    assert.equal(res.body.ResultCode, 0);
    assert.equal(await LedgerEntry.countDocuments({}), 0);
  });

  test('a malformed callback body does not crash the endpoint', async (t) => {
    if (guard(t)) return;
    const res = await request(app).post('/api/mpesa/callback').send({ nonsense: true });
    assert.equal(res.status, 200);
  });
});

/* ── Payout reservation ─────────────────────────────────────────────────── */

describe('payout reservation', () => {
  test('a failed payout returns every shilling to the customer', async (t) => {
    if (guard(t)) return;
    const { userId } = await makeUser({}, 5000);

    // Seed a reserved payout the way initiatePayout would.
    const { reservePayout } = await import('../../src/core/ledger/flows.js');
    const orderId = `order-${Math.random().toString(36).slice(2)}`;
    const amount = KES(1000);
    const fee = KES(15);

    await ledger.post(
      reservePayout({ userId, amount, fee, metadata: { orderId, fromUserId: userId } })
    );
    await PaymentOrder.create({
      orderId,
      userId,
      direction: 'payout',
      flow: 'payout',
      amount: { minor: amount.minor, currency: 'KES' },
      fee: { minor: fee.minor, currency: 'KES' },
      instrument: { type: 'msisdn', msisdn: '254712345678' },
      rail: 'mpesa',
      providerRef: 'AG_CONV_1',
      status: 'processing',
      reserved: true,
    });

    assert.equal(await balanceOf(userId), 3985, 'reserved out of spendable');
    assert.equal(await reservedOf(userId), 1015, 'still the customer’s money');

    // The rail rejects it.
    const res = await request(app)
      .post('/api/mpesa/b2c/result')
      .send({
        Result: {
          ConversationID: 'AG_CONV_1',
          ResultCode: 2001,
          ResultDesc: 'The initiator information is invalid',
        },
      });

    assert.equal(res.status, 200);
    assert.equal(await balanceOf(userId), 5000, 'fully refunded, including the fee');
    assert.equal(await reservedOf(userId), 0);
    await assertBooksBalance();
  });

  test('a retried failure callback refunds only once', async (t) => {
    if (guard(t)) return;
    const { userId } = await makeUser({}, 5000);
    const { reservePayout } = await import('../../src/core/ledger/flows.js');
    const orderId = `order-${Math.random().toString(36).slice(2)}`;

    await ledger.post(
      reservePayout({ userId, amount: KES(1000), metadata: { orderId, fromUserId: userId } })
    );
    await PaymentOrder.create({
      orderId,
      userId,
      direction: 'payout',
      flow: 'payout',
      amount: { minor: KES(1000).minor, currency: 'KES' },
      instrument: { type: 'msisdn', msisdn: '254712345678' },
      rail: 'mpesa',
      providerRef: 'AG_CONV_2',
      status: 'processing',
      reserved: true,
    });

    const body = {
      Result: { ConversationID: 'AG_CONV_2', ResultCode: 1, ResultDesc: 'Failed' },
    };
    await request(app).post('/api/mpesa/b2c/result').send(body);
    await request(app).post('/api/mpesa/b2c/result').send(body);

    assert.equal(await balanceOf(userId), 5000, 'refunded exactly once');
    await assertBooksBalance();
  });
});

/* ── History and reconciliation ─────────────────────────────────────────── */

describe('history and reconciliation', () => {
  test('history renders the customer’s own view of each entry', async (t) => {
    if (guard(t)) return;
    const sender = await makeUser({}, 2000);
    const recipient = await makeUser();

    await request(app)
      .post('/api/wallet/transfer')
      .set(auth(sender.token))
      .set('Idempotency-Key', 'history-key-00000001')
      .send({ recipientEmail: recipient.email, amount: 400, description: 'lunch' });

    const senderView = await request(app).get('/api/wallet/transactions').set(auth(sender.token));
    const sent = senderView.body.data.transactions.find((x) => x.type === 'transfer');
    assert.equal(sent.direction, 'debit');
    assert.equal(sent.amount, 400);
    assert.equal(sent.description, 'lunch');

    const entries = await ledger.getUserHistory(recipient.userId, {});
    const received = entries.items.find((x) => x.flow === 'transfer');
    assert.equal(received.direction, 'credit', 'the same entry reads as a credit to the payee');
  });

  test('cached balances match a full replay of the journal', async (t) => {
    if (guard(t)) return;
    const a = await makeUser({}, 3000);
    const b = await makeUser({}, 1000);

    await request(app)
      .post('/api/wallet/transfer')
      .set(auth(a.token))
      .set('Idempotency-Key', 'recon-key-000000001')
      .send({ recipientEmail: b.email, amount: 700 });

    const { checkBalanceIntegrity } = await import('../../src/services/reconciliationService.js');
    const result = await checkBalanceIntegrity({ currency: 'KES' });
    assert.ok(result.ok, `drift detected: ${JSON.stringify(result.drifts, null, 2)}`);

    const verified = await ledger.deriveBalance(userAvailable(a.userId, 'KES'), 'KES');
    assert.ok(verified.drift.isZero);
    assert.equal(verified.derived.toDecimal(), '2300.00');
  });

  test('ops endpoints are admin-only', async (t) => {
    if (guard(t)) return;
    const { token } = await makeUser();
    const denied = await request(app).get('/api/ops/trial-balance').set(auth(token));
    assert.equal(denied.status, 403);
  });

  test('an admin can read the trial balance', async (t) => {
    if (guard(t)) return;
    const admin = await makeUser({}, 1000);
    await User.updateOne({ _id: admin.userId }, { role: 'admin' });

    const res = await request(app).get('/api/ops/trial-balance').set(auth(admin.token));
    assert.equal(res.status, 200);
    assert.equal(res.body.data.balanced, true);
    assert.equal(res.body.data.net.minor, 0);
  });
});
