import type { Store } from './store';
import type { NormalizedMessage } from './normalizer';
import { log } from './logger';

let _store: Store | null = null;
let _ttl: number = 86400;

export function initIdempotency(store: Store, ttlSeconds: number): void {
  _store = store;
  _ttl = ttlSeconds;
}

export function buildKey(messageId: string): string {
  return `idempotency:${messageId}`;
}

export async function checkAndLock(
  messageId: string
): Promise<{ isNew: boolean; cachedOutput: NormalizedMessage | null }> {
  if (!_store) {
    return { isNew: true, cachedOutput: null };
  }

  try {
    const key = buildKey(messageId);
    const isNew = await _store.setnx(key, 'processing', _ttl);

    if (isNew) {
      return { isNew: true, cachedOutput: null };
    }

    const existing = await _store.get(key);

    if (existing === null || existing === 'processing') {
      return { isNew: false, cachedOutput: null };
    }

    try {
      const parsed = JSON.parse(existing) as NormalizedMessage;
      return { isNew: false, cachedOutput: parsed };
    } catch {
      return { isNew: false, cachedOutput: null };
    }
  } catch (err) {
    log({
      level: 'WARN',
      status: 'idempotency_store_error',
      correlationId: messageId,
      direction: 'inbound',
      error: err instanceof Error ? err.message : String(err),
    });
    return { isNew: true, cachedOutput: null };
  }
}

export async function writeOutput(
  messageId: string,
  output: NormalizedMessage
): Promise<void> {
  if (!_store) return;

  try {
    const key = buildKey(messageId);
    await _store.set(key, JSON.stringify(output), _ttl);
  } catch {
    // Silently continue — caller handles
  }
}
