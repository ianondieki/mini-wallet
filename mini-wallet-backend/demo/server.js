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
import {
  userAvailable,
  userReserved,
  userVault,
  feeRevenue,
  signFor,
} from '../src/core/ledger/accounts.js';
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
  'savings.lock': 'Moved into savings',
  'savings.release': 'Taken out of savings',
  opening_balance: 'Opening balance',
};

const LEGACY_TYPE = {
  deposit: 'topup',
  transfer: 'transfer',
  'transfer.split': 'transfer',
  refund: 'transfer',
  'payout.reserve': 'withdrawal',
  'payout.release': 'withdrawal',
  'savings.lock': 'transfer',
  'savings.release': 'transfer',
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
    const rail = routing?.chosen ?? 'mpesa';
    post(flows.reservePayout({ userId: 'me', amount, fee, metadata: { fromUserId: 'me', orderId } }));

    // A real rail answers asynchronously; the demo settles immediately.
    //
    // The internal rail is the case worth getting right: when the number
    // belongs to another customer here, the router picks `internal` and no
    // money leaves the institution. Settling that as an ordinary payout would
    // debit the reservation and credit our own float — the books would
    // balance and the recipient would never be paid. It has to credit them.
    const recipient = [...users.values()].find((u) => u.phone === instrument.msisdn);
    if (rail === 'internal' && recipient && recipient.id !== 'me') {
      post(flows.settleInternalPayout({
        fromUserId: 'me', toUserId: recipient.id, amount, fee,
        metadata: { fromUserId: 'me', toUserId: recipient.id, orderId },
      }));
    } else {
      post(flows.settlePayout({
        userId: 'me', rail, amount, fee,
        metadata: { fromUserId: 'me', orderId, receipt: 'QGDEMOWD01' },
      }));
    }
    res.status(201).json({
      success: true,
      message: 'Withdrawal complete.',
      data: {
        orderId, transactionId: orderId, status: 'success',
        rail,
        amount: Number(amount.toDecimal()),
        fee: Number(fee.toDecimal()),
        currency: CCY,
      },
    });
  } catch (err) {
    fail(res, err.status ?? 500, err.code ?? 'INTERNAL_ERROR', err.message);
  }
});

/* ── Savings vaults ────────────────────────────────────────────────────────
 * The goal document holds no balance here either: `saved` is folded from the
 * vault account's postings, exactly as in production.
 * ──────────────────────────────────────────────────────────────────────── */

const goals = new Map();

const addGoal = ({ name, target, lockDays, penaltyBps = 0 }) => {
  const goal = {
    goalId: randomUUID(),
    userId: 'me',
    name,
    currency: CCY,
    target: target ? KES(target) : null,
    deadline: null,
    lockedUntil: lockDays ? new Date(Date.now() + lockDays * 864e5) : null,
    breakPenaltyBps: lockDays ? penaltyBps : 0,
    state: 'active',
    createdAt: new Date(),
  };
  goals.set(goal.goalId, goal);
  return goal;
};

const goalIsLocked = (goal) =>
  Boolean(goal.lockedUntil && goal.lockedUntil > new Date() && goal.breakPenaltyBps > 0);

const presentGoal = (goal) => {
  const saved = balanceOf(userVault(goal.userId, goal.goalId, CCY));
  return {
    goalId: goal.goalId,
    name: goal.name,
    currency: CCY,
    saved: saved.toJSON(),
    target: goal.target ? goal.target.toJSON() : null,
    progressBps: goal.target?.isPositive
      ? Math.min(10_000, Number((saved.minorBigInt * 10_000n) / goal.target.minorBigInt))
      : null,
    remaining: goal.target
      ? Money.max(goal.target.minus(saved), Money.zero(CCY)).toJSON()
      : null,
    deadline: goal.deadline,
    locked: goalIsLocked(goal),
    lockedUntil: goal.lockedUntil,
    breakPenaltyBps: goal.breakPenaltyBps,
    state: goal.state,
    createdAt: goal.createdAt,
  };
};

/** Load a goal, reporting someone else's as missing rather than forbidden. */
const mustOwnGoal = (res, goalId) => {
  const goal = goals.get(goalId);
  if (!goal || goal.userId !== 'me' || goal.state !== 'active') {
    fail(res, 404, 'GOAL_NOT_FOUND', 'Savings goal not found');
    return null;
  }
  return goal;
};

app.get('/api/savings/goals', requireAuth, (_req, res) => {
  const presented = [...goals.values()]
    .filter((g) => g.state === 'active')
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(presentGoal);
  ok(res, {
    currency: CCY,
    totalSaved: presented
      .reduce((acc, g) => acc.plus(Money.fromJSON(g.saved)), Money.zero(CCY))
      .toJSON(),
    spendable: balanceOf(userAvailable('me', CCY)).toJSON(),
    goals: presented,
  });
});

app.post('/api/savings/goals', requireAuth, (req, res) => {
  const name = String(req.body.name ?? '').trim();
  if (!name) return fail(res, 400, 'INVALID_NAME', 'A goal needs a name');
  const goal = addGoal({
    name,
    target: req.body.target ? String(req.body.target) : null,
    lockDays: req.body.lock?.until
      ? Math.ceil((new Date(req.body.lock.until) - Date.now()) / 864e5)
      : 0,
    penaltyBps: Number(req.body.lock?.penaltyBps ?? 0),
  });
  if (req.body.deadline) goal.deadline = new Date(req.body.deadline);
  res.status(201).json({
    success: true,
    message: 'Savings goal created',
    data: { goal: presentGoal(goal) },
  });
});

app.post('/api/savings/goals/:goalId/contribute', requireAuth, (req, res) => {
  const goal = mustOwnGoal(res, req.params.goalId);
  if (!goal) return undefined;
  try {
    const amount = Money.ofRounded(String(req.body.amount), CCY);
    const entry = post(flows.lockToGoal({
      userId: 'me', goalId: goal.goalId, amount, metadata: { goalName: goal.name },
    }));
    return res.status(201).json({
      success: true,
      message: 'Money set aside',
      data: { entryId: entry.id, moved: amount.toJSON(), goal: presentGoal(goal) },
    });
  } catch (err) {
    return fail(res, err.status ?? 400, err.code ?? 'INVALID_AMOUNT', err.message);
  }
});

app.get('/api/savings/goals/:goalId/withdrawal-quote', requireAuth, (req, res) => {
  const goal = mustOwnGoal(res, req.params.goalId);
  if (!goal) return undefined;
  const amount = Money.ofRounded(String(req.query.amount ?? '0'), CCY);
  const early = goalIsLocked(goal);
  const penalty = early ? amount.basisPoints(goal.breakPenaltyBps) : Money.zero(CCY);
  return ok(res, {
    amount: amount.toJSON(),
    early,
    lockedUntil: goal.lockedUntil,
    penaltyBps: early ? goal.breakPenaltyBps : 0,
    penalty: penalty.toJSON(),
    youReceive: amount.minus(penalty).toJSON(),
  });
});

app.post('/api/savings/goals/:goalId/withdraw', requireAuth, (req, res) => {
  const goal = mustOwnGoal(res, req.params.goalId);
  if (!goal) return undefined;
  try {
    const amount = Money.ofRounded(String(req.body.amount), CCY);
    const early = goalIsLocked(goal);
    const penalty = early ? amount.basisPoints(goal.breakPenaltyBps) : Money.zero(CCY);

    // The customer agreed to a number; if it has since changed, refuse rather
    // than charge a different one.
    if (req.body.confirmPenalty !== undefined && req.body.confirmPenalty !== null) {
      const agreed = Money.ofRounded(String(req.body.confirmPenalty), CCY);
      if (!agreed.equals(penalty)) {
        return fail(
          res, 409, 'PENALTY_CHANGED',
          `The penalty is now ${penalty.format()}, not ${agreed.format()}. Check the quote again.`
        );
      }
    }

    const entry = post(flows.releaseFromGoal({
      userId: 'me', goalId: goal.goalId, amount,
      penalty: penalty.isPositive ? penalty : undefined,
      metadata: { goalName: goal.name, earlyBreak: early },
    }));
    return res.status(201).json({
      success: true,
      message: early ? 'Withdrawn early, penalty applied' : 'Withdrawn',
      data: {
        entryId: entry.id,
        released: amount.toJSON(),
        penalty: penalty.toJSON(),
        received: amount.minus(penalty).toJSON(),
        earlyBreak: early,
        goal: presentGoal(goal),
      },
    });
  } catch (err) {
    return fail(res, err.status ?? 400, err.code ?? 'INVALID_AMOUNT', err.message);
  }
});

app.delete('/api/savings/goals/:goalId', requireAuth, (req, res) => {
  const goal = mustOwnGoal(res, req.params.goalId);
  if (!goal) return undefined;
  const saved = balanceOf(userVault('me', goal.goalId, CCY));
  if (saved.isPositive) {
    return fail(
      res, 409, 'VAULT_NOT_EMPTY',
      `Withdraw the ${saved.format()} in this goal before closing it`
    );
  }
  goal.state = 'closed';
  return ok(res, { goal: presentGoal(goal) }, 'Savings goal closed');
});

/* ── Split payments ────────────────────────────────────────────────────── */

/** Resolve a list of emails or phone numbers to demo users. */
const resolveMany = (identifiers) =>
  identifiers.map((id) => {
    const value = String(id).trim().toLowerCase();
    return [...users.values()].find((u) => u.email.toLowerCase() === value || u.phone === value);
  });

app.post('/api/wallet/split', requireAuth, (req, res) => {
  const identifiers = Array.isArray(req.body.recipients) ? req.body.recipients : [];
  if (identifiers.length < 2) {
    return fail(res, 400, 'SPLIT_TOO_SMALL', 'A split needs at least two recipients');
  }

  const people = resolveMany(identifiers);
  const missing = identifiers.filter((_, i) => !people[i]);
  if (missing.length) {
    return fail(res, 404, 'RECIPIENT_NOT_FOUND', `Not on this wallet: ${missing.join(', ')}`);
  }
  if (people.some((p) => p.id === 'me')) {
    return fail(res, 400, 'SELF_TRANSFER', 'You cannot include yourself in a split');
  }
  if (new Set(people.map((p) => p.id)).size !== people.length) {
    return fail(res, 400, 'DUPLICATE_RECIPIENT', 'Someone appears twice in this split');
  }

  try {
    const exact = Array.isArray(req.body.shares) && req.body.shares.length > 0;
    // Largest-remainder when splitting evenly, so the shares add back up to
    // the total rather than losing or inventing a cent.
    const amounts = exact
      ? req.body.shares.map((s) => Money.ofRounded(String(s), CCY))
      : Money.ofRounded(String(req.body.amount), CCY).split(people.length);
    const total = amounts.reduce((acc, a) => acc.plus(a), Money.zero(CCY));

    const { fee } = defaultFeeSchedule.quote({
      flow: 'transfer', amount: total, tier: req.user.kycTier,
    });

    const entry = post(flows.splitTransfer({
      fromUserId: 'me',
      shares: people.map((person, i) => ({ userId: person.id, amount: amounts[i] })),
      fee,
      metadata: { fromUserId: 'me', description: req.body.description },
    }));

    return res.status(201).json({
      success: true,
      message: 'Split sent',
      data: {
        id: entry.id,
        total: total.toJSON(),
        fee: fee.toJSON(),
        charged: total.plus(fee).toJSON(),
        shares: people.map((person, i) => ({
          recipient: { name: person.name, email: person.email },
          amount: amounts[i].toJSON(),
        })),
        status: 'succeeded',
        createdAt: entry.occurredAt,
      },
    });
  } catch (err) {
    return fail(res, err.status ?? 400, err.code ?? 'INVALID_AMOUNT', err.message);
  }
});

/* ── Refunds ───────────────────────────────────────────────────────────── */

const REFUNDABLE_FLOWS = new Set(['transfer', 'transfer.split']);

/** Sum one account's postings in one direction on an entry. */
const sumPostings = (entry, account, direction) =>
  entry.postings
    .filter((p) => p.account === account && p.direction === direction)
    .reduce((acc, p) => acc.plus(p.amount), Money.zero(CCY));

/**
 * What is still refundable, derived from the ledger rather than tracked: what
 * this payee received on the original, less the principal of every refund
 * already posted against it.
 */
const assessRefund = (res, entryId) => {
  const original = entries.find((e) => e.id === entryId);
  if (!original) {
    fail(res, 404, 'ENTRY_NOT_FOUND', 'Transaction not found');
    return null;
  }
  if (!REFUNDABLE_FLOWS.has(original.flow)) {
    fail(res, 409, 'NOT_REFUNDABLE', 'Only a transfer can be refunded');
    return null;
  }
  const payerId = original.metadata?.fromUserId ?? null;
  if (!payerId || payerId === 'me') {
    fail(res, 403, 'NOT_THE_PAYEE', 'Only the person who received a payment can refund it');
    return null;
  }

  const payeeAccount = userAvailable('me', CCY);
  const received = sumPostings(original, payeeAccount, 'credit');
  if (!received.isPositive) {
    fail(res, 403, 'NOT_THE_PAYEE', 'You did not receive this payment');
    return null;
  }

  const alreadyRefunded = entries
    .filter((e) => e.flow === 'refund' && e.metadata?.refundOf === entryId)
    .reduce((acc, e) => acc.plus(sumPostings(e, payeeAccount, 'debit')), Money.zero(CCY));

  const originalFee = sumPostings(original, feeRevenue('transfer', CCY), 'credit')
    .plus(sumPostings(original, feeRevenue('split', CCY), 'credit'));

  return {
    original,
    payerId,
    received,
    alreadyRefunded,
    refundable: received.minus(alreadyRefunded),
    originalFee,
    feeWindowOpen: Date.now() - new Date(original.occurredAt).getTime() <= 24 * 3600e3,
  };
};

app.get('/api/wallet/transactions/:entryId/refundable', requireAuth, (req, res) => {
  const a = assessRefund(res, req.params.entryId);
  if (!a) return undefined;
  return ok(res, {
    entryId: req.params.entryId,
    received: a.received.toJSON(),
    alreadyRefunded: a.alreadyRefunded.toJSON(),
    refundable: a.refundable.toJSON(),
    fullyRefunded: !a.refundable.isPositive,
    originalFee: a.originalFee.toJSON(),
    feeReturnedOnFullRefund: a.originalFee.isPositive && a.feeWindowOpen,
    feeRefundWindowHours: 24,
    occurredAt: a.original.occurredAt,
    narrative: a.original.narrative,
  });
});

app.post('/api/wallet/refund', requireAuth, (req, res) => {
  const a = assessRefund(res, String(req.body.entryId));
  if (!a) return undefined;
  if (!a.refundable.isPositive) {
    return fail(res, 409, 'ALREADY_REFUNDED', 'This payment has already been refunded in full');
  }

  try {
    const principal = req.body.amount === undefined || req.body.amount === null
      ? a.refundable
      : Money.ofRounded(String(req.body.amount), CCY);
    if (principal.greaterThan(a.refundable)) {
      return fail(
        res, 400, 'REFUND_EXCEEDS_PAYMENT',
        `You can refund at most ${a.refundable.format()} of this payment`
      );
    }

    const isFull = principal.equals(a.refundable) && a.alreadyRefunded.isZero;
    const feeRefund = a.originalFee.isPositive && isFull && a.feeWindowOpen
      ? a.originalFee
      : Money.zero(CCY);

    const entry = post(flows.refund({
      fromUserId: 'me',
      toUserId: a.payerId,
      amount: principal,
      feeRefund: feeRefund.isPositive ? feeRefund : undefined,
      refundOf: a.original.id,
      reason: req.body.reason,
      metadata: { fromUserId: 'me', toUserId: a.payerId, description: req.body.reason },
    }));

    return res.status(201).json({
      success: true,
      message: 'Refund sent',
      data: {
        id: entry.id,
        refundOf: a.original.id,
        amount: principal.toJSON(),
        feeRefund: feeRefund.toJSON(),
        returned: principal.plus(feeRefund).toJSON(),
        full: isFull,
        remainingRefundable: a.refundable.minus(principal).toJSON(),
        status: 'succeeded',
        createdAt: entry.occurredAt,
      },
    });
  } catch (err) {
    return fail(res, err.status ?? 400, err.code ?? 'INVALID_AMOUNT', err.message);
  }
});

/* ── Money requests ────────────────────────────────────────────────────── */

const moneyRequests = new Map();

const presentRequest = (request) => {
  const outgoing = request.fromUserId === 'me';
  const counterpartyId = outgoing ? request.toUserId : request.fromUserId;
  const person = users.get(counterpartyId);
  const expired = request.state === 'pending' && request.expiresAt <= new Date();
  return {
    requestId: request.requestId,
    groupId: request.groupId,
    role: outgoing ? 'requester' : 'payer',
    amount: request.amount.toJSON(),
    note: request.note,
    state: expired ? 'expired' : request.state,
    actionable: !expired && request.state === 'pending',
    counterparty: person
      ? { id: counterpartyId, name: person.name, email: person.email }
      : null,
    expiresAt: request.expiresAt,
    settledEntryId: request.settledEntryId,
    settledAt: request.settledAt,
    declineReason: request.declineReason,
    createdAt: request.createdAt,
  };
};

const addRequest = ({ groupId, fromUserId, toUserId, amount, note }) => {
  const request = {
    requestId: randomUUID(),
    groupId,
    fromUserId,
    toUserId,
    amount,
    note: note ?? null,
    state: 'pending',
    expiresAt: new Date(Date.now() + 7 * 864e5),
    settledEntryId: null,
    settledAt: null,
    declineReason: null,
    createdAt: new Date(),
  };
  moneyRequests.set(request.requestId, request);
  return request;
};

app.get('/api/requests', requireAuth, (_req, res) => {
  const mine = [...moneyRequests.values()].sort((a, b) => b.createdAt - a.createdAt);
  const incoming = mine.filter((r) => r.toUserId === 'me').map(presentRequest);
  const outgoing = mine.filter((r) => r.fromUserId === 'me').map(presentRequest);
  const sum = (rows) =>
    rows
      .filter((r) => r.actionable)
      .reduce((acc, r) => acc.plus(Money.fromJSON(r.amount)), Money.zero(CCY));
  ok(res, {
    currency: CCY,
    youOwe: sum(incoming).toJSON(),
    owedToYou: sum(outgoing).toJSON(),
    incoming,
    outgoing,
  });
});

app.post('/api/requests', requireAuth, (req, res) => {
  const identifiers = Array.isArray(req.body.participants) ? req.body.participants : [];
  if (identifiers.length === 0) {
    return fail(res, 400, 'NO_PARTICIPANTS', 'Name at least one person to ask');
  }
  const people = resolveMany(identifiers);
  const missing = identifiers.filter((_, i) => !people[i]);
  if (missing.length) {
    return fail(res, 404, 'RECIPIENT_NOT_FOUND', `Not on this wallet: ${missing.join(', ')}`);
  }
  if (people.some((p) => p.id === 'me')) {
    return fail(res, 400, 'SELF_REQUEST', 'You cannot ask yourself for money');
  }
  if (new Set(people.map((p) => p.id)).size !== people.length) {
    return fail(res, 400, 'DUPLICATE_PARTICIPANT', 'Someone appears twice on this bill');
  }

  try {
    const exact = Array.isArray(req.body.shares) && req.body.shares.length > 0;
    // Everyone at the table shares the bill, the requester included — so the
    // total divides by one more head than there are people to ask, and the
    // requester's own share is simply never requested.
    const amounts = exact
      ? req.body.shares.map((s) => Money.ofRounded(String(s), CCY))
      : Money.ofRounded(String(req.body.total), CCY).split(people.length + 1).slice(1);

    const groupId = randomUUID();
    const created = people.map((person, i) =>
      addRequest({
        groupId,
        fromUserId: 'me',
        toUserId: person.id,
        amount: amounts[i],
        note: req.body.note?.trim() || null,
      })
    );
    const requested = amounts.reduce((acc, a) => acc.plus(a), Money.zero(CCY));
    const yourShare = exact
      ? null
      : Money.ofRounded(String(req.body.total), CCY).minus(requested);

    return res.status(201).json({
      success: true,
      message: 'Request sent',
      data: {
        groupId,
        requested: requested.toJSON(),
        yourShare: yourShare ? yourShare.toJSON() : null,
        expiresAt: created[0].expiresAt,
        requests: created.map(presentRequest),
      },
    });
  } catch (err) {
    return fail(res, err.status ?? 400, err.code ?? 'INVALID_AMOUNT', err.message);
  }
});

app.post('/api/requests/:requestId/approve', requireAuth, (req, res) => {
  const request = moneyRequests.get(req.params.requestId);
  if (!request) return fail(res, 404, 'REQUEST_NOT_FOUND', 'Request not found');
  if (request.toUserId !== 'me') {
    return fail(res, 403, 'NOT_THE_PAYER', 'You cannot pay a request you created');
  }
  if (request.state === 'paid') {
    return fail(res, 409, 'ALREADY_PAID', 'You have already paid this request');
  }
  if (request.state !== 'pending' || request.expiresAt <= new Date()) {
    return fail(res, 409, 'REQUEST_NOT_ACTIONABLE', `This request is ${request.state}`);
  }

  const { fee } = defaultFeeSchedule.quote({
    flow: 'transfer', amount: request.amount, tier: req.user.kycTier,
  });

  try {
    // Paying a request is an ordinary transfer — same flow, same pricing, same
    // overdraft guard. There is no second, softer path into the books.
    const entry = post(flows.transfer({
      fromUserId: 'me',
      toUserId: request.fromUserId,
      amount: request.amount,
      fee,
      metadata: {
        fromUserId: 'me',
        toUserId: request.fromUserId,
        description: request.note ? `Request: ${request.note}` : 'Money request',
      },
    }));
    request.state = 'paid';
    request.settledEntryId = entry.id;
    request.settledAt = new Date();

    const requester = users.get(request.fromUserId);
    return res.status(201).json({
      success: true,
      message: 'Request paid',
      data: {
        requestId: request.requestId,
        paid: request.amount.toJSON(),
        fee: fee.toJSON(),
        entryId: entry.id,
        requester: { name: requester?.name ?? null, email: requester?.email ?? null },
        settledAt: request.settledAt,
      },
    });
  } catch (err) {
    return fail(res, err.status ?? 400, err.code ?? 'INTERNAL_ERROR', err.message);
  }
});

app.post('/api/requests/:requestId/decline', requireAuth, (req, res) => {
  const request = moneyRequests.get(req.params.requestId);
  if (!request) return fail(res, 404, 'REQUEST_NOT_FOUND', 'Request not found');
  if (request.toUserId !== 'me') {
    return fail(res, 403, 'NOT_THE_PAYER', 'Only the person asked can decline a request');
  }
  if (request.state !== 'pending') {
    return fail(res, 409, 'REQUEST_NOT_ACTIONABLE', `This request is ${request.state}`);
  }
  request.state = 'declined';
  request.declineReason = req.body?.reason?.trim() || null;
  return ok(res, { requestId: request.requestId, state: 'declined' }, 'Request declined');
});

app.delete('/api/requests/group/:groupId', requireAuth, (req, res) => {
  const rows = [...moneyRequests.values()].filter(
    (r) => r.groupId === req.params.groupId && r.fromUserId === 'me' && r.state === 'pending'
  );
  if (rows.length === 0) return fail(res, 404, 'REQUEST_NOT_FOUND', 'No open requests to cancel');
  rows.forEach((r) => {
    r.state = 'cancelled';
  });
  return ok(res, { groupId: req.params.groupId, cancelled: rows.length }, 'Request cancelled');
});

app.delete('/api/requests/:requestId', requireAuth, (req, res) => {
  const request = moneyRequests.get(req.params.requestId);
  if (!request) return fail(res, 404, 'REQUEST_NOT_FOUND', 'Request not found');
  if (request.fromUserId !== 'me') {
    return fail(res, 403, 'NOT_THE_REQUESTER', 'Only the person who asked can cancel a request');
  }
  if (request.state === 'paid') {
    return fail(res, 409, 'ALREADY_PAID', 'This request has been paid. Refund it instead.');
  }
  request.state = 'cancelled';
  return ok(res, { requestId: request.requestId, state: 'cancelled' }, 'Request cancelled');
});

/* The new surfaces the current UI does not use yet */
app.get('/api/payments/rails', requireAuth, (_req, res) => ok(res, { rails: describeAll() }));

app.get('/api/ops/trial-balance', requireAuth, (_req, res) => {
  // Netted per currency, never across them. Adding a KES total to a USD one
  // produces a number in no currency at all, and a wallet that reports it is
  // telling its operator the books balance when it has not checked.
  const byCurrency = new Map();
  for (const [key, amount] of foldBalances(entries)) {
    const [account, currency] = key.split('|');
    const bucket = byCurrency.get(currency) ?? { net: 0n, accounts: [] };
    bucket.net += amount.minorBigInt * BigInt(signFor(account, 'debit'));
    bucket.accounts.push({ account, balance: amount.toJSON() });
    byCurrency.set(currency, bucket);
  }

  const currencies = [...byCurrency.entries()].map(([currency, bucket]) => ({
    currency,
    balanced: bucket.net === 0n,
    net: Money.fromMinor(bucket.net, currency).toJSON(),
    accounts: bucket.accounts,
  }));

  ok(res, {
    balanced: currencies.every((c) => c.balanced),
    currencies,
    // The single-currency shape the existing ops screen reads.
    net: (byCurrency.get(CCY)
      ? Money.fromMinor(byCurrency.get(CCY).net, CCY)
      : Money.zero(CCY)
    ).toJSON(),
    accounts: byCurrency.get(CCY)?.accounts ?? [],
  });
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

/**
 * Seed the newer surfaces too, so the Savings and Split screens have
 * something to show on first load rather than two empty states.
 */
const seedFeatures = () => {
  const rent = addGoal({ name: 'Rent', target: '45000.00' });
  const emergency = addGoal({ name: 'Emergency fund', lockDays: 90, penaltyBps: 500 });
  post(flows.lockToGoal({
    userId: 'me', goalId: rent.goalId, amount: KES('18000.00'),
    metadata: { goalName: rent.name },
  }));
  post(flows.lockToGoal({
    userId: 'me', goalId: emergency.goalId, amount: KES('6000.00'),
    metadata: { goalName: emergency.name },
  }));

  // One bill owed to someone else, one owed to us — so both tabs are live.
  addRequest({
    groupId: randomUUID(), fromUserId: 'u2', toUserId: 'me',
    amount: KES('400.00'), note: 'Dinner at Mama Oliech',
  });
  addRequest({
    groupId: randomUUID(), fromUserId: 'me', toUserId: 'u3',
    amount: KES('750.00'), note: 'Fuel to Naivasha',
  });
};

seedFeatures();

app.listen(PORT, () => {
  const available = balanceOf(userAvailable('me', CCY));
  console.log(`\n  Demo API on http://localhost:${PORT}`);
  console.log(`  Ledger: ${entries.length} journal entries, ${ME.name}'s balance ${available.format()}`);
  console.log(`  Savings: ${goals.size} goals · Requests: ${moneyRequests.size} open`);
  console.log(`  Sign in with any email and password.\n`);
});
