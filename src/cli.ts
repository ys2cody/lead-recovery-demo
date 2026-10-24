// Local inspection CLI for the lead store. Personal data is hidden unless --show-pii is passed.
// Usage: npm run leads -- <stats | list | show <lead-id> | requeue <lead-id>> [--status s] [--limit n] [--show-pii]
import { parseArgs } from 'node:util';
import { LEAD_STATUSES, LeadRepository, type LeadRecord, type LeadStatus } from './leads/repository.ts';

const USAGE = `Usage: npm run leads -- <command> [options]

Commands:
  stats                 Count leads by status
  list                  List recent leads (newest first)
  show <lead-id>        Show one lead and its follow-up tasks
  requeue <lead-id>     Move a terminally failed lead back to the retry queue (resets attempts)

Options:
  --status <s>          Filter list by status: ${LEAD_STATUSES.join(', ')}
  --limit <n>           Max rows for list (default 20, max 500)
  --show-pii            Include name, email and phone (synthetic data only!)
`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function runCli(argv: string[], dbPath: string, out: (line: string) => void = console.log): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { status: { type: 'string' }, limit: { type: 'string', default: '20' }, 'show-pii': { type: 'boolean', default: false } },
    });
  } catch (err) {
    out(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, id] = positionals;
  const showPii = values['show-pii'];

  if (!command || !['stats', 'list', 'show', 'requeue'].includes(command)) {
    out(USAGE);
    return command ? 2 : 0;
  }
  if ((command === 'show' || command === 'requeue') && !(id && UUID.test(id))) {
    out(`${command} needs a lead id (UUID), e.g. from "npm run leads -- list"`);
    return 2;
  }
  if (values.status !== undefined && !LEAD_STATUSES.includes(values.status as LeadStatus)) {
    out(`Unknown status "${values.status}". Use one of: ${LEAD_STATUSES.join(', ')}`);
    return 2;
  }
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    out('--limit must be an integer between 1 and 500');
    return 2;
  }

  const repo = new LeadRepository(dbPath);
  try {
    if (command === 'stats') {
      out(JSON.stringify(repo.countByStatus(), null, 2));
      return 0;
    }
    if (command === 'list') {
      const rows = repo.list(values.status as LeadStatus | undefined, limit).map((r) => summarise(r, showPii, repo));
      out(rows.length ? table(rows) : 'No leads found.');
      return 0;
    }
    if (command === 'show') {
      const record = repo.findById(id as string);
      if (!record) return notFound(out);
      out(JSON.stringify({ ...summarise(record, showPii, repo), followUps: repo.followUpsForLead(record.id) }, null, 2));
      return 0;
    }
    // requeue
    if (!repo.findById(id as string)) return notFound(out);
    if (!repo.requeue(id as string, Date.now())) {
      out('Only leads in status "failed" can be requeued.');
      return 1;
    }
    out('Requeued. The running app will retry it on its next worker tick.');
    return 0;
  } finally {
    repo.close();
  }
}

function notFound(out: (line: string) => void): number {
  out('Lead not found.');
  return 1;
}

function summarise(r: LeadRecord, showPii: boolean, repo: LeadRepository): Record<string, unknown> {
  const followUp = repo.followUpsForLead(r.id)[0];
  return {
    leadId: r.id,
    webhookId: r.webhookId,
    status: r.status,
    attempts: r.attempts,
    lastError: r.lastError ?? '',
    nextAttemptAt: r.nextAttemptAt ? new Date(r.nextAttemptAt).toISOString() : '',
    crmContactId: r.crmContactId ?? '',
    followUp: followUp?.status ?? '',
    createdAt: r.createdAt,
    ...(showPii && { name: r.lead.name, email: r.lead.email, phone: r.lead.phone ?? '' }),
  };
}

function table(rows: Record<string, unknown>[]): string {
  const keys = Object.keys(rows[0] ?? {});
  const widths = keys.map((k) => Math.max(k.length, ...rows.map((r) => String(r[k]).length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  return [line(keys), line(widths.map((w) => '-'.repeat(w))), ...rows.map((r) => line(keys.map((k) => String(r[k]))))].join('\n');
}

if (import.meta.main) {
  process.exitCode = runCli(process.argv.slice(2), process.env.DB_PATH || 'data/leads.db');
}
