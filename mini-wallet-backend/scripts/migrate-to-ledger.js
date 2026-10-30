#!/usr/bin/env node
/**
 * Migrate legacy `Wallet.balance` figures into the double-entry ledger.
 *
 * ## What it does
 *
 * For every wallet holding a non-zero balance, it posts one opening-balance
 * entry crediting that customer's `liabilities:user:<id>:available` account.
 * After it runs, balances are served from the ledger and the `Wallet`
 * collection is read-only history.
 *
 * ## What it deliberately does NOT do
 *
 * It does not convert historical `Transaction` rows into journal entries.
 * That would double-count: the opening balance already accounts for every
 * movement those rows represent. The old collection is kept as an archive,
 * and the ledger starts clean from the opening position — which is how a
 * ledger migration is done in practice, and the only version that balances.
 *
 * ## The offsetting leg, and the honest caveat
 *
 * Each credit is offset against `equity:opening`. That says "this balance is
 * declared as at migration", which is all we can truthfully assert from the
 * old data alone.
 *
 * It does **not** assert where the backing money physically is. In reality it
 * should be sitting in the M-Pesa float, and after this runs you must
 * reconcile `assets:rail:mpesa:float` against a real Safaricom statement and
 * post a correcting entry for the difference. Until you do, the books balance
 * but the asset side is unproven — so treat a clean trial balance here as a
 * starting point, not a clean bill of health.
 *
 * ## Usage
 *
 *   node scripts/migrate-to-ledger.js              # dry run, changes nothing
 *   node scripts/migrate-to-ledger.js --commit     # actually write
 *
 * Safe to run more than once: a customer who already has an opening entry is
 * skipped, so an interrupted run can simply be repeated.
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { Money } from '../src/core/money/Money.js';
import { openingBalance } from '../src/core/ledger/flows.js';
import { userAvailable } from '../src/core/ledger/accounts.js';
import { post, trialBalance } from '../src/services/ledgerService.js';
import { LedgerEntry } from '../src/models/LedgerEntry.js';
import { Wallet } from '../src/models/Wallet.js';

const COMMIT = process.argv.includes('--commit');
const CURRENCY = process.env.DEFAULT_CURRENCY || 'KES';

/** Print a table row. */
const row = (...cells) => console.log(cells.join('  '));

const main = async () => {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`\nConnected. Mode: ${COMMIT ? 'COMMIT' : 'DRY RUN (nothing will be written)'}\n`);

  const wallets = await Wallet.find({}).lean();
  console.log(`Found ${wallets.length} legacy wallet(s).\n`);

  let migrated = 0;
  let skipped = 0;
  let zero = 0;
  let total = Money.zero(CURRENCY);
  const failures = [];

  for (const wallet of wallets) {
    const userId = wallet.user.toString();
    const account = userAvailable(userId, wallet.currency || CURRENCY);

    // The legacy balance is a Number of whole shillings. Round rather than
    // reject: a float that has drifted to 99.99999 is still 100 shillings,
    // and refusing to migrate it would strand the customer's money.
    const amount = Money.ofRounded(String(wallet.balance ?? 0), wallet.currency || CURRENCY);

    if (!amount.isPositive) {
      zero += 1;
      continue;
    }

    const already = await LedgerEntry.findOne({ accounts: account, flow: 'opening_balance' }).lean();
    if (already) {
      row('SKIP  ', userId, amount.toString(), '(already migrated)');
      skipped += 1;
      continue;
    }

    const entry = openingBalance({
      account,
      amount,
      reason: `Migrated legacy wallet balance for user ${userId}`,
      metadata: { migration: 'wallet-to-ledger', legacyWalletId: wallet._id.toString(), toUserId: userId },
    });

    if (COMMIT) {
      try {
        await post(entry);
      } catch (err) {
        row('FAIL  ', userId, amount.toString(), err.message);
        failures.push({ userId, amount: amount.toString(), error: err.message });
        continue;
      }
    }

    row(COMMIT ? 'POSTED' : 'WOULD ', userId, amount.toString());
    total = total.plus(amount);
    migrated += 1;
  }

  console.log('\n── Summary ────────────────────────────────────');
  row('migrated   :', String(migrated));
  row('skipped    :', String(skipped), '(already had an opening entry)');
  row('zero       :', String(zero), '(nothing to migrate)');
  row('failed     :', String(failures.length));
  row('total value:', total.toString());

  if (COMMIT) {
    const trial = await trialBalance(CURRENCY);
    console.log(
      `\nTrial balance: ${trial.balanced ? 'BALANCED' : `OUT BY ${trial.net}`} ` +
        `across ${trial.accounts.length} account(s).`
    );
    console.log(
      '\nNext step: reconcile assets:rail:mpesa:float against a real Safaricom\n' +
        'statement and post a correcting entry. Until then the asset side of\n' +
        'these opening balances is declared, not proven.\n'
    );
  } else {
    console.log('\nDry run only. Re-run with --commit to write.\n');
  }

  await mongoose.disconnect();
  process.exit(failures.length > 0 ? 1 : 0);
};

main().catch(async (err) => {
  console.error('\nMigration failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
