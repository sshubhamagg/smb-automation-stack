import { buildDuplicateCheckInput } from '../../src/inputs/check-duplicate';
import type { Rep } from '../../src/types';
import type { ParsedReportData } from '../../src/parser';

const REP: Rep = {
  rep_id: 'rep-01',
  name: 'Arjun Mehta',
  manager_id: 'mgr-01',
  region: 'Jaipur',
  phone: '+919876543210',
  active: true,
};

const PARSED: ParsedReportData = {
  date: '25 Mar',
  region: 'Jaipur',
  beat: 'Sodala',
  total_calls: 18,
  orders: 7,
  sales_value: 24500,
  stock_issue: false,
  remarks: '',
};

describe('buildDuplicateCheckInput', () => {
  it('returns correct shape', () => {
    const result = buildDuplicateCheckInput({ parsed_input: PARSED, rep: REP });

    expect(result).toEqual({
      provider: 'sheets',
      operation: 'query',
      resource: 'daily_reports',
      query: { rep_id: 'rep-01', date: '25 Mar' },
      options: { range: 'A:Z' },
    });
  });

  it('maps rep_id from rep, not parsed_input', () => {
    const result = buildDuplicateCheckInput({ parsed_input: PARSED, rep: REP });
    expect(result.query.rep_id).toBe(REP.rep_id);
  });

  it('maps date from parsed_input', () => {
    const result = buildDuplicateCheckInput({
      parsed_input: { ...PARSED, date: '01 Jan' },
      rep: REP,
    });
    expect(result.query.date).toBe('01 Jan');
  });

  it('always sets provider to sheets', () => {
    const result = buildDuplicateCheckInput({ parsed_input: PARSED, rep: REP });
    expect(result.provider).toBe('sheets');
  });

  it('always sets operation to query', () => {
    const result = buildDuplicateCheckInput({ parsed_input: PARSED, rep: REP });
    expect(result.operation).toBe('query');
  });
});
