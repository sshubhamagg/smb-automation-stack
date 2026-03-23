import type { StorageAdapter } from './types';

const registry = new Map<string, StorageAdapter>();

export function registerAdapter(provider: string, adapter: StorageAdapter): void {
  registry.set(provider, adapter);
}

export function getAdapter(provider: string): StorageAdapter {
  const adapter = registry.get(provider);
  if (!adapter) {
    throw new Error(`No storage adapter registered for provider: ${provider}`);
  }
  return adapter;
}
