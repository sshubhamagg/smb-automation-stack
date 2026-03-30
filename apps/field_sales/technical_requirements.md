# Field Sales Automation — Technical Specification

## 1. Architecture Overview

System follows:

Trigger → Handler → Flow → Modules → Outputs

Modules:

* storage
* communication
* intelligence (not used in v1 core)

---

## 2. Data Schema

### 2.1 Rep Table

```json
{
  "rep_id": "string",
  "name": "string",
  "manager_id": "string",
  "region": "string",
  "active": true
}
```

---

### 2.2 Daily Report (Raw)

```json
{
  "raw_text": "string",
  "source": "whatsapp",
  "timestamp": "number",
  "rep_id": "string"
}
```

---

### 2.3 Daily Report (Normalized)

```json
{
  "report_id": "string",
  "rep_id": "string",
  "date": "string",
  "region": "string",
  "beat": "string",
  "total_calls": "number",
  "orders": "number",
  "sales_value": "number",
  "stock_issue": "boolean",
  "remarks": "string",
  "status": "valid | invalid | duplicate"
}
```

---

### 2.4 Manager Summary

```json
{
  "manager_id": "string",
  "date": "string",
  "total_reps": "number",
  "reports_received": "number",
  "missing_reps": ["string"],
  "total_sales": "number",
  "total_orders": "number",
  "total_calls": "number"
}
```

---

## 3. Flows

### 3.1 Flow: daily-field-report-entry

Steps:

1. validate-input
2. check-duplicate (storage query)
3. write-raw-report
4. write-normalized-report
5. send-confirmation
6. send-error (conditional)

---

### 3.2 Flow: missing-report-escalation

Steps:

1. read-rep-roster
2. read-submitted-reports
3. compute-missing
4. notify-reps
5. notify-manager

---

### 3.3 Flow: daily-performance-summary

Steps:

1. read-reports
2. aggregate-metrics
3. compute-exceptions
4. send-summary

---

## 4. Module Usage

### Storage

Operations:

* write → reports
* read → reports, reps
* query → duplicate detection

Providers:

* sheets (v1)
* postgres (optional)

---

### Communication

Used for:

* confirmations
* reminders
* summaries

Providers:

* meta (WhatsApp)

---

## 5. Context Structure

```ts
ctx = {
  event: { message, user },
  state: {
    config,
    parsed_input,
    rep
  },
  outputs: {}
}
```

---

## 6. Validation Rules

* sales_value >= 0
* total_calls >= 0
* orders >= 0
* required fields present
* rep must exist
* date must be valid

---

## 7. Idempotency Strategy

* unique key: (rep_id + date)
* duplicate check before write
* no overwrite without explicit correction flow

---

## 8. Error Handling

* validation errors → user response
* module failure → stop flow
* no throwing inside input/condition

---

## 9. Scheduling

* missing-report flow: triggered at cutoff time
* summary flow: end-of-day trigger

---

## 10. Future Extensions

* AI-based anomaly detection
* natural language parsing
* predictive insights

