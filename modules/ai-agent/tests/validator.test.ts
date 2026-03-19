import { validateInput } from '../src/validator';

const validObjectInput = {
  data: [{ product: 'cement', stock: '50' }],
  question: 'Which product has lowest stock?',
};

const validArrayInput = {
  data: [['cement', '50'], ['steel', '20']],
  question: 'Which product has lowest stock?',
  context: { columns: ['product', 'stock'] },
};

describe('validateInput — data field', () => {
  it('accepts valid array of objects', () => {
    expect(validateInput(validObjectInput)).toEqual({ valid: true });
  });

  it('accepts valid array of arrays', () => {
    expect(validateInput(validArrayInput)).toEqual({ valid: true });
  });

  it('fails when data is missing', () => {
    const result = validateInput({ question: 'q' });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('fails when data is not an array', () => {
    const result = validateInput({ data: 'not-array', question: 'q' });
    expect(result.valid).toBe(false);
  });

  it('fails when data is empty array', () => {
    const result = validateInput({ data: [], question: 'q' });
    expect(result.valid).toBe(false);
  });

  it('fails when data exceeds 1000 rows', () => {
    const data = Array.from({ length: 1001 }, () => ({ a: 'b' }));
    const result = validateInput({ data, question: 'q' });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.message).toMatch(/1000/);
  });

  it('accepts exactly 1000 rows', () => {
    const data = Array.from({ length: 1000 }, () => ({ a: 'b' }));
    expect(validateInput({ data, question: 'q' })).toEqual({ valid: true });
  });

  it('fails when data mixes objects and arrays', () => {
    const result = validateInput({ data: [{ a: 'b' }, ['c', 'd']], question: 'q' });
    expect(result.valid).toBe(false);
  });

  it('fails when first element is a primitive', () => {
    const result = validateInput({ data: ['string'], question: 'q' });
    expect(result.valid).toBe(false);
  });
});

describe('validateInput — question field', () => {
  it('fails when question is missing', () => {
    const result = validateInput({ data: [{ a: 'b' }] });
    expect(result.valid).toBe(false);
  });

  it('fails when question is not a string', () => {
    const result = validateInput({ data: [{ a: 'b' }], question: 123 });
    expect(result.valid).toBe(false);
  });

  it('fails when question is empty string', () => {
    const result = validateInput({ data: [{ a: 'b' }], question: '' });
    expect(result.valid).toBe(false);
  });

  it('fails when question is whitespace only', () => {
    const result = validateInput({ data: [{ a: 'b' }], question: '   ' });
    expect(result.valid).toBe(false);
  });
});

describe('validateInput — context field', () => {
  it('accepts input with no context', () => {
    expect(validateInput(validObjectInput)).toEqual({ valid: true });
  });

  it('accepts context with description and columns', () => {
    const result = validateInput({
      ...validObjectInput,
      context: { description: 'Inventory data', columns: ['product', 'stock'] },
    });
    expect(result.valid).toBe(true);
  });

  it('fails when context is not an object', () => {
    const result = validateInput({ ...validObjectInput, context: 'bad' });
    expect(result.valid).toBe(false);
  });

  it('fails when context.description is empty string', () => {
    const result = validateInput({ ...validObjectInput, context: { description: '' } });
    expect(result.valid).toBe(false);
  });

  it('fails when context.columns is empty array', () => {
    const result = validateInput({ ...validObjectInput, context: { columns: [] } });
    expect(result.valid).toBe(false);
  });

  it('fails when context.columns contains empty string', () => {
    const result = validateInput({ ...validObjectInput, context: { columns: ['product', ''] } });
    expect(result.valid).toBe(false);
  });

  it('fails when context.columns contains non-strings', () => {
    const result = validateInput({ ...validObjectInput, context: { columns: [123] } });
    expect(result.valid).toBe(false);
  });
});

describe('validateInput — top level', () => {
  it('fails for null input', () => {
    expect(validateInput(null)).toEqual(expect.objectContaining({ valid: false }));
  });

  it('fails for non-object input', () => {
    expect(validateInput('string')).toEqual(expect.objectContaining({ valid: false }));
  });
});
