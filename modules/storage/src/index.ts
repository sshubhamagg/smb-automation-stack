// Standard Module Contract:
// - Never throw
// - Always return { ok: true | false }

import { registerAdapter, getAdapter } from './registry';
import { SheetsAdapter } from './adapters/sheets';
import { PostgresAdapter } from './adapters/postgres';
import type { StorageInput, StorageResult } from './types';

// Register all known adapters at module init — add new providers here
registerAdapter('sheets', new SheetsAdapter());
registerAdapter('postgres', new PostgresAdapter());

export async function execute(input: StorageInput): Promise<StorageResult> {
  let adapter;

  try {
    adapter = getAdapter(input.provider);
  } catch (err) {
    return {
      ok: false,
      reason: 'adapter_error',
      error: err instanceof Error ? err.message : 'unknown error',
    };
  }

  try {
    return await adapter.execute(input);
  } catch (err) {
    return {
      ok: false,
      reason: 'adapter_error',
      error: err instanceof Error ? err.message : 'unknown error',
    };
  }
}

export type { StorageInput, StorageResult, StorageAdapter } from './types';
