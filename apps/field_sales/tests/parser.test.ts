import { parseReport } from '../src/parser';

const VALID_INPUT = `date: 25 Mar
region: Jaipur
beat: Sodala
calls: 18
orders: 7
sales_value: 24500
stock_issue: yes
remarks: Distributor stock issue`;

describe('parseReport — happy path', () => {
  it('parses a well-formed input', () => {
    const result = parseReport({ text: VALID_INPUT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data).toEqual({
      date: '25 Mar',
      region: 'Jaipur',
      beat: 'Sodala',
      total_calls: 18,
      orders: 7,
      sales_value: 24500,
      stock_issue: true,
      remarks: 'Distributor stock issue',
    });
  });

  it('maps "calls" alias to "total_calls"', () => {
    const result = parseReport({ text: VALID_INPUT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.total_calls).toBe(18);
  });

  it('accepts stock_issue: no → false', () => {
    const input = VALID_INPUT.replace('stock_issue: yes', 'stock_issue: no');
    const result = parseReport({ text: input });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.stock_issue).toBe(false);
  });

  it('is case-insensitive on keys', () => {
    const input = VALID_INPUT
      .replace('date:', 'DATE:')
      .replace('region:', 'Region:')
      .replace('beat:', 'BEAT:');
    const result = parseReport({ text: input });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.region).toBe('Jaipur');
  });

  it('trims whitespace from values', () => {
    const input = VALID_INPUT.replace('region: Jaipur', 'region:   Jaipur   ');
    const result = parseReport({ text: input });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.region).toBe('Jaipur');
  });

  it('allows empty remarks', () => {
    const input = VALID_INPUT.replace('remarks: Distributor stock issue', 'remarks: ');
    const result = parseReport({ text: input });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.remarks).toBe('');
  });

  it('preserves colons in values', () => {
    const input = VALID_INPUT.replace(
      'remarks: Distributor stock issue',
      'remarks: Issue: low stock'
    );
    const result = parseReport({ text: input });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.remarks).toBe('Issue: low stock');
  });

  it('accepts sales_value of 0', () => {
    const input = VALID_INPUT.replace('sales_value: 24500', 'sales_value: 0');
    const result = parseReport({ text: input });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.sales_value).toBe(0);
  });

  it('accepts stock_issue as true/false literals', () => {
    const trueInput = VALID_INPUT.replace('stock_issue: yes', 'stock_issue: true');
    const falseInput = VALID_INPUT.replace('stock_issue: yes', 'stock_issue: false');

    const r1 = parseReport({ text: trueInput });
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.data.stock_issue).toBe(true);

    const r2 = parseReport({ text: falseInput });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.data.stock_issue).toBe(false);
  });
});

describe('parseReport — missing fields', () => {
  const fields = ['date', 'region', 'beat', 'calls', 'orders', 'sales_value', 'stock_issue', 'remarks'];

  for (const field of fields) {
    it(`returns error when "${field}" is missing`, () => {
      const lines = VALID_INPUT.split('\n').filter((l) => !l.startsWith(field));
      const result = parseReport({ text: lines.join('\n') });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/missing/i);
    });
  }
});

describe('parseReport — invalid numeric values', () => {
  it('rejects non-numeric calls', () => {
    const input = VALID_INPUT.replace('calls: 18', 'calls: abc');
    const result = parseReport({ text: input });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/total_calls/);
  });

  it('rejects negative sales_value', () => {
    const input = VALID_INPUT.replace('sales_value: 24500', 'sales_value: -100');
    const result = parseReport({ text: input });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/sales_value/);
  });

  it('rejects negative orders', () => {
    const input = VALID_INPUT.replace('orders: 7', 'orders: -1');
    const result = parseReport({ text: input });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/orders/);
  });
});

describe('parseReport — invalid boolean values', () => {
  it('rejects unrecognized stock_issue value', () => {
    const input = VALID_INPUT.replace('stock_issue: yes', 'stock_issue: maybe');
    const result = parseReport({ text: input });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/stock_issue/);
  });
});

describe('parseReport — invalid string values', () => {
  it('rejects empty region', () => {
    const input = VALID_INPUT.replace('region: Jaipur', 'region: ');
    const result = parseReport({ text: input });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/region/);
  });

  it('rejects empty beat', () => {
    const input = VALID_INPUT.replace('beat: Sodala', 'beat: ');
    const result = parseReport({ text: input });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/beat/);
  });
});

describe('parseReport — edge cases', () => {
  it('returns error on empty string', () => {
    const result = parseReport({ text: '' });
    expect(result.ok).toBe(false);
  });

  it('returns error on whitespace-only string', () => {
    const result = parseReport({ text: '   \n  \n  ' });
    expect(result.ok).toBe(false);
  });

  it('ignores lines without colons', () => {
    const input = `garbage line\n${VALID_INPUT}`;
    const result = parseReport({ text: input });
    expect(result.ok).toBe(true);
  });

  it('does not throw on any input', () => {
    const inputs = [null as unknown as string, undefined as unknown as string, '::::', '\t\t\t'];
    for (const text of inputs) {
      expect(() => parseReport({ text })).not.toThrow();
    }
  });
});
