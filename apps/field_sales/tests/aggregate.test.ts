import { aggregateReports } from '../src/aggregate';
import type { NormalizedReport } from '../src/types';

function makeReport(
  rep_id: string,
  overrides: Partial<NormalizedReport> = {},
): NormalizedReport {
  return {
    report_id: `${rep_id}_25 Mar`,
    rep_id,
    date: '25 Mar',
    region: 'Jaipur',
    beat: 'Sodala',
    total_calls: 10,
    orders: 2,
    sales_value: 1000,
    stock_issue: false,
    remarks: '',
    status: 'valid',
    submitted_at: 0,
    ...overrides,
  };
}

describe('aggregateReports — totals', () => {
  it('sums sales_value across all valid reports', () => {
    const reports = [
      makeReport('r1', { sales_value: 10000 }),
      makeReport('r2', { sales_value: 5000 }),
    ];
    expect(aggregateReports(reports).total_sales).toBe(15000);
  });

  it('sums total_calls across all valid reports', () => {
    const reports = [
      makeReport('r1', { total_calls: 18 }),
      makeReport('r2', { total_calls: 12 }),
    ];
    expect(aggregateReports(reports).total_calls).toBe(30);
  });

  it('sums orders across all valid reports', () => {
    const reports = [
      makeReport('r1', { orders: 7 }),
      makeReport('r2', { orders: 3 }),
    ];
    expect(aggregateReports(reports).total_orders).toBe(10);
  });

  it('returns zeros when reports array is empty', () => {
    const result = aggregateReports([]);
    expect(result.total_sales).toBe(0);
    expect(result.total_orders).toBe(0);
    expect(result.total_calls).toBe(0);
    expect(result.rep_metrics).toEqual({});
  });

  it('returns zeros when all reports are non-valid', () => {
    const reports = [
      makeReport('r1', { status: 'invalid' }),
      makeReport('r2', { status: 'duplicate' }),
    ];
    const result = aggregateReports(reports);
    expect(result.total_sales).toBe(0);
    expect(result.total_orders).toBe(0);
    expect(result.total_calls).toBe(0);
  });
});

describe('aggregateReports — status filtering', () => {
  it('excludes invalid reports from all totals', () => {
    const reports = [
      makeReport('r1', { sales_value: 5000, status: 'valid' }),
      makeReport('r2', { sales_value: 9999, status: 'invalid' }),
    ];
    expect(aggregateReports(reports).total_sales).toBe(5000);
  });

  it('excludes duplicate reports from all totals', () => {
    const reports = [
      makeReport('r1', { orders: 5, status: 'valid' }),
      makeReport('r2', { orders: 99, status: 'duplicate' }),
    ];
    expect(aggregateReports(reports).total_orders).toBe(5);
  });

  it('excludes non-valid reps from rep_metrics', () => {
    const reports = [
      makeReport('r1', { status: 'valid' }),
      makeReport('r2', { status: 'invalid' }),
    ];
    const { rep_metrics } = aggregateReports(reports);
    expect(Object.keys(rep_metrics)).toEqual(['r1']);
  });
});

describe('aggregateReports — rep_metrics grouping', () => {
  it('creates one entry per rep', () => {
    const reports = [makeReport('r1'), makeReport('r2'), makeReport('r3')];
    const { rep_metrics } = aggregateReports(reports);
    expect(Object.keys(rep_metrics).sort()).toEqual(['r1', 'r2', 'r3']);
  });

  it('accumulates multiple reports for the same rep', () => {
    const reports = [
      makeReport('r1', { sales_value: 3000, orders: 3, total_calls: 8 }),
      makeReport('r1', { report_id: 'r1_26 Mar', date: '26 Mar', sales_value: 2000, orders: 2, total_calls: 5 }),
    ];
    const { rep_metrics } = aggregateReports(reports);
    expect(rep_metrics['r1'].sales_value).toBe(5000);
    expect(rep_metrics['r1'].orders).toBe(5);
    expect(rep_metrics['r1'].total_calls).toBe(13);
    expect(rep_metrics['r1'].report_count).toBe(2);
  });

  it('sets stock_issue to true if any report for the rep has it', () => {
    const reports = [
      makeReport('r1', { stock_issue: false }),
      makeReport('r1', { report_id: 'r1_26 Mar', date: '26 Mar', stock_issue: true }),
    ];
    const { rep_metrics } = aggregateReports(reports);
    expect(rep_metrics['r1'].stock_issue).toBe(true);
  });

  it('keeps stock_issue false when no report for rep has it', () => {
    const reports = [makeReport('r1', { stock_issue: false })];
    expect(aggregateReports(reports).rep_metrics['r1'].stock_issue).toBe(false);
  });

  it('sets report_count to 1 for a single report', () => {
    const reports = [makeReport('r1')];
    expect(aggregateReports(reports).rep_metrics['r1'].report_count).toBe(1);
  });

  it('rep_metrics entry matches individual report values for single-report rep', () => {
    const reports = [makeReport('r1', { total_calls: 15, orders: 4, sales_value: 7500 })];
    const metrics = aggregateReports(reports).rep_metrics['r1'];
    expect(metrics.total_calls).toBe(15);
    expect(metrics.orders).toBe(4);
    expect(metrics.sales_value).toBe(7500);
    expect(metrics.rep_id).toBe('r1');
  });
});

describe('aggregateReports — precision', () => {
  it('handles values that would accumulate floating point errors', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in naive JS addition
    const reports = [
      makeReport('r1', { sales_value: 0.1 }),
      makeReport('r2', { sales_value: 0.2 }),
    ];
    expect(aggregateReports(reports).total_sales).toBe(0.3);
  });

  it('sums many small values without drift', () => {
    const reports = Array.from({ length: 10 }, (_, i) =>
      makeReport(`r${i}`, { sales_value: 0.1 }),
    );
    expect(aggregateReports(reports).total_sales).toBe(1.0);
  });
});

describe('aggregateReports — immutability', () => {
  it('does not mutate the input array', () => {
    const reports = [makeReport('r1'), makeReport('r2')];
    const copy = reports.map((r) => ({ ...r }));
    aggregateReports(reports);
    expect(reports).toEqual(copy);
  });

  it('does not mutate individual report objects', () => {
    const report = makeReport('r1', { sales_value: 5000 });
    const snapshot = { ...report };
    aggregateReports([report]);
    expect(report).toEqual(snapshot);
  });
});
