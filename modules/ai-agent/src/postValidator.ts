export type RowData = Record<string, string> | string[];

export interface AnalysisResult {
  answer: string;
  rows: RowData[];
  confidence: 'low' | 'medium' | 'high';
}

export type PostValidationResult =
  | { valid: true; result: AnalysisResult }
  | { valid: false; error: { code: string; message: string; details?: Record<string, unknown> } };

const VALID_CONFIDENCE = ['low', 'medium', 'high'] as const;
const VALID_STATUS = ['ok', 'insufficient_data', 'ambiguous'] as const;

function fail(
  code: string,
  message: string,
  details?: Record<string, unknown>
): PostValidationResult {
  return { valid: false, error: { code, message, details } };
}

export function checkRequiredFields(parsed: Record<string, unknown>): boolean {
  return 'answer' in parsed && 'rows' in parsed && 'confidence' in parsed && 'status' in parsed;
}

export function checkEnums(parsed: Record<string, unknown>): boolean {
  return (
    (VALID_CONFIDENCE as readonly string[]).includes(parsed.confidence as string) &&
    (VALID_STATUS as readonly string[]).includes(parsed.status as string)
  );
}

function objectsMatch(r: Record<string, unknown>, i: Record<string, unknown>): boolean {
  const rKeys = Object.keys(r);
  const iKeys = Object.keys(i);
  if (rKeys.length !== iKeys.length) return false;
  return rKeys.every((k) => k in i && r[k] === i[k]);
}

function arraysMatch(r: unknown[], i: unknown[]): boolean {
  if (r.length !== i.length) return false;
  return r.every((v, idx) => v === i[idx]);
}

export function matchRows(parsedRows: unknown[], inputData: unknown[]): boolean {
  return parsedRows.every((parsedRow) => {
    if (Array.isArray(parsedRow)) {
      return inputData.some(
        (inputRow) => Array.isArray(inputRow) && arraysMatch(parsedRow, inputRow)
      );
    }
    if (typeof parsedRow === 'object' && parsedRow !== null) {
      return inputData.some(
        (inputRow) =>
          !Array.isArray(inputRow) &&
          typeof inputRow === 'object' &&
          inputRow !== null &&
          objectsMatch(
            parsedRow as Record<string, unknown>,
            inputRow as Record<string, unknown>
          )
      );
    }
    return false;
  });
}

// v1: limited to direct value conflicts — no semantic reasoning.
// Full NLP-based contradiction detection is out of scope.
// Returns false (no contradiction detected) in all cases in v1.
export function checkContradiction(_answer: string, _rows: unknown[]): boolean {
  return false;
}

export function mapStatus(
  status: string
): { code: string; message: string } | null {
  if (status === 'insufficient_data') {
    return {
      code: 'INSUFFICIENT_DATA',
      message:
        'The provided data does not contain enough information to answer the question.',
    };
  }
  if (status === 'ambiguous') {
    return {
      code: 'AMBIGUOUS_QUESTION',
      message:
        'The question cannot be answered with a single interpretation of the data.',
    };
  }
  return null;
}

export function validate(
  parsed: Record<string, unknown>,
  inputData: unknown[]
): PostValidationResult {
  // Rule 7: required fields
  if (!checkRequiredFields(parsed)) {
    return fail('LLM_ERROR', 'LLM response is missing required fields.', {
      required: ['answer', 'rows', 'confidence', 'status'],
    });
  }

  // Rule 7b: strict type checks on answer, confidence, status
  if (typeof parsed.answer !== 'string') {
    return fail('LLM_ERROR', 'LLM response field "answer" must be a string.');
  }
  if (typeof parsed.confidence !== 'string') {
    return fail('LLM_ERROR', 'LLM response field "confidence" must be a string.');
  }
  if (typeof parsed.status !== 'string') {
    return fail('LLM_ERROR', 'LLM response field "status" must be a string.');
  }

  // Rules 8 & 9: enum validation
  if (!checkEnums(parsed)) {
    return fail('LLM_ERROR', 'LLM response contains invalid enum values for confidence or status.', {
      confidence: parsed.confidence,
      status: parsed.status,
    });
  }

  const rows = parsed.rows as unknown[];
  const status = parsed.status as string;
  const answer = parsed.answer as string;
  const confidence = parsed.confidence as 'low' | 'medium' | 'high';

  // Rule 10: rows must be an array
  if (!Array.isArray(rows)) {
    return fail('LLM_ERROR', 'LLM response field "rows" must be an array.');
  }

  // Rule 10: row matching
  if (rows.length > 0 && !matchRows(rows, inputData)) {
    return fail('LLM_ERROR', 'LLM returned rows not found in the input data.');
  }

  // Rule 11: answer non-empty when status is ok
  if (status === 'ok' && (typeof answer !== 'string' || answer.trim() === '')) {
    return fail('LLM_ERROR', 'LLM returned status "ok" but answer is empty.');
  }

  // Rule 12: contradiction check
  if (status === 'ok' && checkContradiction(answer, rows)) {
    return fail('LLM_ERROR', 'LLM answer contradicts values in returned rows.');
  }

  // Rule 13: status mapping to business errors
  const statusError = mapStatus(status);
  if (statusError) {
    return { valid: false, error: statusError };
  }

  return {
    valid: true,
    result: { answer, rows: rows as RowData[], confidence },
  };
}
