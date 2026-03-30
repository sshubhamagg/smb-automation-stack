import type { ParsedReportData } from '../parser';
import type { Rep } from '../types';

type WriteRawReportInput = {
  provider: 'sheets';
  operation: 'write';
  resource: string;
  data: {
    raw_text: string;
    source: 'whatsapp';
    timestamp: number;
    rep_id: string;
  };
  options: {
    range: string;
  };
};

export function buildWriteRawReportInput(state: {
  parsed_input: ParsedReportData;
  rep: Rep;
  raw_text: string;
  timestamp: number;
}): WriteRawReportInput {
  return {
    provider: 'sheets',
    operation: 'write',
    resource: 'raw_reports',
    data: {
      raw_text: state.raw_text ?? '',
      source: 'whatsapp',
      timestamp: state.timestamp ?? 0,
      rep_id: state.rep?.rep_id ?? '',
    },
    options: {
      range: 'A:Z',
    },
  };
}
