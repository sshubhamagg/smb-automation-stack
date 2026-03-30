# Event Planner — Execution Tickets

---

## TASK 1: Parse Intent (Intent Router)

### Input
- `ctx.event.message` — raw WhatsApp text from planner or vendor
- `ctx.state.config.mode` — 'structured' | 'ai'

### Output
`ctx.state.parsed`

```ts
{
  intent: 'assign' | 'status' | 'done' | 'cancel',
  vendorPhone?: string,
  taskDescription?: string,
  category?: string,
  deadline?: string,        // YYYY-MM-DD
  taskId?: string,
}
```

### Logic
Structured parse first (always):
- `assign +91... <task> by <date>` → intent: assign
- `status` or `status +91...`     → intent: status
- `done EVT-...`                  → intent: done
- `cancel EVT-...`                → intent: cancel

If structured parse fails AND mode = 'ai':
- Run intelligence classify step with categories: assign, status, done, cancel, unknown

### Integration
- intelligence module (classify) — conditional step

### Constraints
- buildInitialContext handles structured parse (pure, non-throwing)
- AI step only runs when structured parse produced no result
- Unknown intent → send help message, do not fail flow

---

## TASK 2: Assign Task to Vendor

### Input
`ctx.state.parsed`
```ts
{
  intent: 'assign',
  vendorPhone: string,
  taskDescription: string,
  deadline: string,
  category?: string,
}
```

`ctx.state.config`
```ts
{
  sheetId: string,
  plannerPhone: string,
  eventName: string,
}
```

`ctx.state.taskId` — generated in buildInitialContext

### Output
`ctx.outputs['write-task']` — storage write result (updatedRange)

### Logic
- Build task row: [taskId, eventName, vendorPhone, description, category, deadline, 'PENDING', assignedAt, '']
- Write to TASKS sheet

### Integration
- storage module (write)

### Constraints
- taskId generated deterministically in buildInitialContext, never inside a step
- deadline must be YYYY-MM-DD format — validated before flow runs
- vendor phone must be E.164 — validated before flow runs
- assignedAt = ISO timestamp computed in buildInitialContext

---

## TASK 3: Confirm Assignment (Planner + Vendor)

### Input
`ctx.outputs['write-task']` — must be present (write succeeded)
`ctx.state.parsed` — vendorPhone, taskDescription, deadline
`ctx.state.config` — plannerPhone, eventName

### Output
`ctx.outputs['notify-planner']` — null (communication result)
`ctx.outputs['notify-vendor']`  — null (communication result)

### Logic
Planner message:
```
Task assigned ✅
ID: EVT-xxxx
Vendor: +91...
Task: deliver flowers
Deadline: 2026-04-15
```

Vendor message:
```
Hi! You have a new task for <EventName>:
Task: deliver flowers
Deadline: 2026-04-15
Reply "done EVT-xxxx" when complete.
```

### Integration
- communication module (meta)

### Constraints
- both steps conditional on write-task output being present
- do not send if write step failed or was skipped

---

## TASK 4: Query Task Status

### Input
`ctx.state.config.sheetId`
`ctx.state.parsed.vendorPhone` — optional filter

### Output
`ctx.outputs['read-tasks']` — rows from TASKS sheet
`ctx.outputs['send-status']` — null (communication result)

### Logic
- Read full TASKS sheet
- Filter rows where Status = PENDING (and optionally vendor = vendorPhone)
- If no pending tasks: "No pending tasks 🎉"
- Else: format list:
```
Pending Tasks (3):
1. EVT-001 | Florist | deliver flowers | due: 2026-04-15
2. EVT-002 | Caterer | confirm menu | due: 2026-04-13
3. EVT-003 | DJ | send equipment list | due: 2026-04-12
```

### Integration
- storage module (read)
- communication module (meta)

### Constraints
- all row filtering happens in input() of send-status step (pure, non-throwing)
- handle empty sheet (no rows returned)
- handle vendor filter producing 0 matches

---

## TASK 5: Mark Task Complete

### Input
`ctx.state.parsed.taskId`
`ctx.state.config.sheetId`
`ctx.event.userId` — vendor phone (sender)

### Output
`ctx.outputs['find-task']` — query result rows
`ctx.outputs['update-task']` — updatedRange
`ctx.outputs['confirm-vendor']` — null
`ctx.outputs['notify-planner-done']` — null

### Logic
- Query TASKS sheet by Task ID
- If not found → send "Task ID not found" to vendor
- If found but status != PENDING → send "Task already marked as done or cancelled"
- If found and PENDING → update Status = DONE, CompletedAt = now

Vendor confirmation:
```
✅ Task marked as done!
Task: deliver flowers
Event: <EventName>
```

Planner notification:
```
Task completed ✅
ID: EVT-xxxx
Vendor: +91...
Task: deliver flowers
Completed: 2026-04-14 10:32
```

### Integration
- storage module (query, update)
- communication module (meta)

### Constraints
- update step conditional: task found AND status = PENDING
- confirm/notify steps conditional on update success
- send "not found" message if query returns empty rows

---

## TASK 6: Cancel Task

### Input
`ctx.state.parsed.taskId`
`ctx.state.config.sheetId`

### Output
`ctx.outputs['find-task']` — query result rows
`ctx.outputs['cancel-task']` — updatedRange
`ctx.outputs['confirm-planner']` — null
`ctx.outputs['notify-vendor-cancel']` — null

### Logic
- Query TASKS sheet by Task ID
- If not found → send "Task ID not found" to planner
- If found but status = DONE → send "Cannot cancel a completed task"
- If valid → update Status = CANCELLED

Planner confirmation:
```
Task cancelled ❌
ID: EVT-xxxx
Task: deliver flowers
Vendor notified.
```

Vendor notification:
```
Task cancelled: deliver flowers for <EventName>.
No action needed.
```

### Integration
- storage module (query, update)
- communication module (meta)

### Constraints
- cancel step conditional: task found AND status != DONE AND status != CANCELLED
- planner must be sender for cancel (validated in buildInitialContext)

---

## TASK 7: Send Deadline Reminders (Scheduled)

### Input
`ctx.state.config`
```ts
{
  sheetId: string,
  reminderSheetId: string,
  plannerPhone: string,
  thresholds: { upcomingHours: 48 }
}
```

### Output
`ctx.outputs['read-pending-tasks']` — all pending rows
`ctx.outputs['send-upcoming-reminder']` — null
`ctx.outputs['send-overdue-alert']` — null
`ctx.outputs['log-reminders']` — updatedRange

### Logic
Read all PENDING tasks.

Identify:
- Upcoming: deadline within next 48 hours
- Overdue: deadline already passed

For each upcoming task → send vendor reminder:
```
⏰ Reminder: Task due in <N> hours
Event: <EventName>
Task: deliver flowers
Deadline: 2026-04-15
Reply "done EVT-xxxx" when complete.
```

For overdue tasks → alert planner (one message with full list):
```
🚨 Overdue Tasks (2):
- EVT-001 | Florist | deliver flowers | was due 2026-04-13
- EVT-004 | Venue | submit invoice | was due 2026-04-12
```

Log each reminder to REMINDERS_LOG sheet.

### Integration
- storage module (read, write)
- communication module (meta)

### Constraints
- all row classification (upcoming vs overdue) in input() of send steps — pure
- send-upcoming-reminder conditional: upcoming tasks exist
- send-overdue-alert conditional: overdue tasks exist
- log-reminders conditional: at least one reminder was sent
- idempotency: check REMINDERS_LOG before sending to avoid duplicate reminders on same day

---

## TASK 8: Orchestrator Flow Execution

### Input
- inbound: normalized WhatsApp event from ingestion-module
- scheduled: cron trigger from server.ts

### Output
- final ExecutionResult from last flow

### Logic
Inbound path:
1. ingestion-module.receive() → NormalizedEvent
2. buildInitialContext() for intent-router
3. runFlow(intentRouterFlow)
4. resolveRouting() → nextFlow + parsed payload
5. buildInitialContext() for selected sub-flow
6. runFlow(selectedFlow)
7. log result

Scheduled path:
1. cron fires (09:00 daily)
2. buildInitialContext() for reminder flow
3. runFlow(reminderFlow)
4. log result

### Constraints
- flows must not throw
- use ctx.state for data sharing between buildInitialContext and flow steps
- use ctx.outputs for step-to-step chaining within a flow
- deterministic logic only in condition() and input()
- no external API calls in flow files

---

## GLOBAL CONSTRAINTS

- flows must not throw
- no external API calls in flow files
- no module imports in flow files (for execution)
- use ctx.state.config for all runtime config
- use ctx.outputs for step output access
- condition() and input() must be pure and non-throwing
- task IDs generated in buildInitialContext, never in steps
- all phone numbers validated to E.164 before flow runs

---

## SUCCESS CRITERIA

- planner assigns a task in one WhatsApp message
- vendor receives notification within seconds
- daily reminders sent automatically at 09:00
- planner receives overdue alert without manual action
- task sheet always reflects accurate status
- zero duplicate reminders per task per day
