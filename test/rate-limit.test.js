import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimit } from '../server/rate-limit.js';

test('rate limit spans callers with the same address, resets at the boundary and bounds memory', () => {
  let time = 0;
  const allow = createRateLimit({ limit: 2, windowMs: 100, maxKeys: 2, now: () => time });
  assert.equal(allow('a'), true);
  assert.equal(allow('a'), true);
  assert.equal(allow('a'), false);
  assert.equal(allow('b'), true);
  assert.equal(allow('c'), false);
  time = 99;
  assert.equal(allow('a'), false);
  time = 100;
  assert.equal(allow('c'), true);
  assert.equal(allow('a'), true);
});

test('rate limiter rejects invalid configuration', () => {
  assert.throws(() => createRateLimit({ limit: 0, windowMs: 100 }), /Invalid/);
});
