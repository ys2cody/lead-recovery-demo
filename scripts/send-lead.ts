// Demo tool: signs and sends a synthetic lead to the local webhook, like a website form backend would.
// Usage: npm run send-lead -- [--id <webhook-id>] [--email <email>] [--invalid] [--bad-signature] [--stale]
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { sign } from '../src/webhooks/signature.ts';

const { values: opts } = parseArgs({
  options: {
    id: { type: 'string' },
    email: { type: 'string', default: 'jane.doe@example.com' },
    url: { type: 'string', default: `http://127.0.0.1:${process.env.PORT ?? 3000}/webhooks/leads` },
    invalid: { type: 'boolean', default: false },
    'bad-signature': { type: 'boolean', default: false },
    stale: { type: 'boolean', default: false },
  },
});

const secret = process.env.WEBHOOK_SECRET;
if (!secret) {
  console.error('WEBHOOK_SECRET is not set. Run: cp config/example.env .env  (then set a secret)');
  process.exit(1);
}

// Synthetic data only (example.com is reserved for documentation, RFC 2606).
const lead = opts.invalid
  ? { name: '', email: 'not-an-email', budget: 5000 }
  : { name: 'Jane Doe', email: opts.email, phone: '+44 20 7946 0000', message: 'Interested in a quote for a kitchen refit.', source: 'website' };

const id = opts.id ?? `evt_${randomUUID()}`;
const timestamp = String(Math.floor(Date.now() / 1000) - (opts.stale ? 3600 : 0));
const body = JSON.stringify(lead);
const signature = opts['bad-signature'] ? 'v1,' + Buffer.alloc(32).toString('base64') : sign(secret, id, timestamp, body);

const response = await fetch(opts.url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signature },
  body,
});
console.log(`webhook-id: ${id}`);
console.log(`HTTP ${response.status}`);
console.log(JSON.stringify(await response.json(), null, 2));
