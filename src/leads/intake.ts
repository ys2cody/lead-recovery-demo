// Lead intake use case: claim (idempotency) → first CRM attempt → outcome for the webhook response.
// The lead is stored before the CRM call, so a CRM outage leaves it queued for retry instead of dropping it.
import type { Lead } from './schema.ts';
import type { LeadRepository, LeadStatus } from './repository.ts';
import type { SyncLead } from './sync.ts';
import type { Logger } from '../logger.ts';

export type IntakeOutcome =
  | { status: 'created'; leadId: string; crmContactId: string }
  | { status: 'duplicate'; leadId: string; state: LeadStatus; crmContactId: string | null }
  | { status: 'pending'; leadId: string; reason: string; nextAttemptAt?: string }
  | { status: 'failed'; leadId: string; reason: string };

export interface IntakeDeps {
  repo: LeadRepository;
  sync: SyncLead;
  logger: Logger;
  clock: () => number;
  leaseMs: number;
}

export type LeadIntake = (webhookId: string, lead: Lead) => Promise<IntakeOutcome>;

export function createLeadIntake({ repo, sync, logger, clock, leaseMs }: IntakeDeps): LeadIntake {
  return async (webhookId, lead) => {
    const { kind, record } = repo.claim(webhookId, lead, clock(), leaseMs);

    if (kind === 'duplicate') {
      logger.info('lead_duplicate_ignored', { leadId: record.id, webhookId, state: record.status });
      return { status: 'duplicate', leadId: record.id, state: record.status, crmContactId: record.crmContactId };
    }

    logger.info('lead_received', { leadId: record.id, webhookId });
    const outcome = await sync(record);
    switch (outcome.status) {
      case 'synced':
        return { status: 'created', leadId: record.id, crmContactId: outcome.crmContactId };
      case 'retry_scheduled':
        return { status: 'pending', leadId: record.id, reason: outcome.error, nextAttemptAt: new Date(outcome.nextAttemptAt).toISOString() };
      case 'failed':
        return { status: 'failed', leadId: record.id, reason: outcome.error };
      case 'lease_lost':
        return { status: 'pending', leadId: record.id, reason: 'lease_lost' };
    }
  };
}
