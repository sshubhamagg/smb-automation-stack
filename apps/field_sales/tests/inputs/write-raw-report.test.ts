import { buildWriteRawReportInput } from '../../src/inputs/write-raw-report';
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

const BASE_STATE = {
  parsed_input: PARSED,
  rep: REP,
  raw_text: 'date: 25 Mar\nregion: Jaipur',
  timestamp: 1711353600000,
};

describe('buildWriteRawReportInput', () => {
  it('returns correct shape', () => {
    const result = buildWriteRawReportInput(BASE_STATE);
    expect(result).toEqual({
      provider: 'sheets',
      operation: 'write',
      resource: 'raw_reports',
      data: {
        raw_text: 'date: 25 Mar\nregion: Jaipur',
        source: 'whatsapp',
        timestamp: 1711353600000,
        rep_id: 'rep-01',
      },
      options: { range: 'A:Z' },
    });
  });

  it('source is always "whatsapp"', () => {
    expect(buildWriteRawReportInput(BASE_STATE).data.source).toBe('whatsapp');
  });

  it('operation is always "write"', () => {
    expect(buildWriteRawReportInput(BASE_STATE).operation).toBe('write');
  });

  it('resource is always "raw_reports"', () => {
    expect(buildWriteRawReportInput(BASE_STATE).resource).toBe('raw_reports');
  });

  it('maps rep_id from rep', () => {
    expect(buildWriteRawReportInput(BASE_STATE).data.rep_id).toBe(REP.rep_id);
  });

  it('preserves raw_text verbatim', () => {
    const text = 'anything: goes\neven: weird: colons';
    const result = buildWriteRawReportInput({ ...BASE_STATE, raw_text: text });
    expect(result.data.raw_text).toBe(text);
  });

  it('preserves timestamp exactly', () => {
    const result = buildWriteRawReportInput({ ...BASE_STATE, timestamp: 9999999 });
    expect(result.data.timestamp).toBe(9999999);
  });
});
