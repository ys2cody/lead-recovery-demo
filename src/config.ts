// Environment configuration, validated at startup. Error messages name the variable, never its value.
import { z } from 'zod';
import { CRM_MODES } from './crm/mock-server.ts';

const port = z.coerce.number().int().min(0).max(65535);

const ms = (max: number) => z.coerce.number().int().positive().max(max);

const EnvSchema = z
  .object({
  HOST: z.string().default('127.0.0.1'),
  PORT: port.default(3000),
  WEBHOOK_SECRET: z.string().min(32, 'must be at least 32 characters (generate with: openssl rand -hex 32)'),
  WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().positive().max(3600).default(300),
  DB_PATH: z.string().min(1).default('data/leads.db'),
  CRM_BASE_URL: z.url().default('http://127.0.0.1:4010'),
  CRM_API_KEY: z.string().min(8, 'must be at least 8 characters'),
  CRM_TIMEOUT_MS: z.coerce.number().int().positive().max(60_000).default(5000),
  START_MOCK_CRM: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  MOCK_CRM_PORT: port.default(4010),
  MOCK_CRM_MODE: z.enum(CRM_MODES).default('ok'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),

  // Durable retries (see src/leads/retry-policy.ts)
  RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(6),
  RETRY_BASE_DELAY_MS: ms(3_600_000).default(2000),
  RETRY_MAX_DELAY_MS: ms(86_400_000).default(300_000),
  // A lead stuck in `processing` longer than this is treated as abandoned (crash) and retried.
  LEASE_MS: ms(3_600_000).default(30_000),
  WORKER_POLL_MS: ms(60_000).default(1000),
  WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(5),
  FOLLOW_UP_DELAY_MS: z.coerce.number().int().min(0).max(604_800_000).default(900_000),
  })
  .refine((c) => c.LEASE_MS > c.CRM_TIMEOUT_MS, {
    path: ['LEASE_MS'],
    message: 'must be greater than CRM_TIMEOUT_MS, or in-flight requests would be treated as abandoned',
  })
  .refine((c) => c.RETRY_BASE_DELAY_MS <= c.RETRY_MAX_DELAY_MS, {
    path: ['RETRY_BASE_DELAY_MS'],
    message: 'must not exceed RETRY_MAX_DELAY_MS',
  });

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = EnvSchema.safeParse(env);
  if (result.success) return result.data;
  const problems = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid configuration (see config/example.env):\n${problems}`);
}
