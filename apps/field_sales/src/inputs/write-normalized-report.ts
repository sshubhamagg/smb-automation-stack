import type { ParsedReportData } from '../parser';
import type { Rep } from '../types';

type WriteNormalizedReportInput = {
  provider: 'sheets';
  operation: 'write';
  resource: string;
  data: {
    report_id: string;
    rep_id: string;
    date: string;
    region: string;
    beat: string;
    total_calls: number;
    orders: number;
    sales_value: number;
    stock_issue: boolean;
    remarks: string;
    status: 'valid';
    submitted_at: number;
  };
  options: {
    range: string;
  };
};

export function buildWriteNormalizedReportInput(state: {
  parsed_input: ParsedReportData;
  rep: Rep;
  submitted_at: number;
}): WriteNormalizedReportInput {
  return {
    provider: 'sheets',
    operation: 'write',
    resource: 'daily_reports',
    data: {
      report_id: `${state.rep?.rep_id ?? ''}_${state.parsed_input?.date ?? ''}`,
      rep_id: state.rep?.rep_id ?? '',
      date: state.parsed_input?.date ?? '',
      region: state.parsed_input?.region ?? '',
      beat: state.parsed_input?.beat ?? '',
      total_calls: state.parsed_input?.total_calls ?? 0,
      orders: state.parsed_input?.orders ?? 0,
      sales_value: state.parsed_input?.sales_value ?? 0,
      stock_issue: state.parsed_input?.stock_issue ?? false,
      remarks: state.parsed_input?.remarks ?? '',
      status: 'valid',
      submitted_at: state.submitted_at ?? 0,
    },
    options: {
      range: 'A:Z',
    },
  };
}
