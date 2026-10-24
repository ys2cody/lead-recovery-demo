# 2-Minute Demo Recording Script

**Story:** a customer enquires while the CRM is down. The enquiry is kept and reaches the CRM automatically when it comes back, without anyone resending it.

## Before recording (not on camera)

- [ ] Fresh state: `rm -f data/leads.db data/leads.db-wal data/leads.db-shm`
- [ ] `.env` exists with a generated `WEBHOOK_SECRET`. **Never show `.env` on screen.**
- [ ] Demo timings in `.env`: `RETRY_BASE_DELAY_MS=1000`, `RETRY_MAX_DELAY_MS=4000`, `FOLLOW_UP_DELAY_MS=5000`, `LEASE_MS=8000`, `MOCK_CRM_MODE=ok`
- [ ] Terminal font ≥ 16 pt, dark theme, two panes side by side: **left = app logs**, **right = commands**
- [ ] Notifications off, unrelated windows closed
- [ ] Do a full dry run once; nothing on screen should be real customer data

## Script

| Time | On screen | Say |
|---|---|---|
| 0:00–0:15 | README "In plain English" section | "This is a portfolio demo of a website-to-CRM integration built for the moment the CRM goes down. It uses a simulated CRM and made-up data, and it never sends real messages." |
| 0:15–0:25 | Left: `npm run dev` | "One process: the webhook, a simulated CRM, and a background worker that handles retries." |
| 0:25–0:40 | Right: `npm run send-lead -- --id evt_ok` → `201 created` | "A normal enquiry: signed, validated, stored, then created in the CRM." |
| 0:40–0:50 | Right: `npm run send-lead -- --id evt_ok` → `200 duplicate` | "If the website sends the same enquiry again, it's recognised and not processed twice." |
| 0:50–1:05 | Right: `curl -s -X POST localhost:4010/__control -d '{"mode":"fail-500"}'` then `npm run send-lead -- --id evt_outage --email sam@example.com` → `202 pending` | "Now the CRM goes down and a new enquiry arrives. It's saved first, so the failure doesn't lose it." |
| 1:05–1:20 | Left: `lead_retry_scheduled` lines with growing `delayMs`. Right: `npm run leads -- list --status pending` | "The worker keeps retrying, waiting a little longer each time. Personal details are hidden in the logs and in this list." |
| 1:20–1:40 | Right: `curl -s -X POST localhost:4010/__control -d '{"mode":"ok"}'`, wait, then `npm run leads -- list` → `synced` | "The CRM comes back. Nobody resends anything, and on the next retry the enquiry goes through by itself." |
| 1:40–1:50 | Left: `follow_up_simulated` line | "A follow-up task was scheduled after the sync. In this demo it's only logged; nothing is sent." |
| 1:50–2:00 | Browser: README "Tested failure scenarios" table | "The same behaviour is covered by automated tests: crashes, retry limits, permanent errors, duplicates. The limitations are documented too." |

## Wording to avoid

Don't say "guaranteed", "never loses a lead", "exactly once", or any figures about leads recovered or revenue. Say instead: "keeps the enquiry and retries automatically", "recognises repeated deliveries", "tested failure scenarios".

## Optional 30-second extension: crash recovery

```bash
curl -s -X POST localhost:4010/__control -d '{"mode":"timeout"}'
npm run send-lead -- --id evt_crash --email alex@example.com &
sleep 1; pkill -9 -f "src/main.ts"
npm run leads -- list --status processing   # stuck mid-attempt
npm run dev                                 # restart; after LEASE_MS the lead is recovered and synced
```

Say: "Even if the server is killed mid-request, the enquiry is picked up again after restart."
