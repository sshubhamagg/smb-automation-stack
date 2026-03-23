import { read, append, update, search } from '../providers/sheets/main';
import type { StorageAdapter, StorageInput, StorageResult } from '../types';

export class SheetsAdapter implements StorageAdapter {
  async execute(input: StorageInput): Promise<StorageResult> {
    switch (input.operation) {
      case 'read':   return this.read(input);
      case 'write':  return this.write(input);
      case 'update': return this.update(input);
      case 'query':  return this.query(input);
      default:
        return {
          ok: false,
          reason: 'unknown_operation',
          error: `Unknown operation: ${input.operation as string}`,
        };
    }
  }

  private async read(input: StorageInput): Promise<StorageResult> {
    const result = await read({
      sheetId: input.resource,
      range: input.options?.range,
    });

    if (!result.success) {
      return { ok: false, reason: result.error.code, error: result.error.message };
    }

    const data = result.data as { rows: Record<string, string>[] | string[][] };
    const meta = result.metadata as { rowCount: number; range: string };

    return {
      ok: true,
      output: { rows: data.rows },
      metadata: { rowCount: meta.rowCount, range: meta.range },
    };
  }

  private async write(input: StorageInput): Promise<StorageResult> {
    if (!input.options?.range) {
      return { ok: false, reason: 'missing_field', error: "Field 'options.range' is required for write" };
    }
    if (!Array.isArray(input.data) || input.data.length === 0) {
      return { ok: false, reason: 'missing_field', error: "Field 'data' must be a non-empty array for write" };
    }

    const result = await append({
      sheetId: input.resource,
      range: input.options.range,
      row: input.data as string[],
    });

    if (!result.success) {
      return { ok: false, reason: result.error.code, error: result.error.message };
    }

    const data = result.data as { updatedRange: string };
    const meta = result.metadata as { updatedRowCount: number };

    return {
      ok: true,
      output: { updatedRange: data.updatedRange },
      metadata: { updatedRowCount: meta.updatedRowCount },
    };
  }

  private async update(input: StorageInput): Promise<StorageResult> {
    if (!input.options?.range) {
      return { ok: false, reason: 'missing_field', error: "Field 'options.range' is required for update" };
    }
    if (input.options?.rowIndex === undefined) {
      return { ok: false, reason: 'missing_field', error: "Field 'options.rowIndex' is required for update" };
    }
    if (!Array.isArray(input.data) || input.data.length === 0) {
      return { ok: false, reason: 'missing_field', error: "Field 'data' must be a non-empty array for update" };
    }

    const result = await update({
      sheetId: input.resource,
      range: input.options.range,
      rowIndex: input.options.rowIndex,
      row: input.data as string[],
    });

    if (!result.success) {
      return { ok: false, reason: result.error.code, error: result.error.message };
    }

    const data = result.data as { updatedRange: string };
    const meta = result.metadata as { updatedRowCount: number };

    return {
      ok: true,
      output: { updatedRange: data.updatedRange },
      metadata: { updatedRowCount: meta.updatedRowCount },
    };
  }

  private async query(input: StorageInput): Promise<StorageResult> {
    if (!input.options?.range) {
      return { ok: false, reason: 'missing_field', error: "Field 'options.range' is required for query" };
    }
    if (!input.query || Object.keys(input.query).length === 0) {
      return { ok: false, reason: 'missing_field', error: "Field 'query' is required for query operation" };
    }

    const result = await search({
      sheetId: input.resource,
      range: input.options.range,
      filter: input.query as Record<string, string>,
    });

    if (!result.success) {
      return { ok: false, reason: result.error.code, error: result.error.message };
    }

    const data = result.data as { rows: Record<string, string>[] };
    const meta = result.metadata as { matchCount: number; range: string };

    return {
      ok: true,
      output: { rows: data.rows },
      metadata: { matchCount: meta.matchCount, range: meta.range },
    };
  }
}
