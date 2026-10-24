// Webhook boundary: authentication, validation, idempotency and first-attempt outcomes.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, lead, SECRET, CRM_KEY, type Harness } from './harness.ts';

let h: Harness;
before(async () => {
  h = await createHarness();
});
after(() => h.close());
beforeEach(() => h.resetCrm());

describe('successful processing', () => {
  it('creates a CRM contact and records the lead as synced', async () => {
    const res = await h.send(lead);
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'created');
    assert.match(String(res.body.crmContactId), /^crm_/);
    assert.equal(h.mock.contacts.get('jane.doe@example.com')?.id, res.body.crmContactId, 'email normalised before CRM upsert');

    const stored = h.repo.findByWebhookId(res.id);
    assert.equal(stored?.status, 'synced');
    assert.equal(stored?.attempts, 1);
  });

  it('serves a health check', async () => {
    assert.equal((await fetch(`${h.appUrl()}/health`)).status, 200);
  });
});

describe('authentication and replay protection', () => {
  it('rejects a missing signature without touching the CRM', async () => {
    const res = await h.send(lead, { signature: null });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'missing_signature_headers');
    assert.equal(h.mock.state.requests, 0);
  });

  it('rejects an invalid signature and stores nothing', async () => {
    const res = await h.send(lead, { signature: 'v1,' + Buffer.alloc(32).toString('base64') });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_signature');
    assert.equal(h.repo.findByWebhookId(res.id), undefined);
  });

  it('rejects a replayed request with an old timestamp', async () => {
    const res = await h.send(lead, { timestamp: Math.floor(h.clock.now / 1000) - 3600 });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'stale_timestamp');
  });
});

describe('input validation', () => {
  it('returns field-level errors for an invalid lead', async () => {
    const res = await h.send({ name: '', email: 'not-an-email', budget: 5000 });
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'validation_failed');
    const fields = (res.body.details as { field: string }[]).map((d) => d.field).sort();
    assert.deepEqual(fields, ['(body)', 'email', 'name']); // (body) = unknown key "budget"
    assert.equal(h.mock.state.requests, 0);
  });

  it('rejects malformed JSON, wrong content type and oversized bodies', async () => {
    assert.equal((await h.send(null, { body: '{"name":' })).status, 400);
    assert.equal((await h.send(lead, { contentType: 'text/plain' })).status, 415);
    assert.equal((await h.send(null, { body: JSON.stringify({ ...lead, message: 'x'.repeat(70_000) }) })).status, 413);
  });
});

describe('idempotency', () => {
  it('processes a repeated delivery only once', async () => {
    const first = await h.send(lead, { id: 'evt_repeat' });
    const second = await h.send(lead, { id: 'evt_repeat' });
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.body.status, 'duplicate');
    assert.equal(second.body.leadId, first.body.leadId);
    assert.equal(h.mock.state.requests, 1);
  });

  it('processes concurrent duplicate deliveries only once', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => h.send(lead, { id: 'evt_concurrent' })));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 200, 200, 201]);
    assert.equal(h.mock.state.requests, 1);
  });

  it('remembers processed events across a restart (persistent store)', async () => {
    const first = await h.send(lead, { id: 'evt_restart' });
    await h.restart();
    const again = await h.send(lead, { id: 'evt_restart' });
    assert.equal(again.status, 200);
    assert.equal(again.body.leadId, first.body.leadId);
    assert.equal(h.mock.state.requests, 1);
  });

  it('keeps one CRM contact when the same person enquires twice', async () => {
    const a = await h.send({ ...lead, email: 'repeat.customer@example.com' });
    const b = await h.send({ ...lead, email: 'repeat.customer@example.com', message: 'Following up' });
    assert.equal(a.body.crmContactId, b.body.crmContactId);
  });
});

describe('first-attempt CRM failures', () => {
  it('stores the lead and schedules a retry on a transient error', async () => {
    h.mock.state.mode = 'fail-500';
    const res = await h.send(lead, { id: 'evt_crm_down' });
    assert.equal(res.status, 202);
    assert.equal(res.body.status, 'pending');
    assert.equal(res.body.reason, 'crm_http_500');
    const stored = h.repo.findByWebhookId('evt_crm_down');
    assert.equal(stored?.status, 'pending');
    assert.ok((stored?.nextAttemptAt ?? 0) > h.clock.now);
  });

  it('answers a redelivery of a pending lead as a duplicate (the worker owns retries)', async () => {
    h.mock.state.mode = 'fail-500';
    await h.send(lead, { id: 'evt_pending_redeliver' });
    h.resetCrm();
    const again = await h.send(lead, { id: 'evt_pending_redeliver' });
    assert.equal(again.status, 200);
    assert.equal(again.body.state, 'pending');
    assert.equal(h.mock.state.requests, 0);
  });

  it('marks the lead failed immediately on a permanent error', async () => {
    h.mock.state.mode = 'fail-400';
    const res = await h.send(lead);
    assert.equal(res.status, 202);
    assert.deepEqual([res.body.status, res.body.reason], ['failed', 'crm_http_400']);
  });

  it('times out a hanging CRM instead of hanging the webhook', async () => {
    h.mock.state.mode = 'timeout';
    const res = await h.send(lead);
    assert.equal(res.status, 202);
    assert.equal(res.body.reason, 'crm_timeout');
  });
});

describe('logging', () => {
  it('never logs personal data or secrets', () => {
    assert.ok(h.logs.length > 0);
    const all = h.logs.join('\n').toLowerCase();
    for (const leaked of ['jane.doe@example.com', 'jane doe', '7946', SECRET, CRM_KEY]) {
      assert.ok(!all.includes(leaked.toLowerCase()), `log output contains ${leaked.slice(0, 4)}…`);
    }
  });
});
