export interface Rep {
  rep_id: string;
  name: string;
  manager_id: string;
  region: string;
  phone: string;
  active: boolean;
}

export interface RawReport {
  raw_text: string;
  source: 'whatsapp';
  timestamp: number;
  rep_id: string;
}

export type ReportStatus = 'valid' | 'invalid' | 'duplicate';

export interface NormalizedReport {
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
  status: ReportStatus;
  submitted_at: number;
}

export interface ManagerSummary {
  manager_id: string;
  date: string;
  total_reps: number;
  reports_received: number;
  missing_reps: string[];
  total_sales: number;
  total_orders: number;
  total_calls: number;
  top_performers: string[];
  exceptions: string[];
}

export type ExceptionType =
  | 'missing_report'
  | 'zero_sales'
  | 'low_performance'
  | 'stock_issue';

export interface ExceptionLog {
  exception_id: string;
  rep_id: string;
  date: string;
  type: ExceptionType;
  description: string;
  report_id: string | null;
  created_at: number;
}
