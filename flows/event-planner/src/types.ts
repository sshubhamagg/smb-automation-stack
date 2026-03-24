// ============================================================
// Event Planner — Shared Domain Types
// ============================================================

// ---- Runtime config (from env vars, injected into ctx.state.config) ----

export type PlannerConfig = {
  sheetId: string;
  reminderSheetId: string;
  plannerPhone: string;       // E.164
  eventName: string;
  eventDate: string;          // YYYY-MM-DD — used as default deadline
  mode: 'structured' | 'ai';
  aiProvider: 'openai' | 'anthropic' | 'local' | 'nvidia';
};

// ---- Parsed inbound intent (from structured parser or AI) ----

export type ParsedIntent = {
  intent: 'assign' | 'status' | 'done' | 'cancel';
  vendorPhone?: string;       // E.164 — required for assign / optional for status
  taskDescription?: string;  // required for assign
  category?: string;         // optional for assign
  deadline?: string;         // YYYY-MM-DD — for assign; defaults to eventDate if absent
  taskId?: string;           // required for done / cancel
};

// ---- Routing decision returned by resolveRouting() ----

export type RoutingDecision = {
  nextFlow: 'task-assign' | 'task-status' | 'task-complete' | 'task-cancel';
  parsed: ParsedIntent;
} | null;

// ---- TASKS sheet column header names ----
// Sheet must have these exact headers in row 1.

export const TASK_COLS = {
  taskId:      'Task ID',
  event:       'Event',
  vendorPhone: 'Vendor Phone',
  description: 'Description',
  category:    'Category',
  deadline:    'Deadline',
  status:      'Status',
  assignedAt:  'Assigned At',
  completedAt: 'Completed At',
} as const;

export type TaskStatus = 'PENDING' | 'DONE' | 'CANCELLED';

// ---- REMINDERS_LOG sheet column header names ----

export const REMINDER_COLS = {
  date:          'Date',
  taskId:        'Task ID',
  vendorPhone:   'Vendor Phone',
  messageSent:   'Message Sent',
  reminderType:  'Reminder Type',
} as const;

// ---- Inbound message shape (after ingestion-module normalization) ----

export type IncomingMessage = {
  phone_number: string;   // E.164 — sender
  text_body?: string;
  message_type: 'text' | 'unsupported';
};
