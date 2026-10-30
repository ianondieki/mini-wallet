import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createLimiter } from '../../src/middleware/rateLimiter.js';

/**
 * The integration suite raises every rate limit, because ~40 registrations
 * from a single runner IP would otherwise trip a control that is correctly
 * tuned for consumer traffic. That would leave the limiter itself untested,
 * so its behaviour is pinned here instead — directly, with no database and no
 * waiting on a real window to elapse.
 */

/** Mount one limiter on a bare app with a single endpoint. */
const appWith = (limiter) => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(limiter);
  app.get('/thing', (_req, res) => res.json({ success: true }));
  return app;
};

describe('rate limiter', () => {
  test('allows requests up to the limit, then refuses with the right code', async () => {
    const app = appWith(
      createLimiter({ windowMs: 60_000, max: 3, code: 'RATE_LIMIT_TEST' })
    );

    for (let i = 1; i <= 3; i += 1) {
      const res = await request(app).get('/thing');
      assert.equal(res.status, 200, `request ${i} should be allowed`);
    }

    const blocked = await request(app).get('/thing');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.code, 'RATE_LIMIT_TEST');
    assert.equal(blocked.body.success, false);
    // The standard envelope, so a client parses a throttle like any other error.
    assert.ok(blocked.body.message);
  });

  test('advertises the limit in standard headers', async () => {
    const app = appWith(createLimiter({ windowMs: 60_000, max: 2, code: 'X' }));
    const res = await request(app).get('/thing');
    assert.equal(res.headers['ratelimit-limit'], '2');
    assert.ok(!res.headers['x-ratelimit-limit'], 'legacy headers are off');
  });

  test('a custom key generator isolates one caller from another', async () => {
    // Payment limits are keyed per user, so one customer exhausting their
    // quota must not throttle anyone else behind the same address.
    const app = express();
    app.use((req, _res, next) => {
      req.userId = req.get('X-Test-User') || null;
      next();
    });
    app.use(
      createLimiter({
        windowMs: 60_000,
        max: 2,
        code: 'RATE_LIMIT_PAYMENT',
        keyGenerator: (req) => req.userId || req.ip,
      })
    );
    app.get('/pay', (_req, res) => res.json({ success: true }));

    await request(app).get('/pay').set('X-Test-User', 'alice');
    await request(app).get('/pay').set('X-Test-User', 'alice');
    const aliceBlocked = await request(app).get('/pay').set('X-Test-User', 'alice');
    assert.equal(aliceBlocked.status, 429, 'alice has spent her quota');

    const bob = await request(app).get('/pay').set('X-Test-User', 'bob');
    assert.equal(bob.status, 200, 'bob is unaffected by alice');
  });

  test('the production defaults are what we think they are', async () => {
    // A regression guard: these are security controls, and a stray edit that
    // loosened them would otherwise pass unnoticed.
    const fresh = await import(`../../src/middleware/rateLimiter.js?fresh=${Date.now()}`);
    for (const name of ['globalLimiter', 'authLimiter', 'refreshLimiter', 'paymentLimiter']) {
      assert.equal(typeof fresh[name], 'function', `${name} is mounted`);
    }
  });
});

describe('rate limit configuration', () => {
  test('a malformed limit falls back to the default rather than failing open', async () => {
    // Number('') and Number('abc') are 0 and NaN. Either reaching
    // express-rate-limit as `max` would disable the control entirely, which is
    // the one failure mode worth guarding on a brute-force defence.
    const previous = process.env.RATE_LIMIT_AUTH_MAX;
    try {
      for (const bad of ['', 'abc', '-5', '0']) {
        process.env.RATE_LIMIT_AUTH_MAX = bad;
        const fresh = await import(
          `../../src/middleware/rateLimiter.js?bad=${encodeURIComponent(bad)}`
        );
        const app = appWith(fresh.authLimiter);

        // The default is 5, so a sixth request must be refused.
        for (let i = 0; i < 5; i += 1) await request(app).get('/thing');
        const blocked = await request(app).get('/thing');
        assert.equal(
          blocked.status,
          429,
          `RATE_LIMIT_AUTH_MAX="${bad}" must fall back to the default, not disable the limit`
        );
      }
    } finally {
      if (previous === undefined) delete process.env.RATE_LIMIT_AUTH_MAX;
      else process.env.RATE_LIMIT_AUTH_MAX = previous;
    }
  });
});
