import { parse, extractFromFences, extractFromSubstring, tryParse } from '../src/parser';

const validLLMObject = JSON.stringify({
  answer: 'Steel has the lowest stock.',
  rows: [{ product: 'steel', stock: '20' }],
  confidence: 'high',
  status: 'ok',
});

describe('tryParse', () => {
  it('returns parsed object for valid JSON object string', () => {
    const result = tryParse('{"a":"b"}');
    expect(result).toEqual({ a: 'b' });
  });

  it('returns null for invalid JSON', () => {
    expect(tryParse('not json')).toBeNull();
  });

  it('returns null for a JSON array (not an object)', () => {
    expect(tryParse('[1,2,3]')).toBeNull();
  });

  it('returns null for JSON null', () => {
    expect(tryParse('null')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(tryParse('')).toBeNull();
  });
});

describe('extractFromFences', () => {
  it('extracts content from ```json fences', () => {
    const raw = '```json\n{"a":"b"}\n```';
    expect(extractFromFences(raw)).toBe('{"a":"b"}');
  });

  it('extracts content from plain ``` fences', () => {
    const raw = '```\n{"a":"b"}\n```';
    expect(extractFromFences(raw)).toBe('{"a":"b"}');
  });

  it('returns null when no fences present', () => {
    expect(extractFromFences('{"a":"b"}')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractFromFences('')).toBeNull();
  });
});

describe('extractFromSubstring', () => {
  it('extracts JSON object from text-wrapped response', () => {
    const raw = 'Here is the result: {"a":"b"} Done.';
    expect(extractFromSubstring(raw)).toBe('{"a":"b"}');
  });

  it('returns null when no { present', () => {
    expect(extractFromSubstring('no braces here')).toBeNull();
  });

  it('returns null when no } present', () => {
    expect(extractFromSubstring('{no closing')).toBeNull();
  });

  it('uses first { and last }', () => {
    const raw = 'text {"a":"b"} more {"c":"d"}';
    const result = extractFromSubstring(raw);
    expect(result).toBe('{"a":"b"} more {"c":"d"}');
  });
});

describe('parse — Stage 1: markdown fences', () => {
  it('parses valid JSON inside ```json fences', () => {
    const raw = '```json\n' + validLLMObject + '\n```';
    const result = parse(raw);
    expect(result.success).toBe(true);
    if (result.success) expect(result.parsed.status).toBe('ok');
  });

  it('parses valid JSON inside plain ``` fences', () => {
    const raw = '```\n' + validLLMObject + '\n```';
    const result = parse(raw);
    expect(result.success).toBe(true);
  });
});

describe('parse — Stage 2: substring extraction', () => {
  it('parses JSON surrounded by arbitrary text', () => {
    const raw = 'Here is my analysis:\n' + validLLMObject + '\nHope that helps!';
    const result = parse(raw);
    expect(result.success).toBe(true);
    if (result.success) expect(result.parsed.answer).toBe('Steel has the lowest stock.');
  });
});

describe('parse — Stage 3: direct parse', () => {
  it('parses clean JSON with no wrapping', () => {
    const result = parse(validLLMObject);
    expect(result.success).toBe(true);
    if (result.success) expect(result.parsed.confidence).toBe('high');
  });
});

describe('parse — failures', () => {
  it('returns LLM_ERROR for completely invalid JSON', () => {
    const result = parse('The answer is steel. It has the lowest stock.');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('LLM_ERROR');
  });

  it('returns LLM_ERROR for empty string', () => {
    const result = parse('');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('LLM_ERROR');
  });

  it('returns LLM_ERROR for partial JSON with no closing brace', () => {
    const result = parse('{"answer":"steel","rows":[');
    expect(result.success).toBe(false);
  });

  it('extracts object from JSON array wrapper (postValidator rejects schema)', () => {
    // Parser no longer rejects top-level arrays — it extracts the inner object.
    // Schema rejection (wrong structure) is postValidator's responsibility.
    const result = parse('[{"answer":"x"}]');
    expect(result.success).toBe(true);
  });
});
