# Mini Wallet — multi-rail payments backend

[![CI](https://github.com/ianondieki/mini-wallet/actions/workflows/ci.yml/badge.svg)](https://github.com/ianondieki/mini-wallet/actions/workflows/ci.yml)

A production-shaped fintech API: a **double-entry ledger** as the source of
truth, a **pluggable payment-rail layer** (M-Pesa, bank transfer via PesaLink,
SACCOs and MFIs via Apache Fineract) with **least-cost routing**, KYC tier
limits, an explainable risk engine, and automated reconciliation.

> Real money flows through this. Balances are the sum of immutable journal
> postings — not a mutable field — so money cannot be created or destroyed,
> and every balance can be replayed from the entries that produced it.

**Start here:**
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — how it is built and why.
- [`BENCHMARK.md`](./BENCHMARK.md) — what live products do, what we took, and
  what this system still cannot do.

## Table of contents
1. [Requirements](#requirements)
2. [Setup](#setup)
3. [Security model](#security-model)
4. [API reference](#api-reference)
5. [Error codes](#error-codes)
6. [Project structure](#project-structure)
7. [Testing](#testing)
8. [Migrating an existing deployment](#migrating-an-existing-deployment)

---

## Requirements

- **Node.js 20+**
- **MongoDB as a replica set** (or MongoDB Atlas). Transactions require it.
  Spin up a local single-node replica set:
  ```bash
  mongod --replSet rs0 --dbpath /data/db
  # then once, in mongosh:
  rs.initiate()
  ```
- A **Safaricom Daraja** developer account (sandbox is free):
  https://developer.safaricom.co.ke

## Setup

```bash
cp .env.example .env          # then fill in real values
npm install
npm run dev                   # node --watch, hot reload
# or
npm start
```

Generate strong JWT secrets:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

For local callback testing, expose your machine with a tunnel (e.g. ngrok)
and set `MPESA_CALLBACK_URL` / B2C URLs to the public HTTPS address.

Health check: `GET /health` → `{ "success": true, "status": "ok" }`.

---

## Security model

| Control | Implementation |
|---|---|
| Password hashing | bcrypt, 12 rounds, `select: false` (never serialised) |
| Access token | JWT HS256, 15 min, algorithm pinned (blocks `alg: none`) |
| Refresh token | JWT HS256, 7 d, httpOnly cookie, **hashed** in DB, **rotated** on every refresh, reuse → all sessions revoked |
| Rate limiting | Auth 5/15min·IP · Payments 10/min·user · Global 100/15min·IP |
| Input sanitisation | `express-mongo-sanitize` strips `$` / `.` operators |
| Headers | Helmet incl. CSP, `x-powered-by` disabled |
| CORS | Origin whitelist from `ALLOWED_ORIGINS`, credentials enabled |
| Callbacks | Public but **IP-whitelisted** to Safaricom ranges |
| Idempotency | `Idempotency-Key` header + unique sparse index, 60 s replay window |
| Logging | Winston structured JSON; secrets redacted, phone masked, amounts masked in prod |
| Error shape | Always `{ success: false, message, code }`; stack traces dev-only |

All money movement (transfer, top-up credit, withdrawal debit/reversal)
runs inside `session.withTransaction(...)`. Debits use a **conditional
update** (`{ balance: { $gte: amount } }`) so an overdraft simply fails the
transaction instead of going negative.

---

## API reference

Base URL: `http://localhost:3000`
Authenticated requests send `Authorization: Bearer <accessToken>`.
All responses use `{ success, message?, data?, code?, details? }`.

### Auth

#### `POST /api/auth/register`
```json
{ "name": "Ada Lovelace", "email": "ada@example.com",
  "phone": "0712345678", "password": "Str0ngPass" }
```
**201** — creates the user **and** their wallet atomically, sets the
refresh cookie, returns an access token:
```json
{ "success": true, "message": "Account created",
  "data": { "user": { "id": "…", "name": "Ada Lovelace",
    "email": "ada@example.com", "phone": "254712345678", "role": "user" },
    "accessToken": "eyJ…" } }
```

#### `POST /api/auth/login`
```json
{ "email": "ada@example.com", "password": "Str0ngPass" }
```
**200** — `{ data: { user, accessToken } }`, refresh cookie set.

#### `POST /api/auth/refresh`
No body — uses the httpOnly `refreshToken` cookie. Rotates the token and
returns a new access token. **200** `{ data: { user, accessToken } }`.

#### `POST /api/auth/logout`
Revokes the current refresh token and clears the cookie. **200**.

#### `GET /api/auth/me`  *(auth)*
**200** `{ data: { user } }`.

### Wallet

#### `GET /api/wallet/balance`  *(auth)*
```json
{ "success": true, "data": {
  "balance": 1250.5, "currency": "KES",
  "available": { "minor": 125050, "currency": "KES", "amount": "1250.50" },
  "reserved":  { "minor": 0, "currency": "KES", "amount": "0.00" },
  "total":     { "minor": 125050, "currency": "KES", "amount": "1250.50" }
} }
```
`balance` is the legacy plain number. `reserved` is money committed to a payout
that has not yet settled — still the customer's, but not spendable twice.

#### `GET /api/wallet/limits`  *(auth)*
The customer's KYC tier, the caps that apply, how much headroom is left today
and this month, and the published tariff. Powers "why can't I send this?" and
"what will this cost?" without the client guessing.

#### `POST /api/wallet/quote`  *(auth)*
`{ flow, amount, currency?, instrument? }` → the fee, the total, the rule that
priced it, the arithmetic behind it, and the rail options with their scores.
Moves no money and needs no idempotency key.

#### `POST /api/wallet/transfer`  *(auth, Idempotency-Key required)*
`{ recipientEmail | recipient, amount, currency?, description? }`
`recipient` accepts a phone number as well as an email. Settles instantly —
both sides are our own liabilities, so no rail is involved.

#### `GET /api/wallet/transactions`  *(auth)*
`?page=&limit=&type=topup|transfer|withdrawal&status=&currency=`
In-flight payments are prepended on page 1 rather than hidden until they
settle.

#### `GET /api/wallet/recipients?q=<term>`  *(auth)*
Matches name, email or phone. Minimum 2 characters.

---

### Payments (rail-agnostic)

The customer supplies an **instrument**; the router decides what carries it.

```jsonc
// mobile money
{ "type": "msisdn", "msisdn": "254712345678" }
// bank account
{ "type": "bank_account", "bankCode": "01", "accountNumber": "0123456789" }
// SACCO / MFI member account
{ "type": "member_account", "institutionId": "stima", "accountNumber": "42" }
```

#### `POST /api/payments/deposit`  *(auth, Idempotency-Key)*
`{ amount, currency?, instrument | phone }` → starts a collection.
**Nothing is credited here** — an unapproved prompt is an intention, not
value. The ledger is written when the rail confirms.

#### `POST /api/payments/payout`  *(auth, Idempotency-Key required)*
`{ amount, currency?, instrument | phone }` → reserves the funds, then sends.
Settles or refunds in full when the rail answers.

#### `GET /api/payments/orders/:reference`  *(auth)*
By our order id or the provider's reference. Falls back to querying the rail
when the stored state is not yet terminal, so a lost webhook resolves itself
the moment the customer looks.

#### `GET /api/payments/rails`  *(auth)*
The rails this deployment can route over, with live circuit-breaker health.

---

### M-Pesa  *(compatibility)*

These paths are kept because **Safaricom has the callback URLs registered
against a live short code** — moving them is a coordinated production change,
and until then a payment that lands on a 404 is money taken and not credited.

| Path | Now handled by |
|---|---|
| `POST /api/mpesa/topup` | `payments/deposit` |
| `POST /api/mpesa/withdraw` | `payments/payout` |
| `GET /api/mpesa/status/:checkoutRequestId` | `payments/orders/:reference` |
| `POST /api/mpesa/callback` | generic rail webhook handler |
| `POST /api/mpesa/b2c/result` · `/b2c/timeout` | generic rail webhook handler |

Callbacks are authenticated by the M-Pesa adapter (shared secret + source IP
allowlist, **failing closed in production**). An unverified callback is
acknowledged and dropped rather than rejected, so Safaricom does not retry
forever; reconciliation catches anything genuinely missed.

New integrations should use `/api/payments`.

---

### Ops  *(auth, admin only)*

| Endpoint | Answers |
|---|---|
| `GET /api/ops/reconciliation` | the morning report — every check, one verdict |
| `GET /api/ops/trial-balance` | do the books sum to zero? |
| `GET /api/ops/accounts/:account/verify` | does this cached balance match a journal replay? |
| `GET /api/ops/stuck` | what never reached a terminal state? |
| `GET /api/ops/rails/health` | circuit-breaker state and observed reliability |
| `GET /api/ops/outbox/dead` | events that exhausted their retries |
| `POST /api/ops/rails/:rail/reconcile` | compare a provider statement against our records |

There is deliberately no "fix it" endpoint. The correct response to an
unexplained discrepancy is to look at it.

---

## Deposit flow

The rail is chosen by the router; M-Pesa is shown because it has the most
moving parts. **No ledger entry exists until the money actually arrives.**

```
 Client          Wallet API           Ledger            Rail (M-Pesa)      Phone
   |                 |                   |                    |              |
   | POST /deposit   |                   |                    |              |
   |---------------->|                   |                    |              |
   |                 | limits → risk     |                    |              |
   |                 | PaymentOrder(pending)                  |              |
   |                 |------------------>|                    |              |
   |                 |   router.execute(): quote every rail, pick one        |
   |                 |-------------------------------------->| PIN prompt    |
   |                 |         { providerRef }                |------------->|
   | providerRef     |<--------------------------------------|               |
   |<----------------|                   |                    | enters PIN    |
   |                 |                   |                    |<--------------|
   |                 |          POST /api/mpesa/callback                      |
   |                 |<--------------------------------------|               |
   |                 | verifyCallback → parseCallback → RailEvent            |
   |                 | conditional claim on the order (idempotent)           |
   |                 | post deposit entry ───────────────────>|              |
   |                 |   DR assets:rail:mpesa:float           |              |
   |                 |   CR liabilities:user:<id>:available   |              |
   |                 | + outbox event, same transaction       |              |
   | poll /orders/:r |                   |                    |              |
   |---------------->| succeeded ✓       |                    |              |
   |<----------------|                   |                    |              |
```

Ten retried webhooks credit once: the order's status is flipped by a
conditional update, and only the caller that wins it posts the entry.

---

## Error codes

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `INVALID_PHONE` | Phone not a valid Kenyan MSISDN |
| 400 | `SELF_TRANSFER` | Tried to transfer to your own account |
| 400 | `INSUFFICIENT_FUNDS` | Wallet balance below requested amount |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Money-moving request missing the header |
| 400 | `IDEMPOTENCY_KEY_INVALID` | Header present but malformed |
| 400 | `INVALID_ID` | Malformed Mongo ObjectId |
| 401 | `NO_TOKEN` / `INVALID_TOKEN` / `TOKEN_EXPIRED` | Access-token problems |
| 401 | `INVALID_CREDENTIALS` | Wrong email/password |
| 401 | `NO_REFRESH_TOKEN` / `INVALID_REFRESH_TOKEN` / `REFRESH_TOKEN_REVOKED` | Refresh problems |
| 401 | `USER_INACTIVE` | Account deactivated |
| 401 | `STEP_UP_REQUIRED` | Risk engine wants the customer to confirm |
| 403 | `FORBIDDEN` / `ACCOUNT_DISABLED` | Insufficient permissions |
| 403 | `ACCOUNT_FROZEN` | Under compliance review; can still be inspected |
| 403 | `LIMIT_EXCEEDED` | Over a KYC tier limit (`violations`, `remaining`) |
| 403 | `RISK_BLOCKED` | Refused by the risk engine |
| 202 | `RISK_REVIEW` | Held for an analyst; will complete or be refunded |
| 404 | `RECIPIENT_NOT_FOUND` / `TXN_NOT_FOUND` / `ORDER_NOT_FOUND` | Missing resource |
| 409 | `DUPLICATE_KEY` | Unique constraint (e.g. email/phone in use) |
| 409 | `IDEMPOTENT_REPLAY` | Duplicate request collapsed |
| 409 | `IDEMPOTENCY_IN_PROGRESS` | The first request is still running |
| 409 | `CONCURRENCY_CONFLICT` | Optimistic-lock collision; retry |
| 422 | `VALIDATION_ERROR` | Input failed validation (`details` array) |
| 422 | `IDEMPOTENCY_KEY_REUSED` | Same key, different payload — a client bug |
| 429 | `RATE_LIMIT_*` | Throttled (`AUTH` / `PAYMENT` / `GLOBAL`) |
| 502 | `MPESA_AUTH_FAILED` / `MPESA_REQUEST_FAILED` | Daraja upstream error |
| 502 | `RAIL_REQUEST_FAILED` | Upstream rail error |
| 502 | `PAYOUT_INDETERMINATE` | Rail outcome unknown — parked, never retried |
| 502 | `ALL_RAILS_FAILED` | Every candidate rail refused |
| 503 | `NO_ROUTE` | Nothing can carry this transfer (`rejected` explains why) |
| 500 | `INTERNAL_ERROR` | Unexpected (message masked in production) |

---

## Project structure

Dependencies point **inwards**. `core/` knows nothing about Express, Mongo or
Safaricom — which is why it is fully unit-tested without a database.

```
src/
├── core/                    PURE DOMAIN — no I/O, no framework
│   ├── money/               Money (BigInt minor units) · currency registry
│   ├── ledger/              accounts · JournalEntry · flows (every movement)
│   ├── fees/                FeeSchedule — ordered, first-match-wins tariff
│   ├── limits/              KYC tiers and their caps
│   └── risk/                weighted, explainable rules engine
│
├── rails/                   PROVIDERS — one interface, many implementations
│   ├── Rail.js              the contract every adapter satisfies
│   ├── registry.js          what this deployment has enabled
│   ├── router.js            least-cost routing + safe failover
│   ├── health.js            per-rail circuit breakers
│   └── adapters/            internal · mpesa · pesalink · fineract · simulator
│                            (HttpRail.js — shared REST machinery)
│
├── services/                ORCHESTRATION
│   ├── paymentService.js    limits → affordability → risk → price → route → post
│   ├── ledgerService.js     the ONLY writer to the books
│   ├── reconciliationService.js
│   └── outboxService.js
│
├── models/                  PERSISTENCE
│   ├── LedgerEntry.js       append-only journal
│   ├── AccountBalance.js    materialised view, verifiable against the journal
│   ├── PaymentOrder.js      operational state (separate from accounting)
│   ├── IdempotencyRecord.js · OutboxEvent.js · User.js · RefreshToken.js
│   └── Wallet.js · Transaction.js   DEPRECATED — read by the migration only
│
├── controllers/  wallet · payments · webhook · ops · auth
├── routes/       wallet · payments · mpesa (compat) · ops · auth
├── middleware/   auth · validate · rateLimiter · idempotency · errorHandler
├── app.js        Express app (no listen — testable)
└── server.js     Boot, outbox dispatcher, graceful shutdown

scripts/migrate-to-ledger.js   legacy balances → opening entries
```

---

## Testing

```bash
npm run test:unit          # 124 tests, no database required, ~1s
npm run test:integration    # 29 tests, needs a MongoDB replica set
npm test                    # both
```

The unit suite covers exact money arithmetic (including a fuzz test proving
allocation never loses a minor unit), the ledger balance invariant, every
posting flow, fee bands, KYC limits, risk scoring, routing policies, circuit
breaker transitions and every branch of the payout failover rule. It needs no
infrastructure because `core/` and `rails/` have no I/O.

### The integration tests need a replica set, not a standalone mongod

This trips people up, so it is worth being explicit: the wallet's atomicity
relies on **multi-document transactions**, and standalone MongoDB does not
support them. Pointing the tests at a plain `mongod` fails with

```
Transaction numbers are only allowed on a replica set member or mongos
```

which looks like a bug in the wallet and is not one.

**Easiest — a throwaway replica set in Docker** (port 27018, so it will not
clash with a MongoDB you already run on 27017):

```bash
npm run db:up        # starts it and prints the exact command to run
npm run db:down      # when you are done
```

**Or convert a MongoDB you already have.** Stop it, restart with a replica set
name, and initiate once:

```bash
mongod --replSet rs0 --dbpath /your/data/path
# then, once, in a separate shell:
mongosh --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})'
```

This is a one-time change and is safe for a development machine — a
single-node replica set behaves like a standalone server, plus transactions.

**Then run them:**

```bash
TEST_MONGO_URI='mongodb://127.0.0.1:27018/mini_wallet_test?replicaSet=rs0' \
  REQUIRE_TEST_DB=true npm run test:integration
```

### Skipping is deliberate locally and forbidden in CI

Without a database the integration tests **skip** with an explanatory message
rather than failing, so a contributor without MongoDB still gets a useful unit
run instead of a wall of red.

That leniency is dangerous in automation: a database that failed to start
would produce a green build which tested nothing. Setting `REQUIRE_TEST_DB=true`
turns an unavailable database into a hard failure. CI always sets it — use it
locally too whenever you actually mean to test the money paths.

### CI

`.github/workflows/ci.yml` runs on every push and pull request:

| Job | What it proves |
|---|---|
| `backend-unit` | the domain core is correct, in about a second |
| `backend-integration` | the money paths work against a real replica set |
| `ui` | the frontend tests pass **and** it still compiles |

The integration job starts `mongo:8` with plain `docker run` and initiates a
single-node replica set — no marketplace action, so nothing third-party sits
in the pipeline that verifies money movement.

### Seeing it run with no infrastructure at all

```bash
node demo/server.js          # http://localhost:3000
cd ../mini-wallet-ui && npm run dev
```

Serves the wallet API from the **real domain core** — Money, the ledger, the
fee schedule, KYC limits, the risk engine, the rail router — against an
in-memory list of journal entries instead of MongoDB. Balances are folded from
postings exactly as in production; only the storage is swapped. Sign in with
any email and password.

Useful for seeing the UI without standing up a database and for demonstrating
the ledger to someone who does not read code. Authentication is a stub and
nothing persists — `src/server.js` is the real server.

### Running the whole wallet with no provider credentials

```bash
ENABLE_RAIL_SIMULATOR=true npm run dev
```

Registers a rail with controllable latency and failure rate, so routing,
circuit breakers and failover can be exercised through states a provider
sandbox will not reproduce on demand. It is refused outright when
`NODE_ENV=production` — it would settle payouts that never happened.

---

## Migrating an existing deployment

```bash
npm run migrate:ledger          # dry run — reports, changes nothing
npm run migrate:ledger:commit   # writes opening-balance entries
```

Posts one opening entry per non-zero legacy wallet, offset against
`equity:opening`. Safe to re-run: already-migrated customers are skipped.

It deliberately does **not** convert historical `Transaction` rows — the
opening balance already accounts for every movement they represent, so doing
both would double-count. The old collection stays as a read-only archive.

**Afterwards:** the offsetting leg says "declared as at migration". It does not
assert where the backing money physically is. Reconcile
`assets:rail:mpesa:float` against a real Safaricom statement and post a
correcting entry. Until you do, the books balance but the asset side is
unproven — a clean trial balance here is a starting point, not a clean bill of
health.
