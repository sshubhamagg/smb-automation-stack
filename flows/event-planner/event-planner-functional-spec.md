# Event Planner — Functional Specification

## 1. Product Overview

### Purpose
Event Planner is a WhatsApp-native task and vendor coordination system that transforms informal group chat coordination into a structured, trackable workflow.

It eliminates lost messages and missed deadlines by giving event planners a WhatsApp interface to:
- assign tasks to vendors
- track task status
- receive automated deadline reminders
- query pending work at any time

---

## 2. Target Users

- Wedding Planners (primary)
- Corporate Event Coordinators
- Event Operations Teams
- Vendors (as task recipients only — no app required)

---

## 3. Problem Statement

### Current State
- Vendor coordination happens in WhatsApp groups
- Task assignments buried in long message threads
- No single source of truth for what is pending
- Deadlines missed because reminders are manual
- Planner must chase vendors individually for status

### Solution
- Planner sends structured WhatsApp commands to assign, track, and remind
- All tasks stored in Google Sheets (single source of truth)
- Automated reminders sent to vendors before deadlines
- Planner can query full task list or per-vendor status anytime

---

## 4. Input Data Model

### Inbound Commands (via WhatsApp from Planner)

#### Assign a task
```
assign <vendor_phone> <task_description> by <deadline>
```
Example:
```
assign +919876543210 deliver flowers by 2026-04-15
```

#### Check status
```
status
status <vendor_phone>
```

#### Mark task done (sent by vendor)
```
done <task_id>
```

#### Cancel a task
```
cancel <task_id>
```

---

## 5. Output Data Model

### Google Sheets — Task Tracker

#### TASKS Sheet
| Task ID | Event | Vendor Phone | Task Description | Category | Deadline | Status | Assigned At | Completed At |

#### REMINDERS_LOG Sheet
| Date | Task ID | Vendor Phone | Message Sent | Reminder Type |

---

## 6. Core Features

### Task Assignment
- Planner assigns task to vendor via WhatsApp
- System stores task in Google Sheets
- Confirmation sent to planner
- Assignment notification sent to vendor

### Status Queries
- Planner queries all pending tasks
- Planner queries tasks for a specific vendor
- System reads sheet and returns formatted summary

### Deadline Reminders (Scheduled)
- Daily cron checks tasks due within 48 hours
- Reminder sent to vendor with task details
- Reminder sent to planner for overdue tasks
- Reminder logged to REMINDERS_LOG

### Task Completion
- Vendor replies "done <task_id>" to confirm
- System marks task as DONE in sheet
- Confirmation sent to planner

### Task Cancellation
- Planner sends "cancel <task_id>"
- System marks task as CANCELLED
- Confirmation sent to planner + vendor

---

## 7. Rule Engine (Decision Layer)

Rules convert task state → reminders and alerts.

| Rule | Condition | Action |
|------|-----------|--------|
| UPCOMING_DEADLINE | deadline within 48h AND status = PENDING | Send reminder to vendor |
| OVERDUE | deadline passed AND status = PENDING | Alert planner + remind vendor |
| TASK_AT_RISK | deadline within 24h AND no vendor acknowledgement | Escalate to planner |

---

## 8. Task Status Model

```
PENDING   → task assigned, awaiting vendor action
DONE      → vendor confirmed completion
CANCELLED → planner cancelled the task
OVERDUE   → deadline passed, still PENDING
```

---

## 9. Execution Modes

### Inbound Mode (webhook-triggered)
- Planner or vendor sends WhatsApp message
- System normalizes via ingestion-module
- Intent parsed (structured first, AI fallback)
- Appropriate flow dispatched

### Scheduled Mode (cron-triggered)
- Daily at configurable time (default 09:00)
- Reads all PENDING tasks from sheet
- Evaluates reminder rules
- Sends reminders to relevant vendors

---

## 10. Multi-Event Support

- Each event has independent config (sheet ID, event date, planner phone)
- Same system reused across multiple events
- Event identified by planner's phone number

---

## 11. MVP Scope

### Included
- Task assignment (structured parsing)
- Task storage (Google Sheets)
- Assignment confirmations (planner + vendor)
- Status queries (all pending / by vendor)
- Deadline reminders (daily cron)
- Task completion marking

### Excluded (v1)
- AI intent classification (structured parsing only)
- Dashboard / web UI
- Multi-planner per event
- File/image attachments
- Calendar integrations
- Budget tracking

### AI Layer (Post-MVP)
- Free-text task assignment ("tell the florist to deliver roses by friday")
- Smart budget optimization suggestions
- Vendor performance summaries

---

## 12. Product Differentiation

- WhatsApp-native — no new app for planners or vendors
- Decision-first — reminders + alerts, not just a log
- Event-specific — configured per event, not generic
- Fully automated — no manual chasing

---

## 13. Success Criteria

- Planner can assign a task in one WhatsApp message
- All tasks visible in a single Google Sheet
- Vendors receive reminders automatically before deadlines
- Planner receives overdue alerts without manual follow-up
- Zero missed tasks due to lost WhatsApp messages
