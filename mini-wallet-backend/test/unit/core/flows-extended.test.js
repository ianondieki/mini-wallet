import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Money } from '../../../src/core/money/Money.js';
import { foldBalances } from '../../../src/core/ledger/JournalEntry.js';
import * as flows from '../../../src/core/ledger/flows.js';
import {
  signFor, Direction,
  userAvailable, userReserved, userVault, railFloat, feeRevenue, openingEquity,
  customerBucket, goalIdFromAccount, userIdFromAccount,
} from '../../../src/core/ledger/accounts.js';

const KES = (v) => Money.of(v, 'KES');
const A = 'alice', B = 'bob', C = 'carol';

/** Every entry must net to zero across the whole book, per currency. */
const assertBalanced = (entries, ccy = 'KES') => {
  let net = 0n;
  for (const [key, amount] of foldBalances(entries)) {
    const [account, c] = key.split('|');
    if (c !== ccy) continue;
    net += amount.minorBigInt * BigInt(signFor(account, Direction.DEBIT));
  }
  assert.equal(net, 0n, `book does not balance in ${ccy}`);
};
const bal = (entries, account, ccy = 'KES') =>
  foldBalances(entries).get(`${account}|${ccy}`) ?? Money.zero(ccy);

describe('account bucketing', () => {
  test('a vault is a customer liability, distinct from available and reserved', () => {
    const v = userVault(A, 'school-fees', 'KES');
    assert.equal(customerBucket(v), 'vault');
    assert.equal(customerBucket(userAvailable(A, 'KES')), 'available');
    assert.equal(customerBucket(userReserved(A, 'KES')), 'reserved');
    assert.equal(customerBucket(railFloat('mpesa', 'KES')), null);
  });

  test('a vault still resolves to its owner, so guards and queries keep working', () => {
    const v = userVault(A, 'school-fees', 'KES');
    assert.equal(userIdFromAccount(v), A);
    assert.equal(goalIdFromAccount(v), 'school-fees');
    assert.ok(v.startsWith('liabilities:user:'), 'the non-negative guard matches on this prefix');
  });
});

describe('fundRailFloat', () => {
  test('debits the asset and credits equity', () => {
    const e = flows.fundRailFloat({ rail: 'mpesa', amount: KES('250000.00') });
    assert.ok(e.effectOn(railFloat('mpesa', 'KES'), 'KES').equals(KES('250000.00')));
    assert.ok(e.effectOn(openingEquity('KES'), 'KES').equals(KES('250000.00')));
    assertBalanced([e]);
  });

  test('openingBalance refuses a debit-normal target rather than inverting it', () => {
    // The bug this guard exists for: crediting an asset posts a NEGATIVE float.
    assert.throws(
      () => flows.openingBalance({ account: railFloat('mpesa', 'KES'), amount: KES('1000') }),
      /debit-normal.*fundRailFloat/s
    );
    // The legitimate use is untouched.
    const ok = flows.openingBalance({ account: userAvailable(A, 'KES'), amount: KES('1000') });
    assert.ok(ok.effectOn(userAvailable(A, 'KES'), 'KES').equals(KES('1000')));
  });
});

describe('settleInternalPayout — the in-network payout fix', () => {
  const amount = KES('3000.00');
  const fee = KES('30.00');

  test('pays the recipient instead of a rail float that does not exist', () => {
    const e = flows.settleInternalPayout({ fromUserId: A, toUserId: B, amount, fee });
    assert.ok(e.effectOn(userReserved(A, 'KES'), 'KES').equals(KES('-3030.00')));
    assert.ok(e.effectOn(userAvailable(B, 'KES'), 'KES').equals(amount), 'recipient is credited');
    assert.ok(e.effectOn(feeRevenue('transfer', 'KES'), 'KES').equals(fee));
    assert.ok(
      e.accounts.every((a) => !a.startsWith('assets:rail:')),
      'nothing internal should touch a rail float'
    );
    assertBalanced([e]);
  });

  test('reserve then internal settle moves the money end to end', () => {
    const entries = [
      flows.openingBalance({ account: userAvailable(A, 'KES'), amount: KES('10000.00') }),
      flows.reservePayout({ userId: A, amount, fee }),
      flows.settleInternalPayout({ fromUserId: A, toUserId: B, amount, fee }),
    ];
    assert.equal(bal(entries, userAvailable(A, 'KES')).toDecimal(), '6970.00');
    assert.equal(bal(entries, userReserved(A, 'KES')).toDecimal(), '0.00');
    assert.equal(bal(entries, userAvailable(B, 'KES')).toDecimal(), '3000.00');
    assertBalanced(entries);
  });

  test('refuses to settle a payout back to its sender', () => {
    assert.throws(
      () => flows.settleInternalPayout({ fromUserId: A, toUserId: A, amount }),
      /to the sender/
    );
  });
});

describe('splitTransfer', () => {
  test('one debit against many credits, in a single entry', () => {
    const shares = [
      { userId: B, amount: KES('34.00') },
      { userId: C, amount: KES('33.00') },
      { userId: 'dave', amount: KES('33.00') },
    ];
    const e = flows.splitTransfer({ fromUserId: A, shares });
    assert.equal(e.postings.filter((p) => p.direction === Direction.DEBIT).length, 1);
    assert.equal(e.postings.filter((p) => p.direction === Direction.CREDIT).length, 3);
    assert.ok(e.effectOn(userAvailable(A, 'KES'), 'KES').equals(KES('-100.00')));
    assertBalanced([e]);
  });

  test('an awkward split conserves every cent, end to end', () => {
    // 100.00 three ways has no exact answer; allocate() decides, the entry proves it.
    const parts = KES('100.00').allocate([1, 1, 1]);
    const shares = [B, C, 'dave'].map((userId, i) => ({ userId, amount: parts[i] }));
    const entries = [
      flows.openingBalance({ account: userAvailable(A, 'KES'), amount: KES('100.00') }),
      flows.splitTransfer({ fromUserId: A, shares }),
    ];
    assert.equal(bal(entries, userAvailable(A, 'KES')).toDecimal(), '0.00', 'sender fully spent');
    const received = Money.sum('KES',
      bal(entries, userAvailable(B, 'KES')),
      bal(entries, userAvailable(C, 'KES')),
      bal(entries, userAvailable('dave', 'KES')));
    assert.equal(received.toDecimal(), '100.00');
    assertBalanced(entries);
  });

  test('charges the sender a fee on top of the shares', () => {
    const e = flows.splitTransfer({
      fromUserId: A,
      shares: [{ userId: B, amount: KES('50.00') }, { userId: C, amount: KES('50.00') }],
      fee: KES('5.00'),
    });
    assert.ok(e.effectOn(userAvailable(A, 'KES'), 'KES').equals(KES('-105.00')));
    assert.ok(e.effectOn(feeRevenue('split', 'KES'), 'KES').equals(KES('5.00')));
    assertBalanced([e]);
  });

  test('rejects degenerate splits', () => {
    const one = [{ userId: B, amount: KES('10') }];
    assert.throws(() => flows.splitTransfer({ fromUserId: A, shares: one }), /at least two/);
    assert.throws(() => flows.splitTransfer({ fromUserId: A, shares: [
      { userId: B, amount: KES('10') }, { userId: B, amount: KES('10') }] }), /Duplicate recipient/);
    assert.throws(() => flows.splitTransfer({ fromUserId: A, shares: [
      { userId: A, amount: KES('10') }, { userId: B, amount: KES('10') }] }), /to the sender/);
    assert.throws(() => flows.splitTransfer({ fromUserId: A, shares: [
      { userId: B, amount: Money.zero('KES') }, { userId: C, amount: KES('10') }] }), /must be positive/);
  });
});

describe('refund', () => {
  test('returns part of a payment to the payer', () => {
    const e = flows.refund({ fromUserId: B, toUserId: A, amount: KES('80.00'), refundOf: 'entry-1' });
    assert.ok(e.effectOn(userAvailable(B, 'KES'), 'KES').equals(KES('-80.00')));
    assert.ok(e.effectOn(userAvailable(A, 'KES'), 'KES').equals(KES('80.00')));
    assert.equal(e.metadata.refundOf, 'entry-1');
    assertBalanced([e]);
  });

  test('refunding the fee gives back revenue we had recognised', () => {
    const e = flows.refund({ fromUserId: B, toUserId: A, amount: KES('80.00'), feeRefund: KES('4.00') });
    assert.ok(e.effectOn(feeRevenue('transfer', 'KES'), 'KES').equals(KES('-4.00')), 'revenue reversed');
    assert.ok(e.effectOn(userAvailable(A, 'KES'), 'KES').equals(KES('84.00')));
    assertBalanced([e]);
  });

  test('a full refund leaves the pair netting to the original fee only', () => {
    const original = flows.transfer({ fromUserId: A, toUserId: B, amount: KES('250.00'), fee: KES('5.00') });
    const back = flows.refund({ fromUserId: B, toUserId: A, amount: KES('250.00') });
    const net = foldBalances([original, back]);
    assert.equal(net.get(`${userAvailable(A, 'KES')}|KES`).toDecimal(), '-5.00', 'only the fee is gone');
    assert.ok(net.get(`${userAvailable(B, 'KES')}|KES`).isZero);
    assertBalanced([original, back]);
  });

  test('a reversal, by contrast, unwinds the fee too', () => {
    const original = flows.transfer({ fromUserId: A, toUserId: B, amount: KES('250.00'), fee: KES('5.00') });
    const undone = original.reverse({ reason: 'wrong recipient' });
    for (const [key, amount] of foldBalances([original, undone])) {
      assert.ok(amount.isZero, `${key} should net to zero`);
    }
  });
});

describe('savings vaults', () => {
  const GOAL = 'school-fees-jan';

  test('locking moves money between the customer’s own buckets', () => {
    const e = flows.lockToGoal({ userId: A, goalId: GOAL, amount: KES('2000.00') });
    assert.ok(e.effectOn(userAvailable(A, 'KES'), 'KES').equals(KES('-2000.00')));
    assert.ok(e.effectOn(userVault(A, GOAL, 'KES'), 'KES').equals(KES('2000.00')));
    assert.equal(e.accounts.length, 2, 'nothing leaves the customer');
    assertBalanced([e]);
  });

  test('releasing without a penalty returns the whole amount', () => {
    const entries = [
      flows.openingBalance({ account: userAvailable(A, 'KES'), amount: KES('5000.00') }),
      flows.lockToGoal({ userId: A, goalId: GOAL, amount: KES('2000.00') }),
      flows.releaseFromGoal({ userId: A, goalId: GOAL, amount: KES('2000.00') }),
    ];
    assert.equal(bal(entries, userAvailable(A, 'KES')).toDecimal(), '5000.00');
    assert.equal(bal(entries, userVault(A, GOAL, 'KES')).toDecimal(), '0.00');
    assertBalanced(entries);
  });

  test('an early break posts the penalty as its own leg, gross stays visible', () => {
    const e = flows.releaseFromGoal({
      userId: A, goalId: GOAL, amount: KES('2000.00'), penalty: KES('100.00'),
    });
    assert.ok(e.effectOn(userVault(A, GOAL, 'KES'), 'KES').equals(KES('-2000.00')), 'gross released');
    assert.ok(e.effectOn(userAvailable(A, 'KES'), 'KES').equals(KES('1900.00')), 'net received');
    assert.ok(e.effectOn(feeRevenue('savings.break', 'KES'), 'KES').equals(KES('100.00')));
    assert.ok(e.totalFor('KES').equals(KES('2000.00')), 'gross is readable, not netted away');
    assertBalanced([e]);
  });

  test('a penalty cannot swallow the entire release', () => {
    assert.throws(
      () => flows.releaseFromGoal({ userId: A, goalId: GOAL, amount: KES('100'), penalty: KES('100') }),
      /cannot consume the whole release/
    );
  });

  test('a vault cannot be the route to overdrawing — the guard prefix still matches', () => {
    const v = userVault(A, GOAL, 'KES');
    assert.ok(/^liabilities:user:/.test(v));
  });
});
