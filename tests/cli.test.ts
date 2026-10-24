import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, lead, type Harness } from './harness.ts';
import { runCli } from '../src/cli.ts';

let h: Harness;
let leadId = '';
before(async () => {
  h = await createHarness();
  leadId = (await h.send(lead)).body.leadId as string;
  h.mock.state.mode = 'fail-400';
  await h.send({ ...lead, email: 'bounced@example.com' });
});
after(() => h.close());

const cli = (...args: string[]) => {
  const lines: string[] = [];
  const code = runCli(args, h.dbPath, (l) => lines.push(l));
  return { code, out: lines.join('\n') };
};

describe('leads CLI', () => {
  it('hides personal data by default', () => {
    for (const out of [cli('list').out, cli('show', leadId).out, cli('list', '--status', 'failed').out]) {
      assert.ok(!/example\.com|jane|7946/i.test(out), 'PII leaked in default output');
    }
    assert.match(cli('list').out, new RegExp(leadId));
  });

  it('shows personal data only with --show-pii', () => {
    assert.match(cli('show', leadId, '--show-pii').out, /jane\.doe@example\.com/);
  });

  it('filters by status and counts', () => {
    const failed = cli('list', '--status', 'failed').out;
    assert.match(failed, /crm_http_400/);
    assert.doesNotMatch(failed, new RegExp(leadId));
    assert.deepEqual(JSON.parse(cli('stats').out), { pending: 0, processing: 0, synced: 1, failed: 1 });
  });

  it('shows follow-up tasks for a lead', () => {
    const shown = JSON.parse(cli('show', leadId).out) as { followUps: { status: string }[] };
    assert.equal(shown.followUps[0]?.status, 'scheduled');
  });

  it('validates input', () => {
    assert.equal(cli('list', '--status', 'bogus').code, 2);
    assert.equal(cli('show', 'not-a-uuid').code, 2);
    assert.equal(cli('list', '--limit', '0').code, 2);
    assert.equal(cli('requeue', leadId).code, 1, 'synced leads cannot be requeued');
    assert.equal(cli('frobnicate').code, 2);
  });
});
