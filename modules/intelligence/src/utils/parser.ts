export type ParseResult =
  | { success: true; parsed: Record<string, unknown> }
  | { success: false; error: { code: string; message: string } };

const PARSE_ERROR = {
  code: 'LLM_ERROR',
  message: 'LLM response could not be parsed as valid JSON',
};

function extractFromFences(raw: string): string | null {
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}

function extractFromSubstring(raw: string): string | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.substring(start, end + 1);
}

function tryParse(candidate: string): Record<string, unknown> | null {
  try {
    const result: unknown = JSON.parse(candidate);
    if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
      return result as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

// Strip <think>...</think> blocks emitted by reasoning models (DeepSeek, etc.)
function stripThinkBlocks(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

export function parse(rawResponse: string): ParseResult {
  const cleaned = stripThinkBlocks(rawResponse);

  const fromFences = extractFromFences(cleaned);
  if (fromFences !== null) {
    const parsed = tryParse(fromFences);
    if (parsed) return { success: true, parsed };
  }

  const fromSubstring = extractFromSubstring(cleaned);
  if (fromSubstring !== null) {
    const parsed = tryParse(fromSubstring);
    if (parsed) return { success: true, parsed };
  }

  const direct = tryParse(cleaned);
  if (direct) return { success: true, parsed: direct };

  return { success: false, error: PARSE_ERROR };
}
