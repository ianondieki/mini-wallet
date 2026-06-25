# Mini Wallet & M-Pesa Payment Backend

A production-grade fintech API: JWT auth with refresh-token rotation, an
atomic wallet (peer-to-peer transfers), and full Safaricom **Daraja**
integration — **STK Push** (top-up) and **B2C** (withdrawal) — built on
Node.js 20+ (ESM), Express, and MongoDB.

> Real money flows through this. Transfers and credits run inside MongoDB
> multi-document transactions with conditional, race-safe balance updates,
> so overdraft and double-spend are structurally impossible.

---

## Table of contents
1. [Requirements](#requirements)
2. [Setup](#setup)
3. [Security model](#security-model)
4. [API reference](#api-reference)
5. [STK Push flow](#stk-push-flow)
6. [Error codes](#error-codes)
7. [Project structure](#project-structure)

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
{ "success": true, "data": { "balance": 12500, "currency": "KES" } }
```

#### `POST /api/wallet/transfer`  *(auth, Idempotency-Key required)*
Headers: `Idempotency-Key: <uuid>`
```json
{ "recipientEmail": "grace@example.com", "amount": 500,
  "description": "Lunch" }
```
**201** on success. Rejects self-transfer (`SELF_TRANSFER`), insufficient
funds (`INSUFFICIENT_FUNDS`), unknown recipient (`RECIPIENT_NOT_FOUND`),
and duplicate keys (`IDEMPOTENT_REPLAY`).

#### `GET /api/wallet/transactions`  *(auth)*
Query: `page`, `limit`, `type` (`topup|transfer|withdrawal`),
`status` (`pending|success|failed|reversed`).
```json
{ "success": true, "data": {
  "transactions": [ { "id": "…", "type": "transfer", "status": "success",
    "amount": 500, "direction": "debit",
    "sender": { "name": "Ada", "email": "ada@example.com" },
    "receiver": { "name": "Grace", "email": "grace@example.com" },
    "createdAt": "…" } ],
  "pagination": { "page": 1, "limit": 10, "total": 1, "totalPages": 1,
    "hasNextPage": false, "hasPrevPage": false } } }
```
`direction` is `credit`/`debit` from the **requesting user's** perspective.

#### `GET /api/wallet/recipients?q=<term>`  *(auth)*
Search users by name/email to pick a transfer recipient (min 2 chars).

### M-Pesa

#### `POST /api/mpesa/topup`  *(auth)*
```json
{ "amount": 1000, "phone": "0712345678" }
```
Records a `pending` transaction, fires the STK Push, returns:
```json
{ "success": true, "data": { "checkoutRequestId": "ws_CO_…",
  "merchantRequestId": "…", "customerMessage": "…" } }
```
Amount must be an integer 10–150000.

#### `POST /api/mpesa/callback`  *(public, IP-whitelisted)*
Safaricom posts the STK result here. Success credits the wallet **once**
(idempotent on the `pending → success` flip). Always replies
`{ "ResultCode": 0, "ResultDesc": "Accepted" }`.

#### `GET /api/mpesa/status/:checkoutRequestId`  *(auth)*
Returns a unified status, trusting the DB once settled and otherwise
querying Daraja:
```json
{ "success": true, "data": { "status": "pending|success|failed",
  "amount": 1000, "receipt": "ABC123", "source": "db|daraja|pending" } }
```

#### `POST /api/mpesa/withdraw`  *(auth, Idempotency-Key required)*
```json
{ "amount": 500, "phone": "0712345678" }
```
Debits the wallet first (race-safe), records a `pending` withdrawal, then
fires B2C (`CommandID: BusinessPayment`). If the B2C request fails, the
debit is reversed immediately.

#### `POST /api/mpesa/b2c/result` · `POST /api/mpesa/b2c/timeout`  *(public, IP-whitelisted)*
B2C async callbacks. `result` confirms (success) or reverses (failure);
`timeout` reverses. Both always reply `ResultCode: 0`.

---

## STK Push flow

```
 Client (UI)        Wallet API            MongoDB           Safaricom Daraja      User's Phone
     |                  |                    |                     |                   |
     |  POST /topup     |                    |                     |                   |
     |----------------->|                    |                     |                   |
     |                  | create txn(pending)|                     |                   |
     |                  |------------------->|                     |                   |
     |                  |   getAccessToken (cached, auto-refresh)  |                   |
     |                  |---------------------------------------->|                    |
     |                  |        STK Push (processrequest)         |                   |
     |                  |---------------------------------------->|  PIN prompt        |
     |                  |    { CheckoutRequestID }                 |------------------>|
     |  checkoutReqId   |<----------------------------------------|                    |
     |<-----------------|                    |                     |    enters PIN      |
     |                  |                    |                     |<------------------ |
     |  poll /status    |                    |                     |                   |
     |----------------->| read txn           |                     |                   |
     |   pending        |<-------------------|                     |                   |
     |<-----------------|                    |   POST /callback (ResultCode 0)          |
     |                  |<----------------------------------------|                    |
     |                  | txn pending->success (atomic, once)      |                   |
     |                  | credit wallet      |                     |                   |
     |                  |------------------->|                     |                   |
     |  poll /status    |                    |                     |                   |
     |----------------->| read txn           |                     |                   |
     |   success ✓      |<-------------------|                     |                   |
     |<-----------------|                    |                     |                   |
```

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
| 403 | `FORBIDDEN` / `ACCOUNT_DISABLED` | Insufficient permissions |
| 404 | `WALLET_NOT_FOUND` / `RECIPIENT_NOT_FOUND` / `TXN_NOT_FOUND` / `NOT_FOUND` | Missing resource |
| 409 | `DUPLICATE_KEY` | Unique constraint (e.g. email/phone in use) |
| 409 | `IDEMPOTENT_REPLAY` / `IDEMPOTENCY_KEY_REUSED` | Duplicate request |
| 409 | `CONCURRENCY_CONFLICT` | Optimistic-lock collision; retry |
| 422 | `VALIDATION_ERROR` | Input failed validation (`details` array) |
| 429 | `RATE_LIMIT_*` | Throttled (`AUTH` / `PAYMENT` / `GLOBAL`) |
| 502 | `MPESA_AUTH_FAILED` / `MPESA_REQUEST_FAILED` | Daraja upstream error |
| 500 | `INTERNAL_ERROR` | Unexpected (message masked in production) |

---

## Project structure

```
src/
├── config/      db.js · logger.js · mpesa.js
├── controllers/ authController.js · walletController.js · mpesaController.js
├── middleware/  auth.js · validate.js · rateLimiter.js · idempotency.js · errorHandler.js
├── models/      User.js · Wallet.js · Transaction.js · RefreshToken.js
├── routes/      auth.js · wallet.js · mpesa.js
├── utils/       ApiError.js · asyncHandler.js · mpesaHelpers.js · paginate.js
├── validators/  authValidators.js · walletValidators.js · mpesaValidators.js
├── app.js       Express app (no listen — testable)
└── server.js    Boot + graceful shutdown
```
