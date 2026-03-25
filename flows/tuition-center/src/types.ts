// ============================================================
// Tuition Center — Shared Domain Types
// ============================================================

// ---- Runtime config (from env vars, injected into ctx.state.config) ----

export type TuitionConfig = {
  studentsSheetId: string;      // STUDENTS named range sheet
  attendanceSheetId: string;    // ATTENDANCE named range sheet
  feesSheetId: string;          // FEES named range sheet
  remindersSheetId: string;     // REMINDERS_LOG named range sheet
  teacherPhone: string;         // E.164
  centerName: string;           // display name for messages
  mode: 'structured' | 'ai';
  aiProvider: 'openai' | 'anthropic' | 'local' | 'nvidia';
};

// ---- Parsed inbound intent (from structured parser or AI) ----

export type ParsedIntent = {
  intent: 'present' | 'absent' | 'paid' | 'attendance' | 'fees' | 'unknown';
  studentPhone?: string;   // E.164 — target student
  amount?: number;         // for 'paid'
};

// ---- Routing decision returned by resolveRouting() ----

export type RoutingDecision = {
  nextFlow: 'mark-attendance' | 'record-payment' | 'query-attendance' | 'query-fees';
  parsed: ParsedIntent;
} | null;

// ---- Inbound message shape (after ingestion-module normalization) ----

export type IncomingMessage = {
  phone_number: string;   // E.164 — sender (teacher)
  text_body?: string;
  message_type: 'text' | 'unsupported';
};

// ---- STUDENTS sheet column header names ----

export const STUDENT_COLS = {
  studentId:   'Student ID',
  name:        'Name',
  phone:       'Phone',
  parentPhone: 'Parent Phone',
  batch:       'Batch',
  monthlyFee:  'Monthly Fee',
  enrolledAt:  'Enrolled At',
  status:      'Status',
} as const;

// ---- ATTENDANCE sheet column header names ----

export const ATTENDANCE_COLS = {
  date:      'Date',
  studentId: 'Student ID',
  phone:     'Student Phone',
  name:      'Name',
  batch:     'Batch',
  status:    'Status',
  markedBy:  'Marked By',
  markedAt:  'Marked At',
} as const;

// ---- FEES sheet column header names ----

export const FEE_COLS = {
  feeId:      'Fee ID',
  studentId:  'Student ID',
  phone:      'Student Phone',
  name:       'Name',
  month:      'Month',
  amountDue:  'Amount Due',
  amountPaid: 'Amount Paid',
  status:     'Status',
  dueDate:    'Due Date',
  paidAt:     'Paid At',
} as const;

export type FeeStatus = 'UNPAID' | 'PARTIAL' | 'PAID' | 'WAIVED';
