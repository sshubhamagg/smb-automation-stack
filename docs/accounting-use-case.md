# Accounting Engine — Use Case Document

## Overview

The Accounting App is a deterministic, double-entry accounting automation engine that operates entirely on Google Sheets. Users enter raw journal entries into a spreadsheet; the engine validates, posts, reconciles, and generates financial statements — replacing manual Excel/Sheets workflows with a code-driven pipeline.

Unlike the mining and ledger apps, this system has **no WhatsApp interface, no AI, and no communication module**. It is a pure data processing engine triggered via HTTP, cron schedule, or CLI. All input and output lives in Google Sheets.

> **Implementation status**: This app is currently in **spec/design stage**. All flows and the handler are fully documented in markdown with complete step definitions, but the TypeScript implementation (`flow.ts`, `handler.ts`, `server.ts`) has not yet been written.

---

## Business Context

### Problem Statement

Individuals and small businesses managing finances in Google Sheets do so manually: validating entries, checking totals, computing balances, and building P&L statements by hand. This is error-prone, inconsistent, and does not enforce double-entry accounting principles.

### Solution

A code-driven engine that ingests raw journal entries from a user-maintained sheet, enforces double-entry rules, posts to a validated ledger, computes account balances, checks trial balance integrity, and generates a dated P&L — all automatically, idempotently, and without spreadsheet formulas.

### Target Users

| User | Profile |
|------|---------|
| Individuals | Managing personal finances currently tracked in Excel |
| Small businesses | Without ERP systems, using Sheets as their books |
| Accountants | Wanting automated validation and reporting on top of existing sheets |

### v1 Scope

- Single company, single currency
- Manual journal entry (no invoice capture or bank import)
- No tax/GST computation
- No multi-company or multi-branch support

---

## User Workflow

```
Step 1 → User enters rows in raw_entries with status = pending
Step 2 → User triggers the engine (HTTP POST / cron / CLI)
Step 3 → Engine validates entries → marks processed or failed
Step 4 → User fixes failed rows, resets status = pending, re-triggers
Step 5 → Engine posts to validated ledger, computes balances, generates P&L
```

The engine is idempotent — re-running it with no new pending rows is a safe no-op.

---

## Technical Architecture

### Stack

```
Trigger (HTTP POST / cron / CLI)
        │
        ▼
Handler (runAccounting)
        │
        ├── Flow 1: validate-entries
        ├── Flow 2: compute-ledger-balances
        ├── Flow 3: trial-balance-check
        └── Flow 4: generate-financials
                │
                ▼
        storage-module (Google Sheets)
```

### Module Usage

| Module | Used | Purpose |
|--------|------|---------|
| `storage-module` | Yes | All reads, writes, updates, deletes against Google Sheets |
| `engine-module` | Yes | `runFlow()` orchestrates each flow sequentially |
| `communication-module` | No | Not used in v1 |
| `intelligence-module` | No | Not used in v1 |
| `ingestion-module` | No | No inbound webhook |

### Trigger Modes

| Mode | Entry Point |
|------|-------------|
| HTTP POST | `POST /run/accounting` |
| Cron | Scheduled nightly (e.g. `0 23 * * *`) |
| CLI | Direct invocation for development/testing |

---

## Data Model — Six Sheet Tabs

All storage is in a single Google Sheets document with six named tabs. No formulas are used — all computation runs inside flows.

### 1. `raw_entries` — User Input

**Owner**: User (data entry) + Engine (status updates)

| Column | Type | Description |
|--------|------|-------------|
| `row_id` | string | Unique stable ID assigned by user — never changes |
| `date` | string | ISO date `YYYY-MM-DD` |
| `type` | string | `expense`, `income`, `transfer`, etc. (informational) |
| `amount` | number | Positive decimal |
| `debit_account` | string | Must exist in `accounts` tab |
| `credit_account` | string | Must exist in `accounts` tab |
| `entity` | string | Counterparty name |
| `notes` | string | Freeform description |
| `status` | string | `pending` → `in_progress` → `processed` / `failed` |
| `error_reason` | string | Pipe-separated error codes set by engine on failure |

**Key rule**: `row_id` must be unique, user-assigned, and never modified. It is the stable identity used for all row targeting and `reference_id` generation across runs.

### 2. `validated_entries` — Trusted Ledger

**Owner**: Engine only (append-only, never modified)

| Column | Type | Description |
|--------|------|-------------|
| `date` | string | ISO date from raw entry |
| `debit_account` | string | Normalized (trimmed, lowercase) |
| `credit_account` | string | Normalized (trimmed, lowercase) |
| `amount` | number | Positive decimal |
| `entity` | string | Trimmed counterparty |
| `reference_id` | string | Deterministic: `date-amount-debit-credit-row_id` |
| `run_id` | string | Execution ID: `run-{ISO timestamp}` |

### 3. `accounts` — Chart of Accounts

**Owner**: User (managed manually, engine reads only)

| Column | Type | Values |
|--------|------|--------|
| `account_name` | string | Unique account identifier |
| `type` | string | `asset` / `liability` / `income` / `expense` |

### 4. `snapshots_daily` — Balance History

**Owner**: Engine only (append-only)

| Column | Type | Description |
|--------|------|-------------|
| `date` | string | Snapshot date |
| `account` | string | Account name |
| `balance` | number | Net balance (positive or negative) |
| `snapshot_ref` | string | `snapshot-YYYY-MM-DD` — join key for `financials` |
| `entry_count` | number | Row count watermark for delta computation |
| `run_id` | string | Execution ID |

### 5. `financials` — P&L Log

**Owner**: Engine only (append-only)

| Column | Type | Description |
|--------|------|-------------|
| `date` | string | Snapshot period (not wall-clock run time) |
| `revenue` | number | Sum of all `income` account balances |
| `expenses` | number | Sum of all `expense` account balances |
| `profit` | number | `revenue - expenses` |
| `snapshot_ref` | string | Links to `snapshots_daily` rows that produced this row |
| `run_id` | string | Execution ID |

### 6. `reconciliation_log` — Audit Trail

**Owner**: Engine (writes), User (resolves)

| Column | Type | Description |
|--------|------|-------------|
| `reference_id` | number | Unix timestamp of detection |
| `issue_type` | string | e.g. `trial_balance_mismatch` |
| `status` | string | `open` (engine) → `resolved` (user) |
| `notes` | string | Issue signature for deduplication |
| `context` | string | Per-run debugging state |

---

## Pipeline: Four Flows

The handler runs all four flows sequentially. If any flow fails, the pipeline halts immediately — subsequent flows do not run.

```
validate-entries
      │ (writes to validated_entries)
      ▼
compute-ledger-balances
      │ (writes to snapshots_daily)
      ▼
trial-balance-check
      │ (writes to reconciliation_log on mismatch only)
      ▼
generate-financials
      │ (writes to financials)
      ▼
Done
```

---

### Flow 1: `validate-entries`

**Purpose**: Read pending raw entries, validate them against accounting rules, post valid entries to the ledger, and mark each raw row as processed or failed.

#### Step Table

| Step ID | Condition | Action |
|---------|-----------|--------|
| `read-raw` | always | Read all rows from `raw_entries` |
| `normalize-rows` | rows exist | Attach `_rowIndex` (arrayIndex + 2) |
| `filter-pending` | rows exist | Keep `status = pending` or `in_progress` (orphan recovery) |
| `claim-rows` | pending rows exist | Write `status = in_progress` to all claimed rows |
| `re-read-after-claim` | rows were claimed | Re-read `raw_entries` to verify claim |
| `filter-claimed` | re-read succeeded | Keep only rows this run claimed that still show `in_progress` |
| `normalize-fields` | claimed rows exist | `debit_account`, `credit_account` → `trim().toLowerCase()`; `entity` → `trim()` |
| `read-accounts` | normalized rows exist | Fetch chart of accounts |
| `validate-accounts` | accounts read | Assert uniqueness + valid type — throws on failure |
| `validate-rows` | normalized rows exist | Apply all validation rules; split into `valid[]` / `invalid[]` |
| `read-existing-validated` | valid rows exist | Read `validated_entries` for deduplication |
| `deduplicate-valid` | valid rows exist | Filter out entries whose `reference_id` already exists |
| `write-valid` | new rows exist | Append new entries to `validated_entries` |
| `re-read-validated-for-verify` | new rows written | Re-read `validated_entries` post-write |
| `verify-write` | new rows written | Confirm all expected `reference_id` values are present |
| `re-read-raw-for-update` | valid or invalid rows exist | Re-read `raw_entries` for fresh positions |
| `remap-row-indices` | fresh read succeeded | Resolve `row_id → current _rowIndex` for all rows |
| `mark-processed` | write verified AND valid rows remapped | Update `status = processed` using fresh `_rowIndex` |
| `mark-failed` | invalid rows remapped | Update `status = failed`, write `error_reason` |
| `log-validation-metrics` | `validate-rows` ran | Append metrics row to `reconciliation_log` |

#### Validation Rules

| Field | Rule | Error Code |
|-------|------|-----------|
| `date` | absent | `missing_date` |
| `date` | not `YYYY-MM-DD` or invalid calendar date | `invalid_date_format` |
| `amount` | absent or empty | `invalid_amount` |
| `amount` | non-numeric, comma-separated, letter suffix, negative | `invalid_amount` |
| `amount` | ≤ 0 | `invalid_amount` |
| `debit_account` | absent | `missing_debit` |
| `credit_account` | absent | `missing_credit` |
| `debit_account === credit_account` | same on both sides | `same_account` |
| `debit_account` | not in `accounts` sheet | `invalid_debit_account` |
| `credit_account` | not in `accounts` sheet | `invalid_credit_account` |

Multiple errors are pipe-separated: `invalid_date_format|invalid_amount`

#### `reference_id` Generation

```
reference_id = `${date}-${amount}-${debit_account}-${credit_account}-${row_id}`
```

Stable across runs regardless of sheet sorting, insertions, or deletions. Used for both deduplication and raw→ledger traceability.

#### Concurrency — Claim-Then-Verify

Google Sheets has no atomic operations. The flow uses an advisory `in_progress` marker:

1. **Claim**: Write `in_progress` to all pending rows
2. **Verify**: Re-read and keep only rows this run successfully claimed (still showing `in_progress`)
3. **Deduplication**: `reference_id` prevents double-writing even if two runs proceed concurrently
4. **Orphan recovery**: Rows stuck at `in_progress` from a crashed run are re-claimed on the next run

---

### Flow 2: `compute-ledger-balances`

**Purpose**: Compute account balances from validated entries using delta computation and write a dated snapshot.

#### Step Table

| Step ID | Condition | Action |
|---------|-----------|--------|
| `read-existing-snapshots` | always | Read all `snapshots_daily` rows |
| `check-snapshot-date` | always | Check if today's snapshot exists; extract prior balances and `entry_count` watermark |
| `read-validated` | today not yet snapshotted | Read only new entries starting at `priorEntryCount` |
| `check-validated-integrity` | new rows exist | Scan for structural corruption — throws on violation |
| `compute-balances` | new rows AND no today snapshot | Apply delta on top of prior snapshot balances |
| `write-snapshot` | balances computed | Append one row per account to `snapshots_daily` |
| `prune-snapshots` | `write-snapshot` ran | Delete dates outside `retentionDays` window |

#### Delta Computation

Instead of recomputing all balances from scratch on every run:

```
final_balance[account] = prior_balance[account] + Σ (new entries only)
```

The `entry_count` column in `snapshots_daily` records how many validated entries existed at snapshot time. On the next run, `rows.slice(priorEntryCount)` gives only the new entries — the delta.

**Balance rules:**
- Debit account: `balance += amount`
- Credit account: `balance -= amount`

#### Snapshot Deduplication

If today's snapshot already exists (`check-snapshot-date` detects it), both `compute-balances` and `write-snapshot` are skipped entirely — no duplicate rows, no wasted computation.

---

### Flow 3: `trial-balance-check`

**Purpose**: Verify the double-entry invariant: net sum of all account balances must equal zero. Flag corruption and log mismatches.

#### Step Table

| Step ID | Condition | Action |
|---------|-----------|--------|
| `read-validated` | always | Read all `validated_entries` |
| `check-balance` | rows exist | Scan for corrupt rows; compute net balance sum |
| `read-reconciliation-log` | mismatch detected | Read log for deduplication |
| `check-duplicate` | mismatch detected | Compare candidate notes to latest open entry |
| `write-reconciliation` | mismatch AND new/changed issue | Append diagnostic record |

#### Two Independent Checks

**Check 1 — Row-level corruption scan:**
- Missing `debit_account` or `credit_account`
- `amount ≤ 0` or unparseable
- `debit_account === credit_account` (self-posting)

Corrupt rows are collected by `reference_id` and **excluded** from balance computation.

**Check 2 — Net balance sum:**
```
netSum = Σ balances[account] for all clean rows
```
In a valid double-entry ledger, every `+amount` on a debit is paired with a `−amount` on a credit. `netSum ≠ 0` means an unpaired entry exists.

```
mismatch = netSum !== 0 || corruptEntries.length > 0
```

#### Deduplication — No Log Flooding

If the same issue persists across runs unchanged, only one log entry is written (not one per run). The `notes` field acts as the deduplication key — a new entry is written only when the issue is new or has structurally changed.

**Notes format:**
```
net_sum:-50                                    ← net sum only
corrupt_entries:ref-1,ref-2                    ← corruption only
net_sum:-50|corrupt_entries:ref-1              ← both
```

---

### Flow 4: `generate-financials`

**Purpose**: Read the latest snapshot, classify accounts by type, compute P&L, and append to `financials`.

#### Step Table

| Step ID | Condition | Action |
|---------|-----------|--------|
| `read-snapshots` | always | Read all `snapshots_daily` rows |
| `check-snapshot-integrity` | rows exist | Assert structural integrity — throws on violation |
| `read-accounts` | always | Read chart of accounts |
| `validate-accounts` | accounts read | Assert uniqueness + valid type |
| `select-latest-snapshot` | rows exist | Find max date; filter to that date only |
| `compute-financials` | latest rows exist | Classify by account type; compute revenue/expenses/profit |
| `write-financials` | computed AND date present | Append P&L row stamped with snapshot date |
| `read-financials-for-prune` | `write-financials` ran | Re-read `financials` for prune calculation |
| `prune-financials` | rows returned | Delete oldest rows beyond `retentionDays` |

#### Snapshot Selection

`snapshots_daily` is append-only — it accumulates rows across days. `select-latest-snapshot` uses ISO string comparison to find the max date and filters to only those rows:

```
latestDate = max(row.date for all rows)   // string comparison works for YYYY-MM-DD
rows = filter(snapshots where date === latestDate)
```

The P&L is stamped with the **snapshot date**, not the wall-clock run time. A flow run on 2026-03-26 using a 2026-03-25 snapshot writes `2026-03-25` to `financials`.

#### P&L Classification

| Account Type | Contribution |
|-------------|-------------|
| `income` | balance added to `revenue` |
| `expense` | balance added to `expenses` |
| `asset` | ignored (balance sheet item) |
| `liability` | ignored (balance sheet item) |

```
profit = revenue - expenses
```

---

## Cross-Cutting Concerns

### Idempotency

Every flow is designed to be safe to re-run:

| Flow | Re-run behaviour |
|------|-----------------|
| `validate-entries` | No new pending rows → no-op; duplicate entries filtered by `reference_id` |
| `compute-ledger-balances` | Today's snapshot exists → skip entirely |
| `trial-balance-check` | Same issue → no new log entry written |
| `generate-financials` | Multiple runs append identical P&L rows (same-day re-runs produce duplicates) |

### Traceability

Three linkage mechanisms provide full row-level lineage:

| Key | Links |
|-----|-------|
| `reference_id` | `raw_entries.row_id` → `validated_entries` row |
| `snapshot_ref` | `snapshots_daily` batch → `financials` row |
| `run_id` | All rows written by a single flow execution |

Full pipeline trace with a shared `run_id` injected by the orchestrator:
```
raw_entries.row_id
  → validated_entries.reference_id (via validate-entries)
    → snapshots_daily.run_id + entry_count (via compute-ledger-balances)
      → financials.snapshot_ref (via generate-financials)
```

### Recompute Mode

Past snapshots and financials can be regenerated without data loss:

- All recompute operations **append** new rows — old rows are never deleted
- Flows automatically select the latest `run_id` as authoritative
- `recomputeFrom` in config targets a specific date for snapshot recompute
- `recomputeDate` in config targets a specific date for P&L regeneration

### Retention Policy

Two sheets grow without bound and are subject to automatic pruning:

| Sheet | Pruned by | Rule |
|-------|-----------|------|
| `snapshots_daily` | `prune-snapshots` (in flow 2) | Keep latest `retentionDays` distinct dates |
| `financials` | `prune-financials` (in flow 4) | Keep latest `retentionDays` rows |

Default: `retentionDays = 90`. Four sheets are **never pruned**: `raw_entries`, `validated_entries`, `accounts`, `reconciliation_log`.

### Atomicity Strategy (No Transactions)

Google Sheets provides no transactions. The flow handles failure modes explicitly:

| Failure | Handling |
|---------|---------|
| `write-valid` fails | Rows stay `in_progress`; orphan recovery re-processes on next run |
| `write-valid` partially lands | `verify-write` detects missing `reference_id` values; blocks `mark-processed`; rows stay `in_progress` |
| Process dies between write and mark | Orphan recovery re-runs; deduplication skips re-write; `verify-write` passes; `mark-processed` completes |
| `mark-processed` partially fails | Remaining `in_progress` rows re-process; deduplication prevents double-write |

---

## Configuration

### `AccountingConfig` Structure

```ts
type AccountingConfig = {
  sheetId: string;        // Google Sheets document ID
  ranges: {
    raw:            string;  // tab name for raw_entries
    validated:      string;  // tab name for validated_entries
    accounts:       string;  // tab name for accounts
    snapshots:      string;  // tab name for snapshots_daily
    financials:     string;  // tab name for financials
    reconciliation: string;  // tab name for reconciliation_log
  };
  retentionDays?: number;  // default: 90
  recomputeFrom?: string;  // YYYY-MM-DD — snapshot recompute target
  recomputeDate?: string;  // YYYY-MM-DD — financials recompute target
  runId?: string;          // injected by orchestrator for cross-flow traceability
};
```

### Environment Variables (`.env`)

| Variable | Purpose |
|----------|---------|
| `SHEET_ID` | Google Sheets document ID |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | GCP service account credentials JSON |
| `PORT` | HTTP server port (default: 3000) |
| `LOG_LEVEL` | Logging verbosity (`info`, `debug`) |

Range names default to tab names (`raw_entries`, `validated_entries`, etc.) and can be overridden via env:

| Variable | Default |
|----------|---------|
| `RANGE_RAW` | `raw_entries` |
| `RANGE_VALIDATED` | `validated_entries` |
| `RANGE_ACCOUNTS` | `accounts` |
| `RANGE_SNAPSHOTS` | `snapshots_daily` |
| `RANGE_FINANCIALS` | `financials` |
| `RANGE_RECONCILIATION` | `reconciliation_log` |

---

## Error Handling — Handler Rules

- `validateConfig()` runs first — any invalid config aborts before touching any module or flow
- All config errors are logged in full before returning (not just the first)
- Each `runFlow()` result is checked immediately — a failed flow stops the pipeline
- The handler never throws — all errors surface via logged messages and early returns
- Flows do not use try/catch — errors propagate via `ExecutionResult.ok: false`

---

## Implementation Status

| Component | Status |
|-----------|--------|
| Functional spec | Complete |
| Technical spec | Complete |
| Flow specifications (markdown) | Complete — all 4 flows fully specified |
| Handler specification (markdown) | Complete |
| Schema documentation | Complete |
| `flow.ts` implementations | **Not yet written** |
| `handler.ts` | **Not yet written** |
| `server.ts` | **Not yet written** |
| Tests | **Not yet written** |

---

## Comparison with Other Apps

| Aspect | Mining | Ledger | Accounting |
|--------|--------|--------|------------|
| Interface | WhatsApp | WhatsApp | HTTP / Cron / CLI |
| AI | None | NVIDIA NIM (classification + extraction) | None |
| Communication | WhatsApp (Meta) | WhatsApp (Meta) | None |
| Storage | Google Sheets | Google Sheets | Google Sheets |
| Trigger | Webhook + Cron | Webhook | HTTP POST / Cron |
| Users | Field managers → owner | Single user | Accountant / owner |
| Data entry | Structured text messages | Chat commands | Manual sheet rows |
| Double-entry | No | No | Yes (enforced) |
| Concurrency handling | None | None | Claim-then-verify |
| Idempotency | Basic | Basic | Full (all flows) |
| Implementation | Complete | Complete | Spec only |
