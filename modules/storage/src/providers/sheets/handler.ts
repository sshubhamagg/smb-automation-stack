import * as validator from './validator';
import * as sheetsClient from './sheetsClient';
import * as transformer from './transformer';
import { log } from './logger';

export type ErrorObject = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type SuccessResponse<D, M> = {
  success: true;
  data: D;
  metadata: M;
};

export type ErrorResponse = {
  success: false;
  error: ErrorObject;
};

export type SheetResponse<D, M> = SuccessResponse<D, M> | ErrorResponse;

export async function handle(
  operation: 'read' | 'append' | 'update' | 'search',
  input: unknown
): Promise<SheetResponse<unknown, unknown>> {
  try {
    if (operation === 'read') return await handleRead(input);
    if (operation === 'append') return await handleAppend(input);
    if (operation === 'update') return await handleUpdate(input);
    if (operation === 'search') return await handleSearch(input);
    throw new Error(`Unknown operation: ${String(operation)}`);
  } catch (err: unknown) {
    const e = err as Error;
    const error: ErrorObject = { code: 'INTERNAL_ERROR', message: e.message ?? 'Unexpected internal error' };
    log({ operation, status: 'error', error });
    return { success: false, error };
  }
}

async function handleRead(input: unknown): Promise<SheetResponse<unknown, unknown>> {
  const validation = validator.validateRead(input);
  if (!validation.valid) {
    log({ operation: 'read', status: 'error', error: validation.error });
    return { success: false, error: validation.error };
  }

  const i = input as { sheetId: string; range?: string };
  const range = i.range ?? i.sheetId;

  const result = await sheetsClient.getValues(i.sheetId, range);
  if (!result.success) {
    log({ operation: 'read', status: 'error', sheetId: i.sheetId, error: result.error });
    return { success: false, error: result.error };
  }

  const transformed = transformer.transformRead(result.data, range);
  log({ operation: 'read', status: 'success', sheetId: i.sheetId });
  return {
    success: true,
    data: { rows: transformed.rows },
    metadata: { rowCount: transformed.rowCount, range: transformed.range },
  };
}

async function handleAppend(input: unknown): Promise<SheetResponse<unknown, unknown>> {
  const validation = validator.validateAppend(input);
  if (!validation.valid) {
    log({ operation: 'append', status: 'error', error: validation.error });
    return { success: false, error: validation.error };
  }

  const i = input as { sheetId: string; range: string; row: string[] };

  const result = await sheetsClient.appendValues(i.sheetId, i.range, i.row);
  if (!result.success) {
    log({ operation: 'append', status: 'error', sheetId: i.sheetId, error: result.error });
    return { success: false, error: result.error };
  }

  const transformed = transformer.transformWrite(result.data.updatedRange);
  log({ operation: 'append', status: 'success', sheetId: i.sheetId });
  return {
    success: true,
    data: { updatedRange: transformed.updatedRange },
    metadata: { updatedRowCount: transformed.updatedRowCount },
  };
}

async function handleUpdate(input: unknown): Promise<SheetResponse<unknown, unknown>> {
  const validation = validator.validateUpdate(input);
  if (!validation.valid) {
    log({ operation: 'update', status: 'error', error: validation.error });
    return { success: false, error: validation.error };
  }

  const i = input as { sheetId: string; range: string; rowIndex: number; row: string[] };

  // rowIndex is 1-based, excludes header. Sheet row = rowIndex + 1.
  const sheetRow = i.rowIndex + 1;
  const sheetName = i.range.includes('!') ? i.range.split('!')[0] : i.range;
  const targetRange = `${sheetName}!A${sheetRow}`;

  const result = await sheetsClient.updateValues(i.sheetId, targetRange, i.row);
  if (!result.success) {
    log({ operation: 'update', status: 'error', sheetId: i.sheetId, error: result.error });
    return { success: false, error: result.error };
  }

  const transformed = transformer.transformWrite(result.data.updatedRange);
  log({ operation: 'update', status: 'success', sheetId: i.sheetId });
  return {
    success: true,
    data: { updatedRange: transformed.updatedRange },
    metadata: { updatedRowCount: transformed.updatedRowCount },
  };
}

async function handleSearch(input: unknown): Promise<SheetResponse<unknown, unknown>> {
  const validation = validator.validateSearch(input);
  if (!validation.valid) {
    log({ operation: 'search', status: 'error', error: validation.error });
    return { success: false, error: validation.error };
  }

  const i = input as { sheetId: string; range: string; filter: Record<string, string> };

  const result = await sheetsClient.getValues(i.sheetId, i.range);
  if (!result.success) {
    log({ operation: 'search', status: 'error', sheetId: i.sheetId, error: result.error });
    return { success: false, error: result.error };
  }

  const transformed = transformer.transformRead(result.data, i.range);

  // If header is invalid and there are data rows, search cannot be performed
  if (!transformed.headerValid && transformed.rowCount > 0) {
    const error: ErrorObject = {
      code: 'INVALID_INPUT',
      message: 'Search requires a valid header row',
      details: {},
    };
    log({ operation: 'search', status: 'error', sheetId: i.sheetId, error });
    return { success: false, error };
  }

  // Apply in-memory filter: exact match, case-sensitive, AND across all fields
  const objectRows = transformed.rows as Record<string, string>[];
  const matches = objectRows.filter((row) =>
    Object.entries(i.filter).every(([key, value]) => row[key] === value)
  );

  log({ operation: 'search', status: 'success', sheetId: i.sheetId });
  return {
    success: true,
    data: { rows: matches },
    metadata: { matchCount: matches.length, range: transformed.range },
  };
}
