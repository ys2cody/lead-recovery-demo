// Storage-level behaviour: schema migration from the Phase 1 database.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LeadRepository } from '../src/leads/repository.ts';

it('migrates a v1 database: synced rows kept, failed/stuck rows queued for retry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lead-recovery-migrate-'));
  const path = join(dir, 'leads.db');
  try {
    const v1 = new DatabaseSync(path);
    v1.exec(`
      CREATE TABLE leads (id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('processing','synced','failed')), crm_contact_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX leads_status ON leads (status);
      INSERT INTO leads VALUES ('a','evt_a','{"name":"A","email":"a@example.com","source":"website"}','synced','crm_1',1,NULL,'t','t');
      INSERT INTO leads VALUES ('b','evt_b','{"name":"B","email":"b@example.com","source":"website"}','failed',NULL,1,'crm_http_500','t','t');
      INSERT INTO leads VALUES ('c','evt_c','{"name":"C","email":"c@example.com","source":"website"}','processing',NULL,1,NULL,'t','t');
    `);
    v1.close();

    const repo = new LeadRepository(path);
    assert.equal(repo.findById('a')?.status, 'synced');
    assert.equal(repo.findById('b')?.status, 'pending');
    assert.equal(repo.findById('c')?.status, 'pending');
    assert.deepEqual(repo.countByStatus(), { pending: 2, processing: 0, synced: 1, failed: 0 });
    assert.equal(repo.claimDue(Date.now(), 1000, 10).length, 2, 'migrated rows are immediately due');
    repo.close();

    new LeadRepository(path).close(); // re-opening an up-to-date database is a no-op
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
