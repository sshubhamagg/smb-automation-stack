# Validate Entries — Flow Documentation

**Flow ID**: `validate-entries`

**File**: `apps/accounting/flows/validate-entries/flow.md`

---

## Purpose

The `validate-entries` flow is the first flow in the accounting pipeline. It reads all pending rows from `raw_entries`, claims them with an `in_progress` marker to prevent concurrent duplicate processing, normalizes user-supplied field values, validates them against accounting rules, deduplicates against the existing ledger, writes only new valid entries to `validated_entries`, verifies the write succeeded, and marks each raw row as either `processed` or `failed`.

Row updates use a **stable `row_id` resolved to a fresh sheet position** immediately before writing, ensuring updates always land on the correct row regardless of sheet modifications between reads. `mark-processed` is additionally gated on write verification — it only runs if the ledger write is confirmed.

---

## Step Summary

| Step ID | Type | Condition | Purpose |
|---------|------|-----------|---------|
| `read-raw` | storage | always | Read all rows from `raw_entries` |
| `normalize-rows` | storage | rows exist | Attach initial `_rowIndex` (starts at 2) |
| `filter-pending` | storage | normalized rows exist | Keep `status = pending` OR `status = in_progress` (orphan recovery) |
| `claim-rows` | storage | pending/orphan rows exist | Write `status = in_progress` to all claimed rows |
| `re-read-after-claim` | storage | rows were claimed | Re-read `raw_entries` to capture post-claim state |
| `filter-claimed` | storage | re-read succeeded | Keep only rows whose `row_id` is in the claimed set AND `status = in_progress` |
| `normalize-fields` | storage | claimed rows exist | Normalize `debit_account`, `credit_account` (trim + lowercase); `entity` (trim) |
| `read-accounts` | storage | normalized rows exist | Fetch chart of accounts |
| `validate-accounts` | storage | accounts rows read | Assert `account_name` uniqueness and `type` in valid set — throws on failure |
| `validate-rows` | storage | normalized rows exist | Apply validation rules against normalized values; split valid/invalid; generate `reference_id` |
| `read-existing-validated` | storage | valid rows exist | Read existing `validated_entries` for deduplication |
| `deduplicate-valid` | storage | valid rows exist | Filter out entries whose `reference_id` already exists |
| `write-valid` | storage | new rows exist | Append only new entries to `validated_entries` |
| `re-read-validated-for-verify` | storage | new rows were written | Re-read `validated_entries` to capture post-write state |
| `verify-write` | storage | new rows were written | Confirm all expected `reference_id` values landed; emit `allWritten` flag |
| `re-read-raw-for-update` | storage | valid or invalid rows exist | Re-read `raw_entries` for fresh sheet positions |
| `remap-row-indices` | storage | fresh rows read | Resolve `row_id → current _rowIndex` for all valid and invalid rows |
| `mark-processed` | storage | write verified AND remapped valid rows exist | Update `status = processed` using fresh `_rowIndex` |
| `mark-failed` | storage | remapped invalid rows exist | Update `status = failed`, write `error_reason` using fresh `_rowIndex` |
| `log-validation-metrics` | storage | `validate-rows` produced a `meta` object | Append metrics row to `reconciliation_log` with total/valid/invalid counts |

---

## Row Tracking Mechanism

### Problem: Positional Index Staleness

`_rowIndex` is computed once as `arrayIndex + 2` during `normalize-rows`. It reflects where a row sits at the moment `read-raw` executes. Between that read and the later update steps, the sheet can be modified:

| Modification | Effect |
|---|---|
| Row inserted above a pending row | All subsequent `_rowIndex` values are off by +1 or more |
| Row deleted above a pending row | All subsequent `_rowIndex` values are off by -1 or more |
| Sheet sorted | `_rowIndex` values are completely wrong for all rows |

Updates to `status` and `error_reason` land on the **wrong rows silently** — no error is raised.

Additionally, the old `reference_id` formula used `_rowIndex`:
```
reference_id = `${date}-${amount}-${debit_account}-${credit_account}-${_rowIndex}`
```
If `_rowIndex` changes between runs (e.g. after a sort), the same logical row produces a **different `reference_id`** — breaking idempotency and allowing duplicate ledger entries.

### Fix: `row_id` as Stable Identity

`raw_entries` has a `row_id` column. The user assigns a unique value per row when entering data. This value never changes regardless of sorting, insertions, or deletions.

`row_id` serves two roles:

**1. Stable `reference_id` generation**

```
reference_id = `${date}-${amount}-${debit_account}-${credit_account}-${row_id}`
```

A row's `reference_id` is now identical across all runs, regardless of how the sheet is restructured. Idempotency is unconditional.

**2. Index remapping before updates**

Steps 15–16 form an update-safe pair:

- **`re-read-raw-for-update`** — Re-reads `raw_entries` to capture the sheet's current state. This runs after all writes to `validated_entries` are complete, so it reflects any structural changes the user may have made.
- **`remap-row-indices`** — Builds `Map<row_id, current _rowIndex>` from the fresh read. Overwrites `_rowIndex` on every valid and invalid row before they reach the mark steps.

`mark-processed` and `mark-failed` consume `remap-row-indices` output — they always operate on fresh positions.

---

## Normalization Rules

Field normalization runs in the `normalize-fields` step, after claiming and before validation. Normalized values are used by all downstream steps — validation comparisons, `reference_id` generation, and ledger writes all operate on the normalized form.

| Field | Normalization | Example |
|-------|---------------|---------|
| `debit_account` | `trim()` + `toLowerCase()` | `" Cash "` → `"cash"` |
| `credit_account` | `trim()` + `toLowerCase()` | `"Revenue "` → `"revenue"` |
| `entity` | `trim()` | `" Acme Corp "` → `"Acme Corp"` |

All other fields pass through unchanged.

Account names from the `accounts` sheet are normalized with the same `trim().toLowerCase()` transform inside `validate-rows` before the comparison set is built. This ensures `"cash"` matches `"Cash"` in the sheet without requiring the user to keep casing consistent.

**Why lowercase for account names**: lowercase is a deterministic, lossless transform — there is one canonical form for any input. Title Case or sentence case normalization is ambiguous (e.g. `"accounts payable"` vs `"Accounts Payable"`), so lowercase is the safer choice.

**Why trim-only for entity**: `entity` is a free-form label, not a lookup key. Case-preserving trim removes accidental whitespace while keeping the user's intended formatting intact.

---

## Validation Rules

All rules are applied inside the `validate-rows` step, after normalization:

| Field | Rule | Error Code |
|-------|------|-----------|
| `date` | field is absent | `missing_date` |
| `date` | does not match `YYYY-MM-DD` regex | `invalid_date_format` |
| `date` | month out of range (< 1 or > 12) | `invalid_date_format` |
| `date` | day out of range for the given month/year | `invalid_date_format` |
| `amount` | field is absent or empty | `invalid_amount` |
| `amount` | contains non-digit characters other than a single `.` | `invalid_amount` |
| `amount` | parses to ≤ 0 | `invalid_amount` |
| `debit_account` | field is absent | `missing_debit` |
| `credit_account` | field is absent | `missing_credit` |
| `debit_account`, `credit_account` | both fields are equal | `same_account` |
| `debit_account` | not in `accounts` sheet | `invalid_debit_account` |
| `credit_account` | not in `accounts` sheet | `invalid_credit_account` |

Multiple errors are pipe-separated in `error_reason`, e.g.:
```
invalid_date_format|invalid_amount
```

### Date Validation Detail

The date check runs in two stages:

1. **Format** — regex `/^\d{4}-\d{2}-\d{2}$/` must match. Rejects partial dates, timestamps, slashed formats (`2026/03/24`), and any non-digit characters.
2. **Calendar validity** — month must be 1–12; day must be within the actual number of days in that month (e.g. `2026-02-29` fails because 2026 is not a leap year). Implemented using `new Date(year, month, 0).getDate()` — no external library required.

Both stages produce the same error code (`invalid_date_format`). A missing date produces `missing_date` before either check runs.

### Amount Validation Detail

The amount check runs in three stages:

1. **Presence** — empty or absent → `invalid_amount`.
2. **Pattern** — regex `/^\d+(\.\d+)?$/` must match. This explicitly rejects:
   - Comma separators (`"1,000"`)
   - Letter suffixes (`"1k"`, `"1M"`)
   - Scientific notation (`"1e3"`)
   - Leading minus or plus signs (`"-100"`, `"+50"`)
   - Spaces within the value (`.trim()` is applied first to strip surrounding whitespace only)
3. **Range** — `Number(amtStr) <= 0` → `invalid_amount`. A string like `"0"` or `"0.00"` passes the regex but fails here.

All three failures use the same error code. The raw input value is preserved in the row data, so the user can see exactly what was rejected.

---

## `reference_id` Generation

For every valid entry, a `reference_id` is generated deterministically:

```
reference_id = `${date}-${amount}-${debit_account}-${credit_account}-${row_id}`
```

Properties:
- **Stable across runs** — `row_id` does not change when the sheet is sorted or rows are reordered.
- **Deterministic** — the same row data always produces the same ID.
- **Traceable** — the `reference_id` in `validated_entries` can be matched back to the source row by `row_id`.

---

## Concurrency Strategy

Google Sheets provides no atomic operations. Two concurrent runs of `validate-entries` can read the same `pending` rows and begin processing them simultaneously. The flow uses an **advisory `in_progress` marker** with post-claim verification to narrow the collision window.

### `in_progress` Status Lifecycle

| Stage | `status` value |
|-------|---------------|
| User submits row | `pending` |
| Run claims the row | `in_progress` (written by `claim-rows`) |
| Validation passes, ledger write confirmed | `processed` (written by `mark-processed`) |
| Validation fails | `failed` (written by `mark-failed`) |
| Run crashes before marking | Stays `in_progress` — recovered on next run |

### Claim-Then-Verify Pattern

The flow executes a two-phase claim:

**Phase 1 — Claim** (`claim-rows`): Immediately after identifying actionable rows, the flow writes `status = in_progress` to each of them using the current `_rowIndex`.

**Phase 2 — Verify** (`re-read-after-claim` + `filter-claimed`): The flow re-reads `raw_entries` and retains only rows that:
- Have a `row_id` in the set this run claimed
- Currently show `status = in_progress` (not `processed` or `failed`)

Rows that a concurrent run has already moved to `processed` or `failed` between our claim write and the re-read are dropped. This prevents the same row from being processed twice in separate runs — the window for collision is narrowed to the time between the first runner's `claim-rows` and the second runner's `re-read-after-claim`.

### Orphan Recovery

A row stuck at `in_progress` from a crashed run is an orphan. `filter-pending` includes `in_progress` rows alongside `pending` rows. On the next run, the orphan re-enters the pipeline: `claim-rows` re-asserts `in_progress` (idempotent), `filter-claimed` includes it, and processing continues. The `reference_id` is stable so `deduplicate-valid` correctly skips any ledger entries that landed before the crash.

### What Happens in a Race

If two runs execute simultaneously on the same batch:

1. Both read the same `pending` rows
2. Both write `in_progress` to them (writes land in some order; the last write wins — both values are `in_progress`, so the outcome is identical)
3. Both re-read and see `in_progress` — both proceed
4. Both call `validate-rows`, producing the same `reference_id` values
5. Both call `read-existing-validated` and `deduplicate-valid` — whichever run calls `write-valid` first writes the entries; the second run's `deduplicate-valid` filters them as already present, so `write-valid` is skipped
6. Both call `verify-write` — both confirm the entries are in the ledger
7. Both call `mark-processed` — writing `processed` twice is idempotent

**Data integrity is preserved**: deduplication prevents double-writing; `verify-write` confirms the ledger before any marking; `mark-processed` is idempotent.

### Honest Limitation

The `in_progress` advisory marker significantly reduces collision frequency but does not eliminate it. The collision window is the interval between `claim-rows` and `re-read-after-claim`. In the worst case, two runs that claimed rows at the exact same instant both proceed through the full pipeline. The existing deduplication and verification guarantees ensure that even in this case, no data is corrupted and no `reference_id` is written twice.

---

## Deduplication

Two steps guard against duplicate ledger entries:

### `read-existing-validated`
Reads all existing rows from `validated_entries` and surfaces their `reference_id` values. Skipped if there are no valid rows to check.

### `deduplicate-valid`
```
existingIds = new Set(existing.map(r => r.reference_id).filter(Boolean))
newRows     = valid.filter(r => !existingIds.has(r.reference_id))
```

- Falsy `reference_id` values are excluded from `existingIds` via `.filter(Boolean)`.
- If all valid rows are already in the ledger, `newRows` is `[]` and `write-valid` is skipped.
- If `validated_entries` is empty (first run), `newRows === valid`.

---

## Atomicity Strategy

Google Sheets has no transactions. `write-valid` and `mark-processed` are separate API operations. A crash, timeout, or partial write between them leaves state inconsistent. The flow handles this at the logic level.

### Failure modes and handling

| Failure | Without fix | With fix |
|---------|-------------|---------|
| `write-valid` API fails | Engine stops; rows stay `in_progress` — clean | Same |
| `write-valid` partially lands (some rows missing) | `mark-processed` marks all rows `processed` against an incomplete ledger | `verify-write` detects missing IDs → `mark-processed` blocked → rows stay `in_progress` → re-process cleanly |
| Process dies after `write-valid`, before `mark-processed` | Rows stay `in_progress` — self-healing via deduplication and orphan recovery | Same + `verify-write` confirms entries on next run |
| `mark-processed` partially fails | Some rows `processed`, some still `in_progress` | Remaining `in_progress` rows re-process; deduplication skips re-write; `verify-write` passes; mark completes |

### How `verify-write` gates `mark-processed`

After `write-valid`, two steps run:

**`re-read-validated-for-verify`** — Re-reads `validated_entries` to capture its state after the write.

**`verify-write`** — Checks every `reference_id` from `deduplicate-valid.newRows` against the fresh read:
```
writtenIds  = new Set(rows.map(r => r.reference_id).filter(Boolean))
missingIds  = expected.filter(id => !writtenIds.has(id))
allWritten  = missingIds.length === 0
```

`mark-processed` condition:
```ts
ctx.outputs?.['verify-write']?.allWritten !== false
  && !!ctx.outputs?.['remap-row-indices']?.valid?.length
```

The `!== false` expression handles all three states correctly:

| `verify-write` state | `allWritten !== false` | Result |
|---|---|---|
| `{ allWritten: true }` | `true` | Gate passes — `mark-processed` runs |
| `{ allWritten: false }` | `false` | Gate blocks — raw rows stay `in_progress` |
| `undefined` (step skipped — no new rows) | `true` | Gate passes — `mark-processed` still runs for duplicates |

### Why `mark-failed` is not gated

`mark-failed` operates on rows that failed validation — they were never submitted to `write-valid`. There is no ledger entry to verify for these rows. Their status update is independent.

---

## Write vs. Mark-Processed Split

`write-valid` and `mark-processed` deliberately use different source lists:

| Step | Source | Covers |
|------|--------|--------|
| `write-valid` | `deduplicate-valid.newRows` | Only entries not yet in the ledger |
| `mark-processed` | `remap-row-indices.valid` | All valid rows, including duplicates |

A duplicate submission is semantically valid — it just doesn't need to be re-written. Marking it `processed` prevents it from cycling through the pipeline indefinitely.

---

## Idempotency

The flow is fully idempotent:

| Scenario | Behavior |
|----------|----------|
| Re-run with no new pending rows | No-op — `filter-pending` returns empty |
| Re-run after row reset to `pending` (same data, same `row_id`) | Same `reference_id` → `deduplicate-valid` filters it → `write-valid` skipped → `verify-write` skipped → `mark-processed` re-marks the raw row |
| Re-run after `write-valid` succeeded but `mark-processed` was blocked | `deduplicate-valid` filters already-written rows → `write-valid` skipped → `verify-write` skipped → gate passes → `mark-processed` runs |
| Re-run after `write-valid` succeeded but process died | Rows orphaned at `in_progress` → `filter-pending` picks them up → `filter-claimed` includes them → deduplication skips re-write → converges |
| Re-run after sheet sorted | `re-read-raw-for-update` captures new positions → `remap-row-indices` corrects all `_rowIndex` values → updates land on correct rows |
| Re-run after row inserted above | Same as sorted — fresh positions resolved before any update |
| First run against empty ledger | All valid rows treated as new |

---

## Fallback Behavior (Missing `row_id`)

If a row has no `row_id`, `remap-row-indices` falls back to `r._rowIndex` (the position at `filter-claimed` time):

```ts
_rowIndex: indexMap[r.row_id] ?? r._rowIndex
```

This fallback **does not have the stability guarantee**. Rows without `row_id` can receive incorrect updates if the sheet is modified between `read-raw` and the mark steps. Users must populate `row_id` for every row.

Additionally, `filter-claimed` uses `row_id` to identify which rows this run claimed. A row without `row_id` cannot be matched in `filter-claimed` and will be excluded — it will not be processed even if `claim-rows` wrote `in_progress` to it.

---

## Outputs Produced

| Sheet | Operation | Trigger |
|-------|-----------|---------|
| `raw_entries` (status col) | update rows | `claim-rows` — all pending/orphan rows marked `in_progress` |
| `validated_entries` | append rows | new (deduplicated) valid entries exist |
| `raw_entries` (status col) | update rows | valid or invalid entries exist — `mark-processed` / `mark-failed` |
| `reconciliation_log` | append row | `validate-rows` ran — one metrics row per execution |

---

## Error Correction Loop

When rows fail validation:
1. Engine writes `status = failed` and `error_reason` to the raw row using `remap-row-indices` for accurate targeting.
2. User reviews and corrects the row data.
3. User resets `status = pending` (and keeps the same `row_id`).
4. On the next run, the corrected row re-enters the pipeline. If the correction changes any of `date`, `amount`, `debit_account`, or `credit_account`, the new `reference_id` will differ from any prior attempt — it will not be filtered as a duplicate.

---

## Skipped Steps

| Step | Skipped when |
|------|--------------|
| `normalize-rows` | `read-raw` returns no rows |
| `filter-pending` | no normalized rows |
| `claim-rows` | no pending or orphaned rows |
| `re-read-after-claim` | no pending or orphaned rows |
| `filter-claimed` | `re-read-after-claim` was skipped |
| `normalize-fields` | no claimed rows |
| `read-accounts` | no normalized rows |
| `validate-accounts` | `read-accounts` was skipped |
| `validate-rows` | no normalized rows |
| `read-existing-validated` | no valid rows from `validate-rows` |
| `deduplicate-valid` | no valid rows from `validate-rows` |
| `write-valid` | `deduplicate-valid.newRows` is empty |
| `re-read-validated-for-verify` | `deduplicate-valid.newRows` is empty (nothing was written) |
| `verify-write` | `deduplicate-valid.newRows` is empty (nothing to verify) |
| `re-read-raw-for-update` | no valid and no invalid rows |
| `remap-row-indices` | `re-read-raw-for-update` was skipped |
| `mark-processed` | `verify-write.allWritten === false` OR `remap-row-indices.valid` is empty |
| `mark-failed` | `remap-row-indices.invalid` is empty |
| `log-validation-metrics` | `validate-rows` was skipped (no normalized rows) |

A skipped step does not fail the flow. Execution continues to the next step.
