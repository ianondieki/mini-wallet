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
