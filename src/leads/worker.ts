// In-process background worker: recovers expired leases, retries due leads and runs due
// (simulated) follow-ups. Ticks never overlap; stop() waits for the current tick to finish.
import type { LeadRepository } from './repository.ts';
import type { SyncLead } from './sync.ts';
import type { Logger } from '../logger.ts';

export interface WorkerDeps {
  repo: LeadRepository;
  sync: SyncLead;
  logger: Logger;
  clock: () => number;
  leaseMs: number;
  maxAttempts: number;
  batchSize: number;
  pollIntervalMs: number;
}

export interface TickResult {
  recovered: number;
  attempted: number;
  followUps: number;
}

export function createWorker({ repo, sync, logger, clock, leaseMs, maxAttempts, batchSize, pollIntervalMs }: WorkerDeps) {
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<unknown> | undefined;
  let running = false;

  async function runOnce(): Promise<TickResult> {
    const recovered = repo.recoverExpiredLeases(clock(), maxAttempts);
    for (const lead of recovered) {
      logger.warn('lead_lease_recovered', { leadId: lead.id, attempt: lead.attempts, status: lead.status });
    }

    const due = repo.claimDue(clock(), leaseMs, batchSize);
    await Promise.all(due.map((record) => sync(record)));

    // Simulation only: a real implementation would send via a provider and record the provider's
    // message id. Nothing leaves this machine.
    const followUps = repo.completeDueFollowUps(clock(), batchSize);
    for (const task of followUps) {
      logger.info('follow_up_simulated', { followUpId: task.id, leadId: task.leadId, kind: task.kind, delivered: false });
    }
    return { recovered: recovered.length, attempted: due.length, followUps: followUps.length };
  }

  function loop(): void {
    current = runOnce()
      .catch((err: unknown) => logger.error('worker_tick_failed', { error: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        current = undefined;
        if (running) timer = setTimeout(loop, pollIntervalMs);
      });
  }

  return {
    runOnce,
    start(): void {
      if (running) return;
      running = true;
      timer = setTimeout(loop, 0); // first tick immediately: recovers work left by a crash
      logger.info('worker_started', { pollIntervalMs, batchSize, maxAttempts });
    },
    async stop(): Promise<void> {
      running = false;
      clearTimeout(timer);
      await current;
    },
  };
}
