import { SheetsAdapter } from '../src/adapters/sheets';
import { execute } from '../src/index';
import type { StorageInput } from '../src/types';

// Mocking sheets-module prevents its setup() from running (which requires Google credentials)
// and isolates the SheetsAdapter's mapping logic from the real API.
jest.mock('../src/providers/sheets/main', () => ({
  read: jest.fn(),
  append: jest.fn(),
  update: jest.fn(),
  search: jest.fn(),
}));

const sheetsMock = jest.requireMock('../src/providers/sheets/main') as {
  read: jest.Mock;
  append: jest.Mock;
  update: jest.Mock;
  search: jest.Mock;
};

// ── fixtures ─────────────────────────────────────────────────────────────────

const BASE: Pick<StorageInput, 'provider' | 'resource'> = {
  provider: 'sheets',
  resource: 'sheet-id-abc',
};

const SHEETS_ERROR = { success: false, error: { code: 'API_ERROR', message: 'Google API failed' } };

// ── tests ─────────────────────────────────────────────────────────────────────

describe('SheetsAdapter', () => {
  let adapter: SheetsAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new SheetsAdapter();
  });

  // ── read ───────────────────────────────────────────────────────────────────

  describe('read', () => {
    const input: StorageInput = { ...BASE, operation: 'read', options: { range: 'Sheet1' } };

    it('returns ok:true with rows and metadata on success', async () => {
      const rows = [{ Mine: 'North Mine', Labor: '45' }];
      sheetsMock.read.mockResolvedValue({
        success: true,
        data: { rows },
        metadata: { rowCount: 1, range: 'Sheet1' },
      });

      const result = await adapter.execute(input);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.output.rows).toEqual(rows);
      expect(result.metadata?.rowCount).toBe(1);
      expect(result.metadata?.range).toBe('Sheet1');
    });

    it('passes resource as sheetId and options.range to sheets-module', async () => {
      sheetsMock.read.mockResolvedValue({
        success: true,
        data: { rows: [] },
        metadata: { rowCount: 0, range: 'Sheet1' },
      });

      await adapter.execute(input);

      expect(sheetsMock.read).toHaveBeenCalledWith({ sheetId: 'sheet-id-abc', range: 'Sheet1' });
    });

    it('works without options (range is optional)', async () => {
      sheetsMock.read.mockResolvedValue({
        success: true,
        data: { rows: [] },
        metadata: { rowCount: 0, range: 'sheet-id-abc' },
      });

      const noRange: StorageInput = { ...BASE, operation: 'read' };
      await adapter.execute(noRange);

      expect(sheetsMock.read).toHaveBeenCalledWith({ sheetId: 'sheet-id-abc', range: undefined });
    });

    it('returns ok:false with reason and error when sheets-module fails', async () => {
      sheetsMock.read.mockResolvedValue(SHEETS_ERROR);

      const result = await adapter.execute(input);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('API_ERROR');
      expect(result.error).toBe('Google API failed');
    });
  });

  // ── write ──────────────────────────────────────────────────────────────────

  describe('write', () => {
    const input: StorageInput = {
      ...BASE,
      operation: 'write',
      options: { range: 'Sheet1' },
      data: ['2024-03-20', 'North Mine', '45'],
    };

    it('returns ok:true with updatedRange and metadata on success', async () => {
      sheetsMock.append.mockResolvedValue({
        success: true,
        data: { updatedRange: 'Sheet1!A2' },
        metadata: { updatedRowCount: 1 },
      });

      const result = await adapter.execute(input);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.output.updatedRange).toBe('Sheet1!A2');
      expect(result.metadata?.updatedRowCount).toBe(1);
    });

    it('passes resource, options.range, and data to sheets-module append', async () => {
      sheetsMock.append.mockResolvedValue({
        success: true,
        data: { updatedRange: 'Sheet1!A2' },
        metadata: { updatedRowCount: 1 },
      });

      await adapter.execute(input);

      expect(sheetsMock.append).toHaveBeenCalledWith({
        sheetId: 'sheet-id-abc',
        range: 'Sheet1',
        row: ['2024-03-20', 'North Mine', '45'],
      });
    });

    it('returns missing_field when options.range is absent', async () => {
      const noRange: StorageInput = { ...BASE, operation: 'write', data: ['a'] };
      const result = await adapter.execute(noRange);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('missing_field');
      expect(sheetsMock.append).not.toHaveBeenCalled();
    });

    it('returns missing_field when data is absent', async () => {
      const noData: StorageInput = { ...BASE, operation: 'write', options: { range: 'Sheet1' } };
      const result = await adapter.execute(noData);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('missing_field');
      expect(sheetsMock.append).not.toHaveBeenCalled();
    });

    it('returns ok:false when sheets-module fails', async () => {
      sheetsMock.append.mockResolvedValue(SHEETS_ERROR);
      const result = await adapter.execute(input);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('API_ERROR');
    });
  });

  // ── update ─────────────────────────────────────────────────────────────────

  describe('update', () => {
    const input: StorageInput = {
      ...BASE,
      operation: 'update',
      options: { range: 'Sheet1', rowIndex: 3 },
      data: ['updated', 'values'],
    };

    it('returns ok:true with updatedRange on success', async () => {
      sheetsMock.update.mockResolvedValue({
        success: true,
        data: { updatedRange: 'Sheet1!A4' },
        metadata: { updatedRowCount: 1 },
      });

      const result = await adapter.execute(input);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.output.updatedRange).toBe('Sheet1!A4');
      expect(result.metadata?.updatedRowCount).toBe(1);
    });

    it('passes resource, options.range, options.rowIndex, and data to sheets-module update', async () => {
      sheetsMock.update.mockResolvedValue({
        success: true,
        data: { updatedRange: 'Sheet1!A4' },
        metadata: { updatedRowCount: 1 },
      });

      await adapter.execute(input);

      expect(sheetsMock.update).toHaveBeenCalledWith({
        sheetId: 'sheet-id-abc',
        range: 'Sheet1',
        rowIndex: 3,
        row: ['updated', 'values'],
      });
    });

    it('returns missing_field when options.range is absent', async () => {
      const result = await adapter.execute({
        ...BASE, operation: 'update', options: { rowIndex: 1 }, data: ['a'],
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('missing_field');
      expect(sheetsMock.update).not.toHaveBeenCalled();
    });

    it('returns missing_field when options.rowIndex is absent', async () => {
      const result = await adapter.execute({
        ...BASE, operation: 'update', options: { range: 'Sheet1' }, data: ['a'],
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('missing_field');
      expect(sheetsMock.update).not.toHaveBeenCalled();
    });

    it('returns missing_field when data is absent', async () => {
      const result = await adapter.execute({
        ...BASE, operation: 'update', options: { range: 'Sheet1', rowIndex: 1 },
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('missing_field');
      expect(sheetsMock.update).not.toHaveBeenCalled();
    });

    it('returns ok:false when sheets-module fails', async () => {
      sheetsMock.update.mockResolvedValue(SHEETS_ERROR);
      const result = await adapter.execute(input);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('API_ERROR');
    });
  });

  // ── query ──────────────────────────────────────────────────────────────────

  describe('query', () => {
    const input: StorageInput = {
      ...BASE,
      operation: 'query',
      options: { range: 'Sheet1' },
      query: { Mine: 'North Mine' },
    };

    it('returns ok:true with matching rows on success', async () => {
      const rows = [{ Mine: 'North Mine', Labor: '45' }];
      sheetsMock.search.mockResolvedValue({
        success: true,
        data: { rows },
        metadata: { matchCount: 1, range: 'Sheet1' },
      });

      const result = await adapter.execute(input);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.output.rows).toEqual(rows);
      expect(result.metadata?.matchCount).toBe(1);
      expect(result.metadata?.range).toBe('Sheet1');
    });

    it('passes resource, options.range, and query as filter to sheets-module search', async () => {
      sheetsMock.search.mockResolvedValue({
        success: true,
        data: { rows: [] },
        metadata: { matchCount: 0, range: 'Sheet1' },
      });

      await adapter.execute(input);

      expect(sheetsMock.search).toHaveBeenCalledWith({
        sheetId: 'sheet-id-abc',
        range: 'Sheet1',
        filter: { Mine: 'North Mine' },
      });
    });

    it('returns missing_field when options.range is absent', async () => {
      const result = await adapter.execute({ ...BASE, operation: 'query', query: { Mine: 'X' } });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('missing_field');
      expect(sheetsMock.search).not.toHaveBeenCalled();
    });

    it('returns missing_field when query is absent', async () => {
      const result = await adapter.execute({ ...BASE, operation: 'query', options: { range: 'Sheet1' } });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('missing_field');
      expect(sheetsMock.search).not.toHaveBeenCalled();
    });

    it('returns missing_field when query is empty object', async () => {
      const result = await adapter.execute({
        ...BASE, operation: 'query', options: { range: 'Sheet1' }, query: {},
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('missing_field');
      expect(sheetsMock.search).not.toHaveBeenCalled();
    });

    it('returns ok:false when sheets-module fails', async () => {
      sheetsMock.search.mockResolvedValue(SHEETS_ERROR);
      const result = await adapter.execute(input);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('API_ERROR');
    });
  });
});

// ── execute() wrapper ─────────────────────────────────────────────────────────

describe('execute()', () => {
  beforeEach(() => jest.clearAllMocks());

  it('routes a valid sheets read through to SheetsAdapter', async () => {
    sheetsMock.read.mockResolvedValue({
      success: true,
      data: { rows: [] },
      metadata: { rowCount: 0, range: 'Sheet1' },
    });

    const result = await execute({
      provider: 'sheets',
      operation: 'read',
      resource: 'sheet-id-abc',
      options: { range: 'Sheet1' },
    });

    expect(result.ok).toBe(true);
    expect(sheetsMock.read).toHaveBeenCalledTimes(1);
  });

  it('returns adapter_error for an unknown provider', async () => {
    const result = await execute({
      provider: 'unknown-db',
      operation: 'read',
      resource: 'any',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('adapter_error');
    expect(result.error).toContain('unknown-db');
  });
});
