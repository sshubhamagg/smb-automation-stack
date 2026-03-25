# Tuition Center — Functional Specification

## 1. Product Overview

### Purpose
Tuition Center is a WhatsApp-native attendance and fee management system for coaching centers, tutors, and small academic institutions.

It eliminates manual registers and missed payment follow-ups by giving the teacher/admin a WhatsApp interface to:
- mark student attendance per session
- track monthly fee payments (owed, paid, overdue)
- receive automated reminders for unpaid students
- query attendance or fee status at any time

---

## 2. Target Users

| Role | Interaction |
|------|-------------|
| Teacher / Admin | Sends all commands — marks attendance, records payments, queries status |
| Students | Passive recipients — attendance confirmations, fee reminders, payment receipts |
| Parents | Passive recipients — fee reminders on parent phone (if stored) |

---

## 3. Problem Statement

### Current State
- Attendance tracked in paper registers or Excel sheets
- Fee payments noted manually per student
- No automated follow-up for missed payments
- Teacher must manually check who has not paid each month
- Students do not get payment confirmations

### Solution
- Teacher marks attendance via WhatsApp commands
- Fees recorded per student per month in Google Sheets
- Automated monthly fee reminders sent to unpaid students
- Teacher can query attendance or fee status at any time

---

## 4. Input Data Model

### Inbound Commands (via WhatsApp from Teacher)

#### Mark attendance
```
present <student_phone>
absent <student_phone>
```

#### Record fee payment
```
paid <student_phone> <amount>
```

#### Query attendance
```
attendance
attendance <student_phone>
```

#### Query fee status
```
fees
fees <student_phone>
```

---

## 5. Output Data Model

All data stored in **one Google Spreadsheet** (identified by `sheetId`) with four named ranges, plus a separate **reminders log sheet** (identified by `remindersSheetId`). This matches the pattern used by all other services in this stack.

### Main Sheet (`sheetId`)

#### Named Range: STUDENTS
| Student ID | Name | Phone | Parent Phone | Batch | Monthly Fee | Enrolled At | Status |

#### Named Range: ATTENDANCE
| Date | Student ID | Student Phone | Name | Batch | Status | Marked By | Marked At |

#### Named Range: FEES
| Fee ID | Student ID | Student Phone | Name | Month | Amount Due | Amount Paid | Status | Due Date | Paid At |

### Reminders Sheet (`remindersSheetId`)

#### Named Range: REMINDERS_LOG
| Date | Student Phone | Message Sent | Reminder Type |

---

## 6. Core Features

### Attendance Marking
- Teacher sends `present` or `absent` with student phone
- System writes attendance row to ATTENDANCE range
- Confirmation sent to teacher
- Student receives confirmation when marked PRESENT

### Fee Recording
- Teacher sends `paid <phone> <amount>` after receiving payment
- System finds current month's fee record for that student
- Updates: Amount Paid, Status (PAID / PARTIAL), Paid At
- Confirmation sent to teacher; receipt sent to student

### Fee Status Query
- `fees` → all students for current month (who paid / who hasn't)
- `fees <phone>` → one student's full fee history across all months

### Attendance Query
- `attendance` → all students, present/absent count for current month
- `attendance <phone>` → one student's monthly summary

### Monthly Fee Initialization (Scheduled — 1st of month)
- Runs on 1st of each month at 08:00
- Reads all ACTIVE students from STUDENTS range
- Writes one UNPAID fee row per student to FEES range

### Fee Reminders (Scheduled — daily)
- Runs daily at 09:00
- Identifies UNPAID / PARTIAL fees past due date (7th of month)
- Identifies fees due within 2 days (courtesy reminder)
- Sends reminder to student phone (and parent phone if stored)
- Logs each reminder run to REMINDERS_LOG

---

## 7. Rule Engine (Decision Layer)

| Rule | Condition | Action |
|------|-----------|--------|
| FEE_OVERDUE | Status = UNPAID or PARTIAL AND today > due_date | Send reminder to student (+ parent) |
| FEE_DUE_SOON | Status = UNPAID or PARTIAL AND today = due_date − 2 | Send courtesy reminder |
| PARTIAL_PAYMENT | Amount Paid > 0 AND Amount Paid < Amount Due | Set Status = PARTIAL |
| FULL_PAYMENT | Amount Paid >= Amount Due | Set Status = PAID |

---

## 8. Status Models

### Fee Status
```
UNPAID   → fee record created, no payment received
PARTIAL  → some payment received, balance remaining
PAID     → full payment received
WAIVED   → fee manually waived by teacher (future)
```

### Attendance Status
```
PRESENT  → student attended session
ABSENT   → student did not attend
```

### Student Status
```
ACTIVE   → currently enrolled, fees tracked and reminders sent
INACTIVE → no longer enrolled, excluded from all automated actions
```

---

## 9. Execution Modes

### Inbound (webhook-triggered)
- Teacher sends WhatsApp message
- ingestion-module normalises the event
- Intent parsed via structured parser (AI fallback if mode = 'ai')
- Appropriate flow dispatched

### Scheduled (cron-triggered)
- 1st of month at 08:00 → initialize fee records for all ACTIVE students
- Daily at 09:00 → evaluate fee rules, send reminders

---

## 10. Multi-Batch Support

- Students assigned to a batch (e.g. "Morning", "Evening", "Weekend")
- Attendance stored with batch field for future reporting
- Fee tracking is per-student per month, independent of batch
- Same system config serves all batches of the same center

---

## 11. MVP Scope

### Included
- Attendance marking (present / absent by phone)
- Attendance confirmation to teacher + student
- Fee payment recording with partial payment support
- Fee status query (all students / one student)
- Monthly fee initialization (1st-of-month cron)
- Fee reminders for overdue and due-soon payments
- Payment receipt to student

### Excluded (v1)
- AI intent classification (structured parsing only in v1)
- Bulk attendance marking for an entire batch
- Dashboard / web UI
- Multi-teacher / multi-admin support
- Timetable or exam tracking

### AI Layer (Post-MVP)
- Free-text commands ("Rahul didn't come today")
- Student performance insights
- Attendance pattern alerts ("Priya has been absent 4 times this month")
- Fee collection forecasting

---

## 12. Success Criteria

- Teacher marks attendance in one WhatsApp message
- Fee payments recorded and confirmed within seconds
- Overdue students reminded automatically — no teacher action required
- Teacher sees who has not paid in one `fees` command
- All data persists in a structured Google Sheet
- Monthly fee records created automatically on the 1st
