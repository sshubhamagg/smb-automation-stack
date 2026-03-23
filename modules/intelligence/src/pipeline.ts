// Standard Module Contract:
// - Never throw
// - Always return { ok: true | false }

import { parse } from './utils/parser';
import { getAdapter, getTask } from './registry';
import type { AIInput, AIResult } from './types';

export async function run(input: AIInput): Promise<AIResult> {
  let taskHandler;
  try {
    taskHandler = getTask(input.task);
  } catch {
    return { ok: false, reason: 'unknown_task', error: `No handler registered for task: ${input.task}` };
  }

  let adapter;
  try {
    adapter = getAdapter(input.provider);
  } catch {
    return { ok: false, reason: 'unknown_provider', error: `No adapter registered for provider: ${input.provider}` };
  }

  const prompt = taskHandler.buildPrompt(input);

  let rawText: string;
  try {
    rawText = await adapter.execute(prompt);
  } catch (err) {
    return {
      ok: false,
      reason: 'provider_error',
      error: err instanceof Error ? err.message : 'Unknown provider error',
    };
  }

  const parseResult = parse(rawText);
  if (!parseResult.success) {
    return { ok: false, reason: 'parse_error', error: parseResult.error.message };
  }

  const validation = taskHandler.validate(parseResult.parsed, input);
  if (!validation.valid) {
    return { ok: false, reason: 'validation_error', error: validation.error };
  }

  return { ok: true, task: input.task, output: validation.output };
}
