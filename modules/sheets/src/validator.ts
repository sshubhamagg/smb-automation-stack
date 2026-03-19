export type ValidationResult =
  | { valid: true }
  | { valid: false; error: { code: string; message: string; details?: Record<string, unknown> } };

function invalid(message: string, details?: Record<string, unknown>): ValidationResult {
  return { valid: false, error: { code: 'INVALID_INPUT', message, details } };
}

export function validateRead(input: unknown): ValidationResult {
  if (!input || typeof input !== 'object') return invalid('Input must be an object');
  const i = input as Record<string, unknown>;

  if (!i.sheetId || typeof i.sheetId !== 'string') {
    return invalid("Field 'sheetId' is required and must be a string", { field: 'sheetId' });
  }
  if (i.range !== undefined && typeof i.range !== 'string') {
    return invalid("Field 'range' must be a string", { field: 'range' });
  }
  return { valid: true };
}

export function validateAppend(input: unknown): ValidationResult {
  if (!input || typeof input !== 'object') return invalid('Input must be an object');
  const i = input as Record<string, unknown>;

  if (!i.sheetId || typeof i.sheetId !== 'string') {
    return invalid("Field 'sheetId' is required and must be a string", { field: 'sheetId' });
  }
  if (!i.range || typeof i.range !== 'string') {
    return invalid("Field 'range' is required and must be a string", { field: 'range' });
  }
  if (!Array.isArray(i.row) || i.row.length === 0) {
    return invalid("Field 'row' must be a non-empty array of strings", { field: 'row' });
  }
  if (!i.row.every((v: unknown) => typeof v === 'string')) {
    return invalid("Field 'row' must contain only strings", { field: 'row' });
  }
  return { valid: true };
}

export function validateUpdate(input: unknown): ValidationResult {
  if (!input || typeof input !== 'object') return invalid('Input must be an object');
  const i = input as Record<string, unknown>;

  if (!i.sheetId || typeof i.sheetId !== 'string') {
    return invalid("Field 'sheetId' is required and must be a string", { field: 'sheetId' });
  }
  if (!i.range || typeof i.range !== 'string') {
    return invalid("Field 'range' is required and must be a string", { field: 'range' });
  }
  if (typeof i.rowIndex !== 'number' || !Number.isInteger(i.rowIndex) || i.rowIndex < 1) {
    return invalid("Field 'rowIndex' must be a positive integer", { field: 'rowIndex' });
  }
  if (!Array.isArray(i.row) || i.row.length === 0) {
    return invalid("Field 'row' must be a non-empty array of strings", { field: 'row' });
  }
  if (!i.row.every((v: unknown) => typeof v === 'string')) {
    return invalid("Field 'row' must contain only strings", { field: 'row' });
  }
  return { valid: true };
}

export function validateSearch(input: unknown): ValidationResult {
  if (!input || typeof input !== 'object') return invalid('Input must be an object');
  const i = input as Record<string, unknown>;

  if (!i.sheetId || typeof i.sheetId !== 'string') {
    return invalid("Field 'sheetId' is required and must be a string", { field: 'sheetId' });
  }
  if (!i.range || typeof i.range !== 'string') {
    return invalid("Field 'range' is required and must be a string", { field: 'range' });
  }
  if (!i.filter || typeof i.filter !== 'object' || Array.isArray(i.filter)) {
    return invalid("Field 'filter' must be a non-empty object", { field: 'filter' });
  }
  const filter = i.filter as Record<string, unknown>;
  if (Object.keys(filter).length === 0) {
    return invalid("Field 'filter' must be a non-empty object", { field: 'filter' });
  }
  if (!Object.values(filter).every((v) => typeof v === 'string')) {
    return invalid('All filter values must be strings', { field: 'filter' });
  }
  return { valid: true };
}
