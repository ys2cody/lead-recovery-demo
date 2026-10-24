// Test harness: real HTTP app + real SQLite file + local mock CRM, with a controllable clock.
// The worker is driven by calling runOnce() so tests are deterministic (no polling timers).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/http/server.ts';
import { createLeadIntake } from '../src/leads/intake.ts';
import { createLeadSync } from '../src/leads/sync.ts';
import { createWorker } from '../src/leads/worker.ts';
import { LeadRepository } from '../src/leads/repository.ts';
import { createCrmClient } from '../src/crm/client.ts';
import { createMockCrm } from '../src/crm/mock-server.ts';
import { createLogger } from '../src/logger.ts';
import { sign } from '../src/webhooks/signature.ts';

export const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
export const CRM_KEY = 'test-crm-key-123';
export const lead = { name: 'Jane Doe', email: 'Jane.Doe@Example.com', phone: '+44 20 7946 0000', message: 'Quote please' };

export interface HarnessOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  leaseMs?: number;
  crmTimeoutMs?: number;
  followUpDelayMs?: number;
}

export interface SendOptions {
  id?: string;
  timestamp?: number;
  signature?: string | null;
  body?: string;
  contentType?: string;
}

export async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function createHarness(opts: HarnessOptions = {}) {
  const o = { maxAttempts: 4, baseDelayMs: 1000, maxDelayMs: 60_000, leaseMs: 30_000, crmTimeoutMs: 300, followUpDelayMs: 60_000, ...opts };
  const dir = mkdtempSync(join(tmpdir(), 'lead-recovery-test-'));
  const dbPath = join(dir, 'leads.db');
  const logs: string[] = [];
  const clock = { now: Date.UTC(2026, 0, 15, 9, 0, 0) };
  const mock = createMockCrm({ apiKey: CRM_KEY });
  const crmUrl = await listen(mock.server);
  let idCounter = 0;

  // Builds an independent "process": own DB connection, CRM client, sync, worker and HTTP app.
  function buildNode() {
    const repo = new LeadRepository(dbPath);
    const logger = createLogger('debug', (line) => logs.push(line));
    const crm = createCrmClient({ baseUrl: crmUrl, apiKey: CRM_KEY, timeoutMs: o.crmTimeoutMs });
    const now = () => clock.now;
    const policy = { maxAttempts: o.maxAttempts, baseDelayMs: o.baseDelayMs, maxDelayMs: o.maxDelayMs };
    const sync = createLeadSync({ repo, crm, logger, policy, followUpDelayMs: o.followUpDelayMs, clock: now, random: () => 0.5 });
    const intake = createLeadIntake({ repo, sync, logger, clock: now, leaseMs: o.leaseMs });
    const worker = createWorker({ repo, sync, logger, clock: now, leaseMs: o.leaseMs, maxAttempts: o.maxAttempts, batchSize: 10, pollIntervalMs: 1000 });
    const app = createApp({ webhookSecret: SECRET, toleranceSeconds: 300, intake, logger, now });
    return { repo, worker, app };
  }

  let node = buildNode();
  let appUrl = await listen(node.app);

  async function stopNode(): Promise<void> {
    await node.worker.stop();
    node.app.close();
    node.app.closeAllConnections();
    await once(node.app, 'close');
    node.repo.close();
  }

  return {
    dbPath,
    logs,
    clock,
    mock,
    get repo() {
      return node.repo;
    },
    get worker() {
      return node.worker;
    },
    buildNode,
    advance(ms: number) {
      clock.now += ms;
    },
    /** Simulates a crash/restart: drops the process state, keeps the database file. */
    async restart() {
      await stopNode();
      node = buildNode();
      appUrl = await listen(node.app);
    },
    async send(payload: unknown, s: SendOptions = {}) {
      const id = s.id ?? `evt_test_${++idCounter}`;
      const ts = String(s.timestamp ?? Math.floor(clock.now / 1000));
      const body = s.body ?? JSON.stringify(payload);
      const headers: Record<string, string> = { 'content-type': s.contentType ?? 'application/json', 'webhook-id': id, 'webhook-timestamp': ts };
      if (s.signature !== null) headers['webhook-signature'] = s.signature ?? sign(SECRET, id, ts, body);
      const res = await fetch(`${appUrl}/webhooks/leads`, { method: 'POST', headers, body });
      return { status: res.status, body: (await res.json()) as Record<string, unknown>, id };
    },
    resetCrm() {
      mock.state.mode = 'ok';
      mock.state.failNext = 0;
      mock.state.requests = 0;
    },
    async close() {
      await stopNode();
      mock.server.close();
      mock.server.closeAllConnections();
      rmSync(dir, { recursive: true, force: true });
    },
    appUrl: () => appUrl,
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;
