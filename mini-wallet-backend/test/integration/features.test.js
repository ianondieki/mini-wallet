import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Savings vaults, split payments, refunds and money requests, end to end over
 * HTTP against a real replica set.
 *
 * These four features were added on top of the ledger rather than beside it,
 * and that is exactly what needs proving: every one of them has to leave the
 * books balanced, has to be unable to invent or destroy a minor unit, and has
 * to refuse the obvious abuses (paying a request twice, refunding more than
 * was received, spending money parked in a vault). None of that can be
 * checked without transactions, so none of it can be checked without a
 * replica set.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-access-secret-please-change';
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-please-change';
process.env.SAFARICOM_IP_WHITELIST = '';
// See money-flows.test.js: the whole suite arrives from one IP.
process.env.RATE_LIMIT_AUTH_MAX = '100000';
process.env.RATE_LIMIT_GLOBAL_MAX = '100000';
process.env.RATE_LIMIT_PAYMENT_MAX = '100000';
process.env.RATE_LIMIT_REFRESH_MAX = '100000';

const request = (await import('supertest')).default;
const { createApp } = await import('../../src/app.js');
const { User } = await import('../../src/models/User.js');
const { LedgerEntry } = await import('../../src/models/LedgerEntry.js');
const { AccountBalance } = await import('../../src/models/AccountBalance.js');
const { IdempotencyRecord } = await import('../../src/models/IdempotencyRecord.js');
const { SavingsGoal } = await import('../../src/models/SavingsGoal.js');
const { MoneyRequest } = await import('../../src/models/MoneyRequest.js');
const { Money } = await import('../../src/core/money/Money.js');
const { openingBalance } = await import('../../src/core/ledger/flows.js');
const { userAvailable, userVault, feeRevenue } = await import('../../src/core/ledger/accounts.js');
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
  await Promise.all([
    User.init(),
    LedgerEntry.init(),
    AccountBalance.init(),
    IdempotencyRecord.init(),
    SavingsGoal.init(),
    MoneyRequest.init(),
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
const auth = (token) => ({ Authorization: `Bearer ${token}` });

/**
 * A fresh idempotency key per call. Every money-moving endpoint demands one,
 * by design — a client that cannot name its attempt cannot safely retry it.
 */
let keySeq = 0;
const idem = () => `test-key-${(keySeq += 1).toString().padStart(8, '0')}`;

const fund = async (userId, amount) =>
  ledger.post(
    openingBalance({
      account: userAvailable(userId, 'KES'),
      amount: KES(amount),
      reason: 'test fixture',
      metadata: { toUserId: userId },
    })
  );

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

const balanceOf = async (userId) =>
  Number((await ledger.getBalance(userAvailable(userId, 'KES'), 'KES')).toDecimal());

const vaultOf = async (userId, goalId) =>
  Number((await ledger.getBalance(userVault(userId, goalId, 'KES'), 'KES')).toDecimal());

const revenueOf = async (kind) =>
  Number((await ledger.getBalance(feeRevenue(kind, 'KES'), 'KES')).toDecimal());

const assertBooksBalance = async () => {
  const trial = await ledger.trialBalance('KES');
  assert.ok(
    trial.balanced,
    `trial balance is out by ${trial.net} — ${JSON.stringify(trial.accounts, null, 2)}`
  );
};

/** Create a goal over the API and return it. */
const makeGoal = async (token, body = {}) => {
  const res = await request(app)
    .post('/api/savings/goals')
    .set(auth(token))
    .send({ name: `Goal ${Math.random().toString(36).slice(2, 7)}`, ...body });
  assert.equal(res.status, 201, `goal failed: ${JSON.stringify(res.body)}`);
  return res.body.data.goal;
};

/* ── Savings vaults ─────────────────────────────────────────────────────── */

describe('savings goals', () => {
  test('a contribution moves money out of spendable and into the vault', async (t) => {
    if (guard(t)) return;
    const alice = await makeUser({}, 2000);
    const goal = await makeGoal(alice.token, { target: 5000 });

    const res = await request(app)
      .post(`/api/savings/goals/${goal.goalId}/contribute`)
      .set('Idempotency-Key', idem())
      .set(auth(alice.token))
      .send({ amount: 750 });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.goal.saved.amount, '750.00');
    // 750 of 5000 = 15%.
    assert.equal(res.body.data.goal.progressBps, 1500);
    assert.equal(await balanceOf(alice.userId), 1250);
    assert.equal(await vaultOf(alice.userId, goal.goalId), 750);
    await assertBooksBalance();
  });

  test('money in a vault is not spendable', async (t) => {
    if (guard(t)) return;
    // The regression this guards: a vault lives under the same
    // `liabilities:user:` prefix as the spendable balance, so a balance
    // reader that matches on the prefix alone would report saved money as
    // available and let the customer spend it twice.
    const alice = await makeUser({}, 1000);
    const bob = await makeUser();
    const goal = await makeGoal(alice.token);

    await request(app)
      .post(`/api/savings/goals/${goal.goalId}/contribute`)
      .set('Idempotency-Key', idem())
      .set(auth(alice.token))
      .send({ amount: 900 });

    const balance = await request(app).get('/api/wallet/balance').set(auth(alice.token));
    assert.equal(balance.body.data.balance, 100);

    const spend = await request(app)
      .post('/api/wallet/transfer')
      .set('Idempotency-Key', idem())
      .set(auth(alice.token))
      .send({ recipient: bob.email, amount: 500 });

    assert.equal(spend.status, 400);
    assert.equal(spend.body.code, 'INSUFFICIENT_FUNDS');
    assert.equal(await balanceOf(bob.userId), 0);
    await assertBooksBalance();
  });

  test('a contribution bigger than the spendable balance is refused', async (t) => {
    if (guard(t)) return;
    const alice = await makeUser({}, 100);
    const goal = await makeGoal(alice.token);

    const res = await request(app)
      .post(`/api/savings/goals/${goal.goalId}/contribute`)
      .set('Idempotency-Key', idem())
      .set(auth(alice.token))
      .send({ amount: 500 });

    assert.ok(res.status >= 400, `expected a refusal, got ${res.status}`);
    assert.equal(await balanceOf(alice.userId), 100);
    assert.equal(await vaultOf(alice.userId, goal.goalId), 0);
    await assertBooksBalance();
  });

  test('withdrawing from an unlocked goal returns every shilling', async (t) => {
    if (guard(t)) return;
    const alice = await makeUser({}, 1000);
    const goal = await makeGoal(alice.token);
    await request(app)
      .post(`/api/savings/goals/${goal.goalId}/contribute`)
      .set('Idempotency-Key', idem())
      .set(auth(alice.token))
      .send({ amount: 600 });

    const res = await request(app)
      .post(`/api/savings/goals/${goal.goalId}/withdraw`)
      .set('Idempotency-Key', idem())
      .set(auth(alice.token))
      .send({ amount: 600 });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.penalty.amount, '0.00');
    assert.equal(res.body.data.received.amount, '600.00');
    assert.equal(await balanceOf(alice.userId), 1000);
    assert.equal(await vaultOf(alice.userId, goal.goalId), 0);
    await assertBooksBalance();
  });

  test('breaking a locked goal early costs the penalty, and the penalty is revenue', async (t) => {
    if (guard(t)) return;
    const alice = await makeUser({}, 1000);
    const until = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const goal = await makeGoal(alice.token, { lock: { until, penaltyBps: 500 } });
    assert.equal(goal.locked, true);

    await request(app)
      .post(`/api/savings/goals/${goal.goalId}/contribute`)
      .set('Idempotency-Key', idem())
      .set(auth(alice.token))
      .send({ amount: 800 });

    // The quote first — the customer must be able to see the cost.
    const quote = await request(app)
      .get(`/api/savings/goals/${goal.goalId}/withdrawal-quote?amount=400`)
      .set(auth(alice.token));
    assert.equal(quote.status, 200);
    assert.equal(quote.body.data.early, true);
    assert.equal(quote.body.data.penalty.amount, '20.00'); // 5% of 400
    assert.equal(quote.body.data.youReceive.amount, '380.00');

    const res = await request(app)
      .post(`/api/savings/goals/${goal.goalId}/withdraw`)
      .set('Idempotency-Key', idem())
      .set(auth(alice.token))
      .send({ amount: 400, confirmPenalty: 20 });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.earlyBreak, true);
    assert.equal(await balanceOf(alice.userId), 580); // 200 left + 380 back
    assert.equal(await vaultOf(alice.userId, goal.goalId), 400);
    assert.equal(await revenueOf('savings.break'), 20);
    await assertBooksBalance();
  });

  test('a withdrawal is refused when the penalty is not what the customer agreed to', async (t) => {
    if (guard(t)) return;
    const alice = await makeUser({}, 1000);
    const until = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const goal = await makeGoal(alice.token, { lock: { until, penaltyBps: 500 } });
    await request(app)
      .post(`/api/savings/goals/${goal.goalId}/contribute`)
      .set('Idempotency-Key', idem())
      .set(auth(alice.token))
      .send({ amount: 500 });

    const res = await request(app)
      .post(`/api/savings/goals/${goal.goalId}/withdraw`)
      .set('Idempotency-Key', idem())
      .set(auth(alice.token))
      .send({ amount: 400, confirmPenalty: 0 });

    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'PENALTY_CHANGED');
    assert.equal(await vaultOf(alice.userId, goal.goalId), 500);
    await assertBooksBalance();
  });

  test('a goal holding money cannot be closed', async (t) => {
    if (guard(t)) return;
    const alice = await makeUser({}, 500);
    const goal = await makeGoal(alice.token);
    await request(app)
      .post(`/api/savings/goals/${goal.goalId}/contribute`)
      .set('Idempotency-Key', idem())
      .set(auth(alice.token))
      .send({ amount: 300 });

    const res = await request(app)
      .delete(`/api/savings/goals/${goal.goalId}`)
      .set(auth(alice.token));
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'VAULT_NOT_EMPTY');
  });

  test("another customer's goal reads as missing, not forbidden", async (t) => {
    if (guard(t)) return;
    const alice = await makeUser({}, 500);
    const bob = await makeUser({}, 500);
    const goal = await makeGoal(alice.token);

    const res = await request(app)
      .post(`/api/savings/goals/${goal.goalId}/contribute`)
      .set('Idempotency-Key', idem())
      .set(auth(bob.token))
      .send({ amount: 100 });

    // 404 rather than 403: a 403 would confirm the id exists.
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'GOAL_NOT_FOUND');
  });
});

/* ── Split payments ─────────────────────────────────────────────────────── */

describe('split payments', () => {
  test('an even split that does not divide conserves every shilling', async (t) => {
    if (guard(t)) return;
    const alice = await makeUser({}, 1000);
    const [b, c, d] = await Promise.all([makeUser(), makeUser(), makeUser()]);

    const res = await request(app)
      .post('/api/wallet/split')
      .set('Idempotency-Key', idem())
      .set(auth(alice.token))
      .send({ recipients: [b.email, c.email, d.email], amount: 100, description: 'Dinner' });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    const amounts = res.body.data.shares.map((s) => s.amount.amount);
    // 100.00 three ways is 33.34 / 33.33 / 33.33 — never 33.33 × 3.
    assert.deepEqual(amounts.slice().sort(), ['33.33', '33.33', '33.34']);
    assert.equal(res.body.data.total.amount, '100.00');

    const paid = (await Promise.all([b, c, d].map((u) => balanceOf(u.userId)))).reduce(
      (x, y) => x + y,
      0
    );
    assert.equal(paid, 100);
    assert.equal(await balanceOf(alice.userId), 900);
    await assertBooksBalance();
  });

  test('exact shares are honoured as given', async (t) => {
    if (guard(t)) return;
    const alice = await makeUser({}, 1000);
    const [b, c] = await Promise.all([makeUser(), makeUser()]);

    const res = await request(app)
      .post('/api/wallet/split')
      .set('Idempotency-Key', idem())
      .set(auth(alice.token))
      .send({ recipients: [b.email, c.email], shares: [120.5, 79.5] });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.total.amount, '200.00');
    assert.equal(await balanceOf(b.userId), 120.5);
    assert.equal(await balanceOf(c.userId), 79.5);
    assert.equal(await balanceOf(alice.userId), 800);
    await assertBooksBalance();
  });

  test('a split nobody can afford pays nobody — it is one entry or none', async (t) => {
    if (guard(t)) return;
    const alice = await makeUser({}, 100);
    const [b, c] = await Promise.all([makeUser(), makeUser()]);

    const res = await request(app)
      .post('/api/wallet/split')
      .set('Idempotency-Key', idem())
      .set(auth(alice.token))
      .send({ recipients: [b.email, c.email], amount: 900 });

    assert.ok(res.status >= 400, `expected a refusal, got ${res.status}`);
    assert.equal(await balanceOf(b.userId), 0);
    assert.equal(await balanceOf(c.userId), 0);
    assert.equal(await balanceOf(alice.userId), 100);
    assert.equal(await LedgerEntry.countDocuments({ flow: 'transfer.split' }), 0);
    await assertBooksBalance();
  });

  test('the sender cannot be in their own split, and nobody can be in it twice', async (t) => {
    if (guard(t)) return;
    const alice = await makeUser({}, 1000);
    const bob = await makeUser();

    const self = await request(app)
      .post('/api/wallet/split')
      .set('Idempotency-Key', idem())
      .set(auth(alice.token))
      .send({ recipients: [bob.email, alice.email], amount: 100 });
    assert.equal(self.status, 400);
    assert.equal(self.body.code, 'SELF_TRANSFER');

    const dup = await request(app)
      .post('/api/wallet/split')
      .set('Idempotency-Key', idem())
      .set(auth(alice.token))
      .send({ recipients: [bob.email, bob.email], amount: 100 });
    assert.equal(dup.status, 400);
    assert.equal(dup.body.code, 'DUPLICATE_RECIPIENT');

    assert.equal(await balanceOf(alice.userId), 1000);
    await assertBooksBalance();
  });

  test('a split shows up in both sides of the history', async (t) => {
    if (guard(t)) return;
    const alice = await makeUser({}, 1000);
    const [b, c] = await Promise.all([makeUser(), makeUser()]);
    await request(app)
      .post('/api/wallet/split')
      .set('Idempotency-Key', idem())
      .set(auth(alice.token))
      .send({ recipients: [b.email, c.email], amount: 300, description: 'Rent' });

    const mine = await request(app).get('/api/wallet/transactions').set(auth(alice.token));
    const theirs = await request(app).get('/api/wallet/transactions').set(auth(b.token));
    assert.equal(mine.body.data.transactions[0].flow, 'transfer.split');
    assert.equal(mine.body.data.transactions[0].direction, 'debit');
    assert.equal(theirs.body.data.transactions[0].direction, 'credit');
    assert.equal(theirs.body.data.transactions[0].amount, 150);
  });
});

/* ── Refunds ────────────────────────────────────────────────────────────── */

describe('refunds', () => {
  /** Alice pays Bob; returns the entry id. */
  const payment = async (alice, bob, amount = 500) => {
    const res = await request(app)
      .post('/api/wallet/transfer')
      .set('Idempotency-Key', idem())
      .set(auth(alice.token))
      .send({ recipient: bob.email, amount, description: 'Order 91' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data.transaction.id;
  };

  test('the payee can refund in full, and the payer is made whole', async (t) => {
    if (guard(t)) return;
    const alice = await makeUser({}, 1000);
    const bob = await makeUser();
    const entryId = await payment(alice, bob);

    const quote = await request(app)
      .get(`/api/wallet/transactions/${entryId}/refundable`)
      .set(auth(bob.token));
    assert.equal(quote.status, 200, JSON.stringify(quote.body));
    assert.equal(quote.body.data.refundable.amount, '500.00');

    const res = await request(app)
      .post('/api/wallet/refund')
      .set('Idempotency-Key', idem())
      .set(auth(bob.token))
      .send({ entryId, reason: 'out of stock' });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.full, true);
    assert.equal(await balanceOf(alice.userId), 1000);
    assert.equal(await balanceOf(bob.userId), 0);
    await assertBooksBalance();
  });

  test('partial refunds accumulate and cannot together exceed the payment', async (t) => {
    if (guard(t)) return;
    const alice = await makeUser({}, 1000);
    const bob = await makeUser();
    const entryId = await payment(alice, bob, 500);

    const first = await request(app)
      .post('/api/wallet/refund')
      .set('Idempotency-Key', idem())
      .set(auth(bob.token))
      .send({ entryId, amount: 200 });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.data.full, false);
    assert.equal(first.body.data.remainingRefundable.amount, '300.00');

    const tooMuch = await request(app)
      .post('/api/wallet/refund')
      .set('Idempotency-Key', idem())
      .set(auth(bob.token))
      .send({ entryId, amount: 400 });
    assert.equal(tooMuch.status, 400);
    assert.equal(tooMuch.body.code, 'REFUND_EXCEEDS_PAYMENT');

    const rest = await request(app)
      .post('/api/wallet/refund')
      .set('Idempotency-Key', idem())
      .set(auth(bob.token))
      .send({ entryId });
    assert.equal(rest.status, 201, JSON.stringify(rest.body));
    assert.equal(rest.body.data.amount.amount, '300.00');

    const exhausted = await request(app)
      .post('/api/wallet/refund')
      .set('Idempotency-Key', idem())
      .set(auth(bob.token))
      .send({ entryId, amount: 1 });
    assert.equal(exhausted.status, 409);
    assert.equal(exhausted.body.code, 'ALREADY_REFUNDED');

    assert.equal(await balanceOf(alice.userId), 1000);
    assert.equal(await balanceOf(bob.userId), 0);
    await assertBooksBalance();
  });

  test('the payer cannot refund their own payment to themselves', async (t) => {
    if (guard(t)) return;
    const alice = await makeUser({}, 1000);
    const bob = await makeUser();
    const entryId = await payment(alice, bob);

    const res = await request(app)
      .post('/api/wallet/refund')
      .set('Idempotency-Key', idem())
      .set(auth(alice.token))
      .send({ entryId });

    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'NOT_THE_PAYEE');
    assert.equal(await balanceOf(bob.userId), 500);
    await assertBooksBalance();
  });

  test('a stranger to the payment cannot refund it', async (t) => {
    if (guard(t)) return;
    const alice = await makeUser({}, 1000);
    const bob = await makeUser();
    const eve = await makeUser({}, 1000);
    const entryId = await payment(alice, bob);

    const res = await request(app)
      .post('/api/wallet/refund')
      .set('Idempotency-Key', idem())
      .set(auth(eve.token))
      .send({ entryId });

    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'NOT_THE_PAYEE');
    await assertBooksBalance();
  });

  test('one recipient of a split can refund their own share and no more', async (t) => {
    if (guard(t)) return;
    const alice = await makeUser({}, 1000);
    const [b, c] = await Promise.all([makeUser(), makeUser()]);
    const split = await request(app)
      .post('/api/wallet/split')
      .set('Idempotency-Key', idem())
      .set(auth(alice.token))
      .send({ recipients: [b.email, c.email], amount: 400 });
    const entryId = split.body.data.id;

    const tooMuch = await request(app)
      .post('/api/wallet/refund')
      .set('Idempotency-Key', idem())
      .set(auth(b.token))
      .send({ entryId, amount: 300 });
    assert.equal(tooMuch.status, 400);
    assert.equal(tooMuch.body.code, 'REFUND_EXCEEDS_PAYMENT');

    const ok = await request(app)
      .post('/api/wallet/refund')
      .set('Idempotency-Key', idem())
      .set(auth(b.token))
      .send({ entryId });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.data.amount.amount, '200.00');

    assert.equal(await balanceOf(alice.userId), 800);
    assert.equal(await balanceOf(b.userId), 0);
    assert.equal(await balanceOf(c.userId), 200);
    await assertBooksBalance();
  });

  test('a refund is a forward entry, not a reversal of the original', async (t) => {
    if (guard(t)) return;
    const alice = await makeUser({}, 1000);
    const bob = await makeUser();
    const entryId = await payment(alice, bob);
    await request(app).post('/api/wallet/refund').set(auth(bob.token)).set('Idempotency-Key', idem()).send({ entryId });

    // The original stands. Asking "did Alice pay in March?" must still
    // answer yes; a reversal would erase that.
    const original = await LedgerEntry.findOne({ entryId }).lean();
    assert.ok(original);
    assert.equal(original.flow, 'transfer');

    const refundEntry = await LedgerEntry.findOne({ flow: 'refund' }).lean();
    assert.equal(refundEntry.reversalOf, null);
    assert.equal(refundEntry.metadata.refundOf, entryId);
    assert.equal(await LedgerEntry.countDocuments({ reversalOf: entryId }), 0);
  });

  test('a deposit or withdrawal is not refundable through this path', async (t) => {
    if (guard(t)) return;
    const alice = await makeUser({}, 1000);
    const opening = await LedgerEntry.findOne({ flow: 'opening_balance' }).lean();

    const res = await request(app)
      .post('/api/wallet/refund')
      .set('Idempotency-Key', idem())
      .set(auth(alice.token))
      .send({ entryId: opening.entryId });

    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'NOT_REFUNDABLE');
  });
});

/* ── Money requests ─────────────────────────────────────────────────────── */

describe('money requests', () => {
  test('a bill splits between everyone at the table, and only the others are asked', async (t) => {
    if (guard(t)) return;
    const alice = await makeUser({}, 100);
    const [b, c] = await Promise.all([makeUser(), makeUser()]);

    const res = await request(app)
      .post('/api/requests')
      .set(auth(alice.token))
      .send({ participants: [b.email, c.email], total: 1200, note: 'Dinner' });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    // Three people at the table: Alice's own 400 is hers, so 800 is asked for.
    assert.equal(res.body.data.requested.amount, '800.00');
    assert.equal(res.body.data.yourShare.amount, '400.00');
    assert.equal(res.body.data.requests.length, 2);
    assert.deepEqual(
      res.body.data.requests.map((r) => r.amount.amount),
      ['400.00', '400.00']
    );
    // Nothing has moved: a request is a claim, not a payment.
    assert.equal(await balanceOf(alice.userId), 100);
    assert.equal(await LedgerEntry.countDocuments({ flow: 'transfer' }), 0);
  });

  test('approving a request moves the money and marks it paid', async (t) => {
    if (guard(t)) return;
    const alice = await makeUser();
    const bob = await makeUser({}, 1000);

    const created = await request(app)
      .post('/api/requests')
      .set(auth(alice.token))
      .send({ participants: [bob.email], shares: [250] });
    const { requestId } = created.body.data.requests[0];

    const res = await request(app)
      .post(`/api/requests/${requestId}/approve`)
      .set(auth(bob.token));

    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.paid.amount, '250.00');
    assert.equal(await balanceOf(alice.userId), 250);
    assert.equal(await balanceOf(bob.userId), 750);

    const stored = await MoneyRequest.findOne({ requestId }).lean();
    assert.equal(stored.state, 'paid');
    assert.equal(stored.settledEntryId, res.body.data.entryId);
    await assertBooksBalance();
  });

  test('a request cannot be paid twice, however many times it is tapped', async (t) => {
    if (guard(t)) return;
    const alice = await makeUser();
    const bob = await makeUser({}, 1000);
    const created = await request(app)
      .post('/api/requests')
      .set(auth(alice.token))
      .send({ participants: [bob.email], shares: [250] });
    const { requestId } = created.body.data.requests[0];

    // Five simultaneous taps. The settlement key is derived from the request
    // id, so the ledger's unique index is the backstop behind the state
    // machine: exactly one entry, whatever the interleaving.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).post(`/api/requests/${requestId}/approve`).set(auth(bob.token))
      )
    );
    const paid = results.filter((r) => r.status === 201);
    assert.equal(paid.length, 1, `${paid.length} of 5 taps paid`);

    assert.equal(await balanceOf(alice.userId), 250);
    assert.equal(await balanceOf(bob.userId), 750);
    assert.equal(await LedgerEntry.countDocuments({ flow: 'transfer' }), 1);
    await assertBooksBalance();
  });

  test('a failed approval releases the request instead of consuming it', async (t) => {
    if (guard(t)) return;
    const alice = await makeUser();
    const bob = await makeUser({}, 100);
    const created = await request(app)
      .post('/api/requests')
      .set(auth(alice.token))
      .send({ participants: [bob.email], shares: [500] });
    const { requestId } = created.body.data.requests[0];

    const broke = await request(app)
      .post(`/api/requests/${requestId}/approve`)
      .set(auth(bob.token));
    assert.equal(broke.status, 400);
    assert.equal(broke.body.code, 'INSUFFICIENT_FUNDS');

    // Still payable once Bob tops up — a declined payment must not burn the bill.
    const stored = await MoneyRequest.findOne({ requestId }).lean();
    assert.equal(stored.state, 'pending');

    await fund(bob.userId, 500);
    const retry = await request(app)
      .post(`/api/requests/${requestId}/approve`)
      .set(auth(bob.token));
    assert.equal(retry.status, 201, JSON.stringify(retry.body));
    assert.equal(await balanceOf(alice.userId), 500);
    await assertBooksBalance();
  });

  test('the requester cannot approve their own request', async (t) => {
    if (guard(t)) return;
    const alice = await makeUser({}, 1000);
    const bob = await makeUser({}, 1000);
    const created = await request(app)
      .post('/api/requests')
      .set(auth(alice.token))
      .send({ participants: [bob.email], shares: [250] });
    const { requestId } = created.body.data.requests[0];

    const res = await request(app)
      .post(`/api/requests/${requestId}/approve`)
      .set(auth(alice.token));
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'NOT_THE_PAYER');
    assert.equal(await balanceOf(bob.userId), 1000);
  });

  test('declining is a first-class answer, and ends the request', async (t) => {
    if (guard(t)) return;
    const alice = await makeUser();
    const bob = await makeUser({}, 1000);
    const created = await request(app)
      .post('/api/requests')
      .set(auth(alice.token))
      .send({ participants: [bob.email], shares: [250] });
    const { requestId } = created.body.data.requests[0];

    const declined = await request(app)
      .post(`/api/requests/${requestId}/decline`)
      .set(auth(bob.token))
      .send({ reason: 'already settled in cash' });
    assert.equal(declined.status, 200, JSON.stringify(declined.body));

    const after = await request(app)
      .post(`/api/requests/${requestId}/approve`)
      .set(auth(bob.token));
    assert.equal(after.status, 409);
    assert.equal(after.body.code, 'REQUEST_DECLINED');
    assert.equal(await balanceOf(alice.userId), 0);
  });

  test('the requester can cancel a whole bill at once', async (t) => {
    if (guard(t)) return;
    const alice = await makeUser();
    const [b, c] = await Promise.all([makeUser({}, 1000), makeUser({}, 1000)]);
    const created = await request(app)
      .post('/api/requests')
      .set(auth(alice.token))
      .send({ participants: [b.email, c.email], total: 900 });
    const { groupId } = created.body.data;

    const res = await request(app)
      .delete(`/api/requests/group/${groupId}`)
      .set(auth(alice.token));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.cancelled, 2);

    const states = await MoneyRequest.find({ groupId }).lean();
    assert.deepEqual([...new Set(states.map((s) => s.state))], ['cancelled']);
  });

  test('a paid request cannot be cancelled — it has to be refunded', async (t) => {
    if (guard(t)) return;
    const alice = await makeUser();
    const bob = await makeUser({}, 1000);
    const created = await request(app)
      .post('/api/requests')
      .set(auth(alice.token))
      .send({ participants: [bob.email], shares: [250] });
    const { requestId } = created.body.data.requests[0];
    await request(app).post(`/api/requests/${requestId}/approve`).set(auth(bob.token));

    const res = await request(app)
      .delete(`/api/requests/${requestId}`)
      .set(auth(alice.token));
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'ALREADY_PAID');
  });

  test('the list gives each side the two numbers they care about', async (t) => {
    if (guard(t)) return;
    const alice = await makeUser({}, 1000);
    const bob = await makeUser({}, 1000);

    await request(app)
      .post('/api/requests')
      .set(auth(alice.token))
      .send({ participants: [bob.email], shares: [300] });
    await request(app)
      .post('/api/requests')
      .set(auth(bob.token))
      .send({ participants: [alice.email], shares: [120] });

    const mine = await request(app).get('/api/requests').set(auth(alice.token));
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.equal(mine.body.data.owedToYou.amount, '300.00');
    assert.equal(mine.body.data.youOwe.amount, '120.00');
    assert.equal(mine.body.data.incoming[0].role, 'payer');
    assert.equal(mine.body.data.outgoing[0].role, 'requester');
    assert.equal(mine.body.data.outgoing[0].counterparty.email, bob.email);
  });

  test('nobody can be asked twice on one bill, and nobody can ask themselves', async (t) => {
    if (guard(t)) return;
    const alice = await makeUser({}, 1000);
    const bob = await makeUser();

    const self = await request(app)
      .post('/api/requests')
      .set(auth(alice.token))
      .send({ participants: [alice.email], shares: [100] });
    assert.equal(self.status, 400);
    assert.equal(self.body.code, 'SELF_REQUEST');

    const dup = await request(app)
      .post('/api/requests')
      .set(auth(alice.token))
      .send({ participants: [bob.email, bob.email], shares: [100, 100] });
    assert.equal(dup.status, 400);
    assert.equal(dup.body.code, 'DUPLICATE_PARTICIPANT');

    assert.equal(await MoneyRequest.countDocuments({}), 0);
  });
});
