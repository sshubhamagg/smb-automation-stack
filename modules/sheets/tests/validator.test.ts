import { validateRead, validateAppend, validateUpdate, validateSearch } from '../src/validator';

describe('validateRead', () => {
  it('returns valid for sheetId only', () => {
    expect(validateRead({ sheetId: 'abc' })).toEqual({ valid: true });
  });

  it('returns valid for sheetId with range', () => {
    expect(validateRead({ sheetId: 'abc', range: 'Sheet1' })).toEqual({ valid: true });
  });

  it('fails when sheetId is missing', () => {
    const result = validateRead({ range: 'Sheet1' });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('fails when sheetId is not a string', () => {
    const result = validateRead({ sheetId: 123 });
    expect(result.valid).toBe(false);
  });

  it('fails when range is not a string', () => {
    const result = validateRead({ sheetId: 'abc', range: 123 });
    expect(result.valid).toBe(false);
  });

  it('fails for non-object input', () => {
    expect(validateRead(null)).toEqual(expect.objectContaining({ valid: false }));
    expect(validateRead('string')).toEqual(expect.objectContaining({ valid: false }));
  });
});

describe('validateAppend', () => {
  it('returns valid for correct input', () => {
    expect(validateAppend({ sheetId: 'abc', range: 'Sheet1', row: ['a', 'b'] })).toEqual({ valid: true });
  });

  it('fails when sheetId is missing', () => {
    const result = validateAppend({ range: 'Sheet1', row: ['a'] });
    expect(result.valid).toBe(false);
  });

  it('fails when range is missing', () => {
    const result = validateAppend({ sheetId: 'abc', row: ['a'] });
    expect(result.valid).toBe(false);
  });

  it('fails when row is empty array', () => {
    const result = validateAppend({ sheetId: 'abc', range: 'Sheet1', row: [] });
    expect(result.valid).toBe(false);
  });

  it('fails when row is not an array', () => {
    const result = validateAppend({ sheetId: 'abc', range: 'Sheet1', row: 'value' });
    expect(result.valid).toBe(false);
  });

  it('fails when row contains non-strings', () => {
    const result = validateAppend({ sheetId: 'abc', range: 'Sheet1', row: ['a', 123] });
    expect(result.valid).toBe(false);
  });
});

describe('validateUpdate', () => {
  it('returns valid for correct input', () => {
    expect(validateUpdate({ sheetId: 'abc', range: 'Sheet1', rowIndex: 1, row: ['a', 'b'] })).toEqual({ valid: true });
  });

  it('fails when rowIndex is 0', () => {
    const result = validateUpdate({ sheetId: 'abc', range: 'Sheet1', rowIndex: 0, row: ['a'] });
    expect(result.valid).toBe(false);
  });

  it('fails when rowIndex is negative', () => {
    const result = validateUpdate({ sheetId: 'abc', range: 'Sheet1', rowIndex: -1, row: ['a'] });
    expect(result.valid).toBe(false);
  });

  it('fails when rowIndex is not an integer', () => {
    const result = validateUpdate({ sheetId: 'abc', range: 'Sheet1', rowIndex: 1.5, row: ['a'] });
    expect(result.valid).toBe(false);
  });

  it('fails when rowIndex is missing', () => {
    const result = validateUpdate({ sheetId: 'abc', range: 'Sheet1', row: ['a'] });
    expect(result.valid).toBe(false);
  });

  it('fails when row is empty', () => {
    const result = validateUpdate({ sheetId: 'abc', range: 'Sheet1', rowIndex: 1, row: [] });
    expect(result.valid).toBe(false);
  });

  it('fails when row contains non-strings', () => {
    const result = validateUpdate({ sheetId: 'abc', range: 'Sheet1', rowIndex: 1, row: [true] });
    expect(result.valid).toBe(false);
  });
});

describe('validateSearch', () => {
  it('returns valid for correct input', () => {
    expect(validateSearch({ sheetId: 'abc', range: 'Sheet1', filter: { name: 'cement' } })).toEqual({ valid: true });
  });

  it('fails when filter is missing', () => {
    const result = validateSearch({ sheetId: 'abc', range: 'Sheet1' });
    expect(result.valid).toBe(false);
  });

  it('fails when filter is an empty object', () => {
    const result = validateSearch({ sheetId: 'abc', range: 'Sheet1', filter: {} });
    expect(result.valid).toBe(false);
  });

  it('fails when filter is an array', () => {
    const result = validateSearch({ sheetId: 'abc', range: 'Sheet1', filter: [] });
    expect(result.valid).toBe(false);
  });

  it('fails when filter values are not strings', () => {
    const result = validateSearch({ sheetId: 'abc', range: 'Sheet1', filter: { name: 123 } });
    expect(result.valid).toBe(false);
  });

  it('fails when range is missing', () => {
    const result = validateSearch({ sheetId: 'abc', filter: { name: 'cement' } });
    expect(result.valid).toBe(false);
  });

  it('returns valid for multi-key filter', () => {
    expect(validateSearch({ sheetId: 'abc', range: 'Sheet1', filter: { name: 'cement', qty: '50' } })).toEqual({ valid: true });
  });
});
