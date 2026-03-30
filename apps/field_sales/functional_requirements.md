# Field Sales Automation System — Functional Requirements

## 1. Objective

Build a system to:

* Collect daily sales reports from field reps via WhatsApp
* Validate and store structured data
* Generate daily summaries for managers
* Identify missing submissions and exceptions

---

## 2. Users

### Field Sales Representative

* Submits daily report
* Receives confirmation or error

### Manager

* Receives daily summary
* Gets alerts for missing reports and exceptions

### Admin (optional)

* Manages rep roster and configurations

---

## 3. Core Features

### 3.1 Daily Report Submission

* Channel: WhatsApp
* Format: Structured text input
* Required fields:

  * rep_id / name
  * date
  * region
  * beat
  * total_calls
  * orders
  * sales_value
  * stock_issue (yes/no)
  * remarks

---

### 3.2 Validation

System must:

* Validate required fields
* Validate numeric constraints (>= 0)
* Validate rep-region mapping
* Reject invalid submissions with error message

---

### 3.3 Duplicate Detection

* Only one report per rep per day allowed
* Duplicate submissions:

  * rejected OR
  * flagged as correction (configurable)

---

### 3.4 Data Storage

* Store:

  * raw submission
  * normalized structured record
* Maintain audit trail

---

### 3.5 Confirmation

* On success: send confirmation message
* On failure: send validation error message

---

### 3.6 Missing Report Tracking

* Identify reps who have not submitted by cutoff time
* Send:

  * reminder to rep
  * escalation to manager

---

### 3.7 Daily Summary

Generate per manager:

* total reps assigned
* reports received
* missing reps
* total sales
* total orders
* total calls
* top performers
* exceptions

---

### 3.8 Exception Detection

Flag:

* missing reports
* zero sales
* unusually low performance
* stock issues

---

### 3.9 Dashboard Data

* Provide aggregated data:

  * by region
  * by manager
  * by rep
  * by date

---

## 4. Non-Functional Requirements

* Deterministic outputs
* Idempotent processing
* Schema validation enforced
* Handles invalid data safely
* Scalable to 100k+ records/day (future)

---

## 5. Out of Scope (v1)

* AI insights
* Voice input
* Predictive analytics
* Route optimization
* Mobile app UI

