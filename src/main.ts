// Composition root: wires config, storage, CRM client, worker and HTTP server together.
import type { Server } from 'node:http';
import { loadConfig, type Config } from './config.ts';
import { createLogger } from './logger.ts';
import { LeadRepository } from './leads/repository.ts';
import { createCrmClient } from './crm/client.ts';
import { createMockCrm } from './crm/mock-server.ts';
import { createLeadSync } from './leads/sync.ts';
import { createLeadIntake } from './leads/intake.ts';
import { createWorker } from './leads/worker.ts';
import { createApp } from './http/server.ts';

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const logger = createLogger(config.LOG_LEVEL);
const clock = Date.now;

const mock = config.START_MOCK_CRM ? createMockCrm({ apiKey: config.CRM_API_KEY, mode: config.MOCK_CRM_MODE }) : undefined;
mock?.server.listen(config.MOCK_CRM_PORT, '127.0.0.1', () =>
  logger.info('mock_crm_listening', { url: `http://127.0.0.1:${config.MOCK_CRM_PORT}`, mode: config.MOCK_CRM_MODE }),
);

const repo = new LeadRepository(config.DB_PATH);
const crm = createCrmClient({ baseUrl: config.CRM_BASE_URL, apiKey: config.CRM_API_KEY, timeoutMs: config.CRM_TIMEOUT_MS });
const policy = { maxAttempts: config.RETRY_MAX_ATTEMPTS, baseDelayMs: config.RETRY_BASE_DELAY_MS, maxDelayMs: config.RETRY_MAX_DELAY_MS };
const sync = createLeadSync({ repo, crm, logger, policy, followUpDelayMs: config.FOLLOW_UP_DELAY_MS, clock });
const intake = createLeadIntake({ repo, sync, logger, clock, leaseMs: config.LEASE_MS });
const worker = createWorker({
  repo,
  sync,
  logger,
  clock,
  leaseMs: config.LEASE_MS,
  maxAttempts: config.RETRY_MAX_ATTEMPTS,
  batchSize: config.WORKER_BATCH_SIZE,
  pollIntervalMs: config.WORKER_POLL_MS,
});
const app = createApp({ webhookSecret: config.WEBHOOK_SECRET, toleranceSeconds: config.WEBHOOK_TOLERANCE_SECONDS, intake, logger });

app.listen(config.PORT, config.HOST, () => {
  logger.info('app_listening', { url: `http://${config.HOST}:${config.PORT}`, db: config.DB_PATH });
  worker.start();
});

async function shutdown(signal: string): Promise<void> {
  logger.info('shutting_down', { signal });
  setTimeout(() => process.exit(1), 10_000).unref(); // hard stop if something hangs
  // Stop taking new work, let in-flight requests and the current worker tick finish, then close the DB.
  const appClosed = new Promise<void>((resolve) => app.close(() => resolve()));
  app.closeIdleConnections();
  mock?.server.close();
  mock?.server.closeAllConnections();
  await Promise.all([appClosed, worker.stop()]);
  repo.close();
  logger.info('stopped');
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
