# Event Planner — Technical Specification

## 1. Architecture Overview

System follows the existing flow-based execution model:

```
App Handler → Intent Router → Flow Dispatch → Modules → Output
App Server  → Cron Trigger  → Reminder Flow → Modules → Output
```

Aligned with system context:
- flows contain business logic
- modules handle I/O
- orchestrator manages execution
- ingestion-module runs before engine (pre-flow)

---

## 2. Folder Structure

```
apps/event-planner/
└── src/
    ├── server.ts      — Express + webhook + cron trigger
    └── handler.ts     — config, modules, intent dispatch

flows/event-planner/
├── intent-router/
│   └── flow.ts        — parse intent, optional AI classify
├── task-assign/
│   └── flow.ts        — write task + notify planner + vendor
├── task-status/
│   └── flow.ts        — read tasks, format summary, send
├── task-complete/
│   └── flow.ts        — update task status to DONE
├── task-cancel/
│   └── flow.ts        — update task status to CANCELLED
└── reminder/
    └── flow.ts        — check deadlines, send reminders
```

---

## 3. Execution Pipeline

### Inbound (webhook-triggered)

```
server.ts
  → ingestion-module.receive()
  → handler.handleEventPlannerMessage()
      → intent-router flow         (parse intent)
      → resolveRouting()           (pick sub-flow)
      → task-assign flow           if intent = assign
      → task-status flow           if intent = status
      → task-complete flow         if intent = done
      → task-cancel flow           if intent = cancel
```

### Scheduled (cron-triggered, daily)

```
server.ts cron (09:00 daily)
  → handler.handleReminders()
      → reminder flow              (check deadlines → send alerts)
```

Flows do not call other flows.

---

## 4. Context Model

### Inbound flows

```ts
ctx.state = {
  config: {
    sheetId: string,          // TASKS sheet ID
    plannerPhone: string,     // E.164
    eventName: string,
    eventDate: string,        // YYYY-MM-DD
    mode: 'structured' | 'ai'
    aiProvider: 'openai' | 'anthropic' | 'local' | 'nvidia'
  },
  parsed: {
    intent: 'assign' | 'status' | 'done' | 'cancel',
    vendorPhone?: string,     // E.164, for assign/status
    taskDescription?: string, // for assign
    category?: string,        // for assign (optional)
    deadline?: string,        // YYYY-MM-DD, for assign
    taskId?: string,          // for done/cancel
  }
}
```

### Reminder flow

```ts
ctx.state = {
  config: {
    sheetId: string,
    reminderSheetId: string,
    plannerPhone: string,
    eventDate: string,
    thresholds: {
      upcomingHours: 48,     // remind vendor N hours before deadline
      overdueAlert: true     // alert planner on overdue tasks
    }
  }
}
```

---

## 5. Flow Design

### Flow 1: intent-router

Responsibilities:
- try structured parse of inbound message
- if structured parse fails and mode = 'ai': run intelligence classify
- expose resolveRouting() for handler to dispatch sub-flow

Structured parse patterns:
```
assign <phone> <description> by <date>   → intent: assign
status                                   → intent: status
status <phone>                           → intent: status (vendor-filtered)
done <taskId>                            → intent: done
cancel <taskId>                          → intent: cancel
```

Steps:
- `classify-intent` — intelligence, condition: structured parse failed AND mode = 'ai'

---

### Flow 2: task-assign

Responsibilities:
- generate unique task ID
- write task row to TASKS sheet
- send assignment confirmation to planner
- send task notification to vendor

Steps:
- `write-task` — storage write
- `notify-planner` — communication send (condition: write succeeded)
- `notify-vendor` — communication send (condition: write succeeded)

---

### Flow 3: task-status

Responsibilities:
- read all tasks from TASKS sheet
- filter by status = PENDING (and optionally by vendor phone)
- format and send summary to planner

Steps:
- `read-tasks` — storage read
- `send-status` — communication send

---

### Flow 4: task-complete

Responsibilities:
- query task by task ID
- update status to DONE + set completed_at timestamp
- confirm to vendor + notify planner

Steps:
- `find-task` — storage query
- `update-task` — storage update (condition: task found AND status = PENDING)
- `confirm-vendor` — communication send
- `notify-planner-done` — communication send

---

### Flow 5: task-cancel

Responsibilities:
- query task by task ID
- update status to CANCELLED
- confirm to planner + notify vendor

Steps:
- `find-task` — storage query
- `cancel-task` — storage update (condition: task found AND status != DONE)
- `confirm-planner` — communication send
- `notify-vendor-cancel` — communication send

---

### Flow 6: reminder

Responsibilities:
- read all PENDING tasks from TASKS sheet
- evaluate reminder rules (upcoming, overdue)
- send reminders to vendors for upcoming deadlines
- send overdue alert to planner
- log each reminder sent to REMINDERS_LOG

Steps:
- `read-pending-tasks` — storage read
- `send-upcoming-reminder` — communication send (condition: upcoming tasks exist)
- `send-overdue-alert` — communication send (condition: overdue tasks exist)
- `log-reminders` — storage write

---

## 6. Storage Module Usage

### TASKS sheet — read
```ts
{
  provider: 'sheets',
  operation: 'read',
  resource: ctx.state.config.sheetId,
  options: { range: 'TASKS' }
}
```

### TASKS sheet — write (new task)
```ts
{
  provider: 'sheets',
  operation: 'write',
  resource: ctx.state.config.sheetId,
  data: [taskId, eventName, vendorPhone, description, category, deadline, 'PENDING', assignedAt, ''],
  options: { range: 'TASKS' }
}
```

### TASKS sheet — update (status change)
```ts
{
  provider: 'sheets',
  operation: 'update',
  resource: ctx.state.config.sheetId,
  data: [...updatedRow],
  options: { range: 'TASKS', rowIndex: taskRowIndex }
}
```

### TASKS sheet — query (by task ID)
```ts
{
  provider: 'sheets',
  operation: 'query',
  resource: ctx.state.config.sheetId,
  query: { 'Task ID': taskId },
  options: { range: 'TASKS' }
}
```

---

## 7. Communication Module Usage

All messages sent via Meta (WhatsApp).

```ts
{
  to: vendorPhone,     // or plannerPhone
  message: '...',
  provider: 'meta'
}
```

---

## 8. Intelligence Module Usage (AI mode only)

### Intent classification (intent-router)
```ts
{
  provider: ctx.state.config.aiProvider,
  task: 'classification',
  input: { text: ctx.event.message },
  options: { categories: ['assign', 'status', 'done', 'cancel', 'unknown'] }
}
```

---

## 9. Task ID Generation

Task IDs are deterministic, generated in `buildInitialContext()`:

```ts
`EVT-${Date.now()}-${Math.floor(Math.random() * 1000)}`
```

Never generated inside a flow step (must be pure).

---

## 10. Error Handling

Must handle:
- Malformed assign command (missing phone / deadline)
- Unknown task ID in done/cancel
- Already-completed task in done/cancel
- Empty task sheet (no pending tasks for reminders)
- Vendor phone not in E.164 format

---

## 11. Environment Variables

```
EVENT_SHEET_ID              — TASKS sheet ID
EVENT_REMINDERS_SHEET_ID    — REMINDERS_LOG sheet ID
EVENT_PLANNER_PHONE         — planner's WhatsApp number (E.164)
EVENT_NAME                  — event display name
EVENT_DATE                  — event date (YYYY-MM-DD)
EVENT_MODE                  — 'structured' | 'ai' (default: structured)
EVENT_AI_PROVIDER           — openai | anthropic | local | nvidia
WEBHOOK_VERIFY_TOKEN        — Meta webhook token
COMM_PROVIDER               — communication provider (default: meta)
PORT                        — server port (default: 3004)
```

---

## 12. Constraints (System-Level)

- no API calls in flow steps
- no direct DB access
- only storage / communication / intelligence modules in steps
- input() and condition() must not throw
- no hard-coded phone numbers or sheet IDs in flow files
- all config injected via ctx.state.config
- task ID generated in buildInitialContext, never in a step
- all prior step outputs read via ctx.outputs?.['step-id']

---

## 13. Extensibility

Future:
- AI free-text assignment ("tell the florist to deliver roses by friday")
- Budget tracking per vendor per task
- Multi-event support (one server, multiple sheet configs)
- WhatsApp group support (assign from group messages)
- Vendor performance scoring
