# Tuition Center — Technical Specification

## 1. Architecture Overview

System follows the existing flow-based execution model:

```
App Handler → Intent Router → Flow Dispatch → Modules → Output
App Server  → Cron (1st)    → Fee Init Flow → Modules → Output
App Server  → Cron (daily)  → Fee Reminder Flow → Modules → Output
```

Aligned with system context:
- flows contain business logic
- modules handle I/O
- orchestrator manages execution
- ingestion-module runs before engine (pre-flow)

---

## 2. Folder Structure

```
apps/tuition-center/
└── src/
    ├── server.ts      — Express + webhook + cron triggers
    └── handler.ts     — config, modules, intent dispatch

flows/tuition-center/
├── src/
│   └── types.ts       — shared types (TuitionConfig, ParsedIntent, etc.)
├── intent-router/
│   └── flow.ts        — parse intent, resolveRouting()
├── mark-attendance/
│   └── flow.ts        — write attendance row + confirm teacher + optional student notify
├── record-payment/
│   └── flow.ts        — read fee row → update with payment → confirm teacher + student
├── query-attendance/
│   └── flow.ts        — read ATTENDANCE sheet, filter, format, send
├── query-fees/
│   └── flow.ts        — read FEES sheet, filter, format, send
├── init-fees/
│   └── flow.ts        — 1st-of-month: read STUDENTS → write fee row per active student
└── fee-reminders/
    └── flow.ts        — daily: classify overdue/due-soon → send to students → log
```

---

## 3. Execution Pipeline

### Inbound (webhook-triggered)

```
server.ts
  → ingestion-module.receive()
  → handler.handleTeacherMessage()
      → intent-router flow             (parse intent)
      → resolveRouting()               (pick sub-flow)
      → mark-attendance flow           if intent = present | absent
      → record-payment flow            if intent = paid
      → query-attendance flow          if intent = attendance
      → query-fees flow                if intent = fees
```

### Scheduled (cron-triggered)

```
server.ts cron (1st of month, 08:00)
  → handler.handleFeeInit()
      → init-fees flow                 (create fee records for month)

server.ts cron (daily, 09:00)
  → handler.handleFeeReminders()
      → fee-reminders flow             (check overdue/due-soon → send reminders)
```

Flows do not call other flows.

---

## 4. Shared Types

```ts
// flows/tuition-center/src/types.ts

export type TuitionConfig = {
  studentsSheetId: string;      // STUDENTS sheet
  attendanceSheetId: string;    // ATTENDANCE sheet
  feesSheetId: string;          // FEES sheet
  remindersSheetId: string;     // REMINDERS_LOG sheet
  teacherPhone: string;         // E.164
  centerName: string;           // display name
  mode: 'structured' | 'ai';
  aiProvider: 'openai' | 'anthropic' | 'local' | 'nvidia';
};

export type ParsedIntent = {
  intent: 'present' | 'absent' | 'paid' | 'attendance' | 'fees' | 'unknown';
  studentPhone?: string;        // E.164 — target student
  amount?: number;              // for 'paid'
};

export type RoutingDecision = {
  nextFlow: 'mark-attendance' | 'record-payment' | 'query-attendance' | 'query-fees';
  parsed: ParsedIntent;
} | null;

export type IncomingMessage = {
  phone_number: string;
  text_body?: string;
  message_type: 'text' | 'unsupported';
};

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

export const ATTENDANCE_COLS = {
  date:       'Date',
  studentId:  'Student ID',
  phone:      'Student Phone',
  name:       'Name',
  batch:      'Batch',
  status:     'Status',
  markedBy:   'Marked By',
  markedAt:   'Marked At',
} as const;

export const FEE_COLS = {
  feeId:       'Fee ID',
  studentId:   'Student ID',
  phone:       'Student Phone',
  name:        'Name',
  month:       'Month',
  amountDue:   'Amount Due',
  amountPaid:  'Amount Paid',
  status:      'Status',
  dueDate:     'Due Date',
  paidAt:      'Paid At',
} as const;
```

---

## 5. Context Model

### Inbound flows

```ts
ctx.state = {
  config: TuitionConfig,
  parsed: ParsedIntent,
  // flow-specific pre-computed values:
  attendanceId?: string,   // mark-attendance: generated in buildInitialContext
  feeId?: string,          // record-payment: generated in buildInitialContext
  markedAt?: string,       // mark-attendance: ISO timestamp
  month?: string,          // record-payment / query-fees: YYYY-MM (current month)
}
```

### Scheduled flows

```ts
// init-fees
ctx.state = {
  config: TuitionConfig,
  month: string,           // YYYY-MM (current month)
  dueDate: string,         // YYYY-MM-07 (7th of month)
  runDate: string,
}

// fee-reminders
ctx.state = {
  config: TuitionConfig,
  runDate: string,         // YYYY-MM-DD
  month: string,           // YYYY-MM
}
```

---

## 6. Flow Design

### Flow 1: intent-router

Responsibilities:
- Structured parse of inbound teacher message
- Expose `resolveRouting()` for handler dispatch

Structured parse patterns:
```
present +91...        → intent: present
absent +91...         → intent: absent
paid +91... <amount>  → intent: paid
attendance            → intent: attendance (all students)
attendance +91...     → intent: attendance (one student)
fees                  → intent: fees (all students)
fees +91...           → intent: fees (one student)
```

Steps:
- `classify-intent` — intelligence, condition: structured parse failed AND mode = 'ai'

---

### Flow 2: mark-attendance

Responsibilities:
- Write one attendance row to ATTENDANCE sheet
- Confirm to teacher
- (Optional) send attendance confirmation to student

Pre-computed in buildInitialContext:
- Look up student in STUDENTS sheet → get name, batch (passed as state)
- `attendanceId` = `ATT-${Date.now()}-${random}`
- `markedAt` = ISO timestamp

Steps:
- `read-student` — storage read (STUDENTS — find by phone)
- `write-attendance` — storage write (ATTENDANCE)
- `confirm-teacher` — communication send (condition: write-attendance ran)
- `confirm-student` — communication send (condition: write-attendance ran AND status = present)

---

### Flow 3: record-payment

Responsibilities:
- Read FEES sheet to find current month's record for student
- Update row: Amount Paid, Status, Paid At
- Confirm to teacher
- Send receipt to student

Pre-computed in buildInitialContext:
- `month` = current YYYY-MM
- `paidAt` = ISO timestamp

Steps:
- `read-fees` — storage read (FEES)
- `update-fee` — storage update (condition: fee record found AND status != PAID)
- `confirm-teacher` — communication send (condition: update-fee ran)
- `receipt-student` — communication send (condition: update-fee ran)
- `send-not-found` — communication send (condition: fee record not found)
- `send-already-paid` — communication send (condition: fee found AND status = PAID)

---

### Flow 4: query-attendance

Responsibilities:
- Read ATTENDANCE sheet
- Filter by current month (and optionally by student phone)
- Format summary and send to teacher

Steps:
- `read-attendance` — storage read (ATTENDANCE)
- `send-attendance` — communication send

---

### Flow 5: query-fees

Responsibilities:
- Read FEES sheet
- Filter by current month (and optionally by student phone)
- Format summary and send to teacher

Steps:
- `read-fees` — storage read (FEES)
- `send-fees` — communication send

---

### Flow 6: init-fees

Responsibilities:
- 1st of month: read all ACTIVE students from STUDENTS sheet
- For each active student: write one fee row to FEES sheet (UNPAID)
- Engine constraint: one write per step → write up to N students using a loop in buildInitialContext to pre-compute rows, then use a single write per student

Design decision (engine constraint — no dynamic steps):
- `buildInitialContext` reads STUDENTS sheet and pre-computes all fee rows
- Flow has a single step: `write-fee-batch` — a single storage write per student
- Alternatively: `steps: []` — all logic in `buildInitialContext`, rows written by handler iterating over students and calling `runFlow(singleWriteFlow, ctx)` per row
- Recommended: handler calls a lightweight `writeFeeRow` helper outside the flow for each student (not a flow step), since engine cannot dynamically repeat steps

Steps:
- `read-students` — storage read (STUDENTS)
- *(fee row writes handled in handler post-flow, iterating over rows)*

---

### Flow 7: fee-reminders

Responsibilities:
- Read FEES sheet for current month
- Identify UNPAID records past due date (overdue) and 2 days before due (due-soon)
- Send consolidated reminder to overdue students
- Log to REMINDERS_LOG

Steps:
- `read-fees` — storage read (FEES)
- `send-overdue-reminders` — communication send (condition: overdue fees exist)
- `send-due-soon-reminders` — communication send (condition: due-soon fees exist)
- `log-overdue` — storage write (condition: overdue fees exist)
- `log-due-soon` — storage write (condition: due-soon fees exist)
- `send-all-clear` — communication send to teacher (condition: no overdue / due-soon)

---

## 7. Storage Module Usage

### STUDENTS — read
```ts
{
  provider: 'sheets',
  operation: 'read',
  resource: config.studentsSheetId,
  options: { range: 'STUDENTS' }
}
```

### ATTENDANCE — write
```ts
{
  provider: 'sheets',
  operation: 'write',
  resource: config.attendanceSheetId,
  data: [attendanceId, studentId, phone, name, batch, 'PRESENT'|'ABSENT', teacherPhone, markedAt],
  options: { range: 'ATTENDANCE' }
}
```

### FEES — read
```ts
{
  provider: 'sheets',
  operation: 'read',
  resource: config.feesSheetId,
  options: { range: 'FEES' }
}
```

### FEES — write (init)
```ts
{
  provider: 'sheets',
  operation: 'write',
  resource: config.feesSheetId,
  data: [feeId, studentId, phone, name, month, monthlyFee, '0', 'UNPAID', dueDate, ''],
  options: { range: 'FEES' }
}
```

### FEES — update (payment)
```ts
{
  provider: 'sheets',
  operation: 'update',
  resource: config.feesSheetId,
  data: [...updatedRow],
  options: { range: 'FEES', rowIndex: feeRowIndex }  // +1 for header
}
```

### REMINDERS_LOG — write
```ts
{
  provider: 'sheets',
  operation: 'write',
  resource: config.remindersSheetId,
  data: [runDate, studentPhone, messageSent, reminderType],
  options: { range: 'REMINDERS_LOG' }
}
```

---

## 8. Communication Module Usage

```ts
{
  to: studentPhone | teacherPhone,
  message: '...',
  provider: 'meta'
}
```

---

## 9. ID Generation

All IDs generated in `buildInitialContext()` — never inside flow steps.

```ts
attendanceId: `ATT-${Date.now()}-${Math.floor(Math.random() * 1000)}`
feeId:        `FEE-${month}-${studentId}`   // deterministic per student per month
```

---

## 10. Error Handling

Must handle:
- Student phone not found in STUDENTS sheet
- Duplicate attendance for same student same day (write anyway — sheet is log)
- Fee record not found for current month (student not initialized)
- Fee already PAID when `paid` command sent
- Partial payment (Amount Paid < Amount Due → status = PARTIAL)
- Empty FEES sheet on reminder run (no records → skip)
- Non-active students excluded from fee init and reminders

---

## 11. Environment Variables

```
TUITION_STUDENTS_SHEET_ID     — STUDENTS tab sheet ID
TUITION_ATTENDANCE_SHEET_ID   — ATTENDANCE tab sheet ID
TUITION_FEES_SHEET_ID         — FEES tab sheet ID
TUITION_REMINDERS_SHEET_ID    — REMINDERS_LOG tab sheet ID
TUITION_TEACHER_PHONE         — teacher's WhatsApp number (E.164)
TUITION_CENTER_NAME           — display name for messages
TUITION_MODE                  — 'structured' | 'ai' (default: structured)
TUITION_AI_PROVIDER           — openai | anthropic | local | nvidia
WEBHOOK_VERIFY_TOKEN          — Meta webhook token
PORT                          — server port (default: 3003)
```

---

## 12. Constraints (System-Level)

- no API calls in flow step input() or condition()
- no direct DB access
- only storage / communication / intelligence modules in steps
- input() and condition() must not throw
- no hard-coded phone numbers or sheet IDs in flow files
- all config injected via ctx.state.config
- IDs generated in buildInitialContext, never in steps
- all prior step outputs read via ctx.outputs?.['step-id']
- `rowIndex` for update = dataArrayIndex + 1 (header row offset)

---

## 13. Extensibility

Future:
- AI free-text commands ("Rahul didn't come today")
- Bulk attendance marking by batch name
- Exam / test score tracking per student
- Student performance report (AI-generated monthly summary)
- WhatsApp group integration (mark attendance from group message)
- Parent notification on fee due / attendance missed
