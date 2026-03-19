export type ParseResult =
  | { success: true; parsed: Record<string, unknown> }
  | { success: false; error: { code: string; message: string } };

const PARSE_ERROR = {
  code: 'LLM_ERROR',
  message: 'LLM response could not be parsed as valid JSON',
};

export function extractFromFences(raw: string): string | null {
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}

export function extractFromSubstring(raw: string): string | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.substring(start, end + 1);
}

export function tryParse(candidate: string): Record<string, unknown> | null {
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

export function parse(rawResponse: string): ParseResult {
  // Stage 1: markdown fence extraction
  const fromFences = extractFromFences(rawResponse);
  if (fromFences !== null) {
    const parsed = tryParse(fromFences);
    if (parsed) return { success: true, parsed };
  }

  // Stage 2: first { to last } substring
  const fromSubstring = extractFromSubstring(rawResponse);
  if (fromSubstring !== null) {
    const parsed = tryParse(fromSubstring);
    if (parsed) return { success: true, parsed };
  }

  // Stage 3: direct parse
  const direct = tryParse(rawResponse);
  if (direct) return { success: true, parsed: direct };

  return { success: false, error: PARSE_ERROR };
}
