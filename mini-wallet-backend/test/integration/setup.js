import mongoose from 'mongoose';

/**
 * Obtain a MongoDB connection for integration tests.
 *
 * Resolution order:
 *   1. TEST_MONGO_URI — point at any running replica set (CI / local rs0).
 *   2. mongodb-memory-server — spins up an ephemeral in-memory replica set.
 *
 * Multi-document transactions (used by transfers/withdrawals) REQUIRE a
 * replica set, so a standalone mongod will not work.
 *
 * If neither source is available (e.g. the mongod binary can't be downloaded
 * in a locked-down sandbox), this resolves to `{ skip: true }` and the caller
 * SKIPS the suite rather than failing it — so a developer without Mongo still
 * gets a useful unit-test run instead of a wall of red.
 *
 * **In CI that leniency is dangerous**: a database that failed to start would
 * produce a green build which tested nothing at all. Set `REQUIRE_TEST_DB=true`
 * (the CI workflow does) and an unavailable database becomes a hard failure.
 *
 * @returns {Promise<{ skip: boolean, reason?: string, stop: () => Promise<void> }>}
 */
export const startTestDb = async () => {
  const noop = async () => {};

  // 1. Explicit URI wins.
  if (process.env.TEST_MONGO_URI) {
    await mongoose.connect(process.env.TEST_MONGO_URI);
    return {
      skip: false,
      stop: async () => {
        await mongoose.connection.dropDatabase();
        await mongoose.disconnect();
      },
    };
  }

  // 2. In-memory replica set.
  try {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replSet.getUri());
    return {
      skip: false,
      stop: async () => {
        await mongoose.disconnect();
        await replSet.stop();
      },
    };
  } catch (err) {
    const detail = err.message.split('\n')[0];
    if (process.env.REQUIRE_TEST_DB === 'true') {
      // Refuse to pass by default. A silent skip here would mean the money
      // paths shipped unverified behind a green tick.
      throw new Error(
        `REQUIRE_TEST_DB is set but no MongoDB is available: ${detail}. ` +
          'Integration tests must not be skipped in CI.'
      );
    }
    return {
      skip: true,
      reason: `MongoDB unavailable (${detail}). ` +
        'Set TEST_MONGO_URI to a replica set, or allow mongodb-memory-server ' +
        'to download a mongod binary, to run these tests.',
      stop: noop,
    };
  }
};

/** Wipe every collection between tests for isolation. */
export const clearDb = async () => {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
};
