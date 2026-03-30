import type { ParsedReportData } from '../parser';
import type { Rep } from '../types';

type DuplicateCheckInput = {
  provider: 'sheets';
  operation: 'query';
  resource: string;
  query: {
    rep_id: string;
    date: string;
  };
  options: {
    range: string;
  };
};

export function buildDuplicateCheckInput(state: {
  parsed_input: ParsedReportData;
  rep: Rep;
}): DuplicateCheckInput {
  return {
    provider: 'sheets',
    operation: 'query',
    resource: 'daily_reports',
    query: {
      rep_id: state.rep?.rep_id ?? '',
      date: state.parsed_input?.date ?? '',
    },
    options: {
      range: 'A:Z',
    },
  };
}
