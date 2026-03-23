// Mock 'pg' before any imports so the Pool constructor is intercepted
jest.mock('pg', () => {
  const mockQuery = jest.fn();
  const MockPool  = jest.fn().mockImplementation(() => ({ query: mockQuery }));
  return { Pool: MockPool, __mockQuery: mockQuery };
});

import { PostgresAdapter } from '../src/adapters/postgres';
import type { StorageInput } from '../src/types';

// Retrieve the shared mockQuery reference from the mock factory
const pgMock = jest.requireMock('pg') as { Pool: jest.Mock; __mockQuery: jest.Mock };
const mockQuery = pgMock.__mockQuery;

const BASE: Pick<StorageInput, 'provider' | 'resource'> = {
  provider: 'postgres',
  resource: 'reports',
};

describe('PostgresAdapter', () => {
  let adapter: PostgresAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new PostgresAdapter();
  });

  // ── insert (write) ──────────────────────────────────────────────────────────

  describe('write (insert)', () => {
    const input: StorageInput = {
      ...BASE,
      operation: 'write',
      data: { mine: 'North Mine', labor: 25, output_tons: 120 },
    };

    it('returns ok:true with inserted rows on success', async () => {
      const row = { id: 1, mine: 'North Mine', labor: 25, output_tons: 120 };
      mockQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });

      const result = await adapter.execute(input);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.output.rows).toEqual([row]);
      expect(result.metadata?.rowCount).toBe(1);
    });

    it('sends parameterised INSERT with all data columns', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await adapter.execute(input);

      const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/^INSERT INTO "reports"/);
      expect(sql).toContain('"mine"');
      expect(sql).toContain('RETURNING *');
      expect(values).toEqual(['North Mine', 25, 120]);
    });

    it('returns missing_field when data is absent', async () => {
      const result = await adapter.execute({ ...BASE, operation: 'write' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('missing_field');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('returns missing_field when data is empty object', async () => {
      const result = await adapter.execute({ ...BASE, operation: 'write', data: {} });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('missing_field');
    });

    it('returns query_error when pg throws', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection refused'));
      const result = await adapter.execute(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('query_error');
      expect(result.error).toContain('connection refused');
    });
  });

  // ── read (query) ────────────────────────────────────────────────────────────

  describe('read (query)', () => {
    const input: StorageInput = {
      ...BASE,
      operation: 'read',
      query: { mine: 'North Mine' },
    };

    it('returns ok:true with matching rows', async () => {
      const rows = [{ id: 1, mine: 'North Mine' }];
      mockQuery.mockResolvedValueOnce({ rows, rowCount: 1 });

      const result = await adapter.execute(input);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.output.rows).toEqual(rows);
    });

    it('sends parameterised SELECT with WHERE clause', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await adapter.execute(input);

      const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/^SELECT \* FROM "reports" WHERE/);
      expect(sql).toContain('"mine" = $1');
      expect(values).toEqual(['North Mine']);
    });

    it('sends SELECT without WHERE when query is absent', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await adapter.execute({ ...BASE, operation: 'read' });

      const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toBe('SELECT * FROM "reports"');
      expect(values).toEqual([]);
    });

    it('returns query_error when pg throws', async () => {
      mockQuery.mockRejectedValueOnce(new Error('table not found'));
      const result = await adapter.execute(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('query_error');
    });
  });

  // ── update ──────────────────────────────────────────────────────────────────

  describe('update', () => {
    const input: StorageInput = {
      ...BASE,
      operation: 'update',
      data: { labor: 30 },
      query: { id: 1 },
    };

    it('returns ok:true with updated rows', async () => {
      const row = { id: 1, labor: 30 };
      mockQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });

      const result = await adapter.execute(input);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.output.rows).toEqual([row]);
    });

    it('sends parameterised UPDATE with SET and WHERE', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await adapter.execute(input);

      const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/^UPDATE "reports" SET/);
      expect(sql).toContain('"labor" = $1');
      expect(sql).toContain('WHERE "id" = $2');
      expect(sql).toContain('RETURNING *');
      expect(values).toEqual([30, 1]);
    });

    it('returns missing_field when data is absent', async () => {
      const result = await adapter.execute({ ...BASE, operation: 'update', query: { id: 1 } });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('missing_field');
    });

    it('returns missing_field when query (WHERE) is absent', async () => {
      const result = await adapter.execute({ ...BASE, operation: 'update', data: { labor: 30 } });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('missing_field');
    });

    it('returns query_error when pg throws', async () => {
      mockQuery.mockRejectedValueOnce(new Error('deadlock detected'));
      const result = await adapter.execute(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('query_error');
    });
  });

  // ── unsupported operation ───────────────────────────────────────────────────

  it('returns unknown_operation for unsupported operations', async () => {
    const result = await adapter.execute({ ...BASE, operation: 'query' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown_operation');
  });
});
