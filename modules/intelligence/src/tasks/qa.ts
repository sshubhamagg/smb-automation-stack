import type { AIInput, Prompt, TaskHandler, TaskValidationResult } from '../types';

export class QAHandler implements TaskHandler {
  buildPrompt(input: AIInput): Prompt {
    const question: string = input.options?.question ?? '';

    return {
      system: `You are a question-answering assistant. Answer the provided question strictly based on the given content. Do not use external knowledge.
If the answer cannot be determined from the content, set confidence to 0 and answer to "Insufficient data".
Respond ONLY with a JSON object in this exact format:
{"answer": "<answer>", "confidence": <0.0-1.0>}`,
      user: `Content:\n${input.input.text ?? ''}\n\nQuestion: ${question}`,
    };
  }

  validate(parsed: Record<string, unknown>, _input: AIInput): TaskValidationResult {
    const { answer, confidence } = parsed;

    if (typeof answer !== 'string' || answer.trim() === '') {
      return { valid: false, error: 'Missing or invalid field: answer' };
    }
    if (confidence !== undefined && (typeof confidence !== 'number' || confidence < 0 || confidence > 1)) {
      return { valid: false, error: 'Invalid field: confidence (must be 0.0–1.0)' };
    }

    return { valid: true, output: { answer, confidence } };
  }
}
