export type ParsedReportData = {
  date: string;
  region: string;
  beat: string;
  total_calls: number;
  orders: number;
  sales_value: number;
  stock_issue: boolean;
  remarks: string;
};

type ParseResult =
  | { ok: true; data: ParsedReportData }
  | { ok: false; error: string };

// Maps accepted input key aliases → canonical field names.
// Input uses "calls"; the domain model uses "total_calls".
const KEY_ALIASES: Record<string, string> = {
  calls: 'total_calls',
};

const REQUIRED_KEYS: ReadonlyArray<keyof ParsedReportData> = [
  'date',
  'region',
  'beat',
  'total_calls',
  'orders',
  'sales_value',
  'stock_issue',
  'remarks',
];

const NUMERIC_KEYS = new Set<string>(['total_calls', 'orders', 'sales_value']);
const BOOLEAN_KEYS = new Set<string>(['stock_issue']);

function toLines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

function splitOnFirstColon(line: string): [string, string] | null {
  const idx = line.indexOf(':');
  if (idx === -1) return null;
  return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
}

function normalizeKey(raw: string): string {
  const lower = raw.toLowerCase().replace(/\s+/g, '_');
  return KEY_ALIASES[lower] ?? lower;
}

function parseNumber(value: string, field: string): { ok: true; value: number } | { ok: false; error: string } {
  const n = Number(value);
  if (!Number.isFinite(n) || value.trim() === '') {
    return { ok: false, error: `"${field}" must be a number, got: "${value}"` };
  }
  if (n < 0) {
    return { ok: false, error: `"${field}" must be >= 0, got: ${n}` };
  }
  return { ok: true, value: n };
}

function parseBoolean(value: string, field: string): { ok: true; value: boolean } | { ok: false; error: string } {
  const lower = value.toLowerCase();
  if (lower === 'yes' || lower === 'true' || lower === '1') return { ok: true, value: true };
  if (lower === 'no' || lower === 'false' || lower === '0') return { ok: true, value: false };
  return { ok: false, error: `"${field}" must be yes/no, got: "${value}"` };
}

function buildFieldMap(text: string): Map<string, string> | { error: string } {
  const lines = toLines(text);
  if (lines.length === 0) return { error: 'Input text is empty' };

  const map = new Map<string, string>();

  for (const line of lines) {
    const pair = splitOnFirstColon(line);
    if (pair === null) continue; // skip unparseable lines silently
    const [rawKey, rawValue] = pair;
    const key = normalizeKey(rawKey);
    map.set(key, rawValue);
  }

  return map;
}

export function parseReport(input: { text: string }): ParseResult {
  if (typeof input?.text !== 'string') {
    return { ok: false, error: 'Input text must be a string' };
  }

  const mapOrError = buildFieldMap(input.text);
  if ('error' in mapOrError) return { ok: false, error: mapOrError.error };

  const fields = mapOrError;

  // Check all required fields are present before coercing
  const missing = REQUIRED_KEYS.filter((k) => !fields.has(k));
  if (missing.length > 0) {
    return { ok: false, error: `Missing required fields: ${missing.join(', ')}` };
  }

  const coerced: Partial<ParsedReportData> = {};

  for (const key of REQUIRED_KEYS) {
    const raw = fields.get(key) as string;

    if (NUMERIC_KEYS.has(key)) {
      const result = parseNumber(raw, key);
      if (!result.ok) return { ok: false, error: result.error };
      (coerced as Record<string, unknown>)[key] = result.value;
      continue;
    }

    if (BOOLEAN_KEYS.has(key)) {
      const result = parseBoolean(raw, key);
      if (!result.ok) return { ok: false, error: result.error };
      (coerced as Record<string, unknown>)[key] = result.value;
      continue;
    }

    // String fields: validate non-empty except remarks
    if (key !== 'remarks' && raw.length === 0) {
      return { ok: false, error: `"${key}" must not be empty` };
    }
    (coerced as Record<string, unknown>)[key] = raw;
  }

  return { ok: true, data: coerced as ParsedReportData };
}
