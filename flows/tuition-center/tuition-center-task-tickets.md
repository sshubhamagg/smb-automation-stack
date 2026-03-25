# Tuition Center — Execution Tickets

---

## TASK 1: Parse Intent (Intent Router)

### Input
- `ctx.event.message` — raw WhatsApp text from teacher
- `ctx.state.config.mode` — 'structured' | 'ai'

### Output
`ctx.state.parsed`

```ts
{
  intent: 'present' | 'absent' | 'paid' | 'attendance' | 'fees' | 'unknown',
  studentPhone?: string,   // E.164
  amount?: number,         // for 'paid'
}
```

### Logic
Structured parse first (always):
- `present +91...`       → intent: present, studentPhone
- `absent +91...`        → intent: absent, studentPhone
- `paid +91... 2500`     → intent: paid, studentPhone, amount
- `attendance`           → intent: attendance (all)
- `attendance +91...`    → intent: attendance (one student)
- `fees`                 → intent: fees (all)
- `fees +91...`          → intent: fees (one student)

If structured parse fails AND mode = 'ai':
- Run intelligence classify step with categories: present, absent, paid, attendance, fees, unknown

### Integration
- intelligence module (classify) — conditional step only

### Constraints
- buildInitialContext handles structured parse (pure, non-throwing)
- Parts parsed with `?? ''` fallback (strict null safety)
- Amount parsed as `parseFloat` with NaN check
- Unknown or malformed commands → send help message, do not fail flow
- `resolveRouting()` returns null for unknown intent

---

## TASK 2: Mark Attendance

### Input
`ctx.state.parsed`
```ts
{ intent: 'present' | 'absent', studentPhone: string }
```

`ctx.state.config`
```ts
{ attendanceSheetId, studentsSheetId, teacherPhone, centerName }
```

`ctx.state` (pre-computed in buildInitialContext):
```ts
{ attendanceId: string, markedAt: string }
```

### Output
`ctx.outputs['read-student']` — rows from STUDENTS sheet
`ctx.outputs['write-attendance']` — storage write result
`ctx.outputs['confirm-teacher']` — null
`ctx.outputs['confirm-student']` — null

### Logic

Step 1 — read-student:
- Read STUDENTS sheet
- Look up student by phone in input() of next step

Step 2 — write-attendance:
- Build row: [attendanceId, studentId, phone, name, batch, STATUS, teacherPhone, markedAt]
- studentId and name extracted from read-student output
- If student not found in STUDENTS → use phone as fallback for name, empty studentId

Step 3 — confirm-teacher (condition: write-attendance ran):
```
✅ Attendance marked
Student : Rahul (+91...)
Status  : PRESENT
Date    : 2026-03-24
Batch   : Morning
```

Step 4 — confirm-student (condition: write-attendance ran AND intent = present):
```
Hi Rahul! Your attendance has been marked for today at <CenterName>. See you next time!
```

### Integration
- storage module (read, write)
- communication module (meta)

### Constraints
- attendanceId generated in buildInitialContext, never in step
- markedAt ISO timestamp generated in buildInitialContext
- Student lookup failure is non-fatal — attendance row still written with phone as identifier
- No duplicate check — ATTENDANCE is an append-only log

---

## TASK 3: Record Fee Payment

### Input
`ctx.state.parsed`
```ts
{ intent: 'paid', studentPhone: string, amount: number }
```

`ctx.state.config`
```ts
{ feesSheetId, teacherPhone, centerName }
```

`ctx.state` (pre-computed in buildInitialContext):
```ts
{ month: string, paidAt: string }   // month = YYYY-MM
```

### Output
`ctx.outputs['read-fees']` — all rows from FEES sheet
`ctx.outputs['update-fee']` — storage update result
`ctx.outputs['confirm-teacher']` — null
`ctx.outputs['receipt-student']` — null
`ctx.outputs['send-not-found']` — null (if no fee record)
`ctx.outputs['send-already-paid']` — null (if already PAID)

### Logic

Step 1 — read-fees:
- Read full FEES sheet

Step 2 — update-fee (condition: fee record found AND status != PAID):
- Find row by studentPhone + month
- rowIndex = dataIndex + 1 (header offset)
- Compute new amountPaid = existing amountPaid + incoming amount
- Compute status:
  - amountPaid >= amountDue → PAID
  - amountPaid > 0 → PARTIAL
- Update row with new amountPaid, status, paidAt

Step 3 — confirm-teacher (condition: update-fee ran):
```
Payment recorded ✅
Student : Rahul (+91...)
Month   : March 2026
Paid    : ₹2500
Status  : PAID
```

Step 4 — receipt-student (condition: update-fee ran):
```
Payment received ✅
₹2500 for March 2026
<CenterName>
Balance: ₹0
Thank you!
```

Step 5 — send-not-found (condition: fee record not found):
```
No fee record found for +91... in March 2026.
Use "fees +91..." to check, or contact admin.
```

Step 6 — send-already-paid (condition: fee found AND status = PAID):
```
Fees already paid for +91... in March 2026. No action needed.
```

### Integration
- storage module (read, update)
- communication module (meta)

### Constraints
- rowIndex for update = dataIndex + 1 (header row offset)
- amountPaid accumulates (supports partial payments across multiple `paid` commands)
- PARTIAL status set when amountPaid > 0 but < amountDue
- month computed in buildInitialContext from current date, never in step

---

## TASK 4: Query Attendance

### Input
`ctx.state.parsed`
```ts
{ intent: 'attendance', studentPhone?: string }
```

`ctx.state.config`
```ts
{ attendanceSheetId, teacherPhone }
```

`ctx.state`:
```ts
{ month: string }   // current YYYY-MM, for filtering
```

### Output
`ctx.outputs['read-attendance']` — rows from ATTENDANCE sheet
`ctx.outputs['send-attendance']` — null

### Logic

Step 1 — read-attendance:
- Read full ATTENDANCE sheet

Step 2 — send-attendance:
- Filter to current month rows
- If studentPhone provided: filter to that student only
- Count PRESENT / ABSENT

If single student:
```
Attendance — Rahul (March 2026)
Present : 18
Absent  : 3
Total   : 21 sessions
```

If all students:
```
Attendance Summary — March 2026
Rahul     : 18P / 3A
Priya     : 20P / 1A
Arjun     : 15P / 6A
```

### Integration
- storage module (read)
- communication module (meta)

### Constraints
- All filtering in input() of send-attendance step (pure, non-throwing)
- Empty result (no attendance rows for month) → "No attendance records found for March 2026"

---

## TASK 5: Query Fees

### Input
`ctx.state.parsed`
```ts
{ intent: 'fees', studentPhone?: string }
```

`ctx.state.config`
```ts
{ feesSheetId, teacherPhone }
```

`ctx.state`:
```ts
{ month: string }   // current YYYY-MM
```

### Output
`ctx.outputs['read-fees']` — rows from FEES sheet
`ctx.outputs['send-fees']` — null

### Logic

Step 1 — read-fees:
- Read full FEES sheet

Step 2 — send-fees:
- Filter to current month
- If studentPhone provided: show one student's history (all months)
- Else: show all students for current month

All students (current month):
```
Fees — March 2026
✅ Rahul    : ₹2500 PAID
⚠️  Priya    : ₹1500 PARTIAL (₹500 remaining)
🔴 Arjun    : ₹2000 UNPAID
```

Single student (full history):
```
Fees — Rahul (+91...)
Jan 2026 : ₹2500 PAID
Feb 2026 : ₹2500 PAID
Mar 2026 : ₹2500 UNPAID
```

### Integration
- storage module (read)
- communication module (meta)

### Constraints
- All filtering in input() of send-fees step
- "No fee records found" if sheet empty or no records for month
- Balance = amountDue - amountPaid (computed in input(), never in state)

---

## TASK 6: Initialize Monthly Fees (Scheduled — 1st of month)

### Input
`ctx.state`
```ts
{
  config: TuitionConfig,
  month: string,     // YYYY-MM — computed in buildInitialContext from trigger date
  dueDate: string,   // YYYY-MM-07 (7th of month)
  runDate: string,
}
```

### Output
`ctx.outputs['read-students']` — rows from STUDENTS sheet
*(fee writes handled by handler iterating post-flow)*

### Logic

Step 1 — read-students:
- Read full STUDENTS sheet

Post-flow (in handler, not in flow steps):
- Filter rows where Status = ACTIVE
- For each active student: call storage write with fee row
- feeId = `FEE-${month}-${studentId}` (deterministic, idempotent-safe key)
- Amount Due = student's Monthly Fee
- Status = UNPAID
- Due Date = `${month}-07`

### Integration
- storage module (read)
- handler iterates write per student (outside engine — engine has no loop primitive)

### Constraints
- feeId is deterministic per student per month — safe to re-run (duplicate write is a known limitation; future: check for existing records before writing)
- Only ACTIVE students receive fee rows (Status filter)
- Month computed from trigger date in buildInitialContext, not hardcoded

---

## TASK 7: Send Fee Reminders (Scheduled — daily)

### Input
`ctx.state`
```ts
{
  config: TuitionConfig,
  runDate: string,   // YYYY-MM-DD
  month: string,     // YYYY-MM
}
```

### Output
`ctx.outputs['read-fees']` — FEES sheet rows
`ctx.outputs['send-overdue-reminders']` — null
`ctx.outputs['send-due-soon-reminders']` — null
`ctx.outputs['log-overdue']` — storage write result
`ctx.outputs['log-due-soon']` — storage write result
`ctx.outputs['send-all-clear']` — null (teacher-facing, when no issues)

### Logic

Step 1 — read-fees:
- Read full FEES sheet

Step 2 — send-overdue-reminders (condition: overdue fees exist):
- Overdue = UNPAID or PARTIAL AND today > dueDate (7th)
- One message per student:
```
⚠️ Fee Reminder — <CenterName>
Hi Rahul, your fee of ₹2500 for March 2026 is overdue.
Please pay at the earliest. Contact teacher for details.
```

Step 3 — send-due-soon-reminders (condition: due-soon fees exist):
- Due-soon = UNPAID or PARTIAL AND today = dueDate - 2 days
```
📅 Fee Due Soon — <CenterName>
Hi Priya, your fee of ₹2000 for March 2026 is due on 7 March.
```

Step 4 — log-overdue (condition: overdue fees exist):
- Write summary row to REMINDERS_LOG

Step 5 — log-due-soon (condition: due-soon fees exist):
- Write summary row to REMINDERS_LOG

Step 6 — send-all-clear (condition: no overdue AND no due-soon):
- Send to teacher:
```
✅ All fees on track for March 2026 — no overdue or due-soon payments today.
```

### Integration
- storage module (read, write)
- communication module (meta)

### Constraints
- Fee classification (overdue vs due-soon vs ok) computed in condition() and input() — pure
- Engine constraint: one communication step per student not possible without dynamic steps
- v1: send one message per student from within input() using the first matching student
  *Alternative*: handler calls a per-student helper outside flow (same pattern as init-fees)
- Log written at summary granularity (overdue count, due-soon count)

---

## TASK 8: Orchestrator — Handler + Server

### Handler responsibilities
- `handleTeacherMessage(msg)` — inbound WhatsApp dispatch
- `handleFeeInit()` — 1st-of-month cron (reads students, writes fee rows per student)
- `handleFeeReminders()` — daily cron (runs fee-reminders flow)
- `loadConfig()` — reads all env vars, throws on missing

### Server responsibilities
- `POST /webhook` — Meta webhook, calls ingestion-module, dispatches to handler
- `GET /webhook` — Meta webhook verification
- `POST /run/fee-init` — manual trigger for fee initialization
- `POST /run/reminders` — manual trigger for fee reminders
- `GET /health` — health check
- Cron 1: 1st of month at 08:00 → `handleFeeInit()`
- Cron 2: Daily at 09:00 → `handleFeeReminders()`

### Cron implementation
- Lightweight setTimeout-based scheduler (same pattern as event-planner)
- `scheduleMonthlyFeeInit()` — computes ms until next 1st-of-month 08:00
- `scheduleDailyReminders()` — computes ms until next 09:00

### Constraints
- Fee row writes in handleFeeInit loop must be sequential (await each write)
- Per-student reminder sends in handleFeeReminders loop must be sequential
- All errors caught per iteration — one failure must not abort remaining students
- Config loaded fresh on each invocation (no module-level global state)

---

## GLOBAL CONSTRAINTS

- flows must not throw
- no external API calls in flow files
- no module imports in flow files (for execution)
- use ctx.state.config for all runtime config
- use ctx.outputs for step output access
- condition() and input() must be pure and non-throwing
- IDs generated in buildInitialContext, never in steps
- all phone numbers validated to E.164 before flow runs
- rowIndex for update = dataIndex + 1 (header row offset)

---

## SUCCESS CRITERIA

- Teacher marks attendance in one WhatsApp message
- Student receives attendance confirmation
- Fee payment recorded and confirmed with receipt within seconds
- Teacher can see all unpaid students for the month in one command
- Fee reminders sent automatically to overdue students without teacher action
- All data persisted in structured Google Sheets
- Monthly fee records auto-created on 1st of each month
