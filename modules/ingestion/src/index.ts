import { registerAdapter, getAdapter } from './registry';
import { MetaAdapter } from './adapters/meta';
import type { IngestionInput, IngestionResult } from './types';

// Register all known adapters at module init — add new providers here
registerAdapter('whatsapp', 'meta', new MetaAdapter());

export async function receive(input: IngestionInput): Promise<IngestionResult> {
  let adapter;

  try {
    adapter = getAdapter(input.source, input.provider);
  } catch (err) {
    return { ok: false, reason: 'adapter_error', error: err instanceof Error ? err.message : 'unknown error' };
  }

  try {
    return await adapter.execute(input);
  } catch (err) {
    return { ok: false, reason: 'adapter_error', error: err instanceof Error ? err.message : 'unknown error' };
  }
}

export type { IngestionInput, NormalizedEvent, IngestionResult, Adapter } from './types';
