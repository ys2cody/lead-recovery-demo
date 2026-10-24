import { it } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelay } from '../src/leads/retry-policy.ts';
import { parseRetryAfter } from '../src/crm/client.ts';

const policy = { maxAttempts: 6, baseDelayMs: 1000, maxDelayMs: 10_000 };

it('grows exponentially, stays within jitter bounds and is capped', () => {
  assert.deepEqual([1, 2, 3, 4].map((n) => backoffDelay(n, policy, () => 0)), [500, 1000, 2000, 4000]);
  assert.deepEqual([1, 2, 3, 4].map((n) => backoffDelay(n, policy, () => 1)), [1000, 2000, 4000, 8000]);
  assert.equal(backoffDelay(10, policy, () => 1), 10_000);
  assert.equal(backoffDelay(1000, policy, () => 1), 10_000, 'no overflow for huge attempt counts');
});

it('treats Retry-After as a floor but never exceeds the cap', () => {
  assert.equal(backoffDelay(1, policy, () => 0, 3000), 3000);
  assert.equal(backoffDelay(1, policy, () => 0, 999_999), 10_000);
});

it('parses Retry-After seconds and HTTP dates', () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(parseRetryAfter('5', now), 5000);
  assert.equal(parseRetryAfter(new Date(now + 2000).toUTCString(), now), 2000);
  assert.equal(parseRetryAfter('soon', now), undefined);
  assert.equal(parseRetryAfter(null, now), undefined);
});
