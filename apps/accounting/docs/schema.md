# Schema: Google Sheets Data Model

**Purpose**: Documents all Google Sheets tabs used by the accounting engine, their column layouts, data types, and ownership rules.

---

## Overview

Google Sheets is the sole storage layer. The accounting engine reads from and writes to six named sheet tabs. No formulas, pivot tables, or computed cells are used — all computation happens inside flows.

---

## Sheet Tabs

---

### `raw_entries`

**Owner**: User (input), Engine (status updates)

**Description**: The entry point for all journal entries. Users add rows manually with `status = pending`. The engine updates `status` and `error_reason` after validation.

| Column | Type | Values | Owner |
|--------|------|---------|-------|
| `row_id` | string | unique per row, never changes | User |
| `date` | string | ISO date `YYYY-MM-DD` | User |
| `type` | string | e.g. `expense`, `income`, `transfer` | User |
| `amount` | number | positive decimal | User |
| `debit_account` | string | must exist in `accounts` | User |
| `credit_account` | string | must exist in `accounts` | User |
| `entity` | string | counterparty name | User |
| `notes` | string | freeform description | User |
| `status` | string | `pending` / `in_progress` / `processed` / `failed` | User (initial) / Engine (update) |
| `error_reason` | string | pipe-separated error codes | Engine |

**Rules**:
- `row_id` must be assigned by the user when creating a row. It must be unique within the sheet and must never be changed after creation. It is the stable identity of a row across all engine runs, regardless of sorting, insertions, or deletions.
- Acceptable `row_id` formats: sequential integers (`1`, `2`, `3`), prefixed codes (`txn-001`), or UUIDs. Any non-empty unique string is valid.
- User sets `status = pending` when entering a new row.
- Engine sets `status = in_progress` immediately after claiming the row for processing. A row stuck at `in_progress` indicates a prior run crashed before completion — the engine recovers it automatically on the next run.
- Engine overwrites `status` and `error_reason` using a `row_id`-resolved sheet position, not a stored positional index.
- Rows with `status = processed` or `status = failed` are ignored on re-runs. Rows with `status = in_progress` are re-claimed for orphan recovery.
- Rows missing `row_id` fall back to positional index for updates — this is unsafe and not guaranteed to target the correct row if the sheet is modified between reads.

---

### `validated_entries`

**Owner**: Engine (append-only)

**Description**: The trusted double-entry ledger. Written exclusively by the `validate-entries` flow. Never modified after writing.

| Column | Type | Description |
|--------|------|-------------|
| `date` | string | ISO date from raw entry |
| `debit_account` | string | validated account name |
| `credit_account` | string | validated account name |
| `amount` | number | positive decimal |
| `entity` | string | counterparty name |
| `reference_id` | string | deterministic ID: `date-amount-debit-credit-row_id` |
| `run_id` | string | execution ID of the `validate-entries` run that wrote this row — format `run-{ISO timestamp}` |

**Rules**:
- Append-only. The engine never deletes or updates rows here.
- `reference_id` ensures idempotency — re-processing the same raw row (same `row_id`, same field values) always produces the same `reference_id`.
- Account names in `debit_account` and `credit_account` are stored in their normalized form (trimmed, lowercase).
- `run_id` is written by `write-valid`. If `ctx.state.runId` is set by an orchestrator, all rows in this run share that value. Otherwise a value is generated per-run as `` `run-${new Date().toISOString()}` ``. Rows written before this column was introduced have no `run_id` — no check enforces its presence.

---

### `accounts`

**Owner**: User (managed manually)

**Description**: Chart of accounts. Defines all valid account names and their accounting type. Used by `validate-entries` to check account existence and by `generate-financials` to classify balances.

| Column | Type | Values |
|--------|------|--------|
| `account_name` | string | unique account identifier |
| `type` | string | `asset` / `liability` / `income` / `expense` |

**Rules**:
- User manages this sheet. The engine only reads it.
- Account names in `raw_entries` are normalized to lowercase before comparison — `"Cash"` and `"cash"` in `raw_entries` both match an account named `"Cash"` in this sheet.

**Integrity Rules** (enforced at runtime by `validate-accounts` in each flow):

| Rule | Violation | Effect |
|------|-----------|--------|
| `account_name` must be unique | Duplicate names (case/whitespace-insensitive) | Flow fails immediately — `validate-accounts` throws |
| `type` must be one of `asset`, `liability`, `income`, `expense` | Any other value | Flow fails immediately — `validate-accounts` throws |

Uniqueness is checked after `trim().toLowerCase()` normalization. `"Cash"` and `"cash"` in the same sheet are treated as duplicates and will fail the check.

Type values are also normalized before comparison — `"Asset"`, `"ASSET"`, and `"asset"` are all accepted.

Both flows (`validate-entries` and `generate-financials`) run this check before any entry validation or financial computation. A malformed accounts sheet blocks both flows entirely.

---

### `snapshots_daily`

**Owner**: Engine (append-only)

**Description**: Time-series log of account balances. The `compute-ledger-balances` flow appends one row per account per run.

| Column | Type | Description |
|--------|------|-------------|
| `date` | string | ISO date of the run |
| `account` | string | account name |
| `balance` | number | net balance (positive or negative) |
| `snapshot_ref` | string | traceability key: `snapshot-{date}` |
| `entry_count` | number | total rows in `validated_entries` at snapshot time — delta computation watermark |
| `run_id` | string | execution ID of the `compute-ledger-balances` run that wrote this row — format `run-{ISO timestamp}` |

**Rules**:
- Append-only. Each run adds new rows.
- Balance = cumulative net impact of all `validated_entries` rows on this account (not just the delta applied this run).
- All rows in a single run batch share the same `snapshot_ref`, `entry_count`, and `run_id` values.
- `snapshot_ref` is the join key for `financials.snapshot_ref` — filter on this column to retrieve the exact snapshot set that produced a given P&L row.
- `entry_count` is read by `check-snapshot-date` on the next run as the delta watermark: entries at index `entry_count` and beyond are "new" and will be applied as a delta on top of this snapshot's balances.
- Older rows without `entry_count` are treated as if `entry_count = 0`, triggering a full recompute on the next run. No migration is required.
- Rows written before `run_id` was introduced have no value in that column — no check enforces its presence.

---

### `financials`

**Owner**: Engine (append-only)

**Description**: P&L log. The `generate-financials` flow appends one row per run.

| Column | Type | Description |
|--------|------|-------------|
| `date` | string | ISO date of the snapshot this row was derived from |
| `revenue` | number | sum of all `income` account balances from the latest snapshot |
| `expenses` | number | sum of all `expense` account balances from the latest snapshot |
| `profit` | number | `revenue - expenses` |
| `snapshot_ref` | string | traceability key: `snapshot-{date}` — links to `snapshots_daily` |
| `run_id` | string | execution ID of the `generate-financials` run that wrote this row — format `run-{ISO timestamp}` |

**Rules**:
- Append-only. Each run adds one row.
- No formulas. All values are computed by `compute-financials` step.
- `date` reflects the snapshot period, not the wall-clock time the flow ran.
- `snapshot_ref` matches `snapshots_daily.snapshot_ref` for the same date — exact-match join to retrieve source balances.
- Rows written before `run_id` was introduced have no value in that column — no check enforces its presence.

---

### `reconciliation_log`

**Owner**: Engine (append-only)

**Description**: Audit log of detected accounting mismatches. Written by `trial-balance-check` only when a mismatch is detected and the issue is new or has changed.

| Column | Type | Description |
|--------|------|-------------|
| `reference_id` | number | Unix timestamp (`Date.now()`) of detection |
| `issue_type` | string | e.g. `trial_balance_mismatch` |
| `status` | string | `open` (engine-set), `resolved` (user-set) |
| `notes` | string | Issue signature used for deduplication — pipe-separated (e.g. `net_sum:-50\|corrupt_entries:ref-1`) |
| `context` | string | Per-run debugging state — `ledger_entries:N\|corrupt_count:N\|affected_accounts:Account:balance,...` |

**Rules**:
- Written only on mismatch detection when the issue is new or has changed since the last open entry.
- `notes` is compared against the latest open entry to suppress duplicate writes for unchanged issues.
- `context` is not used for deduplication — it reflects the ledger state at first detection.
- Status starts as `open`. Users manually update to `resolved` after investigation.

---

## Column Index Reference

| Sheet | Cols |
|-------|------|
| `raw_entries` | A–J (10 cols) |
| `validated_entries` | A–G (7 cols) |
| `accounts` | A–B (2 cols) |
| `snapshots_daily` | A–F (6 cols) |
| `financials` | A–F (6 cols) |
| `reconciliation_log` | A–E (5 cols) |
