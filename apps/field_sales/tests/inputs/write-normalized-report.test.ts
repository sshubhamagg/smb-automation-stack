import { buildWriteNormalizedReportInput } from '../../src/inputs/write-normalized-report';
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
  remarks: 'all good',
};

const BASE_STATE = { parsed_input: PARSED, rep: REP, submitted_at: 1711353600000 };

describe('buildWriteNormalizedReportInput', () => {
  it('returns correct shape', () => {
    const result = buildWriteNormalizedReportInput(BASE_STATE);
    expect(result).toEqual({
      provider: 'sheets',
      operation: 'write',
      resource: 'daily_reports',
      data: {
        report_id: 'rep-01_25 Mar',
        rep_id: 'rep-01',
        date: '25 Mar',
        region: 'Jaipur',
        beat: 'Sodala',
        total_calls: 18,
        orders: 7,
        sales_value: 24500,
        stock_issue: false,
        remarks: 'all good',
        status: 'valid',
        submitted_at: 1711353600000,
      },
      options: { range: 'A:Z' },
    });
  });

  it('report_id is composite of rep_id and date', () => {
    const result = buildWriteNormalizedReportInput(BASE_STATE);
    expect(result.data.report_id).toBe(`${REP.rep_id}_${PARSED.date}`);
  });

  it('status is always "valid"', () => {
    expect(buildWriteNormalizedReportInput(BASE_STATE).data.status).toBe('valid');
  });

  it('operation is always "write"', () => {
    expect(buildWriteNormalizedReportInput(BASE_STATE).operation).toBe('write');
  });

  it('resource is always "daily_reports"', () => {
    expect(buildWriteNormalizedReportInput(BASE_STATE).resource).toBe('daily_reports');
  });

  it('maps all parsed numeric fields without modification', () => {
    const data = buildWriteNormalizedReportInput(BASE_STATE).data;
    expect(data.total_calls).toBe(PARSED.total_calls);
    expect(data.orders).toBe(PARSED.orders);
    expect(data.sales_value).toBe(PARSED.sales_value);
  });

  it('maps stock_issue boolean', () => {
    const withIssue = buildWriteNormalizedReportInput({
      ...BASE_STATE,
      parsed_input: { ...PARSED, stock_issue: true },
    });
    expect(withIssue.data.stock_issue).toBe(true);
  });

  it('preserves submitted_at timestamp', () => {
    const result = buildWriteNormalizedReportInput({ ...BASE_STATE, submitted_at: 42 });
    expect(result.data.submitted_at).toBe(42);
  });

  it('report_id changes with different rep or date', () => {
    const r1 = buildWriteNormalizedReportInput(BASE_STATE).data.report_id;
    const r2 = buildWriteNormalizedReportInput({
      ...BASE_STATE,
      rep: { ...REP, rep_id: 'rep-02' },
    }).data.report_id;
    expect(r1).not.toBe(r2);
  });
});
