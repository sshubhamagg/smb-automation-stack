export interface ErrorObject {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type ValidationResult = { valid: true } | { valid: false; error: ErrorObject };

function invalid(message: string, details?: Record<string, unknown>): ValidationResult {
  return { valid: false, error: { code: 'INVALID_INPUT', message, details } };
}

export function validateInput(input: unknown): ValidationResult {
  if (!input || typeof input !== 'object') return invalid('Input must be an object');
  const i = input as Record<string, unknown>;

  // data
  if (!Array.isArray(i.data)) {
    return invalid("Field 'data' is required and must be an array", { field: 'data' });
  }
  if (i.data.length === 0) {
    return invalid("Field 'data' must not be empty", { field: 'data' });
  }
  if (i.data.length > 1000) {
    return invalid("Field 'data' must not exceed 1000 rows", { field: 'data', length: i.data.length });
  }

  // uniform shape: all objects or all arrays
  const firstEl = i.data[0];
  const firstIsArray = Array.isArray(firstEl);
  const firstIsObject = !firstIsArray && typeof firstEl === 'object' && firstEl !== null;
  if (!firstIsArray && !firstIsObject) {
    return invalid("Field 'data' elements must be objects or arrays", { field: 'data' });
  }
  const isUniform = i.data.every((el: unknown) =>
    firstIsArray
      ? Array.isArray(el)
      : !Array.isArray(el) && typeof el === 'object' && el !== null
  );
  if (!isUniform) {
    return invalid("Field 'data' must contain all objects or all arrays — mixed types not supported", {
      field: 'data',
    });
  }

  // question
  if (typeof i.question !== 'string') {
    return invalid("Field 'question' is required and must be a string", { field: 'question' });
  }
  if (i.question.trim() === '') {
    return invalid("Field 'question' must not be empty or whitespace", { field: 'question' });
  }

  // context (optional)
  if (i.context !== undefined) {
    if (typeof i.context !== 'object' || Array.isArray(i.context) || i.context === null) {
      return invalid("Field 'context' must be an object", { field: 'context' });
    }
    const ctx = i.context as Record<string, unknown>;

    if (ctx.description !== undefined) {
      if (typeof ctx.description !== 'string' || ctx.description.trim() === '') {
        return invalid("Field 'context.description' must be a non-empty string", {
          field: 'context.description',
        });
      }
    }
    if (ctx.columns !== undefined) {
      if (!Array.isArray(ctx.columns) || ctx.columns.length === 0) {
        return invalid("Field 'context.columns' must be a non-empty array", { field: 'context.columns' });
      }
      if (!ctx.columns.every((c: unknown) => typeof c === 'string' && (c as string).trim() !== '')) {
        return invalid("Field 'context.columns' must contain only non-empty strings", {
          field: 'context.columns',
        });
      }
    }
  }

  return { valid: true };
}
