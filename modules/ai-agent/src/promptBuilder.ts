export interface AnalyzeContext {
  description?: string;
  columns?: string[];
}

export interface Prompt {
  system: string;
  user: string;
}

export function buildSystemPrompt(): string {
  return [
    'You are a data analysis assistant. You will be given structured tabular data and a question about that data.',
    '',
    'Your task:',
    '- Analyze the data to answer the question',
    '- Base your answer ONLY on the provided data — do not use external knowledge',
    '- Do not hallucinate values not present in the data',
    '- Return your response as a single JSON object with no surrounding text',
    '',
    'Required JSON schema:',
    '{',
    '  "answer": "string — your answer in plain language",',
    '  "rows": [] — array of rows from the input data that support your answer,',
    '  "confidence": "low | medium | high",',
    '  "status": "ok | insufficient_data | ambiguous"',
    '}',
    '',
    'Rules:',
    '- Return ONLY the JSON object — no preamble, no explanation, no markdown fences',
    '- "rows" must contain only rows copied exactly from the input data',
    '- If the question cannot be answered: set status to "insufficient_data" or "ambiguous"',
    '- If status is not "ok": set answer to empty string and rows to []',
    '- "confidence" must be exactly one of: "low", "medium", "high"',
    '- "status" must be exactly one of: "ok", "insufficient_data", "ambiguous"',
  ].join('\n');
}

export function buildUserPrompt(
  data: unknown,
  question: string,
  context?: AnalyzeContext
): string {
  const parts: string[] = [];

  parts.push(`Data:\n${JSON.stringify(data)}`);

  if (context?.description) {
    parts.push(`Context:\n${context.description}`);
  }
  if (context?.columns) {
    parts.push(`Columns: ${context.columns.join(', ')}`);
  }

  parts.push(`Question:\n${question}`);

  return parts.join('\n\n');
}

export function buildPrompt(input: {
  data: unknown;
  question: string;
  context?: AnalyzeContext;
}): Prompt {
  return {
    system: buildSystemPrompt(),
    user: buildUserPrompt(input.data, input.question, input.context),
  };
}
