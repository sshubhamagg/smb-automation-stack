import {
  validate,
  checkRequiredFields,
  checkEnums,
  matchRows,
  checkContradiction,
  mapStatus,
} from '../src/postValidator';

const inputData = [
  { product: 'cement', stock: '50' },
  { product: 'steel', stock: '20' },
  { product: 'sand', stock: '80' },
];

const validParsed = {
  answer: 'Steel has the lowest stock with a value of 20.',
  rows: [{ product: 'steel', stock: '20' }],
  confidence: 'high',
  status: 'ok',
};

// ── checkRequiredFields ───────────────────────────────────────────────────────

describe('checkRequiredFields', () => {
  it('returns true when all fields present', () => {
    expect(checkRequiredFields(validParsed)).toBe(true);
  });

  it('returns false when answer is missing', () => {
    const { answer: _a, ...rest } = validParsed;
    expect(checkRequiredFields(rest)).toBe(false);
  });

  it('returns false when rows is missing', () => {
    const { rows: _r, ...rest } = validParsed;
    expect(checkRequiredFields(rest)).toBe(false);
  });

  it('returns false when confidence is missing', () => {
    const { confidence: _c, ...rest } = validParsed;
    expect(checkRequiredFields(rest)).toBe(false);
  });

  it('returns false when status is missing', () => {
    const { status: _s, ...rest } = validParsed;
    expect(checkRequiredFields(rest)).toBe(false);
  });
});

// ── checkEnums ────────────────────────────────────────────────────────────────

describe('checkEnums', () => {
  it('returns true for valid confidence and status', () => {
    expect(checkEnums(validParsed)).toBe(true);
  });

  it('returns false for invalid confidence', () => {
    expect(checkEnums({ ...validParsed, confidence: 'very_high' })).toBe(false);
  });

  it('returns false for invalid status', () => {
    expect(checkEnums({ ...validParsed, status: 'unknown' })).toBe(false);
  });
});

// ── matchRows ─────────────────────────────────────────────────────────────────

describe('matchRows — object rows', () => {
  it('matches when key-value pairs are equal', () => {
    expect(matchRows([{ product: 'steel', stock: '20' }], inputData)).toBe(true);
  });

  it('matches when key order differs', () => {
    expect(matchRows([{ stock: '20', product: 'steel' }], inputData)).toBe(true);
  });

  it('returns false when value differs', () => {
    expect(matchRows([{ product: 'steel', stock: '99' }], inputData)).toBe(false);
  });

  it('returns false when key is missing from input', () => {
    expect(matchRows([{ product: 'iron', stock: '20' }], inputData)).toBe(false);
  });

  it('returns true for empty rows array', () => {
    expect(matchRows([], inputData)).toBe(true);
  });

  it('returns false when row has extra keys', () => {
    expect(matchRows([{ product: 'steel', stock: '20', extra: 'val' }], inputData)).toBe(false);
  });
});

describe('matchRows — array rows', () => {
  const arrayData = [['cement', '50'], ['steel', '20']];

  it('matches when values and order are equal', () => {
    expect(matchRows([['steel', '20']], arrayData)).toBe(true);
  });

  it('returns false when order differs', () => {
    expect(matchRows([['20', 'steel']], arrayData)).toBe(false);
  });

  it('returns false when value differs', () => {
    expect(matchRows([['steel', '99']], arrayData)).toBe(false);
  });
});

// ── checkContradiction ────────────────────────────────────────────────────────

describe('checkContradiction', () => {
  it('returns false (v1: no contradiction detection implemented)', () => {
    expect(checkContradiction('cement has stock 99', [{ product: 'cement', stock: '20' }])).toBe(false);
  });

  it('returns false for empty rows', () => {
    expect(checkContradiction('Some answer', [])).toBe(false);
  });
});

// ── mapStatus ─────────────────────────────────────────────────────────────────

describe('mapStatus', () => {
  it('returns null for "ok"', () => {
    expect(mapStatus('ok')).toBeNull();
  });

  it('returns INSUFFICIENT_DATA for "insufficient_data"', () => {
    const result = mapStatus('insufficient_data');
    expect(result?.code).toBe('INSUFFICIENT_DATA');
  });

  it('returns AMBIGUOUS_QUESTION for "ambiguous"', () => {
    const result = mapStatus('ambiguous');
    expect(result?.code).toBe('AMBIGUOUS_QUESTION');
  });
});

// ── validate (full integration) ───────────────────────────────────────────────

describe('validate', () => {
  it('returns valid result for correct ok response', () => {
    const result = validate(validParsed, inputData);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.result.answer).toBe(validParsed.answer);
      expect(result.result.confidence).toBe('high');
    }
  });

  it('returns LLM_ERROR when required field missing', () => {
    const { answer: _a, ...rest } = validParsed;
    const result = validate(rest, inputData);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.code).toBe('LLM_ERROR');
  });

  it('returns LLM_ERROR for invalid confidence', () => {
    const result = validate({ ...validParsed, confidence: 'extreme' }, inputData);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.code).toBe('LLM_ERROR');
  });

  it('returns LLM_ERROR when row not in input data', () => {
    const result = validate(
      { ...validParsed, rows: [{ product: 'iron', stock: '5' }] },
      inputData
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.code).toBe('LLM_ERROR');
  });

  it('returns LLM_ERROR when status ok but answer is empty', () => {
    const result = validate({ ...validParsed, answer: '' }, inputData);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.code).toBe('LLM_ERROR');
  });

  it('returns valid with empty rows', () => {
    const result = validate({ ...validParsed, rows: [] }, inputData);
    expect(result.valid).toBe(true);
  });

  it('maps status insufficient_data to INSUFFICIENT_DATA', () => {
    const result = validate(
      { answer: '', rows: [], confidence: 'low', status: 'insufficient_data' },
      inputData
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.code).toBe('INSUFFICIENT_DATA');
  });

  it('maps status ambiguous to AMBIGUOUS_QUESTION', () => {
    const result = validate(
      { answer: '', rows: [], confidence: 'low', status: 'ambiguous' },
      inputData
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.code).toBe('AMBIGUOUS_QUESTION');
  });
});
