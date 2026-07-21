'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createHttpError,
  isRetryableError,
  retryAsync
} = require('../src/network-utils');

test('classifies only transient HTTP responses for retry', () => {
  assert.equal(isRetryableError(createHttpError('rate limited', 429)), true);
  assert.equal(isRetryableError(createHttpError('upstream failed', 503)), true);
  assert.equal(isRetryableError(createHttpError('forbidden', 403)), false);
});

test('retries a transient operation with bounded attempts', async () => {
  let attempts = 0;
  const result = await retryAsync(async () => {
    attempts += 1;
    if (attempts < 3) {
      throw createHttpError('try again', 503);
    }
    return 'ok';
  }, { attempts: 3, baseDelayMs: 0 });
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});

test('does not retry a permanent failure', async () => {
  let attempts = 0;
  await assert.rejects(retryAsync(async () => {
    attempts += 1;
    throw createHttpError('bad request', 400);
  }, { attempts: 3, baseDelayMs: 0 }), /bad request/);
  assert.equal(attempts, 1);
});
