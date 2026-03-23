import type { AIAdapter, TaskHandler } from './types';

const adapterRegistry = new Map<string, AIAdapter>();
const taskRegistry = new Map<string, TaskHandler>();

export function registerAdapter(provider: string, adapter: AIAdapter): void {
  adapterRegistry.set(provider, adapter);
}

export function getAdapter(provider: string): AIAdapter {
  const adapter = adapterRegistry.get(provider);
  if (!adapter) {
    throw new Error(`No AI adapter registered for provider: ${provider}`);
  }
  return adapter;
}

export function registerTask(task: string, handler: TaskHandler): void {
  taskRegistry.set(task, handler);
}

export function getTask(task: string): TaskHandler {
  const handler = taskRegistry.get(task);
  if (!handler) {
    throw new Error(`No task handler registered for task: ${task}`);
  }
  return handler;
}
