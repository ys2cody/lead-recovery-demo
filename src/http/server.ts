// HTTP boundary: routing, body limits, authentication, validation and response mapping.
// Order matters: signature is checked on the raw bytes BEFORE parsing anything.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { verifySignature } from '../webhooks/signature.ts';
import { parseLead } from '../leads/schema.ts';
import type { LeadIntake } from '../leads/intake.ts';
import type { Logger } from '../logger.ts';

export const MAX_BODY_BYTES = 64 * 1024;
const WEBHOOK_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface AppDeps {
  webhookSecret: string;
  toleranceSeconds: number;
  intake: LeadIntake;
  logger: Logger;
  now?: () => number; // ms; injectable for deterministic tests
}

export function createApp({ webhookSecret, toleranceSeconds, intake, logger, now = Date.now }: AppDeps) {
  return createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      logger.error('unhandled_request_error', { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) send(res, 500, { error: 'internal_error' });
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/health') return send(res, 200, { status: 'ok' });
    if (path === '/webhooks/leads') {
      if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
      return receiveLead(req, res);
    }
    send(res, 404, { error: 'not_found' });
  }

  async function receiveLead(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      return send(res, 415, { error: 'unsupported_media_type', expected: 'application/json' });
    }
    const body = await readBody(req, MAX_BODY_BYTES);
    if (!body) return send(res, 413, { error: 'payload_too_large', maxBytes: MAX_BODY_BYTES }, { connection: 'close' });

    const headers = {
      id: header(req, 'webhook-id'),
      timestamp: header(req, 'webhook-timestamp'),
      signature: header(req, 'webhook-signature'),
    };
    const auth = verifySignature(webhookSecret, headers, body, Math.floor(now() / 1000), toleranceSeconds);
    if (!auth.ok) {
      logger.warn('webhook_rejected', { reason: auth.reason });
      return send(res, 401, { error: auth.reason });
    }
    const webhookId = headers.id as string;
    if (!WEBHOOK_ID.test(webhookId)) return send(res, 400, { error: 'invalid_webhook_id' });

    let json: unknown;
    try {
      json = JSON.parse(body.toString('utf8'));
    } catch {
      return send(res, 400, { error: 'invalid_json' });
    }
    const parsed = parseLead(json);
    if (!parsed.ok) {
      logger.info('lead_validation_failed', { webhookId, fields: parsed.errors.map((e) => e.field) });
      return send(res, 422, { error: 'validation_failed', details: parsed.errors });
    }

    const outcome = await intake(webhookId, parsed.lead);
    // 202 for pending/failed: the lead is safely stored, so the sender must not redeliver.
    const status = outcome.status === 'created' ? 201 : outcome.status === 'duplicate' ? 200 : 202;
    send(res, status, outcome);
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

// Returns null when the body exceeds the limit (the rest of the stream is discarded).
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const declared = Number(req.headers['content-length']);
  if (declared > limit) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
