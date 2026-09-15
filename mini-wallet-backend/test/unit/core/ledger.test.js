import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Money } from '../../../src/core/money/Money.js';
import {
  JournalEntry,
  debit,
  credit,
  foldBalances,
} from '../../../src/core/ledger/JournalEntry.js';
import {
  parseAccount,
  signFor,
  userAvailable,
  userReserved,
  railFloat,
  feeRevenue,
  AccountType,
  Direction,
} from '../../../src/core/ledger/accounts.js';
import * as flows from '../../../src/core/ledger/flows.js';

const KES = (v) => Money.of(v, 'KES');
const USD = (v) => Money.of(v, 'USD');
const ALICE = 'alice1';
const BOB = 'bob2';

describe('chart of accounts', () => {
  test('resolves type and normal balance from the root segment', () => {
    assert.equal(parseAccount(userAvailable(ALICE, 'KES')).type, AccountType.LIABILITY);
    assert.equal(parseAccount(railFloat('mpesa', 'KES')).type, AccountType.ASSET);
    assert.equal(parseAccount(feeRevenue('transfer', 'KES')).type, AccountType.REVENUE);
  });

  test('a customer balance is a liability — credits increase it', () => {
    assert.equal(signFor(userAvailable(ALICE, 'KES'), Direction.CREDIT), 1);
    assert.equal(signFor(userAvailable(ALICE, 'KES'), Direction.DEBIT), -1);
  });

  test('our float at a rail is an asset — debits increase it', () => {
    assert.equal(signFor(railFloat('mpesa', 'KES'), Direction.DEBIT), 1);
    assert.equal(signFor(railFloat('mpesa', 'KES'), Direction.CREDIT), -1);
  });

  test('rejects malformed or unrooted account paths', () => {
    assert.throws(() => parseAccount('nonsense:user:1'), /Unknown account root/);
    assert.throws(() => parseAccount('assets'), /at least one segment/);
    assert.throws(() => parseAccount(''), /non-empty/);
  });
});

describe('JournalEntry — the balance invariant', () => {
  test('accepts a balanced entry', () => {
    const entry = new JournalEntry({
      flow: 'test',
      postings: [
        debit(railFloat('mpesa', 'KES'), KES('100.00')),
        credit(userAvailable(ALICE, 'KES'), KES('100.00')),
      ],
    });
    assert.equal(entry.postings.length, 2);
    assert.deepEqual(entry.currencies, ['KES']);
  });

  test('refuses an entry where debits do not equal credits', () => {
    assert.throws(
      () =>
        new JournalEntry({
          flow: 'test',
          postings: [
            debit(railFloat('mpesa', 'KES'), KES('100.00')),
            credit(userAvailable(ALICE, 'KES'), KES('99.99')),
          ],
        }),
      /does not balance in KES/
    );
  });

  test('balances each currency independently', () => {
    assert.throws(
      () =>
        new JournalEntry({
          flow: 'test',
          postings: [
            debit(userAvailable(ALICE, 'KES'), KES('100.00')),
            credit(userAvailable(ALICE, 'USD'), USD('0.77')),
          ],
        }),
      /does not balance/
    );
  });

  test('rejects zero and negative postings', () => {
    assert.throws(
      () =>
        new JournalEntry({
          flow: 'test',
          postings: [
            debit(railFloat('mpesa', 'KES'), Money.zero('KES')),
            credit(userAvailable(ALICE, 'KES'), Money.zero('KES')),
          ],
        }),
      /Zero-amount posting/
    );
    assert.throws(
      () =>
        new JournalEntry({
          flow: 'test',
          postings: [
            debit(railFloat('mpesa', 'KES'), Money.fromMinor(-100, 'KES')),
            credit(userAvailable(ALICE, 'KES'), Money.fromMinor(-100, 'KES')),
          ],
        }),
      /negative amount/
    );
  });

  test('requires at least two postings', () => {
    assert.throws(
      () =>
        new JournalEntry({
          flow: 'test',
          postings: [debit(railFloat('mpesa', 'KES'), KES('1.00'))],
        }),
      /at least two postings/
    );
  });

  test('entries are frozen after construction', () => {
    const entry = flows.transfer({ fromUserId: ALICE, toUserId: BOB, amount: KES('10.00') });
    assert.throws(() => {
      'use strict';
      entry.flow = 'tampered';
    });
    assert.ok(Object.isFrozen(entry.postings));
  });

  test('round-trips through JSON without losing exactness', () => {
    const original = flows.deposit({
      userId: ALICE,
      rail: 'mpesa',
      amount: KES('1000.00'),
      fee: KES('12.34'),
    });
    const revived = JournalEntry.fromJSON(JSON.parse(JSON.stringify(original)));
    assert.equal(revived.id, original.id);
    assert.ok(
      revived.effectOn(userAvailable(ALICE, 'KES'), 'KES')
        .equals(original.effectOn(userAvailable(ALICE, 'KES'), 'KES'))
    );
  });
});

describe('JournalEntry — reversal', () => {
  test('a reversal nets an entry to zero on every account', () => {
    const original = flows.transfer({
      fromUserId: ALICE,
      toUserId: BOB,
      amount: KES('250.00'),
      fee: KES('5.00'),
    });
    const reversed = original.reverse({ reason: 'customer dispute' });

    const net = foldBalances([original, reversed]);
    for (const [key, amount] of net) {
      assert.ok(amount.isZero, `${key} did not net to zero: ${amount}`);
    }
    assert.equal(reversed.reversalOf, original.id);
    assert.match(reversed.flow, /\.reversed$/);
  });
});

describe('flows — deposit', () => {
  test('credits the customer and grows our float by the same amount', () => {
    const entry = flows.deposit({ userId: ALICE, rail: 'mpesa', amount: KES('1000.00') });
    assert.ok(entry.effectOn(userAvailable(ALICE, 'KES'), 'KES').equals(KES('1000.00')));
    assert.ok(entry.effectOn(railFloat('mpesa', 'KES'), 'KES').equals(KES('1000.00')));
  });

  test('a fee reduces the customer credit and becomes revenue, gross stays visible', () => {
    const entry = flows.deposit({
      userId: ALICE,
      rail: 'mpesa',
      amount: KES('1000.00'),
      fee: KES('15.00'),
    });
    assert.ok(entry.effectOn(userAvailable(ALICE, 'KES'), 'KES').equals(KES('985.00')));
    assert.ok(entry.effectOn(feeRevenue('deposit.mpesa', 'KES'), 'KES').equals(KES('15.00')));
    // Gross volume is still readable — the fee is its own leg, not netted.
    assert.ok(entry.totalFor('KES').equals(KES('1015.00')));
  });

  test('the rail cost hits our expense, never the customer', () => {
    const entry = flows.deposit({
      userId: ALICE,
      rail: 'mpesa',
      amount: KES('1000.00'),
      railCost: KES('7.00'),
    });
    assert.ok(entry.effectOn(userAvailable(ALICE, 'KES'), 'KES').equals(KES('1000.00')));
    assert.ok(entry.effectOn(railFloat('mpesa', 'KES'), 'KES').equals(KES('993.00')));
    assert.ok(
      entry.effectOn('expenses:rail:mpesa:kes', 'KES').equals(KES('7.00'))
    );
  });
});

describe('flows — transfer', () => {
  test('moves value between customers with no rail involvement', () => {
    const entry = flows.transfer({ fromUserId: ALICE, toUserId: BOB, amount: KES('300.00') });
    assert.ok(entry.effectOn(userAvailable(ALICE, 'KES'), 'KES').equals(KES('-300.00')));
    assert.ok(entry.effectOn(userAvailable(BOB, 'KES'), 'KES').equals(KES('300.00')));
    assert.ok(entry.accounts.every((a) => !a.startsWith('assets:rail')));
  });

  test('the fee is charged on top of the amount the recipient gets', () => {
    const entry = flows.transfer({
      fromUserId: ALICE,
      toUserId: BOB,
      amount: KES('300.00'),
      fee: KES('4.50'),
    });
    assert.ok(entry.effectOn(userAvailable(ALICE, 'KES'), 'KES').equals(KES('-304.50')));
    assert.ok(entry.effectOn(userAvailable(BOB, 'KES'), 'KES').equals(KES('300.00')));
  });

  test('refuses a self-transfer', () => {
    assert.throws(
      () => flows.transfer({ fromUserId: ALICE, toUserId: ALICE, amount: KES('1.00') }),
      /same user/
    );
  });
});

describe('flows — payout reserve/settle/release', () => {
  const amount = KES('500.00');
  const fee = KES('25.00');

  test('reserving moves funds out of spendable but leaves them with the customer', () => {
    const entry = flows.reservePayout({ userId: ALICE, amount, fee });
    assert.ok(entry.effectOn(userAvailable(ALICE, 'KES'), 'KES').equals(KES('-525.00')));
    assert.ok(entry.effectOn(userReserved(ALICE, 'KES'), 'KES').equals(KES('525.00')));
  });

  test('reserve → settle leaves the customer down exactly amount + fee', () => {
    const reserve = flows.reservePayout({ userId: ALICE, amount, fee });
    const settle = flows.settlePayout({ userId: ALICE, rail: 'mpesa', amount, fee });
    const net = foldBalances([reserve, settle]);

    assert.ok(net.get(`${userAvailable(ALICE, 'KES')}|KES`).equals(KES('-525.00')));
    assert.ok(net.get(`${userReserved(ALICE, 'KES')}|KES`).isZero, 'reservation fully released');
    assert.ok(net.get(`${railFloat('mpesa', 'KES')}|KES`).equals(KES('-500.00')));
    assert.ok(net.get(`${feeRevenue('payout.mpesa', 'KES')}|KES`).equals(KES('25.00')));
  });

  test('reserve → release returns every cent and charges nothing', () => {
    const reserve = flows.reservePayout({ userId: ALICE, amount, fee });
    const release = flows.releasePayout({ userId: ALICE, amount, fee, reason: 'rail timeout' });
    const net = foldBalances([reserve, release]);

    for (const [key, value] of net) {
      assert.ok(value.isZero, `${key} should net to zero after a failed payout, got ${value}`);
    }
  });
});

describe('flows — FX', () => {
  test('each currency balances independently and the spread is explicit', () => {
    // 10,000 KES → 77.00 USD for the customer; mid would have been 77.54.
    const entry = flows.fxConvert({
      userId: ALICE,
      from: KES('10000.00'),
      to: USD('77.00'),
      midMarket: USD('77.54'),
    });

    assert.ok(entry.effectOn(userAvailable(ALICE, 'KES'), 'KES').equals(KES('-10000.00')));
    assert.ok(entry.effectOn(userAvailable(ALICE, 'USD'), 'USD').equals(USD('77.00')));
    assert.ok(entry.effectOn('revenue:fx:spread:usd', 'USD').equals(USD('0.54')));
    assert.deepEqual(entry.currencies.sort(), ['KES', 'USD']);
  });

  test('refuses to hand the customer more than mid-market', () => {
    assert.throws(
      () =>
        flows.fxConvert({
          userId: ALICE,
          from: KES('10000.00'),
          to: USD('80.00'),
          midMarket: USD('77.54'),
        }),
      /cannot receive more than the mid-market/
    );
  });

  test('refuses a same-currency or mis-quoted conversion', () => {
    assert.throws(
      () => flows.fxConvert({ userId: ALICE, from: KES('1'), to: KES('1'), midMarket: KES('1') }),
      /two different currencies/
    );
    assert.throws(
      () => flows.fxConvert({ userId: ALICE, from: KES('100'), to: USD('1'), midMarket: KES('1') }),
      /quoted in the destination currency/
    );
  });
});

describe('the ledger as a whole', () => {
  test('a full customer lifecycle leaves the books balanced to zero', () => {
    const entries = [
      flows.deposit({ userId: ALICE, rail: 'mpesa', amount: KES('5000.00'), fee: KES('20.00'), railCost: KES('11.00') }),
      flows.transfer({ fromUserId: ALICE, toUserId: BOB, amount: KES('1200.00'), fee: KES('5.00') }),
      flows.reservePayout({ userId: BOB, amount: KES('1000.00'), fee: KES('30.00') }),
      flows.settlePayout({ userId: BOB, rail: 'mpesa', amount: KES('1000.00'), fee: KES('30.00'), railCost: KES('15.00') }),
      flows.deposit({ userId: BOB, rail: 'pesalink', amount: KES('2500.00') }),
      flows.reservePayout({ userId: ALICE, amount: KES('100.00') }),
      flows.releasePayout({ userId: ALICE, amount: KES('100.00'), reason: 'rail rejected' }),
    ];

    // Every entry balances, so the sum of all signed postings must be zero.
    const balances = foldBalances(entries);
    let net = 0n;
    for (const [account, amount] of balances) {
      const direction = signFor(account.split('|')[0], Direction.DEBIT);
      net += amount.minorBigInt * BigInt(direction);
    }
    assert.equal(net, 0n, 'the trial balance must sum to zero');

    // And the individual balances are the ones we expect.
    assert.ok(balances.get(`${userAvailable(ALICE, 'KES')}|KES`).equals(KES('3775.00')));
    assert.ok(balances.get(`${userAvailable(BOB, 'KES')}|KES`).equals(KES('2670.00')));
    assert.ok(balances.get(`${userReserved(ALICE, 'KES')}|KES`).isZero);
    assert.ok(balances.get(`${userReserved(BOB, 'KES')}|KES`).isZero);
  });

  test('customer liabilities are fully backed by rail assets plus revenue', () => {
    const entries = [
      flows.deposit({ userId: ALICE, rail: 'mpesa', amount: KES('1000.00'), fee: KES('10.00') }),
      flows.deposit({ userId: BOB, rail: 'mpesa', amount: KES('500.00') }),
      flows.transfer({ fromUserId: ALICE, toUserId: BOB, amount: KES('200.00') }),
    ];
    const balances = foldBalances(entries);

    const liabilities = KES('0.00')
      .plus(balances.get(`${userAvailable(ALICE, 'KES')}|KES`))
      .plus(balances.get(`${userAvailable(BOB, 'KES')}|KES`));
    const assets = balances.get(`${railFloat('mpesa', 'KES')}|KES`);
    const revenue = balances.get(`${feeRevenue('deposit.mpesa', 'KES')}|KES`);

    // Assets = what we owe customers + what we have earned. Nothing unexplained.
    assert.ok(assets.equals(liabilities.plus(revenue)), `${assets} != ${liabilities} + ${revenue}`);
  });
});
