// One CRM delivery attempt for a leased lead, and the state transition that follows.
// Shared by the webhook (first attempt) and the background worker (retries).
import type { LeadRecord, LeadRepository } from './repository.ts';
import { backoffDelay, type RetryPolicy } from './retry-policy.ts';
import type { CrmClient, CrmResult } from '../crm/client.ts';
import type { Logger } from '../logger.ts';

export const FOLLOW_UP_KIND = 'first_contact_call';

export type SyncOutcome =
  | { status: 'synced'; crmContactId: string }
  | { status: 'retry_scheduled'; error: string; nextAttemptAt: number }
  | { status: 'failed'; error: string }
  | { status: 'lease_lost' };

export interface SyncDeps {
  repo: LeadRepository;
  crm: CrmClient;
  logger: Logger;
  policy: RetryPolicy;
  followUpDelayMs: number;
  clock: () => number;
  random?: () => number;
}

export type SyncLead = (record: LeadRecord) => Promise<SyncOutcome>;

export function createLeadSync({ repo, crm, logger, policy, followUpDelayMs, clock, random }: SyncDeps): SyncLead {
  return async (record) => {
    const leaseToken = record.leaseToken;
    if (record.status !== 'processing' || !leaseToken) throw new Error('syncLead requires a leased (processing) record');
    const ctx = { leadId: record.id, attempt: record.attempts };

    let result: CrmResult;
    try {
      // The lead id is sent as the CRM idempotency key; a CRM that honours it (or upserts by email) won't create a second contact on retry.
      result = await crm.upsertContact(record.lead, record.id);
    } catch {
      result = { ok: false, transient: true, error: 'crm_client_error' };
    }
    const now = clock();

    const leaseLost = (): SyncOutcome => {
      logger.warn('lead_lease_lost', ctx);
      return { status: 'lease_lost' };
    };

    if (result.ok) {
      const dueAt = now + followUpDelayMs;
      if (!repo.completeSync(record.id, leaseToken, result.contactId, now, { kind: FOLLOW_UP_KIND, dueAt })) return leaseLost();
      logger.info('lead_synced', { ...ctx, crmContactId: result.contactId, followUpDueAt: new Date(dueAt).toISOString() });
      return { status: 'synced', crmContactId: result.contactId };
    }

    if (result.transient && record.attempts < policy.maxAttempts) {
      const delayMs = backoffDelay(record.attempts, policy, random, result.retryAfterMs);
      const nextAttemptAt = now + delayMs;
      if (!repo.scheduleRetry(record.id, leaseToken, result.error, nextAttemptAt, now)) return leaseLost();
      logger.warn('lead_retry_scheduled', { ...ctx, error: result.error, delayMs });
      return { status: 'retry_scheduled', error: result.error, nextAttemptAt };
    }

    if (!repo.markFailed(record.id, leaseToken, result.error, now)) return leaseLost();
    logger.error('lead_failed', { ...ctx, error: result.error, cause: result.transient ? 'max_attempts_reached' : 'permanent_error' });
    return { status: 'failed', error: result.error };
  };
}
