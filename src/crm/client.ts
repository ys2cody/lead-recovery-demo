// HTTP client for the CRM's "upsert contact" endpoint.
// Never throws: every outcome is classified so callers can decide whether a retry makes sense.
import type { Lead } from '../leads/schema.ts';

export type CrmResult =
  | { ok: true; contactId: string }
  | { ok: false; transient: boolean; error: string; retryAfterMs?: number };

export interface CrmClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

export type CrmClient = ReturnType<typeof createCrmClient>;

export function createCrmClient({ baseUrl, apiKey, timeoutMs }: CrmClientOptions) {
  return {
    async upsertContact(lead: Lead, idempotencyKey: string): Promise<CrmResult> {
      let response: Response;
      try {
        response = await fetch(new URL('/contacts', baseUrl), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
            'idempotency-key': idempotencyKey,
          },
          body: JSON.stringify({
            name: lead.name,
            email: lead.email,
            phone: lead.phone,
            source: lead.source,
            notes: lead.message,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const timedOut = err instanceof Error && err.name === 'TimeoutError';
        return { ok: false, transient: true, error: timedOut ? 'crm_timeout' : 'crm_unreachable' };
      }

      if (!response.ok) {
        await response.body?.cancel();
        // 408/429/5xx are worth retrying; other 4xx mean our request is wrong and retrying won't help.
        const transient = response.status === 408 || response.status === 429 || response.status >= 500;
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        return { ok: false, transient, error: `crm_http_${response.status}`, ...(retryAfterMs !== undefined && { retryAfterMs }) };
      }

      const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
      if (typeof body?.id !== 'string') return { ok: false, transient: false, error: 'crm_invalid_response' };
      return { ok: true, contactId: body.id };
    },
  };
}

// Retry-After is either delay-seconds or an HTTP date (RFC 9110 §10.2.3).
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
