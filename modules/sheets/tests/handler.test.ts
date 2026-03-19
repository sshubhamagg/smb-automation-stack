import { handle } from '../src/handler';

jest.mock('../src/sheetsClient', () => ({
  getValues: jest.fn(),
  appendValues: jest.fn(),
  updateValues: jest.fn(),
}));

jest.mock('../src/logger', () => ({
  log: jest.fn(),
}));

import * as sheetsClient from '../src/sheetsClient';

const mockGetValues = sheetsClient.getValues as jest.MockedFunction<typeof sheetsClient.getValues>;
const mockAppendValues = sheetsClient.appendValues as jest.MockedFunction<typeof sheetsClient.appendValues>;
const mockUpdateValues = sheetsClient.updateValues as jest.MockedFunction<typeof sheetsClient.updateValues>;

beforeEach(() => {
  jest.clearAllMocks();
});

// ── READ ──────────────────────────────────────────────────────────────────────

describe('handle read', () => {
  it('returns rows mapped to objects with a valid header', async () => {
    mockGetValues.mockResolvedValueOnce({
      success: true,
      data: [['name', 'qty'], ['cement', '50'], ['steel', '20']],
    });

    const result = await handle('read', { sheetId: 'abc', range: 'Sheet1' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ rows: [{ name: 'cement', qty: '50' }, { name: 'steel', qty: '20' }] });
      expect(result.metadata).toEqual({ rowCount: 2, range: 'Sheet1' });
    }
  });

  it('returns raw arrays when header is malformed', async () => {
    mockGetValues.mockResolvedValueOnce({
      success: true,
      data: [['name', ''], ['cement', '50']],
    });

    const result = await handle('read', { sheetId: 'abc', range: 'Sheet1' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { rows: unknown[] }).rows[0]).toBeInstanceOf(Array);
    }
  });

  it('returns empty rows for empty sheet', async () => {
    mockGetValues.mockResolvedValueOnce({ success: true, data: [] });

    const result = await handle('read', { sheetId: 'abc', range: 'Sheet1' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { rows: unknown[] }).rows).toEqual([]);
    }
  });

  it('uses sheetId as range when range is omitted', async () => {
    mockGetValues.mockResolvedValueOnce({ success: true, data: [] });

    await handle('read', { sheetId: 'abc' });
    expect(mockGetValues).toHaveBeenCalledWith('abc', 'abc');
  });

  it('returns INVALID_INPUT when sheetId is missing', async () => {
    const result = await handle('read', { range: 'Sheet1' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('returns error from sheets client on API failure', async () => {
    mockGetValues.mockResolvedValueOnce({ success: false, error: { code: 'SHEET_NOT_FOUND', message: 'Not found' } });

    const result = await handle('read', { sheetId: 'bad', range: 'Sheet1' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('SHEET_NOT_FOUND');
  });
});

// ── APPEND ────────────────────────────────────────────────────────────────────

describe('handle append', () => {
  it('returns updatedRange on success', async () => {
    mockAppendValues.mockResolvedValueOnce({ success: true, data: { updatedRange: 'Sheet1!A4:B4' } });

    const result = await handle('append', { sheetId: 'abc', range: 'Sheet1', row: ['sand', '100'] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ updatedRange: 'Sheet1!A4:B4' });
      expect(result.metadata).toEqual({ updatedRowCount: 1 });
    }
  });

  it('returns INVALID_INPUT when row is empty', async () => {
    const result = await handle('append', { sheetId: 'abc', range: 'Sheet1', row: [] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('returns INVALID_INPUT when range is missing', async () => {
    const result = await handle('append', { sheetId: 'abc', row: ['a'] });
    expect(result.success).toBe(false);
  });

  it('returns error from sheets client on API failure', async () => {
    mockAppendValues.mockResolvedValueOnce({ success: false, error: { code: 'AUTH_FAILED', message: 'Auth error' } });

    const result = await handle('append', { sheetId: 'abc', range: 'Sheet1', row: ['a'] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('AUTH_FAILED');
  });
});

// ── UPDATE ────────────────────────────────────────────────────────────────────

describe('handle update', () => {
  it('calculates correct targetRange for rowIndex 1', async () => {
    mockUpdateValues.mockResolvedValueOnce({ success: true, data: { updatedRange: 'Sheet1!A2:B2' } });

    await handle('update', { sheetId: 'abc', range: 'Sheet1', rowIndex: 1, row: ['cement', '75'] });
    expect(mockUpdateValues).toHaveBeenCalledWith('abc', 'Sheet1!A2', ['cement', '75']);
  });

  it('calculates correct targetRange for rowIndex 3', async () => {
    mockUpdateValues.mockResolvedValueOnce({ success: true, data: { updatedRange: 'Sheet1!A4:B4' } });

    await handle('update', { sheetId: 'abc', range: 'Sheet1', rowIndex: 3, row: ['val'] });
    expect(mockUpdateValues).toHaveBeenCalledWith('abc', 'Sheet1!A4', ['val']);
  });

  it('returns updatedRange on success', async () => {
    mockUpdateValues.mockResolvedValueOnce({ success: true, data: { updatedRange: 'Sheet1!A2:B2' } });

    const result = await handle('update', { sheetId: 'abc', range: 'Sheet1', rowIndex: 1, row: ['x'] });
    expect(result.success).toBe(true);
    if (result.success) expect(result.metadata).toEqual({ updatedRowCount: 1 });
  });

  it('returns INVALID_INPUT when rowIndex is 0', async () => {
    const result = await handle('update', { sheetId: 'abc', range: 'Sheet1', rowIndex: 0, row: ['a'] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('returns error from sheets client on API failure', async () => {
    mockUpdateValues.mockResolvedValueOnce({ success: false, error: { code: 'API_ERROR', message: 'Error' } });

    const result = await handle('update', { sheetId: 'abc', range: 'Sheet1', rowIndex: 1, row: ['a'] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('API_ERROR');
  });
});

// ── SEARCH ────────────────────────────────────────────────────────────────────

describe('handle search', () => {
  it('returns matching rows (exact match)', async () => {
    mockGetValues.mockResolvedValueOnce({
      success: true,
      data: [['name', 'qty'], ['cement', '50'], ['steel', '20']],
    });

    const result = await handle('search', { sheetId: 'abc', range: 'Sheet1', filter: { name: 'cement' } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { rows: unknown[] }).rows).toEqual([{ name: 'cement', qty: '50' }]);
      expect((result.metadata as { matchCount: number }).matchCount).toBe(1);
    }
  });

  it('returns empty rows when no match', async () => {
    mockGetValues.mockResolvedValueOnce({
      success: true,
      data: [['name', 'qty'], ['cement', '50']],
    });

    const result = await handle('search', { sheetId: 'abc', range: 'Sheet1', filter: { name: 'glass' } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { rows: unknown[] }).rows).toEqual([]);
      expect((result.metadata as { matchCount: number }).matchCount).toBe(0);
    }
  });

  it('is case-sensitive (Cement ≠ cement)', async () => {
    mockGetValues.mockResolvedValueOnce({
      success: true,
      data: [['name', 'qty'], ['cement', '50']],
    });

    const result = await handle('search', { sheetId: 'abc', range: 'Sheet1', filter: { name: 'Cement' } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { rows: unknown[] }).rows).toEqual([]);
    }
  });

  it('applies AND condition across multiple filter fields', async () => {
    mockGetValues.mockResolvedValueOnce({
      success: true,
      data: [['name', 'qty'], ['cement', '50'], ['cement', '20']],
    });

    const result = await handle('search', { sheetId: 'abc', range: 'Sheet1', filter: { name: 'cement', qty: '50' } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { rows: unknown[] }).rows).toEqual([{ name: 'cement', qty: '50' }]);
    }
  });

  it('returns INVALID_INPUT when header is missing and rows exist', async () => {
    mockGetValues.mockResolvedValueOnce({
      success: true,
      data: [['', 'qty'], ['cement', '50']],
    });

    const result = await handle('search', { sheetId: 'abc', range: 'Sheet1', filter: { name: 'cement' } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_INPUT');
      expect(result.error.message).toBe('Search requires a valid header row');
    }
  });

  it('returns INVALID_INPUT when filter is empty', async () => {
    const result = await handle('search', { sheetId: 'abc', range: 'Sheet1', filter: {} });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('returns error from sheets client on API failure', async () => {
    mockGetValues.mockResolvedValueOnce({ success: false, error: { code: 'SHEET_NOT_FOUND', message: 'Not found' } });

    const result = await handle('search', { sheetId: 'bad', range: 'Sheet1', filter: { name: 'x' } });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('SHEET_NOT_FOUND');
  });

  it('returns empty rows when sheet is empty (no header issue)', async () => {
    mockGetValues.mockResolvedValueOnce({ success: true, data: [] });

    const result = await handle('search', { sheetId: 'abc', range: 'Sheet1', filter: { name: 'cement' } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { rows: unknown[] }).rows).toEqual([]);
    }
  });
});
