import { Pool } from 'pg';
import type { StorageAdapter, StorageInput, StorageResult } from '../types';

// Pool is created lazily and reused across calls.
let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host:     process.env.POSTGRES_HOST     ?? 'localhost',
      port:     Number(process.env.POSTGRES_PORT ?? '5432'),
      database: process.env.POSTGRES_DB       ?? '',
      user:     process.env.POSTGRES_USER     ?? '',
      password: process.env.POSTGRES_PASSWORD ?? '',
    });
  }
  return pool;
}

export class PostgresAdapter implements StorageAdapter {
  async execute(input: StorageInput): Promise<StorageResult> {
    switch (input.operation) {
      case 'write':  return this.insert(input);
      case 'read':   return this.query(input);
      case 'update': return this.update(input);
      default:
        return {
          ok: false,
          reason: 'unknown_operation',
          error: `Postgres adapter does not support operation: ${input.operation as string}`,
        };
    }
  }

  // operation: 'write' → INSERT INTO <table> (...) VALUES (...)
  private async insert(input: StorageInput): Promise<StorageResult> {
    const table = input.resource;
    const data = input.data as Record<string, unknown> | undefined;

    if (!table) {
      return { ok: false, reason: 'missing_field', error: "Field 'resource' (table name) is required for write" };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, reason: 'missing_field', error: "Field 'data' must be a non-null object for write" };
    }

    const keys   = Object.keys(data);
    const values = Object.values(data);

    if (keys.length === 0) {
      return { ok: false, reason: 'missing_field', error: "Field 'data' must have at least one column" };
    }

    const columns      = keys.map(k => `"${k}"`).join(', ');
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const sql          = `INSERT INTO "${table}" (${columns}) VALUES (${placeholders}) RETURNING *`;

    try {
      const result = await getPool().query(sql, values);
      return {
        ok: true,
        output: { rows: result.rows },
        metadata: { rowCount: result.rowCount ?? 0 },
      };
    } catch (err) {
      return { ok: false, reason: 'query_error', error: err instanceof Error ? err.message : String(err) };
    }
  }

  // operation: 'read' → SELECT * FROM <table> WHERE ...
  private async query(input: StorageInput): Promise<StorageResult> {
    const table = input.resource;

    if (!table) {
      return { ok: false, reason: 'missing_field', error: "Field 'resource' (table name) is required for read" };
    }

    const where  = input.query ?? {};
    const keys   = Object.keys(where);
    const values = Object.values(where);

    const whereClause = keys.length > 0
      ? 'WHERE ' + keys.map((k, i) => `"${k}" = $${i + 1}`).join(' AND ')
      : '';

    const sql = `SELECT * FROM "${table}" ${whereClause}`.trim();

    try {
      const result = await getPool().query(sql, values);
      return {
        ok: true,
        output: { rows: result.rows },
        metadata: { rowCount: result.rowCount ?? result.rows.length },
      };
    } catch (err) {
      return { ok: false, reason: 'query_error', error: err instanceof Error ? err.message : String(err) };
    }
  }

  // operation: 'update' → UPDATE <table> SET ... WHERE ...
  private async update(input: StorageInput): Promise<StorageResult> {
    const table = input.resource;
    const data  = input.data as Record<string, unknown> | undefined;
    const where = input.query ?? {};

    if (!table) {
      return { ok: false, reason: 'missing_field', error: "Field 'resource' (table name) is required for update" };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length === 0) {
      return { ok: false, reason: 'missing_field', error: "Field 'data' must be a non-empty object for update" };
    }
    if (Object.keys(where).length === 0) {
      return { ok: false, reason: 'missing_field', error: "Field 'query' (WHERE clause) is required for update" };
    }

    const setKeys    = Object.keys(data);
    const setValues  = Object.values(data);
    const whereKeys  = Object.keys(where);
    const whereVals  = Object.values(where);

    const setClause   = setKeys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
    const whereClause = whereKeys.map((k, i) => `"${k}" = $${setKeys.length + i + 1}`).join(' AND ');
    const sql = `UPDATE "${table}" SET ${setClause} WHERE ${whereClause} RETURNING *`;

    try {
      const result = await getPool().query(sql, [...setValues, ...whereVals]);
      return {
        ok: true,
        output: { rows: result.rows },
        metadata: { rowCount: result.rowCount ?? 0 },
      };
    } catch (err) {
      return { ok: false, reason: 'query_error', error: err instanceof Error ? err.message : String(err) };
    }
  }
}
