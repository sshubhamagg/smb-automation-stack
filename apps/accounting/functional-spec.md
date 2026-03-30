# Google Sheets Accounting Automation Engine (v1)

## 1. Objective

Build a deterministic accounting system that:
- Automates manual Excel/Sheets workflows
- Ensures accounting correctness (double-entry)
- Uses Google Sheets as the only data source
- Replaces validation, reconciliation, and reporting done manually

---

## 2. Target Users

- Individuals managing personal finances
- Small businesses without ERP systems
- Users currently using Excel/Sheets manually

---

## 3. Core Concept

Users manually input data → system processes:

1. Validate
2. Correct
3. Post ledger
4. Reconcile
5. Compute balances
6. Generate financials

---

## 4. Sheet Structure

### raw_entries (UNTRUSTED INPUT)

Columns:
- date
- type
- amount
- debit_account
- credit_account
- entity
- notes
- status (pending / processed / failed)
- error_reason

---

### validated_entries (SYSTEM LEDGER)

Columns:
- date
- debit_account
- credit_account
- amount
- entity
- reference_id

---

### accounts

Columns:
- account_name
- type (asset/liability/income/expense)

---

### snapshots_daily

Columns:
- date
- account
- balance

---

### financials

Columns:
- date
- revenue
- expenses
- profit

---

### reconciliation_log

Columns:
- reference_id
- issue_type
- status
- notes

---

## 5. User Workflow

### Step 1: Enter Data
User inputs rows in `raw_entries` with status = pending

---

### Step 2: Validation
System validates entries and marks:
- processed
- OR failed with error_reason

---

### Step 3: Correction Loop
User fixes failed rows → system reprocesses

---

### Step 4: Ledger Posting
Validated entries stored in `validated_entries`

---

### Step 5: Reconciliation
System ensures:
- debit == credit

---

### Step 6: Financial Computation
System computes:
- account balances
- P&L

---

## 6. Guarantees

- Double-entry enforced
- No partial writes
- Deterministic execution
- Idempotent processing

---

## 7. Out of Scope (v1)

- Tax/GST
- Multi-company
- Multi-currency
- Invoice generation