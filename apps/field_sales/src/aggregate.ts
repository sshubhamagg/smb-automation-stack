import type { NormalizedReport } from './types';

export type RepMetrics = {
  rep_id: string;
  total_calls: number;
  orders: number;
  sales_value: number;
  stock_issue: boolean;
  report_count: number;
};

export type AggregateResult = {
  total_sales: number;
  total_orders: number;
  total_calls: number;
  rep_metrics: Record<string, RepMetrics>;
};

// Sums an array of integers using integer arithmetic to avoid IEEE 754
// accumulation errors on values that are whole numbers (sales, calls, orders).
// Values are multiplied by SCALE before summing and divided after.
// For this domain all monetary values are assumed to be whole currency units.
const SCALE = 100;

function safeSum(values: number[]): number {
  const scaled = values.reduce((acc, v) => acc + Math.round(v * SCALE), 0);
  return scaled / SCALE;
}

export function aggregateReports(reports: NormalizedReport[]): AggregateResult {
  const valid = reports.filter((r) => r.status === 'valid');

  const total_sales = safeSum(valid.map((r) => r.sales_value));
  const total_orders = safeSum(valid.map((r) => r.orders));
  const total_calls = safeSum(valid.map((r) => r.total_calls));

  const rep_metrics: Record<string, RepMetrics> = {};

  for (const report of valid) {
    const existing = rep_metrics[report.rep_id];

    if (existing === undefined) {
      rep_metrics[report.rep_id] = {
        rep_id: report.rep_id,
        total_calls: report.total_calls,
        orders: report.orders,
        sales_value: report.sales_value,
        stock_issue: report.stock_issue,
        report_count: 1,
      };
    } else {
      rep_metrics[report.rep_id] = {
        rep_id: report.rep_id,
        total_calls: safeSum([existing.total_calls, report.total_calls]),
        orders: safeSum([existing.orders, report.orders]),
        sales_value: safeSum([existing.sales_value, report.sales_value]),
        stock_issue: existing.stock_issue || report.stock_issue,
        report_count: existing.report_count + 1,
      };
    }
  }

  return { total_sales, total_orders, total_calls, rep_metrics };
}
