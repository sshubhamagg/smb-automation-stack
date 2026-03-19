export interface LogEntry {
  operation: string;
  status: 'success' | 'error';
  errorCode?: string;
  latencyMs: number;
}

let _logLevel = 'info';

export function setLogLevel(level: string): void {
  _logLevel = level;
}

export function log(entry: LogEntry): void {
  if (_logLevel === 'silent') return;
  if (_logLevel === 'error' && entry.status === 'success') return;

  process.stdout.write(JSON.stringify(entry) + '\n');
}
