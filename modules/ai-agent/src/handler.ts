import { validateInput, ErrorObject } from './validator';
import { buildPrompt } from './promptBuilder';
import { callLLM } from './llmClient';
import { parse } from './parser';
import { validate } from './postValidator';
import { log } from './logger';
import { loadConfig } from './config';

export interface AnalyzeInput {
  data: Record<string, string>[] | string[][];
  question: string;
  context?: {
    description?: string;
    columns?: string[];
  };
}

export type AnalyzeResponse =
  | { success: true; data: { answer: string; rows: unknown[]; confidence: string } }
  | { success: false; error: ErrorObject };

export async function handle(input: unknown): Promise<AnalyzeResponse> {
  const startTime = Date.now();
  const config = loadConfig();

  const latency = () => Date.now() - startTime;

  // Step 1: validate input
  const validation = validateInput(input);
  if (!validation.valid) {
    log({ operation: 'analyze', status: 'error', errorCode: validation.error.code, latencyMs: latency() });
    return { success: false, error: validation.error };
  }

  const typedInput = input as AnalyzeInput;

  // Step 2 & 3: normalize (handled by prompt builder serialization) + build prompt
  const prompt = buildPrompt(typedInput);

  // Step 4: call LLM
  const llmResult = await callLLM(prompt, config);
  if (!llmResult.success) {
    log({ operation: 'analyze', status: 'error', errorCode: llmResult.error.code, latencyMs: latency() });
    return { success: false, error: llmResult.error };
  }

  // Step 5: parse response
  const parseResult = parse(llmResult.rawResponse);
  if (!parseResult.success) {
    log({ operation: 'analyze', status: 'error', errorCode: parseResult.error.code, latencyMs: latency() });
    return { success: false, error: parseResult.error };
  }

  // Step 6: post-validate
  const postResult = validate(parseResult.parsed, typedInput.data as unknown[]);
  if (!postResult.valid) {
    log({ operation: 'analyze', status: 'error', errorCode: postResult.error.code, latencyMs: latency() });
    return { success: false, error: postResult.error };
  }

  // Step 7: return success
  log({ operation: 'analyze', status: 'success', latencyMs: latency() });
  return {
    success: true,
    data: {
      answer: postResult.result.answer,
      rows: postResult.result.rows,
      confidence: postResult.result.confidence,
    },
  };
}
