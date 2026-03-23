import type { CommunicationAdapter } from './types';

const registry = new Map<string, CommunicationAdapter>();

export function registerAdapter(provider: string, adapter: CommunicationAdapter): void {
  registry.set(provider, adapter);
}

export function getAdapter(provider: string): CommunicationAdapter {
  const adapter = registry.get(provider);
  if (!adapter) {
    throw new Error(`No communication adapter registered for provider: ${provider}`);
  }
  return adapter;
}
