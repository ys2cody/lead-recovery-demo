import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sign, verifySignature } from '../src/webhooks/signature.ts';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const NOW = 1_800_000_000;
const body = Buffer.from('{"name":"Jane"}');
const headersFor = (sig: string, ts = String(NOW), id = 'evt_1') => ({ id, timestamp: ts, signature: sig });
const verify = (h: ReturnType<typeof headersFor>, b = body, secret = SECRET) => verifySignature(secret, h, b, NOW, 300);

describe('webhook signature', () => {
  it('accepts a correctly signed request', () => {
    assert.deepEqual(verify(headersFor(sign(SECRET, 'evt_1', String(NOW), body))), { ok: true });
  });

  it('rejects a tampered body', () => {
    const sig = sign(SECRET, 'evt_1', String(NOW), body);
    assert.deepEqual(verify(headersFor(sig), Buffer.from('{"name":"Mallory"}')), { ok: false, reason: 'invalid_signature' });
  });

  it('rejects a signature made with another secret', () => {
    const sig = sign('another-secret-0123456789abcdef0123456789', 'evt_1', String(NOW), body);
    assert.equal(verify(headersFor(sig)).ok, false);
  });

  it('rejects a changed webhook-id (id is part of the signed content)', () => {
    const sig = sign(SECRET, 'evt_1', String(NOW), body);
    assert.deepEqual(verify(headersFor(sig, String(NOW), 'evt_2')), { ok: false, reason: 'invalid_signature' });
  });

  it('rejects timestamps outside the tolerance window, past and future', () => {
    for (const ts of [String(NOW - 301), String(NOW + 301)]) {
      assert.deepEqual(verify(headersFor(sign(SECRET, 'evt_1', ts, body), ts)), { ok: false, reason: 'stale_timestamp' });
    }
  });

  it('rejects missing headers and non-numeric timestamps', () => {
    assert.deepEqual(verifySignature(SECRET, { id: 'evt_1', timestamp: undefined, signature: 'v1,x' }, body, NOW, 300), {
      ok: false,
      reason: 'missing_signature_headers',
    });
    assert.deepEqual(verify(headersFor('v1,x', '17e8')), { ok: false, reason: 'invalid_timestamp' });
  });

  it('accepts any valid entry in a multi-signature header (secret rotation)', () => {
    const good = sign(SECRET, 'evt_1', String(NOW), body);
    assert.deepEqual(verify(headersFor(`v1,AAAA v2,ignored ${good}`)), { ok: true });
  });

  it('supports whsec_ base64 secrets', () => {
    const whsec = 'whsec_' + Buffer.from(SECRET).toString('base64');
    assert.deepEqual(verify(headersFor(sign(whsec, 'evt_1', String(NOW), body)), body, whsec), { ok: true });
  });
});
