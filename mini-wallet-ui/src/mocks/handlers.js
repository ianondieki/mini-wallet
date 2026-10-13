import { http, HttpResponse } from 'msw';

const API = 'http://localhost:3000';

export const MOCK_USER = {
  id: 'me',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: '254712345678',
  role: 'user',
};

const RECIPIENTS = [
  { id: 'u2', name: 'Grace Hopper', email: 'grace@example.com' },
  { id: 'u3', name: 'Alan Turing', email: 'alan@example.com' },
  { id: 'u4', name: 'Katherine Johnson', email: 'katherine@example.com' },
];

/** Deterministic set of 20 transactions covering every type/status/direction. */
export const MOCK_TRANSACTIONS = Array.from({ length: 20 }).map((_, i) => {
  const types = ['topup', 'transfer', 'transfer', 'withdrawal'];
  const statuses = ['success', 'success', 'success', 'pending', 'failed'];
  const type = types[i % types.length];
  const status = statuses[i % statuses.length];
  const amount = (i + 1) * 250;
  const createdAt = new Date(Date.now() - i * 36e5 * 6).toISOString();

  let direction = 'credit';
  let sender = null;
  let receiver = { name: MOCK_USER.name, email: MOCK_USER.email };
  if (type === 'transfer') {
    if (i % 2 === 0) {
      direction = 'credit';
      sender = { name: 'Grace Hopper', email: 'grace@example.com' };
    } else {
      direction = 'debit';
      sender = { name: MOCK_USER.name, email: MOCK_USER.email };
      receiver = { name: 'Alan Turing', email: 'alan@example.com' };
    }
  } else if (type === 'withdrawal') {
    direction = 'debit';
  }

  return {
    id: `txn_${i + 1}`,
    type,
    status,
    amount,
    direction,
    description:
      type === 'topup' ? 'Wallet top-up' : type === 'withdrawal' ? 'Withdrawal' : `Transfer #${i + 1}`,
    sender,
    receiver,
    phone: type !== 'transfer' ? '254712345678' : undefined,
    mpesaReceiptNumber: status === 'success' && type !== 'transfer' ? `QGR${i}XYZ${i}` : undefined,
    createdAt,
  };
});

const money = (amount, currency = 'KES') => ({
  amount: Number(amount).toFixed(2),
  currency,
  minor: Math.round(Number(amount) * 100),
});

/**
 * Savings goals and money requests live in module state so a test can drive a
 * sequence — contribute, then see the vault grow — rather than only asserting
 * against a frozen fixture.
 */
export const MOCK_GOALS = [];
export const MOCK_REQUESTS = [];
export const resetFeatureState = () => {
  MOCK_GOALS.length = 0;
  MOCK_GOALS.push(
    {
      goalId: 'goal_rent',
      name: 'Rent',
      currency: 'KES',
      saved: money(18000),
      target: money(45000),
      progressBps: 4000,
      remaining: money(27000),
      deadline: null,
      locked: false,
      lockedUntil: null,
      breakPenaltyBps: 0,
      state: 'active',
      createdAt: new Date('2026-01-04').toISOString(),
    },
    {
      goalId: 'goal_emergency',
      name: 'Emergency fund',
      currency: 'KES',
      saved: money(6000),
      target: null,
      progressBps: null,
      remaining: null,
      deadline: null,
      locked: true,
      lockedUntil: new Date(Date.now() + 60 * 86400000).toISOString(),
      breakPenaltyBps: 500,
      state: 'active',
      createdAt: new Date('2026-02-11').toISOString(),
    }
  );
  MOCK_REQUESTS.length = 0;
  MOCK_REQUESTS.push(
    {
      requestId: '11111111-1111-4111-8111-111111111111',
      groupId: 'aaaaaaaa-1111-4111-8111-111111111111',
      role: 'payer',
      amount: money(400),
      note: 'Dinner at Mama Oliech',
      state: 'pending',
      actionable: true,
      counterparty: { id: 'u2', name: 'Grace Hopper', email: 'grace@example.com' },
      expiresAt: new Date(Date.now() + 6 * 86400000).toISOString(),
      settledEntryId: null,
      settledAt: null,
      declineReason: null,
      createdAt: new Date().toISOString(),
    },
    {
      requestId: '22222222-2222-4222-8222-222222222222',
      groupId: 'bbbbbbbb-2222-4222-8222-222222222222',
      role: 'requester',
      amount: money(750),
      note: 'Fuel',
      state: 'pending',
      actionable: true,
      counterparty: { id: 'u3', name: 'Alan Turing', email: 'alan@example.com' },
      expiresAt: new Date(Date.now() + 6 * 86400000).toISOString(),
      settledEntryId: null,
      settledAt: null,
      declineReason: null,
      createdAt: new Date().toISOString(),
    }
  );
};
resetFeatureState();

const ok = (data, message) => HttpResponse.json({ success: true, message, data });
const fail = (status, message, code) =>
  HttpResponse.json({ success: false, message, code }, { status });

/** Status-poll counter — first poll(s) pending, then success. Reset per test. */
let statusPolls = 0;
export const resetMpesaPolls = () => {
  statusPolls = 0;
};

export const handlers = [
  // ── Auth ───────────────────────────────────────────────────────────
  http.post(`${API}/api/auth/refresh`, () =>
    fail(401, 'No refresh token', 'NO_REFRESH_TOKEN')
  ),
  http.get(`${API}/api/auth/me`, () => ok({ user: MOCK_USER })),
  http.post(`${API}/api/auth/login`, async ({ request }) => {
    const body = await request.json();
    if (body.password === 'wrongpass') {
      return fail(401, 'Invalid email or password', 'INVALID_CREDENTIALS');
    }
    return ok({ user: MOCK_USER, accessToken: 'mock-access-token' }, 'Logged in');
  }),
  http.post(`${API}/api/auth/register`, async ({ request }) => {
    const body = await request.json();
    if (body.email === 'taken@example.com') {
      return fail(409, 'A record with this email already exists', 'DUPLICATE_KEY');
    }
    return HttpResponse.json(
      {
        success: true,
        message: 'Account created',
        data: { user: { ...MOCK_USER, name: body.name, email: body.email }, accessToken: 'mock-access-token' },
      },
      { status: 201 }
    );
  }),
  http.post(`${API}/api/auth/logout`, () => ok(null, 'Logged out')),

  // ── Wallet ─────────────────────────────────────────────────────────
  http.get(`${API}/api/wallet/balance`, () => ok({ balance: 12500, currency: 'KES' })),

  http.get(`${API}/api/wallet/recipients`, ({ request }) => {
    const q = new URL(request.url).searchParams.get('q')?.toLowerCase() || '';
    const recipients = RECIPIENTS.filter(
      (r) => r.email.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)
    );
    return ok({ recipients });
  }),

  http.post(`${API}/api/wallet/transfer`, async ({ request }) => {
    const body = await request.json();
    if (body.amount > 12500) {
      return fail(400, 'Insufficient balance', 'INSUFFICIENT_FUNDS');
    }
    return HttpResponse.json(
      {
        success: true,
        message: 'Transfer successful',
        data: {
          transaction: {
            id: 'txn_new',
            amount: body.amount,
            recipient: { name: 'Grace Hopper', email: body.recipientEmail },
            status: 'success',
            createdAt: new Date().toISOString(),
          },
        },
      },
      { status: 201 }
    );
  }),

  http.get(`${API}/api/wallet/transactions`, ({ request }) => {
    const url = new URL(request.url);
    const page = Number(url.searchParams.get('page') || 1);
    const limit = Number(url.searchParams.get('limit') || 10);
    const type = url.searchParams.get('type');
    const status = url.searchParams.get('status');

    let rows = MOCK_TRANSACTIONS;
    if (type) rows = rows.filter((t) => t.type === type);
    if (status) rows = rows.filter((t) => t.status === status);

    const total = rows.length;
    const start = (page - 1) * limit;
    const transactions = rows.slice(start, start + limit);

    return ok({
      transactions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        hasNextPage: start + limit < total,
        hasPrevPage: page > 1,
      },
    });
  }),

  // ── Split payments and refunds ─────────────────────────────────────
  http.post(`${API}/api/wallet/split`, async ({ request }) => {
    const body = await request.json();
    const recipients = body.recipients ?? [];
    if (body.amount > 12500) return fail(400, 'Insufficient balance', 'INSUFFICIENT_FUNDS');
    // Largest-remainder, same as the server, so the preview and the result
    // agree to the shilling.
    const minor = Math.round(Number(body.amount) * 100);
    const base = Math.floor(minor / recipients.length);
    let left = minor - base * recipients.length;
    const shares = recipients.map((email) => {
      const extraUnit = left > 0 ? 1 : 0;
      left -= extraUnit;
      return {
        recipient: { name: email.split('@')[0], email },
        amount: money((base + extraUnit) / 100),
      };
    });
    return HttpResponse.json(
      {
        success: true,
        message: 'Split sent',
        data: {
          id: 'entry_split_1',
          total: money(body.amount),
          fee: money(0),
          charged: money(body.amount),
          shares,
          status: 'succeeded',
          createdAt: new Date().toISOString(),
        },
      },
      { status: 201 }
    );
  }),

  http.get(`${API}/api/wallet/transactions/:entryId/refundable`, ({ params }) => {
    if (String(params.entryId) === 'txn_spent') {
      return ok({
        entryId: params.entryId,
        received: money(500),
        alreadyRefunded: money(500),
        refundable: money(0),
        fullyRefunded: true,
        originalFee: money(0),
        feeReturnedOnFullRefund: false,
        feeRefundWindowHours: 24,
        occurredAt: new Date().toISOString(),
        narrative: 'Transfer',
      });
    }
    return ok({
      entryId: params.entryId,
      received: money(500),
      alreadyRefunded: money(0),
      refundable: money(500),
      fullyRefunded: false,
      originalFee: money(0),
      feeReturnedOnFullRefund: false,
      feeRefundWindowHours: 24,
      occurredAt: new Date().toISOString(),
      narrative: 'Transfer',
    });
  }),

  http.post(`${API}/api/wallet/refund`, async ({ request }) => {
    const body = await request.json();
    const amount = body.amount ?? 500;
    if (amount > 500) {
      return fail(400, 'You can refund at most KES 500.00 of this payment', 'REFUND_EXCEEDS_PAYMENT');
    }
    return HttpResponse.json(
      {
        success: true,
        message: 'Refund sent',
        data: {
          id: 'entry_refund_1',
          refundOf: body.entryId,
          amount: money(amount),
          feeRefund: money(0),
          returned: money(amount),
          full: amount === 500,
          remainingRefundable: money(500 - amount),
          status: 'succeeded',
          createdAt: new Date().toISOString(),
        },
      },
      { status: 201 }
    );
  }),

  // ── Savings ────────────────────────────────────────────────────────
  http.get(`${API}/api/savings/goals`, () =>
    ok({
      currency: 'KES',
      totalSaved: money(MOCK_GOALS.reduce((sum, g) => sum + Number(g.saved.amount), 0)),
      spendable: money(12500),
      goals: MOCK_GOALS,
    })
  ),

  http.post(`${API}/api/savings/goals`, async ({ request }) => {
    const body = await request.json();
    const goal = {
      goalId: `goal_${MOCK_GOALS.length + 1}`,
      name: body.name,
      currency: 'KES',
      saved: money(0),
      target: body.target ? money(body.target) : null,
      progressBps: body.target ? 0 : null,
      remaining: body.target ? money(body.target) : null,
      deadline: body.deadline ?? null,
      locked: Boolean(body.lock?.penaltyBps),
      lockedUntil: body.lock?.until ?? null,
      breakPenaltyBps: body.lock?.penaltyBps ?? 0,
      state: 'active',
      createdAt: new Date().toISOString(),
    };
    MOCK_GOALS.unshift(goal);
    return HttpResponse.json(
      { success: true, message: 'Savings goal created', data: { goal } },
      { status: 201 }
    );
  }),

  http.post(`${API}/api/savings/goals/:goalId/contribute`, async ({ request, params }) => {
    const { amount } = await request.json();
    if (amount > 12500) return fail(400, 'Insufficient balance', 'INSUFFICIENT_FUNDS');
    const goal = MOCK_GOALS.find((g) => g.goalId === params.goalId);
    if (!goal) return fail(404, 'Savings goal not found', 'GOAL_NOT_FOUND');
    goal.saved = money(Number(goal.saved.amount) + Number(amount));
    return HttpResponse.json(
      {
        success: true,
        message: 'Money set aside',
        data: { entryId: 'entry_lock_1', moved: money(amount), goal },
      },
      { status: 201 }
    );
  }),

  http.get(`${API}/api/savings/goals/:goalId/withdrawal-quote`, ({ request, params }) => {
    const amount = Number(new URL(request.url).searchParams.get('amount') || 0);
    const goal = MOCK_GOALS.find((g) => g.goalId === params.goalId);
    if (!goal) return fail(404, 'Savings goal not found', 'GOAL_NOT_FOUND');
    const penalty = goal.locked ? (amount * goal.breakPenaltyBps) / 10_000 : 0;
    return ok({
      amount: money(amount),
      early: goal.locked,
      lockedUntil: goal.lockedUntil,
      penaltyBps: goal.locked ? goal.breakPenaltyBps : 0,
      penalty: money(penalty),
      youReceive: money(amount - penalty),
    });
  }),

  http.post(`${API}/api/savings/goals/:goalId/withdraw`, async ({ request, params }) => {
    const { amount, confirmPenalty } = await request.json();
    const goal = MOCK_GOALS.find((g) => g.goalId === params.goalId);
    if (!goal) return fail(404, 'Savings goal not found', 'GOAL_NOT_FOUND');
    const penalty = goal.locked ? (amount * goal.breakPenaltyBps) / 10_000 : 0;
    if (confirmPenalty !== undefined && Number(confirmPenalty) !== penalty) {
      return fail(409, `The penalty is now KES ${penalty.toFixed(2)}`, 'PENALTY_CHANGED');
    }
    goal.saved = money(Number(goal.saved.amount) - Number(amount));
    return HttpResponse.json(
      {
        success: true,
        message: 'Withdrawn',
        data: {
          entryId: 'entry_release_1',
          released: money(amount),
          penalty: money(penalty),
          received: money(amount - penalty),
          earlyBreak: goal.locked,
          goal,
        },
      },
      { status: 201 }
    );
  }),

  http.delete(`${API}/api/savings/goals/:goalId`, ({ params }) => {
    const index = MOCK_GOALS.findIndex((g) => g.goalId === params.goalId);
    if (index === -1) return fail(404, 'Savings goal not found', 'GOAL_NOT_FOUND');
    if (Number(MOCK_GOALS[index].saved.amount) > 0) {
      return fail(409, 'Withdraw the money in this goal before closing it', 'VAULT_NOT_EMPTY');
    }
    const [goal] = MOCK_GOALS.splice(index, 1);
    return ok({ goal: { ...goal, state: 'closed' } }, 'Savings goal closed');
  }),

  // ── Money requests ─────────────────────────────────────────────────
  http.get(`${API}/api/requests`, () => {
    const live = (role) =>
      MOCK_REQUESTS.filter((r) => r.role === role && r.actionable).reduce(
        (sum, r) => sum + Number(r.amount.amount),
        0
      );
    return ok({
      currency: 'KES',
      youOwe: money(live('payer')),
      owedToYou: money(live('requester')),
      incoming: MOCK_REQUESTS.filter((r) => r.role === 'payer'),
      outgoing: MOCK_REQUESTS.filter((r) => r.role === 'requester'),
    });
  }),

  http.post(`${API}/api/requests`, async ({ request }) => {
    const body = await request.json();
    const participants = body.participants ?? [];
    const heads = participants.length + 1;
    const share = body.shares ? null : Number(body.total) / heads;
    const created = participants.map((email, i) => ({
      requestId: `3333333${i}-3333-4333-8333-333333333333`,
      groupId: 'cccccccc-3333-4333-8333-333333333333',
      role: 'requester',
      amount: money(body.shares ? body.shares[i] : share),
      note: body.note ?? null,
      state: 'pending',
      actionable: true,
      counterparty: { id: `n${i}`, name: email.split('@')[0], email },
      expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      settledEntryId: null,
      settledAt: null,
      declineReason: null,
      createdAt: new Date().toISOString(),
    }));
    MOCK_REQUESTS.push(...created);
    const requested = created.reduce((sum, r) => sum + Number(r.amount.amount), 0);
    return HttpResponse.json(
      {
        success: true,
        message: 'Request sent',
        data: {
          groupId: created[0]?.groupId ?? 'cccccccc-3333-4333-8333-333333333333',
          requested: money(requested),
          yourShare: share ? money(share) : null,
          expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
          requests: created,
        },
      },
      { status: 201 }
    );
  }),

  http.post(`${API}/api/requests/:requestId/approve`, ({ params }) => {
    const found = MOCK_REQUESTS.find((r) => r.requestId === params.requestId);
    if (!found) return fail(404, 'Request not found', 'REQUEST_NOT_FOUND');
    if (found.state === 'paid') {
      return fail(409, 'You have already paid this request', 'ALREADY_PAID');
    }
    found.state = 'paid';
    found.actionable = false;
    found.settledEntryId = 'entry_request_1';
    return HttpResponse.json(
      {
        success: true,
        message: 'Request paid',
        data: {
          requestId: found.requestId,
          paid: found.amount,
          fee: money(0),
          entryId: 'entry_request_1',
          requester: found.counterparty,
          settledAt: new Date().toISOString(),
        },
      },
      { status: 201 }
    );
  }),

  http.post(`${API}/api/requests/:requestId/decline`, async ({ params, request }) => {
    const body = await request.json().catch(() => ({}));
    const found = MOCK_REQUESTS.find((r) => r.requestId === params.requestId);
    if (!found) return fail(404, 'Request not found', 'REQUEST_NOT_FOUND');
    found.state = 'declined';
    found.actionable = false;
    found.declineReason = body?.reason ?? null;
    return ok({ requestId: found.requestId, state: 'declined' }, 'Request declined');
  }),

  http.delete(`${API}/api/requests/group/:groupId`, ({ params }) => {
    const rows = MOCK_REQUESTS.filter((r) => r.groupId === params.groupId && r.state === 'pending');
    rows.forEach((r) => {
      r.state = 'cancelled';
      r.actionable = false;
    });
    return ok({ groupId: params.groupId, cancelled: rows.length }, 'Request cancelled');
  }),

  http.delete(`${API}/api/requests/:requestId`, ({ params }) => {
    const found = MOCK_REQUESTS.find((r) => r.requestId === params.requestId);
    if (!found) return fail(404, 'Request not found', 'REQUEST_NOT_FOUND');
    if (found.state === 'paid') {
      return fail(409, 'This request has been paid. Refund it instead.', 'ALREADY_PAID');
    }
    found.state = 'cancelled';
    found.actionable = false;
    return ok({ requestId: found.requestId, state: 'cancelled' }, 'Request cancelled');
  }),

  // ── M-Pesa ─────────────────────────────────────────────────────────
  http.post(`${API}/api/mpesa/topup`, () =>
    HttpResponse.json(
      {
        success: true,
        message: 'STK push sent',
        data: {
          checkoutRequestId: 'ws_CO_03062026123456789',
          merchantRequestId: 'mr_123',
          customerMessage: 'Success. Request accepted for processing',
        },
      },
      { status: 201 }
    )
  ),

  http.get(`${API}/api/mpesa/status/:id`, () => {
    statusPolls += 1;
    const status = statusPolls >= 2 ? 'success' : 'pending';
    return ok({
      status,
      amount: 1000,
      receipt: status === 'success' ? 'QGR12XYZ' : null,
      source: status === 'success' ? 'db' : 'pending',
    });
  }),

  http.post(`${API}/api/mpesa/withdraw`, async ({ request }) => {
    const { amount } = await request.json();
    if (amount > 12500) return fail(400, 'Insufficient balance', 'INSUFFICIENT_FUNDS');
    return HttpResponse.json(
      {
        success: true,
        message: 'Withdrawal initiated',
        data: {
          transaction: { id: 'wd_1', type: 'withdrawal', status: 'pending', amount },
        },
      },
      { status: 201 }
    );
  }),
];

export default handlers;
