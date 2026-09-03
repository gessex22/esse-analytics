type LogLevel = 'info' | 'warn' | 'error';

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function write(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  if (level === 'error') console.error(entry);
  else if (level === 'warn') console.warn(entry);
  else console.log(entry);
}

export const logger = {
  info: (event: string, fields?: Record<string, unknown>) => write('info', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => write('warn', event, fields),
  error: (event: string, fields?: Record<string, unknown>) => write('error', event, fields),
};
