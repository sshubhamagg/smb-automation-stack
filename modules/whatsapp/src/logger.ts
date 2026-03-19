import type { Config } from './config';

export interface LogEntry {
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  status: string;
  messageId?: string;
  correlationId: string;
  userId?: string;
  direction: 'inbound' | 'outbound';
  normalizedOutput?: unknown;
  rawPayload?: unknown;
  error?: unknown;
  durationMs?: number;
}

const LEVEL_ORDER: Record<string, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

let _config: Config | null = null;

export function initLogger(config: Config): void {
  _config = config;
}

export function maskPii(phone: string): string {
  if (phone.length <= 7) {
    return phone;
  }
  const prefix = phone.slice(0, 3);
  const suffix = phone.slice(-4);
  const middleLength = phone.length - 7;
  const masked = '*'.repeat(middleLength);
  return `${prefix}${masked}${suffix}`;
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\u2026';
}

export function truncatePayload(
  payload: unknown,
  maxBytes: number
): { data: unknown; truncated: boolean } {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return { data: '[unserializable]', truncated: true };
  }

  const byteLength = Buffer.byteLength(serialized, 'utf8');
  if (byteLength <= maxBytes) {
    return { data: payload, truncated: false };
  }

  const truncatedStr = serialized.slice(0, maxBytes);
  try {
    const parsed: unknown = JSON.parse(truncatedStr);
    return { data: parsed, truncated: true };
  } catch {
    return { data: '[truncated]', truncated: true };
  }
}

export function log(entry: LogEntry): void {
  const configLogLevel = _config?.logLevel ?? 'INFO';
  const configMaxPayloadBytes = _config?.logMaxPayloadBytes ?? 2048;

  const entryOrder = LEVEL_ORDER[entry.level] ?? 1;
  const configOrder = LEVEL_ORDER[configLogLevel] ?? 1;

  if (entryOrder < configOrder) {
    return;
  }

  const output: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level: entry.level,
    status: entry.status,
    correlationId: entry.correlationId,
    direction: entry.direction,
  };

  if (entry.messageId !== undefined) {
    output['messageId'] = entry.messageId;
  }

  if (entry.userId !== undefined) {
    output['userId'] = maskPii(entry.userId);
  }

  if (entry.durationMs !== undefined) {
    output['durationMs'] = entry.durationMs;
  }

  if (entry.error !== undefined) {
    output['error'] = entry.error;
  }

  if (entry.normalizedOutput !== undefined) {
    const { data, truncated } = truncatePayload(entry.normalizedOutput, 1024);
    output['normalizedOutput'] = data;
    if (truncated) {
      output['_normalizedOutput_truncated'] = true;
    }
  }

  if (entry.rawPayload !== undefined) {
    const { data, truncated } = truncatePayload(entry.rawPayload, configMaxPayloadBytes);
    output['rawPayload'] = data;
    if (truncated) {
      output['_rawPayload_truncated'] = true;
    }
  }

  process.stdout.write(JSON.stringify(output) + '\n');
}
