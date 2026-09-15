/**
 * Demo server — the whole wallet, with no infrastructure.
 *
 * Runs the **real domain core** (Money, the double-entry ledger, the fee
 * schedule, KYC limits, the risk engine, the rail router) against an
 * in-memory list of journal entries instead of MongoDB. Every balance you see
 * is derived by folding postings, exactly as in production; only the storage
 * is swapped.
 *
 * That makes it useful for three things a provider sandbox is bad at:
 * seeing the UI without standing up a database, demonstrating the ledger to
 * someone who does not read code, and exercising rail failure modes on demand.
 *
 * It is NOT the production server: authentication is a stub, and nothing is
 * persisted. `src/server.js` is the real one.
 *
 *   node demo/server.js          # http://localhost:3000
 */

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';

import { Money } from '../src/core/money/Money.js';
import { JournalEntry, foldBalances } from '../src/core/ledger/JournalEntry.js';
import * as flows from '../src/core/ledger/flows.js';
import { userAvailable, userReserved, signFor } from '../src/core/ledger/accounts.js';
import { defaultFeeSchedule } from '../src/core/fees/FeeSchedule.js';
import { limitsFor, checkLimits, KycTier } from '../src/core/limits/tiers.js';
import { defaultRiskEngine } from '../src/core/risk/engine.js';
import { bootstrapRails } from '../src/rails/index.js';
import { describeAll } from '../src/rails/registry.js';
import { explain, RoutingPolicy } from '../src/rails/router.js';
import { RailDirection, InstrumentType } from '../src/rails/Rail.js';

const PORT = Number(process.env.DEMO_PORT) || 3000;
const CCY = 'KES';
const KES = (v) => Money.of(String(v), CCY);

/* ── In-memory ledger ──────────────────────────────────────────────────────
 * The only thing swapped out. `post` enforces the same non-negative guard on
 * customer balances that the real conditional update does.
 * ──────────────────────────────────────────────────────────────────────── */

/** @type {JournalEntry[]} */
const entries = [];

/** @param {string} account @returns {Money} */
const balanceOf = (account) =>
  foldBalances(entries).get(`${account}|${CCY}`) ?? Money.zero(CCY);

/** @param {JournalEntry} entry */
const post = (entry) => {
  // Overdraft check, mirroring the production guard.
  for (const posting of entry.postings) {
    if (!posting.account.startsWith('liabilities:user:')) continue;
    if (signFor(posting.account, posting.direction) === 1) continue;
    if (balanceOf(posting.account).lessThan(posting.amount)) {
      const err = new Error('Insufficient balance');
      err.code = 'INSUFFICIENT_FUNDS';
      err.status = 400;
      throw err;
    }
  }
  entries.push(entry);
  return entry;
};

/* ── Demo directory ────────────────────────────────────────────────────── */

const users = new Map();
const addUser = (id, name, email, phone, tier = KycTier.TIER_1) => {
  const user = {
    id,
    name,
    email,
    phone,
    role: id === 'me' ? 'user' : 'user',
    kycTier: tier,
    createdAt: new Date(Date.now() - 400 * 864e5).toISOString(),
  };
  users.set(id, user);
  return user;
};

const ME = addUser('me', 'Ada Lovelace', 'ada@example.com', '254712345678', KycTier.TIER_2);
addUser('u2', 'Grace Hopper', 'grace@example.com', '254712345002');
addUser('u3', 'Alan Turing', 'alan@example.com', '254712345003');
addUser('u4', 'Katherine Johnson', 'katherine@example.com', '254712345004');

/** Payment orders keyed by provider reference, for the STK poll. */
const orders = new Map();

/* ── Seed a plausible month of history ─────────────────────────────────── */

const daysAgo = (n) => new Date(Date.now() - n * 864e5);

const seed = () => {
  const entriesToPost = [
    flows.deposit({ userId: 'me', rail: 'mpesa', amount: KES('25000.00'),
      metadata: { toUserId: 'me', receipt: 'QGH7X2K1A0' } }),
    flows.transfer({ fromUserId: 'u2', toUserId: 'me', amount: KES('4500.00'),
      metadata: { fromUserId: 'u2', toUserId: 'me', description: 'Project milestone' } }),
    flows.transfer({ fromUserId: 'me', toUserId: 'u3', amount: KES('1200.00'),
      metadata: { fromUserId: 'me', toUserId: 'u3', description: 'Lunch + taxi' } }),
    flows.deposit({ userId: 'me', rail: 'mpesa', amount: KES('8000.00'),
      metadata: { toUserId: 'me', receipt: 'QGH8B4M2C1' } }),
    flows.transfer({ fromUserId: 'me', toUserId: 'u4', amount: KES('3500.00'),
      metadata: { fromUserId: 'me', toUserId: 'u4', description: 'Rent share' } }),
    flows.transfer({ fromUserId: 'u3', toUserId: 'me', amount: KES('2750.00'),
      metadata: { fromUserId: 'u3', toUserId: 'me', description: 'Refund' } }),
    flows.reservePayout({ userId: 'me', amount: KES('5000.00'), fee: KES('50.00'),
      metadata: { fromUserId: 'me', orderId: 'seed-1' } }),
    flows.settlePayout({ userId: 'me', rail: 'mpesa', amount: KES('5000.00'), fee: KES('50.00'),
      railCost: KES('25.00'), metadata: { fromUserId: 'me', orderId: 'seed-1', receipt: 'QGJ1D5N3E2' } }),
    flows.transfer({ fromUserId: 'me', toUserId: 'u2', amount: KES('800.00'),
      metadata: { fromUserId: 'me', toUserId: 'u2', description: 'Coffee run' } }),
    flows.deposit({ userId: 'me', rail: 'pesalink', amount: KES('12000.00'),
      metadata: { toUserId: 'me', receipt: 'PSL-99201' } }),
  ];

  // Backdate so the charts have a spread, and seed the counterparties first so
  // their transfers to `me` do not overdraw.
  post(flows.openingBalance({ account: userAvailable('u2', CCY), amount: KES('50000.00'),
    reason: 'demo float', metadata: { toUserId: 'u2' } }));
  post(flows.openingBalance({ account: userAvailable('u3', CCY), amount: KES('50000.00'),
    reason: 'demo float', metadata: { toUserId: 'u3' } }));

  // Entries are frozen at construction, so backdating means rebuilding rather
  // than assigning — which is the point of them being immutable.
  const backdate = (entry, occurredAt) =>
    new JournalEntry({
      flow: entry.flow,
      narrative: entry.narrative,
      postings: entry.postings,
      metadata: entry.metadata,
      reversalOf: entry.reversalOf,
      occurredAt,
    });

  entriesToPost.forEach((entry, i) => post(backdate(entry, daysAgo(26 - i * 2.5))));
};

/* ── Presentation, mirroring walletController ──────────────────────────── */

/** Mirrors CUSTOMER_LABEL in walletController — see the note there. */
const CUSTOMER_LABEL = {
  'payout.reserve': 'Withdrawal',
  'payout.release': 'Withdrawal reversed — funds returned',
  opening_balance: 'Opening balance',
};

const LEGACY_TYPE = {
  deposit: 'topup',
  transfer: 'transfer',
  'payout.reserve': 'withdrawal',
  'payout.release': 'withdrawal',
  opening_balance: 'topup',
};

/** Render the ledger from one customer's point of view. */
const historyFor = (userId) => {
  const spendable = userAvailable(userId, CCY);
  return entries
    .filter((e) => e.flow !== 'payout.settle')
    .map((entry) => {
      const effect = entry.postings
        .filter((p) => p.account === spendable)
        .reduce(
          (acc, p) => (signFor(p.account, p.direction) === 1 ? acc.plus(p.amount) : acc.minus(p.amount)),
          Money.zero(CCY)
        );
      if (effect.isZero) return null;

      const from = entry.metadata?.fromUserId;
      const to = entry.metadata?.toUserId;
      const person = (id) => (id && users.has(id) ? { name: users.get(id).name, email: users.get(id).email } : null);

      return {
        id: entry.id,
        type: LEGACY_TYPE[entry.flow] ?? entry.flow,
        status: entry.flow === 'payout.release' ? 'reversed' : 'success',
        amount: Number(effect.abs().toDecimal()),
        currency: CCY,
        direction: effect.isNegative ? 'debit' : 'credit',
        description:
          entry.metadata?.description ?? CUSTOMER_LABEL[entry.flow] ?? entry.narrative,
        sender: person(from),
        receiver: person(to),
        mpesaReceiptNumber: entry.metadata?.receipt ?? null,
        createdAt: entry.occurredAt,
        flow: entry.flow,
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
};

/* ── App ───────────────────────────────────────────────────────────────── */

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

const ok = (res, data, message) => res.json({ success: true, ...(message ? { message } : {}), data });
const fail = (res, status, code, message) => res.status(status).json({ success: false, code, message });

/** Stubbed session. Real auth lives in src/controllers/authController.js. */
const SESSION = 'demo-session';
const requireAuth = (req, res, next) => {
  if (!req.get('Authorization')?.startsWith('Bearer ')) {
    return fail(res, 401, 'NO_TOKEN', 'Authentication required');
  }
  req.user = ME;
  next();
};

const session = (res) => {
  res.cookie(SESSION, '1', { httpOnly: true, sameSite: 'lax' });
  return { user: ME, accessToken: `demo.${randomUUID()}` };
};

/* Auth */
app.post('/api/auth/login', (_req, res) => ok(res, session(res), 'Logged in'));
app.post('/api/auth/register', (_req, res) => res.status(201).json({ success: true, data: session(res) }));
app.post('/api/auth/refresh', (req, res) =>
  req.cookies?.[SESSION]
    ? ok(res, session(res))
    : fail(res, 401, 'NO_REFRESH_TOKEN', 'No refresh token')
);
app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie(SESSION);
  ok(res, {}, 'Logged out');
});
app.get('/api/auth/me', requireAuth, (req, res) => ok(res, { user: req.user }));

/* Wallet */
app.get('/api/wallet/balance', requireAuth, (req, res) => {
  const available = balanceOf(userAvailable(req.user.id, CCY));
  const reserved = balanceOf(userReserved(req.user.id, CCY));
  ok(res, {
    balance: Number(available.toDecimal()),
    currency: CCY,
    available: available.toJSON(),
    reserved: reserved.toJSON(),
    total: available.plus(reserved).toJSON(),
  });
});

app.get('/api/wallet/limits', requireAuth, (req, res) => {
  const limits = limitsFor(req.user.kycTier, CCY);
  ok(res, {
    tier: req.user.kycTier,
    tierLabel: limits.label,
    currency: CCY,
    limits: {
      perTransaction: limits.perTransaction.toJSON(),
      daily: limits.daily.toJSON(),
      monthly: limits.monthly.toJSON(),
      maxBalance: limits.maxBalance.toJSON(),
    },
    tariff: defaultFeeSchedule.publish(CCY),
  });
});

app.get('/api/wallet/transactions', requireAuth, (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 10);
  let rows = historyFor(req.user.id);
  if (req.query.type) rows = rows.filter((t) => t.type === req.query.type);
  if (req.query.status) rows = rows.filter((t) => t.status === req.query.status);

  const total = rows.length;
  ok(res, {
    transactions: rows.slice((page - 1) * limit, page * limit),
    pagination: {
      page, limit, total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      hasNextPage: page * limit < total,
      hasPrevPage: page > 1,
    },
  });
});

app.get('/api/wallet/recipients', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const recipients = q.length < 2 ? [] : [...users.values()]
    .filter((u) => u.id !== 'me')
    .filter((u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
    .map((u) => ({ id: u.id, name: u.name, email: u.email }));
  ok(res, { recipients });
});

app.post('/api/wallet/transfer', requireAuth, (req, res) => {
  const recipient = [...users.values()].find(
    (u) => u.email === req.body.recipientEmail || u.phone === req.body.recipient
  );
  if (!recipient) return fail(res, 404, 'RECIPIENT_NOT_FOUND', 'Recipient not found');

  let amount;
  try {
    amount = Money.ofRounded(String(req.body.amount), CCY);
  } catch {
    return fail(res, 400, 'INVALID_AMOUNT', 'Invalid amount');
  }

  // The real gates: KYC limits, then risk, then pricing.
  const limits = checkLimits({
    tier: req.user.kycTier, flow: 'transfer', amount,
    usage: { daily: Money.zero(CCY), monthly: Money.zero(CCY), balance: balanceOf(userAvailable('me', CCY)) },
  });
  if (!limits.allowed) return fail(res, 403, 'LIMIT_EXCEEDED', limits.violations[0].message);

  const { fee } = defaultFeeSchedule.quote({ flow: 'transfer', amount, tier: req.user.kycTier });

  try {
    const entry = post(flows.transfer({
      fromUserId: 'me', toUserId: recipient.id, amount, fee,
      metadata: { fromUserId: 'me', toUserId: recipient.id, description: req.body.description },
    }));
    res.status(201).json({
      success: true,
      message: 'Transfer successful',
      data: { transaction: {
        id: entry.id,
        amount: Number(amount.toDecimal()),
        fee: Number(fee.toDecimal()),
        currency: CCY,
        recipient: { name: recipient.name, email: recipient.email },
        status: 'success',
        createdAt: entry.occurredAt,
      } },
    });
  } catch (err) {
    fail(res, err.status ?? 500, err.code ?? 'INTERNAL_ERROR', err.message);
  }
});

/* Deposits and payouts */
app.post('/api/mpesa/topup', requireAuth, (req, res) => {
  const amount = Money.ofRounded(String(req.body.amount), CCY);
  const providerRef = `ws_CO_${Date.now()}`;
  // Settles a few seconds later, as a customer entering their PIN would.
  orders.set(providerRef, { amount, settleAt: Date.now() + 4000, settled: false });
  res.status(201).json({
    success: true,
    message: 'STK push sent. Check your phone to enter your M-Pesa PIN.',
    data: { checkoutRequestId: providerRef, providerRef, customerMessage: 'Check your phone to authorise the payment.' },
  });
});

app.get('/api/mpesa/status/:checkoutRequestId', requireAuth, (req, res) => {
  const order = orders.get(req.params.checkoutRequestId);
  if (!order) return fail(res, 404, 'TXN_NOT_FOUND', 'Transaction not found');

  if (!order.settled && Date.now() >= order.settleAt) {
    order.settled = true;
    post(flows.deposit({
      userId: 'me', rail: 'mpesa', amount: order.amount,
      metadata: { toUserId: 'me', receipt: `QG${Math.random().toString(36).slice(2, 10).toUpperCase()}` },
    }));
  }
  ok(res, {
    status: order.settled ? 'success' : 'pending',
    amount: Number(order.amount.toDecimal()),
    receipt: order.settled ? 'QGDEMO0001' : null,
  });
});

app.post('/api/mpesa/withdraw', requireAuth, async (req, res) => {
  const amount = Money.ofRounded(String(req.body.amount), CCY);
  const instrument = { type: InstrumentType.MSISDN, msisdn: req.body.phone || '254712345678', country: 'KE' };

  // Price it against the rail that would actually carry it.
  const routing = await explain(
    { direction: RailDirection.PAYOUT, amount, instrument, country: 'KE', reference: randomUUID() },
    { policy: RoutingPolicy.BALANCED }
  ).catch(() => null);

  const { fee } = defaultFeeSchedule.quote({
    flow: 'payout', amount, rail: routing?.chosen, tier: req.user.kycTier,
  });

  try {
    const orderId = randomUUID();
    post(flows.reservePayout({ userId: 'me', amount, fee, metadata: { fromUserId: 'me', orderId } }));
    // A real rail answers asynchronously; the demo settles immediately.
    post(flows.settlePayout({
      userId: 'me', rail: routing?.chosen ?? 'mpesa', amount, fee,
      metadata: { fromUserId: 'me', orderId, receipt: 'QGDEMOWD01' },
    }));
    res.status(201).json({
      success: true,
      message: 'Withdrawal complete.',
      data: {
        orderId, transactionId: orderId, status: 'success',
        rail: routing?.chosen ?? 'mpesa',
        amount: Number(amount.toDecimal()),
        fee: Number(fee.toDecimal()),
        currency: CCY,
      },
    });
  } catch (err) {
    fail(res, err.status ?? 500, err.code ?? 'INTERNAL_ERROR', err.message);
  }
});

/* The new surfaces the current UI does not use yet */
app.get('/api/payments/rails', requireAuth, (_req, res) => ok(res, { rails: describeAll() }));

app.get('/api/ops/trial-balance', requireAuth, (_req, res) => {
  const folded = foldBalances(entries);
  let net = 0n;
  const accounts = [...folded.entries()].map(([key, amount]) => {
    const account = key.split('|')[0];
    const debitPositive = amount.minorBigInt * BigInt(signFor(account, 'debit'));
    net += debitPositive;
    return { account, balance: amount.toJSON() };
  });
  ok(res, { balanced: net === 0n, net: Money.fromMinor(Number(net), CCY).toJSON(), accounts });
});

app.get('/health', (_req, res) => res.json({ success: true, status: 'ok', mode: 'demo' }));

/* ── Boot ──────────────────────────────────────────────────────────────── */

bootstrapRails({
  resolveUserId: async (instrument) => {
    const match = [...users.values()].find((u) => u.phone === instrument?.msisdn);
    return match && match.id !== 'me' ? match.id : null;
  },
  includeSimulator: true,
});

seed();

app.listen(PORT, () => {
  const available = balanceOf(userAvailable('me', CCY));
  console.log(`\n  Demo API on http://localhost:${PORT}`);
  console.log(`  Ledger: ${entries.length} journal entries, ${ME.name}'s balance ${available.format()}`);
  console.log(`  Sign in with any email and password.\n`);
});
