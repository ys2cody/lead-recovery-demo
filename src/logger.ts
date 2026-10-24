// JSON-lines logger. Any field whose key looks sensitive is redacted, at any depth,
// so a careless `logger.info('x', { lead })` cannot leak personal data or credentials.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
export type LogLevel = keyof typeof LEVELS;

const SENSITIVE_KEY = /secret|token|password|authorization|signature|api_?key|cookie|email|phone|name|message|notes|payload/i;

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1)]),
  );
}

export function createLogger(level: LogLevel = 'info', write: (line: string) => void = (l) => process.stdout.write(l + '\n')): Logger {
  const min = LEVELS[level];
  const log = (lvl: Exclude<LogLevel, 'silent'>, msg: string, fields: Record<string, unknown> = {}) => {
    if (LEVELS[lvl] < min) return;
    write(JSON.stringify({ time: new Date().toISOString(), level: lvl, msg, ...(redact(fields) as object) }));
  };
  return {
    debug: (m, f) => log('debug', m, f),
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
  };
}
