# Technical Specification

## 1. Architecture

- Flows = business logic
- Modules = execution
- Sheets = storage
- App Handler = orchestration

---

## 2. Execution Model

- Sequential flow execution
- No cross-flow calls
- Step types:
  - storage
  - communication
  - intelligence (not used in v1)

---

## 3. Context Usage

- ctx.state → config + derived values
- ctx.outputs → step outputs

---

## 4. Flows

---

## Flow 1: validate-entries

### Purpose
Validate raw entries and separate valid vs invalid rows

---

### Steps

#### 1. read-raw-entries
- storage.read (sheets)

#### 2. filter-pending
- input(): select rows where status == pending

#### 3. validate-rows
- input(): apply validation rules

Validation Rules:
- required fields present
- amount > 0
- debit_account ≠ credit_account
- accounts exist
- valid date

---

#### 4. write-valid-entries
- storage.write → validated_entries

---

#### 5. mark-processed
- storage.update → raw_entries

---

#### 6. mark-failed
- storage.update → raw_entries with error_reason

---

## Flow 2: compute-ledger-balances

### Purpose
Compute account balances incrementally

---

### Steps

1. read-validated-entries
2. read-last-snapshot
3. compute-delta
4. write-new-snapshot

---

## Flow 3: trial-balance-check

### Purpose
Ensure total debit == total credit

---

### Steps

1. read-validated-entries
2. compute totals
3. if mismatch → write reconciliation_log

---

## Flow 4: generate-financials

### Purpose
Generate P&L

---

### Steps

1. read-snapshots
2. classify accounts
3. compute revenue/expenses
4. write financials

---

## 5. Key Constraints

- No direct API calls in flows
- No logic inside modules
- input() and condition() must not throw
- No formulas in sheets
- All computation inside flows

---

## 6. Scaling Strategy

- Use snapshots
- Avoid full recomputation
- Process only new rows
