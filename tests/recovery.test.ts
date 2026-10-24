// Durable retries, retry limits, crash recovery, concurrent workers and follow-up tasks.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, lead, type Harness } from './harness.ts';
import { FOLLOW_UP_KIND } from '../src/leads/sync.ts';

// Fresh database per test: the worker processes everything that is due, so shared state would leak between tests.
// Defaults: base 1s, cap 60s, 4 attempts, 30s lease, 60s follow-up delay; jitter fixed at 0.5 → 0.75s, 1.5s, 3s …
let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(() => h.close());

const status = (webhookId: string) => h.repo.findByWebhookId(webhookId)?.status;

describe('automatic retries', () => {
  it('delivers a lead submitted during a CRM outage once the CRM recovers, with no redelivery', async () => {
    h.mock.state.mode = 'fail-500';
    const res = await h.send(lead, { id: 'evt_outage' });
    assert.equal(res.body.status, 'pending');

    // Outage continues: the worker retries when due and reschedules.
    assert.equal((await h.worker.runOnce()).attempted, 0, 'not due yet');
    h.advance(750);
    assert.equal((await h.worker.runOnce()).attempted, 1);
    assert.equal(status('evt_outage'), 'pending');

    // CRM recovers. The next due attempt succeeds without the sender doing anything.
    h.mock.state.mode = 'ok';
    h.advance(1500);
    await h.worker.runOnce();
    const stored = h.repo.findByWebhookId('evt_outage');
    assert.equal(stored?.status, 'synced');
    assert.equal(stored?.attempts, 3);
    assert.match(stored?.crmContactId ?? '', /^crm_/);
    assert.equal(h.mock.contacts.size >= 1, true);
  });

  it('backs off exponentially between attempts', async () => {
    h.mock.state.mode = 'fail-500';
    await h.send(lead, { id: 'evt_backoff' });
    const gaps: number[] = [];
    for (let i = 0; i < 2; i++) {
      const before = h.clock.now;
      const next = h.repo.findByWebhookId('evt_backoff')?.nextAttemptAt as number;
      gaps.push(next - before);
      h.clock.now = next;
      await h.worker.runOnce();
    }
    assert.deepEqual(gaps, [750, 1500]); // base 1000 * 2^(n-1), equal jitter at 0.5
  });

  it('stops after the maximum attempts and leaves a terminal failed state', async () => {
    h.mock.state.mode = 'fail-500';
    await h.send(lead, { id: 'evt_exhaust' });
    for (let i = 0; i < 10; i++) {
      h.advance(60_000);
      await h.worker.runOnce();
    }
    const stored = h.repo.findByWebhookId('evt_exhaust');
    assert.equal(stored?.status, 'failed');
    assert.equal(stored?.attempts, 4);
    assert.equal(stored?.lastError, 'crm_http_500');
    assert.equal(h.mock.state.requests, 4, 'exactly maxAttempts CRM calls, then no more');
  });

  it('never retries a permanent error', async () => {
    h.mock.state.mode = 'fail-400';
    await h.send(lead, { id: 'evt_permanent' });
    h.mock.state.mode = 'ok';
    h.advance(3_600_000);
    await h.worker.runOnce();
    assert.equal(status('evt_permanent'), 'failed');
    assert.equal(h.mock.state.requests, 1);
  });

  it('honours Retry-After from a rate-limited CRM', async () => {
    h.mock.state.mode = 'fail-429'; // mock sends Retry-After: 1 (second)
    await h.send(lead, { id: 'evt_429' });
    const next = h.repo.findByWebhookId('evt_429')?.nextAttemptAt as number;
    assert.equal(next - h.clock.now, 1000, 'Retry-After (1000ms) wins over the 750ms backoff');
  });

  it('retries after a CRM timeout', async () => {
    h.mock.state.mode = 'timeout';
    await h.send(lead, { id: 'evt_timeout' });
    assert.equal(h.repo.findByWebhookId('evt_timeout')?.lastError, 'crm_timeout');
    h.mock.state.mode = 'ok';
    h.advance(750);
    await h.worker.runOnce();
    assert.equal(status('evt_timeout'), 'synced');
  });

  it('lets an operator requeue a terminally failed lead', async () => {
    h.mock.state.mode = 'fail-400';
    await h.send(lead, { id: 'evt_requeue' });
    const id = h.repo.findByWebhookId('evt_requeue')?.id as string;
    h.mock.state.mode = 'ok';
    assert.equal(h.repo.requeue(id, h.clock.now), true);
    await h.worker.runOnce();
    assert.equal(status('evt_requeue'), 'synced');
    assert.equal(h.repo.requeue(id, h.clock.now), false, 'only failed leads can be requeued');
  });
});

describe('crash recovery', () => {
  it('recovers a lead left in processing by a crash after the lease expires', async () => {
    // Simulate a process that claimed a lead and died before calling the CRM.
    h.repo.claim('evt_crashed', { ...lead, source: 'website' }, h.clock.now, 30_000);
    await h.restart();
    assert.equal((await h.worker.runOnce()).recovered, 0, 'lease still valid: maybe the other process is alive');

    h.advance(30_001);
    const tick = await h.worker.runOnce();
    assert.equal(tick.recovered, 1);
    assert.equal(tick.attempted, 1);
    const stored = h.repo.findByWebhookId('evt_crashed');
    assert.equal(stored?.status, 'synced');
    assert.equal(stored?.attempts, 2);
  });

  it('fails a crashed lead that has used its last attempt instead of retrying forever', async () => {
    h.mock.state.mode = 'fail-500';
    await h.send(lead, { id: 'evt_crash_exhausted' });
    for (let i = 0; i < 2; i++) {
      h.advance(60_000);
      await h.worker.runOnce();
    }
    // Attempt 4 (the last) is claimed, then the process "dies" before finishing it.
    h.advance(60_000);
    const [claimed] = h.repo.claimDue(h.clock.now, 30_000, 1);
    assert.equal(claimed?.attempts, 4);
    h.advance(30_001);
    h.resetCrm();
    await h.worker.runOnce();
    const stored = h.repo.findByWebhookId('evt_crash_exhausted');
    assert.equal(stored?.status, 'failed');
    assert.equal(stored?.lastError, 'lease_expired');
    assert.equal(h.mock.state.requests, 0);
  });

  it('ignores a late result from a worker whose lease was taken over', async () => {
    h.repo.claim('evt_slow_worker', { ...lead, source: 'website' }, h.clock.now, 30_000);
    const stale = h.repo.findByWebhookId('evt_slow_worker');
    h.advance(30_001);
    await h.worker.runOnce(); // takes over and syncs
    assert.equal(status('evt_slow_worker'), 'synced');
    // The original worker wakes up and tries to record a failure: rejected.
    assert.equal(h.repo.markFailed(stale?.id as string, stale?.leaseToken as string, 'crm_http_500', h.clock.now), false);
    assert.equal(status('evt_slow_worker'), 'synced');
  });
});

describe('concurrent workers', () => {
  it('two processes sharing the database never send the same due lead to the CRM twice', async () => {
    h.mock.state.mode = 'fail-500';
    for (let i = 0; i < 6; i++) await h.send({ ...lead, email: `concurrent${i}@example.com` }, { id: `evt_cc_${i}` });
    h.resetCrm();
    h.advance(750);

    const other = h.buildNode(); // second "process": its own DB connection and worker
    try {
      const [a, b] = await Promise.all([h.worker.runOnce(), other.worker.runOnce()]);
      assert.equal(a.attempted + b.attempted, 6);
      assert.equal(h.mock.state.requests, 6, 'no lead sent to the CRM twice');
      for (let i = 0; i < 6; i++) assert.equal(status(`evt_cc_${i}`), 'synced');
    } finally {
      other.repo.close();
    }
  });
});

describe('simulated follow-up tasks', () => {
  it('schedules exactly one follow-up per synced lead and runs it once when due', async () => {
    const res = await h.send(lead, { id: 'evt_followup' });
    await h.send(lead, { id: 'evt_followup' }); // duplicate delivery must not add a task
    const leadId = res.body.leadId as string;

    const tasks = h.repo.followUpsForLead(leadId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.kind, FOLLOW_UP_KIND);
    assert.equal(tasks[0]?.status, 'scheduled');
    assert.equal(tasks[0]?.dueAt, h.clock.now + 60_000);

    const runFor = async () => {
      const before = h.logs.length;
      await h.worker.runOnce();
      return h.logs.slice(before).filter((l) => l.includes('follow_up_simulated') && l.includes(leadId)).length;
    };
    assert.equal(await runFor(), 0, 'not due yet');
    h.advance(60_000);
    assert.equal(await runFor(), 1);
    h.advance(60_000);
    assert.equal(await runFor(), 0, 'never executed twice');
    assert.equal(h.repo.followUpsForLead(leadId)[0]?.status, 'completed');

    const followUpLogs = h.logs.filter((l) => l.includes('follow_up_simulated')).join('\n').toLowerCase();
    assert.ok(!followUpLogs.includes('example.com') && !followUpLogs.includes('jane'), 'no personal data in follow-up logs');
  });

  it('does not schedule follow-ups for leads that are not synced', async () => {
    h.mock.state.mode = 'fail-400';
    const res = await h.send(lead);
    assert.equal(h.repo.followUpsForLead(res.body.leadId as string).length, 0);
  });
});
