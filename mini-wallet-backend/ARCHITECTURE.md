# Architecture

## The one change everything else follows from

The original wallet kept `Wallet.balance` as a mutable `Number` and
`Transaction` as a separate log. Nothing connected them. If a credit applied
but its log row failed to write — or the reverse — the two drifted
permanently, and there was no mechanism that could *detect* it, let alone
explain it. Fees or FX would have introduced fractions a JS `Number` cannot
hold exactly.

So the balance field is gone. **The postings are the truth.**

```
balance(account) = Σ signed postings to that account
```

A cached balance still exists, because summing a customer's whole history on
every request does not scale — but it is a *materialised view* that
`reconciliation.checkBalanceIntegrity()` replays and compares. Drift becomes a
detectable, alertable event instead of a silent loss.

Everything downstream is a consequence: money cannot be created or destroyed,
because every entry must balance to zero; corrections are reversing entries,
so history stays truthful; and "why is my balance this?" has an exact,
replayable answer.

---

## Layers

Dependencies point **inwards only**. The core knows nothing about Express,
Mongo, or Safaricom.

```
┌──────────────────────────────────────────────────────────────┐
│ routes/ · controllers/        HTTP. Parse, call one service,  │
│                               render. No business rules.      │
├──────────────────────────────────────────────────────────────┤
│ services/                     Orchestration. The order of     │
│  paymentService               operations lives here.          │
│  ledgerService                                                │
│  reconciliationService                                        │
│  outboxService                                                │
├──────────────────────────────────────────────────────────────┤
│ rails/                        Providers. One interface, many  │
│  Rail.js  router.js           implementations, chosen at      │
│  adapters/                    runtime by cost/speed/health.   │
├──────────────────────────────────────────────────────────────┤
│ core/                         Pure domain. No I/O. No Mongo.  │
│  money/   ledger/             Fully unit-testable without a   │
│  fees/    limits/   risk/     database — and it is.           │
└──────────────────────────────────────────────────────────────┘
```

The practical payoff: **124 unit tests run in under a second with no
database**, because the rules that are hardest to get right — exact money
arithmetic, the balance invariant, fee bands, tier limits, risk scoring, rail
routing — live in `core/` and `rails/`, which have no I/O to mock.

---

## `core/money` — exact arithmetic

Value is held in **integer minor units as a BigInt**. `0.1 + 0.2 === 0.3`.

BigInt rather than a safe-integer `Number` specifically because of FX:
converting KES 1,000,000 at a rate scaled to 8 decimal places computes
`100_000_000n * 100_000_000n ≈ 1e16`, past `Number.MAX_SAFE_INTEGER`
(≈9.007e15). With `Number` that intermediate silently loses precision.

`allocate()` distributes a remainder by largest fractional shortfall, so
`sum(allocate(weights)) === total` **always** — verified by a fuzz test.
Splitting 1.00 three ways gives 0.34 + 0.33 + 0.33, never 0.99.

Fees are declared in **basis points** (integers), so "1.5%" is `150` and never
a float.

## `core/ledger` — the balance invariant

A `JournalEntry` refuses to exist unless debits equal credits **in every
currency it touches**. Entries are frozen at construction and append-only in
storage — the model itself rejects `updateOne`/`deleteOne`.

Sign conventions matter and are easy to get backwards:

| Account | Type | Increases on |
|---|---|---|
| `liabilities:user:<id>:available` | liability | credit |
| `liabilities:user:<id>:reserved` | liability | credit |
| `assets:rail:<rail>:float` | asset | debit |
| `revenue:fees:<product>` | revenue | credit |
| `expenses:rail:<rail>` | expense | debit |

A customer balance is a **liability**: their money is not ours, we owe it to
them. That is what makes the balance sheet mean anything, and it is how Wise,
Monzo and Stripe Treasury model stored value.

`core/ledger/flows.js` is the complete vocabulary of permitted movements.
Nothing else assembles postings by hand.

### The payout lifecycle is two-phase

The most important behavioural change in the redesign:

```
reserve  →  available −(amount+fee),  reserved +(amount+fee)
              ├── rail confirms → settle:  reserved −, rail float −, fee → revenue
              └── rail rejects  → release: reserved −, available +   (full refund)
```

The old code debited outright and relied on a compensating write if the rail
rejected the request. If that write was lost, the customer was simply short.
Now the money is visibly still theirs until it demonstrably leaves.

## `rails/` — providers as interchangeable candidates

M-Pesa used to be wired into the controllers: `stkPush` built a Daraja payload
inline, and "paying out" *was* B2C. Adding a bank meant duplicating the
controller.

A rail is anything that moves value: `quote`, `collect`, `payout`, `status`,
`parseCallback`, `verifyCallback`. `verifyCallback` **defaults to deny** — a
rail that has not thought about webhook authentication cannot credit wallets.

| Rail | Direction | Reaches | Settles |
|---|---|---|---|
| `internal` | out | another wallet here | instant, free |
| `mpesa` | in & out | Kenyan mobile money | instant |
| `pesalink` | out | any Kenyan bank account | instant |
| `sacco:<id>` | in & out | SACCO/MFI member accounts (Fineract) | same day |
| `simulator` | in & out | nothing (dev/test only) | instant |

**The internal rail is the product insight.** When a recipient turns out to be
a customer, the router sees a free instant option next to the M-Pesa quote and
takes it — the network effect falls out of routing rather than needing a rule.
It is why in-network transfers can be free while payouts cannot.

**Fineract is the reach insight.** "Integrate with microfinance" has no single
counterparty — there are thousands of SACCOs and none will build an API for
us. But many already run Apache Fineract, which has one documented REST API.
Integrating with the *platform* turns a thousand integrations into one adapter
plus a row of config per institution.

### Smart routing

Every eligible rail is quoted in parallel and scored on cost, speed and
*observed* reliability under a policy (`CHEAPEST`, `FASTEST`, `MOST_RELIABLE`,
`BALANCED`). A provider's claimed success rate loses to our measurement.

Per-rail circuit breakers take a failing provider out of rotation and probe it
back in after a cooldown.

### Failover has a hard safety rule

Retrying a **collection** is harmless — worst case the customer is asked twice
and pays once. Retrying a **payout** is not: if the first rail actually sent
the money and merely failed to tell us, a retry pays twice, unrecoverably.

> A payout may be retried **only** on a definitively terminal failure. A
> timeout, a 502 or any `UNKNOWN` means we do not know whether value moved, so
> it is parked for reconciliation rather than sent again.

Losing a few seconds is recoverable. Double-paying is not.

## `core/limits` and `core/risk`

Four KYC tiers with per-transaction, rolling-24h, rolling-30d and
balance-at-rest caps. Tiering is what lets onboarding be instant at low value
and ask for more only when usage requires it. An unknown tier **fails closed**
to the most restrictive limits; an unconfigured currency is refused rather
than treated as unlimited.

Risk is a weighted rules engine over the *shape* of a transaction against
history — pass-through mule patterns, structuring just under a reporting
threshold, fan-in collection accounts, velocity, dormant reactivation.

Rules rather than a model because **every decline must be explainable** to the
customer, the regulator and the analyst. The rules also double as the labelled
features a model would eventually train on.

Ambiguous cases resolve to a **step-up challenge**, not a refusal: a false
positive on someone paying rent costs more than most false negatives. A
verified customer gets friction where an unverified one gets held — that is
where the KYC evidence is meant to be spent.

### Order of operations, and why

```
1. Limits        cheap, deterministic, a regulatory hard stop
2. Affordability cheap — don't challenge someone for a doomed transaction
3. Risk          needs history; can only add friction, never grant permission
4. Price         quoted before anything moves
5. Route         only for money leaving the network
6. Post          ledger entry + outbox event, one transaction
```

## Reliability

**Idempotency** is a first-class store, not inferred from transactions. Claim
the key via a unique index; replay the stored response on a duplicate; reject
a key reused with a *different* payload rather than hiding the client bug.
Completed responses are kept for 4xx (deterministic) and released for 5xx
(may be transient, must stay retryable).

**The outbox** writes the intent to deliver *inside the same transaction as
the ledger entry*, so it commits or rolls back with the money exactly. A
dispatcher delivers with exponential backoff and a dead-letter state.
At-least-once, no broker, no two-phase commit — so consumers must be
idempotent, and every event carries a stable `eventId`.

**Reconciliation** asks the four questions the old design could not pose:

1. Do the books balance? (trial balance must be zero)
2. Do cached balances match a full journal replay?
3. Is anything stuck in flight?
4. Does the provider's statement agree with us?

Statement comparison distinguishes **missing** (they settled it, we never
credited anyone — a customer is short) from **phantom** (we credited money
that never arrived — we are short). Opposite problems, opposite remedies.

Findings are reported, never auto-corrected. Silently fixing an unexplained
discrepancy is how a small bug becomes a large one.

---

## Concurrency

Overdraft is a **conditional decrement**, not read-then-write:

```js
updateOne({ account, currency, minor: { $gte: -delta } }, { $inc: { minor: delta } })
```

Two concurrent withdrawals of the last shilling cannot both match. The second
fails cleanly. This requires MongoDB as a **replica set** — multi-document
transactions do.

---

## Request flow: a withdrawal

```
POST /api/payments/payout
  │
  ├─ idempotency()          claim the key, or replay the stored response
  ├─ validate               present and plausible (not: affordable)
  │
  └─ paymentService.initiatePayout
       ├─ gate()            limits → affordability → risk
       ├─ router.explain()  price against the rail that will carry it
       ├─ ledger.post(reservePayout)   ─┐ one transaction
       │  + PaymentOrder.create         ─┘
       ├─ router.execute()  send; fail over only on a definite rejection
       └─ on terminal event → settle or release

POST /api/mpesa/callback  (later)
  └─ rail.verifyCallback → rail.parseCallback → handleRailEvent
       └─ conditional claim on the order, then ledger.post(settle|release)
```

Ten retried webhooks settle once, because the claim is a conditional update
and only its winner posts the entry.

---

## What is deliberately not here

- **No auto-correction** of ledger discrepancies.
- **No balance mutation** outside `ledgerService.post`.
- **No provider vocabulary** above the adapter layer.
- **No business rules in controllers.**
- **No simulator in production** — it would settle payouts that never happened.

---

## Migration

`npm run migrate:ledger` (dry run) → `npm run migrate:ledger:commit`.

Posts one opening-balance entry per non-zero legacy wallet. It deliberately
does **not** convert historical `Transaction` rows — the opening balance
already accounts for every movement they represent, and doing both would
double-count.

The offsetting leg is `equity:opening`, which says "declared as at migration".
It does **not** assert where the backing money physically is. After running
it, reconcile `assets:rail:mpesa:float` against a real Safaricom statement and
post a correcting entry. Until then the asset side is declared, not proven —
so a clean trial balance here is a starting point, not a clean bill of health.
