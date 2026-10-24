# Case Study: Lead Recovery & CRM Automation

*Portfolio demonstration. This is not a client engagement. No customer, revenue or performance results are claimed. All data is synthetic, and the CRM is simulated locally.*

## The business problem

Small service businesses rely on website enquiries reaching their CRM so someone follows up quickly. Many integrations are a single "form → CRM" call. When the CRM is briefly unavailable, rate-limits the request, or the integration server restarts at the wrong moment, the enquiry can fail without anyone noticing. A sender that retries can do the opposite and create duplicate contacts. Both cost time, and lost enquiries may cost customers.

## The demonstrated solution

A small backend service between the website and the CRM that:

- **Accepts only genuine requests:** a signed webhook (HMAC-SHA256, Standard Webhooks format) with a 5-minute replay window.
- **Validates input** and returns clear field-level errors.
- **Stores every accepted enquiry before contacting the CRM**, so a CRM failure doesn't lose it.
- **Retries automatically** with exponential backoff and jitter, honouring the CRM's `Retry-After`. It stops after a set number of attempts and marks the lead as failed for a person to review.
- **Never automatically retries permanent errors** such as a rejected request.
- **Recovers after a crash:** an attempt interrupted by a process crash is picked up again once its time-limited lease expires.
- **Avoids duplicates:** repeated deliveries of the same event are recognised. Each CRM call carries an idempotency key, and the simulated CRM upserts by email.
- **Schedules one follow-up task** per successfully synced lead. It is simulated: logged, never sent.
- **Gives operators visibility** through a CLI listing pending, completed and failed leads, with personal data hidden by default.

## Technologies and architecture

TypeScript on Node.js 24, using built-in modules for HTTP, SQLite (`node:sqlite`), cryptography and testing. There is one runtime dependency, Zod, for validation. SQLite acts as both the idempotency ledger and a durable retry queue. A background worker runs inside the same process. GitHub Actions runs typecheck, build and tests.

```
Website → signed webhook → validate → store (SQLite) → CRM attempt
                                            ↑                ↓ failure
                               background worker ← retry queue (backoff, leases)
```

Full diagrams are in the [README](../README.md#how-it-works).

## Tested failure scenarios

46 automated tests exercise the real HTTP server, a real SQLite file and the simulated CRM, using a controllable clock. They include:

- Forged, missing or replayed signatures (rejected, nothing stored)
- Invalid data, malformed JSON, oversized requests
- The same event delivered repeatedly, concurrently (5 at once) and after a restart
- A CRM outage during submission: the lead is delivered automatically after recovery, with no resend from the website
- A CRM that keeps failing: the lead stops at the attempt limit in a terminal failed state
- Permanent CRM errors, rate limiting with `Retry-After`, and CRM timeouts
- A process crash mid-attempt, including a crash on the final allowed attempt
- A slow worker whose late result must not overwrite a newer one
- Two worker processes sharing one database
- Follow-ups created once and executed once; logs free of personal data

Outage recovery and hard-crash (`kill -9`) recovery were also demonstrated by hand on the running application.

## Limitations

- CRM delivery is **at-least-once with an idempotency key**, not exactly-once. Whether duplicates are fully prevented depends on the real CRM supporting idempotency keys or upserts.
- Enquiries that never reach the service, or are rejected as invalid, aren't recovered. Storage is one SQLite file on one machine.
- The first CRM attempt runs inside the webhook request, so a slow CRM slows the response.
- Follow-ups are simulated. Real messaging would need consent handling (UK PECR/GDPR), opt-outs and its own retries.
- There's no alerting, data-retention job or multi-server deployment. The CRM is simulated.

## Potential real-world applications

The same pattern (verify, store first, retry with limits, check for repeats, inspect) applies wherever one system must reliably pass records to another:

- Website or landing-page forms → HubSpot, Pipedrive, Salesforce, Zoho or GoHighLevel
- Ad lead forms or booking tools → CRM
- Payment or e-commerce webhooks → accounting or fulfilment systems
- CRM → email/SMS platforms, once consent and opt-out handling are in place

Each real integration would need the target system's own API limits, authentication, field mapping and duplicate rules checked against its official documentation.
