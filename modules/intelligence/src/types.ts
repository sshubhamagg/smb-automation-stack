import type { ModuleResult } from 'shared-types';

export type { ModuleResult };

export type Prompt = {
  system?: string;
  user: string;
};

export type AIInput = {
  provider: string;               // e.g. 'openai'
  task: string;                   // 'classification' | 'extraction' | 'qa' | 'reasoning'
  input: { text?: string; data?: unknown };
  options?: Record<string, any>;  // task-specific options (e.g. categories, fields, question)
};

// AIResult extends ModuleResult — adds task name on success, required reason on failure.
// Structurally compatible with ModuleResult<T>.
export type AIResult<T = any> =
  | { ok: true; task: string; output: T }
  | { ok: false; reason: string; error: string };

export interface AIAdapter {
  execute(prompt: Prompt, options?: any): Promise<string>;  // returns raw LLM text — never structured data
}

export type TaskValidationResult =
  | { valid: true; output: any }
  | { valid: false; error: string };

export interface TaskHandler {
  buildPrompt(input: AIInput): Prompt;
  validate(parsed: Record<string, unknown>, input: AIInput): TaskValidationResult;
}
