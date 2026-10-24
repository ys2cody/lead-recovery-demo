// Local stand-in for a real CRM. Nothing leaves the machine.
// Behaviour is switchable at runtime so failures can be demonstrated live:
//   POST /__control {"mode": "fail-500"}   or   {"failNext": 2}
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

export const CRM_MODES = ['ok', 'fail-500', 'fail-429', 'fail-400', 'timeout'] as const;
export type CrmMode = (typeof CRM_MODES)[number];

export interface MockContact {
  id: string;
  name: string;
  email: string;
  phone?: string;
  source?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MockCrmOptions {
  apiKey: string;
  mode?: CrmMode;
}

export function createMockCrm({ apiKey, mode = 'ok' }: MockCrmOptions) {
  const state = { mode, failNext: 0, requests: 0 };
  const contacts = new Map<string, MockContact>(); // keyed by lower-cased email
  const idempotencyKeys = new Map<string, string>(); // idempotency key -> contact id

  const server = createServer((req, res) => {
    handle(req, res).catch(() => send(res, 500, { error: 'mock_crm_internal_error' }));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'POST' && url.pathname === '/__control') {
      const body = (await readJson(req)) as { mode?: string; failNext?: number } | null;
      if (body?.mode !== undefined) {
        if (!CRM_MODES.includes(body.mode as CrmMode)) return send(res, 400, { error: 'unknown_mode', modes: CRM_MODES });
        state.mode = body.mode as CrmMode;
      }
      if (body?.failNext !== undefined) state.failNext = Math.max(0, Math.floor(body.failNext));
      return send(res, 200, { mode: state.mode, failNext: state.failNext });
    }

    if (req.headers.authorization !== `Bearer ${apiKey}`) return send(res, 401, { error: 'unauthorized' });

    if (req.method === 'GET' && url.pathname === '/contacts') return send(res, 200, { contacts: [...contacts.values()] });

    if (req.method === 'POST' && url.pathname === '/contacts') {
      state.requests++;
      if (state.failNext > 0) {
        state.failNext--;
        return send(res, 503, { error: 'temporarily_unavailable' });
      }
      if (state.mode === 'timeout') return; // never answer; the client's timeout must fire
      if (state.mode === 'fail-500') return send(res, 500, { error: 'internal_error' });
      if (state.mode === 'fail-429') return send(res, 429, { error: 'rate_limited' }, { 'retry-after': '1' });
      if (state.mode === 'fail-400') return send(res, 400, { error: 'bad_request' });

      const body = (await readJson(req)) as Partial<MockContact> | null;
      if (typeof body?.email !== 'string' || typeof body.name !== 'string') return send(res, 400, { error: 'name_and_email_required' });

      const key = req.headers['idempotency-key'];
      const replayedId = typeof key === 'string' ? idempotencyKeys.get(key) : undefined;
      if (replayedId) return send(res, 200, { id: replayedId, replayed: true });

      // Upsert by email: a repeat enquiry from the same person updates one contact.
      const email = body.email.toLowerCase();
      const now = new Date().toISOString();
      const existing = contacts.get(email);
      const contact: MockContact = {
        id: existing?.id ?? `crm_${randomUUID().slice(0, 8)}`,
        name: body.name,
        email,
        ...(body.phone !== undefined && { phone: body.phone }),
        ...(body.source !== undefined && { source: body.source }),
        ...(body.notes !== undefined && { notes: body.notes }),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      contacts.set(email, contact);
      if (typeof key === 'string') idempotencyKeys.set(key, contact.id);
      return send(res, existing ? 200 : 201, { id: contact.id });
    }

    send(res, 404, { error: 'not_found' });
  }

  return { server, state, contacts };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
}
