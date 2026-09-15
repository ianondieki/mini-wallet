# Benchmark: what live products do, and what we took from each

This is the reasoning behind the redesign. Each pass below took one class of
product, asked what it does that this wallet could not, and either adopted the
mechanism or recorded why not.

Where a product's internals are public (engineering blogs, API docs, published
tariffs) the claims are drawn from those. Where they are not, the entry
describes the *observable behaviour* and the mechanism that behaviour implies
— which is what we can actually design against.

---

## Pass 1 — Ledger infrastructure
### Modern Treasury · Increase · Stripe Treasury · Monzo

These sell, or run on, a double-entry ledger as the product itself. The
shared, non-negotiable properties:

- Immutable, append-only postings. Corrections are reversing entries.
- Balances derived from postings, never stored as authoritative fields.
- Money in integer minor units.
- Reconciliation as a first-class, scheduled operation.

**Adopted: all four.** This was the largest gap and it drove the whole
redesign. A mutable balance field is not a simpler version of a ledger — it is
a system that cannot answer "how did this number get here?", which is the one
question a payments incident always turns on.

**Taken from Stripe specifically:** the split between a `PaymentIntent`
(operational, may be retried across providers) and balance transactions
(accounting, only records what happened). Our `PaymentOrder` / `LedgerEntry`
split is that idea. The old `Transaction` collection conflated them — a
`pending` row had already moved a balance.

**Also from Stripe:** idempotency keys as a *public contract* with a stated
retention window, and rejecting a key replayed with a different payload rather
than silently returning the first response.

---

## Pass 2 — Multi-currency and FX
### Wise

Wise's substantive mechanisms, in rough order of how much they matter here:

1. **Mid-market rate plus an explicit, separately stated fee.** The margin is
   a line item, not a worse rate.
2. **Local rails at both ends** rather than correspondent banking — money
   enters locally and leaves locally, with the cross-border leg netted
   internally.
3. **Multi-currency balances** as distinct accounts, not a display conversion.

**Adopted 1 and 3.** `fxConvert` balances each currency leg independently
against a treasury FX position and posts the spread to `revenue:fx:spread` in
the destination currency — computed as the difference between what the
customer received and what mid-market would have given them. That is exactly
the number Wise publishes, and the only honest way to report a spread. The
currency registry makes per-currency exponents real, so UGX (0dp) and KES
(2dp) both work.

**2 is structural, not a code change.** Netting requires funded accounts in
both corridors and a treasury function. The ledger now *models* it correctly
(the FX position accounts are where a netted book would live), which is the
prerequisite — but the capability itself is a licensing and balance-sheet
question, not something an adapter provides.

---

## Pass 3 — Routing and reach
### Thunes · Onafriq (MFS Africa) · Flutterwave · Paystack

Aggregators' actual product is not the integrations — it is **choosing between
them**. Same observable behaviour across all four: many rails per corridor,
routed on price and availability, with automatic failover.

**Adopted: least-cost routing with health-aware failover.** `rails/router.js`
quotes every eligible rail in parallel and scores cost, speed and *observed*
reliability under a policy. A provider's claimed success rate loses to our own
measurement.

**Added beyond what aggregators generally expose: the payout retry rule.**
Aggregators fail over freely because they hold the counterparty relationship
and can reconcile a double-send commercially. We cannot. So a payout is
retried only on a *definitively terminal* rejection; a timeout or 502 parks
the order for reconciliation. This is the single most important safety
property in the routing layer.

---

## Pass 4 — Microfinance and banks
### Apache Fineract / Mifos · PesaLink (IPSL) · Plaid / Mono / Stitch

The request was to reach beyond mobile money. Three different shapes:

**SACCOs and MFIs (Fineract).** There is no single counterparty — thousands of
institutions, none of which will build an API for us. But a large share
already run Apache Fineract (directly or via Musoni and other Mifos
distributions), which has one documented REST API. So we integrate with the
*platform*, and onboarding an institution becomes a row of configuration.
This is the highest-leverage integration decision in the whole redesign.

One trap worth naming: the direction inverts. A deposit *into the wallet* is a
`withdrawal` on the member's SACCO savings account. Getting that backwards
moves money the wrong way, silently.

**Banks (PesaLink).** Kenya's instant interbank rail. Above roughly KES 20,000
a flat-band bank rail beats percentage-priced mobile money — which is exactly
the crossover the router exists to find. Adopted with **confirmation of
payee**: resolving an account number to the name the bank holds *before* money
moves. The UK made this mandatory because misdirected payments are the largest
category of irrecoverable consumer loss on push rails, and a push rail has no
chargeback. It degrades to a warning rather than a block when the bank cannot
be reached — an unavailable name check must not stop a payment the customer
already confirmed.

**Open banking (Plaid / Mono / Stitch).** Account information and payment
initiation. **Not built.** The `Rail` interface accommodates it (it is a
`collect` rail over `BANK_ACCOUNT`), but shipping an untested adapter against
an API we hold no credentials for would be scaffolding, not an integration.
Noted as the next adapter, not claimed as a feature.

---

## Pass 5 — Consumer product and economics
### M-Pesa · Chime · Revolut · Nubank

**M-Pesa.** The agent float network and USSD reach are the product, and
neither is software. What *is* copyable is the fee structure: banded, not
percentage, so large transfers are not punitively priced. Our default tariff
caps the withdrawal percentage for the same reason.

**Chime.** No-fee consumer model funded largely by interchange. That requires
card issuing — a different licence and a different balance sheet. **Not
adopted**, but it clarified *where* fees should sit: the tariff makes
in-network transfers and deposits free and prices only what touches an
external provider, because that is where cost is actually incurred.

**Revolut.** In-network instant transfers as the retention mechanism. This is
the `internal` rail, and modelling it as a rail rather than a special case is
why the router picks it automatically when a recipient turns out to be a
customer. The network effect falls out of routing.

**Nubank.** Risk scoring as a core competency rather than a compliance
afterthought, with explainability sufficient to defend a decline. Our engine
is rules-based for that reason: a weighted rule set says precisely which
signals fired and what each contributed, and those rules are the labelled
features a model would later train on.

---

## Where this system now stands

| Capability | M-Pesa | Wise | Stripe | Aggregators | This wallet |
|---|---|---|---|---|---|
| Double-entry ledger | — | ✓ | ✓ | ✓ | ✓ |
| Exact integer money | ✓ | ✓ | ✓ | ✓ | ✓ |
| Multi-currency balances | — | ✓ | ✓ | partial | ✓ |
| Explicit FX spread | — | ✓ | ✓ | — | ✓ |
| Multi-rail routing | — | ✓ | — | ✓ | ✓ |
| Circuit breakers + failover | — | ✓ | ✓ | ✓ | ✓ |
| Idempotency contract | — | ✓ | ✓ | ✓ | ✓ |
| Transactional outbox | ✓ | ✓ | ✓ | ✓ | ✓ |
| Automated reconciliation | ✓ | ✓ | ✓ | ✓ | ✓ |
| KYC tiering | ✓ | ✓ | ✓ | — | ✓ |
| Explainable risk engine | ✓ | ✓ | ✓ | partial | ✓ |
| Confirmation of payee | — | ✓ | — | partial | ✓ (PesaLink) |
| SACCO / MFI reach | — | — | — | partial | ✓ (Fineract) |
| Agent cash network | ✓ | — | — | — | ✗ |
| Card issuing | ✓ | ✓ | ✓ | — | ✗ |
| Lending / credit | ✓ | — | — | — | ✗ |
| Banking licence | ✓ | ✓ | ✓ | varies | ✗ |

---

## What software cannot supply

Worth stating plainly, because the remaining gaps are the expensive ones and
none of them close by writing more code:

- **A licence.** Holding customer funds requires authorisation — in Kenya, a
  CBK Payment Service Provider licence. The tier limits here are shaped on
  published thresholds and are *indicative*; they must be replaced with the
  limits in your own licence.
- **Float.** Payouts settle from money you already hold at the rail. The
  ledger models the float correctly and warns when it goes negative; it cannot
  fund it.
- **Provider contracts.** PesaLink needs IPSL participant credentials; each
  SACCO needs its own. The adapters are written against documented API shapes
  and **have not been run against live credentials** — that is integration
  testing nobody can do from a sandbox.
- **Distribution.** M-Pesa's advantage is the agent network, not the API.
- **A real tariff.** The default fee schedule and the M-Pesa tariff bands are
  defaults. The router compares rails on cost, so a wrong number here quietly
  sends money down the wrong rail.

---

## On the economics

Since the brief was framed around a revenue target, the honest arithmetic:

This wallet earns on payouts (a capped percentage), FX (an explicit spread),
and — if float is ever held at scale — interest on customer balances. It earns
**nothing** on deposits or in-network transfers, by design, because those are
what make the network worth joining.

At the default tariff, a payout yields on the order of tens of shillings. Ten
million shillings of revenue is therefore hundreds of thousands of payouts, or
a large and steady FX book. That is a function of licensed distribution and
time, not of code quality.

What the code determines is different, and narrower: whether the thing is
*trustworthy enough to be allowed to try*. A wallet that cannot reconcile,
cannot explain a decline, double-pays on a timeout, or drifts a cent per
thousand transactions does not get a licence — and if it does, it loses more
to operational error than it earns in fees. That is the problem this redesign
actually solves.
