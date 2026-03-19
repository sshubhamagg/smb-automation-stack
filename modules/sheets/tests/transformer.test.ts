import { isValidHeader, mapRows, transformRead, transformWrite } from '../src/transformer';

describe('isValidHeader', () => {
  it('returns true for a valid header row', () => {
    expect(isValidHeader(['name', 'qty', 'price'])).toBe(true);
  });

  it('returns false for an empty array', () => {
    expect(isValidHeader([])).toBe(false);
  });

  it('returns false when a cell is an empty string', () => {
    expect(isValidHeader(['name', '', 'price'])).toBe(false);
  });

  it('returns false when a cell is whitespace only', () => {
    expect(isValidHeader(['name', '   ', 'price'])).toBe(false);
  });

  it('returns true for a single-cell header', () => {
    expect(isValidHeader(['name'])).toBe(true);
  });
});

describe('mapRows', () => {
  it('maps rows to objects using headers', () => {
    const result = mapRows(['name', 'qty'], [['cement', '50'], ['steel', '20']]);
    expect(result).toEqual([
      { name: 'cement', qty: '50' },
      { name: 'steel', qty: '20' },
    ]);
  });

  it('fills missing cells with empty string', () => {
    const result = mapRows(['name', 'qty', 'price'], [['cement']]);
    expect(result).toEqual([{ name: 'cement', qty: '', price: '' }]);
  });

  it('returns empty array for empty rows input', () => {
    expect(mapRows(['name', 'qty'], [])).toEqual([]);
  });

  it('ignores extra data cells beyond header count', () => {
    const result = mapRows(['name'], [['cement', 'extra']]);
    expect(result).toEqual([{ name: 'cement' }]);
  });
});

describe('transformRead', () => {
  it('returns empty rows for empty values', () => {
    const result = transformRead([], 'Sheet1');
    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBe(0);
    expect(result.headerValid).toBe(false);
  });

  it('returns empty rows when only header row exists', () => {
    const result = transformRead([['name', 'qty']], 'Sheet1');
    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBe(0);
    expect(result.headerValid).toBe(true);
  });

  it('maps rows as objects when header is valid', () => {
    const result = transformRead([['name', 'qty'], ['cement', '50']], 'Sheet1');
    expect(result.rows).toEqual([{ name: 'cement', qty: '50' }]);
    expect(result.rowCount).toBe(1);
    expect(result.headerValid).toBe(true);
  });

  it('returns raw arrays when header is invalid (empty cell)', () => {
    const result = transformRead([['name', ''], ['cement', '50']], 'Sheet1');
    expect(result.rows).toEqual([['cement', '50']]);
    expect(result.headerValid).toBe(false);
  });

  it('returns raw arrays when header is malformed (empty string)', () => {
    const result = transformRead([[''], ['cement']], 'Sheet1');
    expect(result.headerValid).toBe(false);
  });

  it('preserves empty cell values as empty string in mapped rows', () => {
    const result = transformRead([['name', 'qty'], ['cement', '']], 'Sheet1');
    expect(result.rows).toEqual([{ name: 'cement', qty: '' }]);
  });

  it('returns the range passed in', () => {
    const result = transformRead([['name'], ['cement']], 'Sheet1!A1:Z');
    expect(result.range).toBe('Sheet1!A1:Z');
  });
});

describe('transformWrite', () => {
  it('returns updatedRange and updatedRowCount of 1', () => {
    const result = transformWrite('Sheet1!A4:B4');
    expect(result).toEqual({ updatedRange: 'Sheet1!A4:B4', updatedRowCount: 1 });
  });
});
