// Webhook signing modelled on the Standard Webhooks spec (https://www.standardwebhooks.com):
//   signed content = `${webhook-id}.${webhook-timestamp}.${raw body}`
//   webhook-signature = space-separated list of `v1,<base64 HMAC-SHA256>` (several allowed for key rotation)
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SignatureHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

export type VerifyFailure = 'missing_signature_headers' | 'invalid_timestamp' | 'stale_timestamp' | 'invalid_signature';
export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure };

// `whsec_<base64>` secrets (Standard Webhooks style) are decoded; anything else is used as UTF-8.
function secretKey(secret: string): Buffer {
  return secret.startsWith('whsec_') ? Buffer.from(secret.slice(6), 'base64') : Buffer.from(secret, 'utf8');
}

function hmac(secret: string, id: string, timestamp: string, body: Buffer | string): Buffer {
  return createHmac('sha256', secretKey(secret)).update(`${id}.${timestamp}.`).update(body).digest();
}

export function sign(secret: string, id: string, timestamp: string, body: Buffer | string): string {
  return `v1,${hmac(secret, id, timestamp, body).toString('base64')}`;
}

export function verifySignature(
  secret: string,
  headers: SignatureHeaders,
  body: Buffer,
  nowSeconds: number,
  toleranceSeconds: number,
): VerifyResult {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing_signature_headers' };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: 'invalid_timestamp' };
  // Replay protection part 1: reject old (or far-future) signed requests.
  // Part 2 is idempotency on webhook-id, so a replay inside the window is never processed twice.
  if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) return { ok: false, reason: 'stale_timestamp' };

  const expected = hmac(secret, id, timestamp, body);
  for (const candidate of signature.split(' ')) {
    const [version, value] = candidate.split(',', 2);
    if (version !== 'v1' || !value) continue;
    const given = Buffer.from(value, 'base64');
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: 'invalid_signature' };
}
