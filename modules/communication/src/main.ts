// Standard Module Contract:
// - Never throw
// - Always return ModuleResult

import type { ModuleResult } from 'shared-types';
import { registerAdapter, getAdapter } from './registry';
import { MetaAdapter } from './meta';
import { TwilioAdapter } from './twilio';
import { TelegramAdapter } from './telegram';

export type { ModuleResult };

// Register all known adapters at module init — add new providers here
registerAdapter('meta', new MetaAdapter());
registerAdapter('twilio', new TwilioAdapter());
registerAdapter('telegram', new TelegramAdapter());

export async function execute(input: { to: string; message: string; provider?: string }): Promise<ModuleResult<null>> {
  const provider = input.provider ?? (process.env.COMM_PROVIDER ?? 'twilio');

  let adapter;
  try {
    adapter = getAdapter(provider);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error', reason: 'adapter_not_found' };
  }

  try {
    await adapter.send(input.to, input.message);
    return { ok: true, output: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}

export type { CommunicationAdapter } from './types';
export { registerAdapter, getAdapter } from './registry';
