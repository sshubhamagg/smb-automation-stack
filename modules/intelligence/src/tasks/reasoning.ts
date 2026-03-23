import type { AIInput, Prompt, TaskHandler, TaskValidationResult } from '../types';

export class ReasoningHandler implements TaskHandler {
  buildPrompt(input: AIInput): Prompt {
    return {
      system: `You are a reasoning assistant. Analyze the provided content and produce a structured conclusion with step-by-step reasoning.
Respond ONLY with a JSON object in this exact format:
{"conclusion": "<final conclusion>", "steps": ["<step 1>", "<step 2>", ...], "confidence": <0.0-1.0>}`,
      user: input.input.text ?? '',
    };
  }

  validate(parsed: Record<string, unknown>, _input: AIInput): TaskValidationResult {
    const { conclusion, steps, confidence } = parsed;

    if (typeof conclusion !== 'string' || conclusion.trim() === '') {
      return { valid: false, error: 'Missing or invalid field: conclusion' };
    }
    if (!Array.isArray(steps) || steps.length === 0 || !steps.every((s) => typeof s === 'string')) {
      return { valid: false, error: 'Missing or invalid field: steps (must be a non-empty string array)' };
    }
    if (confidence !== undefined && (typeof confidence !== 'number' || confidence < 0 || confidence > 1)) {
      return { valid: false, error: 'Invalid field: confidence (must be 0.0–1.0)' };
    }

    return { valid: true, output: { conclusion, steps, confidence } };
  }
}
