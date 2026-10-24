// Persistent lead store, idempotency ledger and durable retry queue (SQLite via node:sqlite).
//
//   claim ─► processing ─┬─► synced  (+ one follow-up task)
//                        ├─► pending ─(due)─► processing …   transient error, attempts left
//                        └─► failed                         permanent error or attempts exhausted
//   processing with an expired lease (crash / hung worker) ─► pending (or failed if exhausted)
//
// Concurrency: every transition is a single conditional UPDATE, so it is atomic even across
// processes. Finishing a lead requires the lease token from its claim; a worker whose lease
// expired cannot overwrite the result of the worker that took over.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Lead } from './schema.ts';

export const LEAD_STATUSES = ['pending', 'processing', 'synced', 'failed'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export interface LeadRecord {
  id: string;
  webhookId: string;
  lead: Lead;
  status: LeadStatus;
  crmContactId: string | null;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: number | null; // epoch ms, set while pending
  lockedUntil: number | null; // epoch ms, set while processing
  leaseToken: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FollowUpRecord {
  id: string;
  leadId: string;
  kind: string;
  status: 'scheduled' | 'completed';
  dueAt: number;
  createdAt: string;
  completedAt: string | null;
}

export type ClaimResult = { kind: 'new' | 'duplicate'; record: LeadRecord };

const SCHEMA_VERSION = 2;

interface LeadRow {
  id: string;
  webhook_id: string;
  payload: string;
  status: LeadStatus;
  crm_contact_id: string | null;
  attempts: number;
  last_error: string | null;
  next_attempt_at: number | null;
  locked_until: number | null;
  lease_token: string | null;
  created_at: string;
  updated_at: string;
}

interface FollowUpRow {
  id: string;
  lead_id: string;
  kind: string;
  status: 'scheduled' | 'completed';
  due_at: number;
  created_at: string;
  completed_at: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

export class LeadRepository {
  #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.#migrate();
  }

  /** Records a new delivery as `processing` under a lease, or reports it as a duplicate. */
  claim(webhookId: string, lead: Lead, now: number, leaseMs: number): ClaimResult {
    const inserted = this.#db
      .prepare(
        `INSERT INTO leads (id, webhook_id, payload, status, attempts, locked_until, lease_token, created_at, updated_at)
         VALUES (?, ?, ?, 'processing', 1, ?, ?, ?, ?)
         ON CONFLICT (webhook_id) DO NOTHING`,
      )
      .run(randomUUID(), webhookId, JSON.stringify(lead), now + leaseMs, randomUUID(), iso(now), iso(now));
    const record = this.findByWebhookId(webhookId);
    if (!record) throw new Error('Lead row missing immediately after claim');
    return { kind: inserted.changes === 1 ? 'new' : 'duplicate', record };
  }

  /** Atomically leases up to `limit` pending leads whose retry time has arrived. */
  claimDue(now: number, leaseMs: number, limit: number): LeadRecord[] {
    const rows = this.#db
      .prepare(
        `UPDATE leads
         SET status = 'processing', attempts = attempts + 1, next_attempt_at = NULL,
             locked_until = ?, lease_token = lower(hex(randomblob(16))), updated_at = ?
         WHERE id IN (SELECT id FROM leads WHERE status = 'pending' AND next_attempt_at <= ?
                      ORDER BY next_attempt_at LIMIT ?)
         RETURNING *`,
      )
      .all(now + leaseMs, iso(now), now, limit) as unknown as LeadRow[];
    return rows.map(toLead);
  }

  /** Releases leads whose lease expired (worker crashed or hung). Returns what was recovered. */
  recoverExpiredLeases(now: number, maxAttempts: number): Pick<LeadRecord, 'id' | 'status' | 'attempts'>[] {
    return this.#db
      .prepare(
        `UPDATE leads
         SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
             next_attempt_at = CASE WHEN attempts >= ? THEN NULL ELSE ? END,
             last_error = 'lease_expired', locked_until = NULL, lease_token = NULL, updated_at = ?
         WHERE status = 'processing' AND locked_until < ?
         RETURNING id, status, attempts`,
      )
      .all(maxAttempts, maxAttempts, now, iso(now), now) as unknown as Pick<LeadRecord, 'id' | 'status' | 'attempts'>[];
  }

  /** Marks the lead synced and schedules its follow-up in one transaction. False if the lease was lost. */
  completeSync(id: string, leaseToken: string, crmContactId: string, now: number, followUp: { kind: string; dueAt: number }): boolean {
    return this.#transaction(() => {
      const updated = this.#finish(
        `status = 'synced', crm_contact_id = ?, last_error = NULL, next_attempt_at = NULL`,
        [crmContactId],
        id,
        leaseToken,
        now,
      );
      if (updated) {
        this.#db
          .prepare(
            `INSERT INTO follow_ups (id, lead_id, kind, status, due_at, created_at)
             VALUES (?, ?, ?, 'scheduled', ?, ?) ON CONFLICT (lead_id, kind) DO NOTHING`,
          )
          .run(randomUUID(), id, followUp.kind, followUp.dueAt, iso(now));
      }
      return updated;
    });
  }

  scheduleRetry(id: string, leaseToken: string, error: string, nextAttemptAt: number, now: number): boolean {
    return this.#finish(`status = 'pending', last_error = ?, next_attempt_at = ?`, [error, nextAttemptAt], id, leaseToken, now);
  }

  markFailed(id: string, leaseToken: string, error: string, now: number): boolean {
    return this.#finish(`status = 'failed', last_error = ?, next_attempt_at = NULL`, [error], id, leaseToken, now);
  }

  /** Operator action: put a terminally failed lead back in the queue with a fresh attempt budget. */
  requeue(id: string, now: number): boolean {
    return (
      this.#db
        .prepare(`UPDATE leads SET status = 'pending', attempts = 0, next_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'failed'`)
        .run(now, iso(now), id).changes === 1
    );
  }

  /** Atomically marks due follow-ups completed and returns them (each is returned exactly once). */
  completeDueFollowUps(now: number, limit: number): FollowUpRecord[] {
    const rows = this.#db
      .prepare(
        `UPDATE follow_ups SET status = 'completed', completed_at = ?
         WHERE id IN (SELECT id FROM follow_ups WHERE status = 'scheduled' AND due_at <= ? ORDER BY due_at LIMIT ?)
         RETURNING *`,
      )
      .all(iso(now), now, limit) as unknown as FollowUpRow[];
    return rows.map(toFollowUp);
  }

  findById(id: string): LeadRecord | undefined {
    const row = this.#db.prepare(`SELECT * FROM leads WHERE id = ?`).get(id) as LeadRow | undefined;
    return row && toLead(row);
  }

  findByWebhookId(webhookId: string): LeadRecord | undefined {
    const row = this.#db.prepare(`SELECT * FROM leads WHERE webhook_id = ?`).get(webhookId) as LeadRow | undefined;
    return row && toLead(row);
  }

  list(status: LeadStatus | undefined, limit: number): LeadRecord[] {
    const rows = status
      ? this.#db.prepare(`SELECT * FROM leads WHERE status = ? ORDER BY created_at DESC LIMIT ?`).all(status, limit)
      : this.#db.prepare(`SELECT * FROM leads ORDER BY created_at DESC LIMIT ?`).all(limit);
    return (rows as unknown as LeadRow[]).map(toLead);
  }

  countByStatus(): Record<LeadStatus, number> {
    const counts = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0])) as Record<LeadStatus, number>;
    const rows = this.#db.prepare(`SELECT status, COUNT(*) AS n FROM leads GROUP BY status`).all() as { status: LeadStatus; n: number }[];
    for (const { status, n } of rows) counts[status] = n;
    return counts;
  }

  followUpsForLead(leadId: string): FollowUpRecord[] {
    const rows = this.#db.prepare(`SELECT * FROM follow_ups WHERE lead_id = ? ORDER BY due_at`).all(leadId) as unknown as FollowUpRow[];
    return rows.map(toFollowUp);
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }

  #finish(set: string, params: (string | number)[], id: string, leaseToken: string, now: number): boolean {
    const result = this.#db
      .prepare(
        `UPDATE leads SET ${set}, locked_until = NULL, lease_token = NULL, updated_at = ?
         WHERE id = ? AND status = 'processing' AND lease_token = ?`,
      )
      .run(...params, iso(now), id, leaseToken);
    return result.changes === 1;
  }

  #transaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  #migrate(): void {
    const { user_version: version } = this.#db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version >= SCHEMA_VERSION) return;
    const hasV1 = this.#db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'leads'`).get() !== undefined;

    this.#transaction(() => {
      if (hasV1) this.#db.exec('ALTER TABLE leads RENAME TO leads_v1');
      this.#db.exec(`
        CREATE TABLE leads (
          id              TEXT PRIMARY KEY,
          webhook_id      TEXT NOT NULL UNIQUE,
          payload         TEXT NOT NULL,
          status          TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'synced', 'failed')),
          crm_contact_id  TEXT,
          attempts        INTEGER NOT NULL DEFAULT 0,
          last_error      TEXT,
          next_attempt_at INTEGER,
          locked_until    INTEGER,
          lease_token     TEXT,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL
        );
        CREATE INDEX leads_due ON leads (status, next_attempt_at);
        CREATE INDEX leads_lease ON leads (status, locked_until);
        CREATE TABLE follow_ups (
          id           TEXT PRIMARY KEY,
          lead_id      TEXT NOT NULL REFERENCES leads (id),
          kind         TEXT NOT NULL,
          status       TEXT NOT NULL CHECK (status IN ('scheduled', 'completed')),
          due_at       INTEGER NOT NULL,
          created_at   TEXT NOT NULL,
          completed_at TEXT,
          UNIQUE (lead_id, kind)
        );
        CREATE INDEX follow_ups_due ON follow_ups (status, due_at);
      `);
      if (hasV1) {
        // v1 had no retry queue: anything not synced becomes pending and is retried immediately.
        this.#db.exec(`
          INSERT INTO leads (id, webhook_id, payload, status, crm_contact_id, attempts, last_error, next_attempt_at, created_at, updated_at)
          SELECT id, webhook_id, payload,
                 CASE status WHEN 'synced' THEN 'synced' ELSE 'pending' END,
                 crm_contact_id, attempts, last_error,
                 CASE status WHEN 'synced' THEN NULL ELSE 0 END,
                 created_at, updated_at
          FROM leads_v1;
          DROP TABLE leads_v1;
        `);
      }
      this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }
}

function toLead(row: LeadRow): LeadRecord {
  return {
    id: row.id,
    webhookId: row.webhook_id,
    lead: JSON.parse(row.payload) as Lead,
    status: row.status,
    crmContactId: row.crm_contact_id,
    attempts: row.attempts,
    lastError: row.last_error,
    nextAttemptAt: row.next_attempt_at,
    lockedUntil: row.locked_until,
    leaseToken: row.lease_token,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toFollowUp(row: FollowUpRow): FollowUpRecord {
  return {
    id: row.id,
    leadId: row.lead_id,
    kind: row.kind,
    status: row.status,
    dueAt: row.due_at,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}
