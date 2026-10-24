export interface RetryPolicy {
  maxAttempts: number; // total CRM attempts, including the first
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * Exponential backoff with "equal jitter": half the delay is fixed, half is random,
 * so retries spread out without ever collapsing to zero. A server-provided Retry-After
 * is treated as a minimum. Never exceeds maxDelayMs.
 */
export function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number = Math.random, retryAfterMs?: number): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jittered = exponential / 2 + random() * (exponential / 2);
  return Math.round(Math.min(policy.maxDelayMs, Math.max(jittered, retryAfterMs ?? 0)));
}
