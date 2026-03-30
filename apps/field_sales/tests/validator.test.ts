import { validateReport } from '../src/validator';
import type { Rep } from '../src/types';
import type { ParsedReportData } from '../src/parser';

const BASE_REP: Rep = {
  rep_id: 'rep-01',
  name: 'Arjun Mehta',
  manager_id: 'mgr-01',
  region: 'Jaipur',
  phone: '+919876543210',
  active: true,
};

const BASE_PARSED: ParsedReportData = {
  date: '25 Mar',
  region: 'Jaipur',
  beat: 'Sodala',
  total_calls: 18,
  orders: 7,
  sales_value: 24500,
  stock_issue: false,
  remarks: '',
};

describe('validateReport — happy path', () => {
  it('passes a valid report with matching rep', () => {
    const result = validateReport({ parsed: BASE_PARSED, rep: BASE_REP });
    expect(result.ok).toBe(true);
  });

  it('passes when sales_value is 0', () => {
    const result = validateReport({ parsed: { ...BASE_PARSED, sales_value: 0 }, rep: BASE_REP });
    expect(result.ok).toBe(true);
  });

  it('passes when total_calls is 0', () => {
    const result = validateReport({ parsed: { ...BASE_PARSED, total_calls: 0 }, rep: BASE_REP });
    expect(result.ok).toBe(true);
  });

  it('passes when orders is 0', () => {
    const result = validateReport({ parsed: { ...BASE_PARSED, orders: 0 }, rep: BASE_REP });
    expect(result.ok).toBe(true);
  });
});

describe('validateReport — numeric constraints', () => {
  it('rejects negative sales_value', () => {
    const result = validateReport({ parsed: { ...BASE_PARSED, sales_value: -1 }, rep: BASE_REP });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContainEqual(expect.stringContaining('sales_value'));
  });

  it('rejects negative total_calls', () => {
    const result = validateReport({ parsed: { ...BASE_PARSED, total_calls: -5 }, rep: BASE_REP });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContainEqual(expect.stringContaining('total_calls'));
  });

  it('rejects negative orders', () => {
    const result = validateReport({ parsed: { ...BASE_PARSED, orders: -2 }, rep: BASE_REP });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContainEqual(expect.stringContaining('orders'));
  });

  it('collects all three numeric errors at once', () => {
    const result = validateReport({
      parsed: { ...BASE_PARSED, sales_value: -1, total_calls: -1, orders: -1 },
      rep: BASE_REP,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toHaveLength(3);
  });
});

describe('validateReport — region matching', () => {
  it('rejects when region does not match rep region', () => {
    const result = validateReport({ parsed: { ...BASE_PARSED, region: 'Mumbai' }, rep: BASE_REP });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContainEqual(expect.stringContaining('region'));
  });

  it('matches region case-insensitively', () => {
    const result = validateReport({ parsed: { ...BASE_PARSED, region: 'jaipur' }, rep: BASE_REP });
    expect(result.ok).toBe(true);
  });

  it('trims whitespace before comparing regions', () => {
    const result = validateReport({ parsed: { ...BASE_PARSED, region: '  Jaipur  ' }, rep: BASE_REP });
    expect(result.ok).toBe(true);
  });
});

describe('validateReport — date validation', () => {
  it('accepts a valid date: "01 Jan"', () => {
    const result = validateReport({ parsed: { ...BASE_PARSED, date: '01 Jan' }, rep: BASE_REP });
    expect(result.ok).toBe(true);
  });

  it('accepts "29 Feb" (leap year validation uses year 2000)', () => {
    const result = validateReport({ parsed: { ...BASE_PARSED, date: '29 Feb' }, rep: BASE_REP });
    expect(result.ok).toBe(true);
  });

  it('accepts "31 Dec"', () => {
    const result = validateReport({ parsed: { ...BASE_PARSED, date: '31 Dec' }, rep: BASE_REP });
    expect(result.ok).toBe(true);
  });

  it('rejects "31 Apr" (April has 30 days)', () => {
    const result = validateReport({ parsed: { ...BASE_PARSED, date: '31 Apr' }, rep: BASE_REP });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContainEqual(expect.stringContaining('date'));
  });

  it('rejects "30 Feb"', () => {
    const result = validateReport({ parsed: { ...BASE_PARSED, date: '30 Feb' }, rep: BASE_REP });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContainEqual(expect.stringContaining('date'));
  });

  it('rejects an unknown month', () => {
    const result = validateReport({ parsed: { ...BASE_PARSED, date: '10 Xyz' }, rep: BASE_REP });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContainEqual(expect.stringContaining('date'));
  });

  it('rejects a free-form string', () => {
    const result = validateReport({ parsed: { ...BASE_PARSED, date: 'yesterday' }, rep: BASE_REP });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContainEqual(expect.stringContaining('date'));
  });

  it('rejects an empty date string', () => {
    const result = validateReport({ parsed: { ...BASE_PARSED, date: '' }, rep: BASE_REP });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContainEqual(expect.stringContaining('date'));
  });

  it('rejects day 0', () => {
    const result = validateReport({ parsed: { ...BASE_PARSED, date: '0 Mar' }, rep: BASE_REP });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContainEqual(expect.stringContaining('date'));
  });
});

describe('validateReport — multiple errors collected', () => {
  it('returns all errors when multiple rules fail', () => {
    const result = validateReport({
      parsed: {
        ...BASE_PARSED,
        sales_value: -100,
        orders: -3,
        region: 'Chennai',
        date: '32 Jan',
      },
      rep: BASE_REP,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(4);
      expect(result.errors).toContainEqual(expect.stringContaining('sales_value'));
      expect(result.errors).toContainEqual(expect.stringContaining('orders'));
      expect(result.errors).toContainEqual(expect.stringContaining('region'));
      expect(result.errors).toContainEqual(expect.stringContaining('date'));
    }
  });
});
