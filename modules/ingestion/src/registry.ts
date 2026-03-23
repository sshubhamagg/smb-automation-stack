import type { Adapter } from './types';

const registry = new Map<string, Adapter>();

export function registerAdapter(source: string, provider: string, adapter: Adapter): void {
  registry.set(`${source}:${provider}`, adapter);
}

export function getAdapter(source: string, provider: string): Adapter {
  const key = `${source}:${provider}`;
  const adapter = registry.get(key);
  if (!adapter) {
    throw new Error(`No adapter registered for provider key: ${key}`);
  }
  return adapter;
}
