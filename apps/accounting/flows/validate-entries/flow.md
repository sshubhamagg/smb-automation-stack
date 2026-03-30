# Flow: validate-entries

**Flow ID**: `validate-entries`

**Purpose**: Read raw journal entries from Google Sheets, normalize user-supplied field values, validate each pending row against accounting rules, deduplicate against the existing ledger, write only new valid entries to the validated ledger, verify the write succeeded before marking raw rows, and mark each raw row as either `processed` or `failed` with a reason. Row updates use a stable `row_id` resolved to a fresh position immediately before writing.

---

## Overview

```
read-raw → normalize-rows → filter-pending → claim-rows → re-read-after-claim → filter-claimed
  → normalize-fields → read-accounts → validate-accounts → validate-rows
  → read-existing-validated → deduplicate-valid → write-valid
  → re-read-validated-for-verify → verify-write
  → re-read-raw-for-update → remap-row-indices
  → mark-processed → mark-failed → log-validation-metrics
```

---

## Batch Strategy

### Problem

At ~100k rows, a single `read` call returning the entire `raw_entries` or `validated_entries` sheet consumes substantial memory and risks API timeout. Write operations sending thousands of rows in one call can exceed API size limits (~10MB per request).

### `batchSize`

A `batchSize` value (default `5000`) is read from `ctx.state.config.batchSize` and passed in the `options` object of every read and write step. The storage provider uses this value to:

- **Reads**: page through the requested range in chunks of at most `batchSize` rows per API call, accumulating results before returning. No individual API response exceeds `batchSize` rows.
- **Writes** (`write-valid`): the `data` array is split into slices of `batchSize` rows; each slice becomes a separate `write` operation. Multiple write operations are returned from the `input` function as an array — the engine executes them sequentially.

### Why full reads are unavoidable for `raw_entries`

`raw_entries` must be read in full because the `status` field (used to identify `pending` rows) can appear at any row position. There is no ordered index that would allow a partial read to guarantee coverage of all `pending` rows.

Mitigation: `filter-pending` runs immediately after `read-raw` and discards all non-pending rows from context. Subsequent steps operate only on the (much smaller) `pendingRows` subset. Peak working-set memory after `filter-pending` is proportional to the number of pending rows, not the total sheet size.

### `write-valid` chunking

When `deduplicate-valid.newRows` contains more than `batchSize` entries, `write-valid` returns an array of write operations — one per chunk. The engine executes them sequentially. Each operation appends one chunk to `validated_entries`. The `re-read-validated-for-verify` step reads the sheet after all chunks complete, so `verify-write` checks all written entries collectively.

---

## Row Tracking Mechanism

### The Problem with Positional Indices

`_rowIndex` is derived as `arrayIndex + 2` at read time. It reflects where a row sits in the sheet **at the moment `read-raw` executes**. If the sheet is modified before `mark-processed` or `mark-failed` run — by inserting a row above, deleting a row, or sorting — the stored `_rowIndex` no longer points to the correct row. Updates land on the wrong rows silently.

### The Fix: `row_id` + Re-Read Before Update

`raw_entries` has a `row_id` column. The user assigns a unique value per row when entering data (e.g. `1`, `2`, `txn-001`). This value never changes regardless of how the sheet is sorted or restructured.

The flow uses `row_id` in two places:

**1. `reference_id` generation (step 10)**

```
reference_id = `${date}-${amount}-${debit_account}-${credit_account}-${row_id}`
```

`row_id` replaces the old `_rowIndex` in the formula. This keeps `reference_id` stable across runs even if the row's sheet position changes. A row that moves from position 3 to position 7 after sorting still produces the same `reference_id`.

**2. Index remapping before updates (steps 16–17)**

Immediately before `mark-processed` and `mark-failed` run, the flow:
- Re-reads `raw_entries` to get the current sheet state (`re-read-raw-for-update`)
- Builds a `Map<row_id → fresh _rowIndex>` from that read (`remap-row-indices`)
- Rewrites the `_rowIndex` on every valid and invalid row using the fresh map

This means updates always target the row's **current** position, not its position from an earlier read.

---

## Atomicity Strategy

Google Sheets provides no transactions. `write-valid` and `mark-processed` are separate API operations. A crash, timeout, or partial API failure between them leaves state inconsistent. The flow handles this at the logic level using two complementary mechanisms.

### Mechanism 1: Write-Before-Mark ordering

`write-valid` always runs before `mark-processed`. If `write-valid` fails, the engine stops immediately — `mark-processed` never executes. This eliminates the "marked but not written" state entirely.

The inverse — "written but not marked" — is handled by the next mechanism.

### Mechanism 2: Verify-then-Gate (`verify-write`)

After `write-valid`, two steps run before any raw row is touched:

- **`re-read-validated-for-verify`** — re-reads `validated_entries` to capture the sheet's state after the write
- **`verify-write`** — checks that every `reference_id` from `deduplicate-valid.newRows` is present in the fresh read; emits `{ allWritten: boolean, missingIds: string[] }`

`mark-processed` has a compound condition:
```ts
ctx.outputs?.['verify-write']?.allWritten !== false
  && !!ctx.outputs?.['remap-row-indices']?.valid?.length
```

The `!== false` expression handles all three states:

| `verify-write` output | `allWritten !== false` | Meaning |
|-----------------------|------------------------|---------|
| `{ allWritten: true }` | `true` | Write confirmed — `mark-processed` runs |
| `{ allWritten: false }` | `false` | Write incomplete — `mark-processed` blocked |
| `undefined` (step skipped — no new rows) | `true` | Nothing was written — `mark-processed` still runs for duplicates |

When `mark-processed` is blocked, raw rows remain `in_progress`. On the next run, they re-enter the pipeline via orphan recovery in `filter-pending`. `deduplicate-valid` filters any entries that did land in `validated_entries`. `write-valid` writes only what is still missing. `verify-write` re-checks. `mark-processed` runs once verification passes.

### Recovery guarantee

| Failure scenario | State after failure | Recovery |
|---|---|---|
| `write-valid` API call fails | Engine stops; no rows written; raw rows stay `in_progress` | Next run picks them up via orphan recovery |
| `write-valid` partially lands (some rows missing) | Ledger has partial entries; raw rows stay `in_progress` | `verify-write` blocks mark; next run writes missing rows, verifies, then marks |
| `write-valid` succeeds; process dies before `mark-processed` | Ledger has entries; raw rows stay `in_progress` | Next run: deduplication skips re-write; `verify-write` passes; `mark-processed` runs |
| `mark-processed` partially fails | Some rows `processed`, some `in_progress` | Next run: `in_progress` rows re-validated, deduplicated, `verify-write` passes, remaining rows marked |

In all cases, the system converges to a consistent state on the next run with no manual intervention.

---

## Concurrency Strategy

Google Sheets provides no atomic operations. Two concurrent runs can read the same `pending` rows and begin processing them simultaneously. The flow uses an **advisory `in_progress` marker** with post-claim verification to narrow the collision window and protect data integrity in all scenarios.

### How It Works

**Step 1 — Claim**: After identifying `pending` rows, the flow immediately writes `status = in_progress` to each of them.

**Step 2 — Verify claim**: The flow re-reads `raw_entries` after writing. It then retains only rows that are still `in_progress` AND whose `row_id` is in the set this run claimed. Rows that were concurrently claimed by another run (and have already been marked `processed` or `failed`) are excluded.

**Step 3 — Process claimed rows only**: All subsequent validation, deduplication, and write steps operate exclusively on `filter-claimed.claimedRows` — the verified-claimed subset.

### `in_progress` Lifecycle

| Stage | `status` value |
|-------|---------------|
| User submits row | `pending` |
| This run claims the row | `in_progress` (written by `claim-rows`) |
| Validation passes, ledger write confirmed | `processed` (written by `mark-processed`) |
| Validation fails | `failed` (written by `mark-failed`) |
| Run crashes before marking | Stays `in_progress` — recovered on next run |

### Orphan Recovery

A row stuck at `in_progress` from a crashed run is an **orphaned row**. Left unrecovered, it would never be processed.

`filter-pending` includes `in_progress` rows alongside `pending` rows. On the next run, orphaned rows re-enter the pipeline: `claim-rows` re-asserts `in_progress` on them, `filter-claimed` includes them, and processing continues normally. Their `reference_id` is stable (computed from `row_id`), so `deduplicate-valid` correctly skips any entries that did land in the ledger before the crash.

### Limitations

The `in_progress` marker is advisory — Google Sheets provides no compare-and-swap or atomic write. The collision window is not eliminated; it is narrowed:

| Scenario | Outcome |
|----------|---------|
| Two runs claim the same rows | Both proceed; both write `in_progress` (idempotent); both validate and call `write-valid` |
| `write-valid` races | Only one set of rows lands; the other is filtered by `deduplicate-valid` |
| `mark-processed` races | Both may mark the same row `processed` — the final state is `processed` either way (safe) |

**Data integrity is preserved in all overlap cases** because:
- `deduplicate-valid` prevents the same `reference_id` from being written twice
- `verify-write` confirms the ledger before any raw row is marked
- `mark-processed` is idempotent — writing `processed` twice produces the same result

The `in_progress` marker primarily protects against the common case: a scheduled run racing with a manual re-trigger. It does not prevent all concurrent processing in a high-frequency environment.

---

## Traceability

### `run_id`

Every row written to `validated_entries` carries a `run_id` column — a string identifying the flow execution that produced it.

**Format**: `` `run-${new Date().toISOString()}` `` — e.g., `run-2026-03-24T10:30:00.000Z`.

`run_id` encodes both a unique execution identifier and the wall-clock time the flow ran. It is generated once at the start of `write-valid`'s `input` function and applied to all write chunks in that operation — all rows written in a single `write-valid` call share the same `run_id`.

**Orchestrator injection**: If `ctx.state.runId` is set (by an external orchestrator), that value is used instead of generating a new one. This enables cross-flow traceability: when `validate-entries`, `compute-ledger-balances`, and `generate-financials` are all triggered by the same parent run with a shared `ctx.state.runId`, all three sheets receive the same `run_id`, forming a traceable chain from raw entry → validated entry → snapshot → financials row.

**Backward compatibility**: Existing rows in `validated_entries` without a `run_id` column are unaffected. No integrity check requires this field.

---

## Steps

---

### Step 1 — `read-raw`

**Type**: `storage`

**Condition**: none (always runs)

**Purpose**: Read all rows from the `raw_entries` sheet.

```ts
{
  id: 'read-raw',
  type: 'storage',
  input: (ctx) => ({
    provider: 'sheets',
    operation: 'read',
    resource: ctx.state.config.sheetId,
    options: {
      range: ctx.state.config.ranges.raw,
      batchSize: ctx.state.config.batchSize ?? 5000
    }
  })
}
```

**Output written to**: `ctx.outputs['read-raw']`

Expected shape:
```ts
{ rows: Array<{ row_id, date, type, amount, debit_account, credit_account, entity, notes, status, error_reason }> }
```

---

### Step 2 — `normalize-rows`

**Type**: `storage`

**Condition**: `Array.isArray(ctx.outputs?.['read-raw']?.rows)`

**Purpose**: Attach a `_rowIndex` to every row. Row index starts at 2 (header is row 1, data starts at row 2). This initial `_rowIndex` is used for the `claim-rows` step. Final updates use remapped indices from step 15.

```ts
{
  id: 'normalize-rows',
  type: 'storage',
  condition: (ctx) => Array.isArray(ctx.outputs?.['read-raw']?.rows),
  input: (ctx) => {
    const rows = ctx.outputs?.['read-raw']?.rows ?? [];
    return {
      rows: rows.map((r, i) => ({ ...r, _rowIndex: i + 2 }))
    };
  }
}
```

**Output written to**: `ctx.outputs['normalize-rows']`

Expected shape:
```ts
{ rows: Array<{ row_id, ...originalFields, _rowIndex: number }> }
```

---

### Step 3 — `filter-pending`

**Type**: `storage`

**Condition**: `!!ctx.outputs?.['normalize-rows']?.rows?.length`

**Purpose**: Keep rows where `status === 'pending'` OR `status === 'in_progress'` (case-insensitive). `pending` rows are new submissions awaiting processing. `in_progress` rows are orphans from a prior run that crashed before completion — they must be recovered on this run. Rows with any other status (`processed`, `failed`) are silently ignored.

```ts
{
  id: 'filter-pending',
  type: 'storage',
  condition: (ctx) => !!ctx.outputs?.['normalize-rows']?.rows?.length,
  input: (ctx) => {
    const rows = ctx.outputs?.['normalize-rows']?.rows ?? [];
    return {
      pendingRows: rows.filter(r => {
        const s = (r.status || '').toLowerCase();
        return s === 'pending' || s === 'in_progress';
      })
    };
  }
}
```

**Output written to**: `ctx.outputs['filter-pending']`

Expected shape:
```ts
{ pendingRows: Array<{ row_id, ...fields, _rowIndex: number }> }
```

---

### Step 4 — `claim-rows`

**Type**: `storage`

**Condition**: `!!ctx.outputs?.['filter-pending']?.pendingRows?.length`

**Purpose**: Write `status = in_progress` to every row in `filter-pending.pendingRows`. This marks the rows as claimed by this run before any other processing occurs. Rows already `in_progress` (orphans) receive the same write — idempotent and harmless.

The `_rowIndex` values used here come from `normalize-rows` (the initial read). They may become stale if the sheet is modified mid-run, but the claim writes are advisory — any index error produces a write to the wrong status cell, not a data loss. All final updates to `status` use remapped indices from step 15.

```ts
{
  id: 'claim-rows',
  type: 'storage',
  condition: (ctx) => !!ctx.outputs?.['filter-pending']?.pendingRows?.length,
  input: (ctx) => {
    const rows = ctx.outputs?.['filter-pending']?.pendingRows ?? [];
    return rows.map(r => ({
      provider: 'sheets',
      operation: 'update',
      resource: ctx.state.config.sheetId,
      data: ['in_progress', ''],
      options: { range: ctx.state.config.ranges.raw, rowIndex: r._rowIndex }
    }));
  }
}
```

**Output written to**: `ctx.outputs['claim-rows']`

---

### Step 5 — `re-read-after-claim`

**Type**: `storage`

**Condition**: `!!ctx.outputs?.['filter-pending']?.pendingRows?.length`

**Purpose**: Re-read `raw_entries` immediately after `claim-rows` writes. The fresh state reflects any concurrent modifications — including rows that another run may have already claimed, validated, and marked before this run's `claim-rows` write landed. The result is passed to `filter-claimed` for verification.

```ts
{
  id: 're-read-after-claim',
  type: 'storage',
  condition: (ctx) => !!ctx.outputs?.['filter-pending']?.pendingRows?.length,
  input: (ctx) => ({
    provider: 'sheets',
    operation: 'read',
    resource: ctx.state.config.sheetId,
    options: {
      range: ctx.state.config.ranges.raw,
      batchSize: ctx.state.config.batchSize ?? 5000
    }
  })
}
```

**Output written to**: `ctx.outputs['re-read-after-claim']`

Expected shape:
```ts
{ rows: Array<{ row_id, date, type, amount, debit_account, credit_account, entity, notes, status, error_reason }> }
```

---

### Step 6 — `filter-claimed`

**Type**: `storage`

**Condition**: `Array.isArray(ctx.outputs?.['re-read-after-claim']?.rows)`

**Purpose**: From the freshly re-read sheet, retain only rows whose `row_id` is in the set this run claimed AND whose current `status` is `in_progress`. Rows that another run has already marked `processed` or `failed` between our claim write and now are excluded. This prevents duplicate processing.

Fresh `_rowIndex` values are re-attached from the re-read (position `arrayIndex + 2`) so that `validate-rows` and later steps operate with up-to-date positions.

```ts
{
  id: 'filter-claimed',
  type: 'storage',
  condition: (ctx) => Array.isArray(ctx.outputs?.['re-read-after-claim']?.rows),
  input: (ctx) => {
    const claimedIds = new Set(
      (ctx.outputs?.['filter-pending']?.pendingRows ?? [])
        .map(r => r.row_id)
        .filter(Boolean)
    );
    const freshRows = ctx.outputs?.['re-read-after-claim']?.rows ?? [];

    const claimedRows = freshRows
      .map((r, i) => ({ ...r, _rowIndex: i + 2 }))
      .filter(r =>
        claimedIds.has(r.row_id) &&
        (r.status || '').toLowerCase() === 'in_progress'
      );

    return { claimedRows };
  }
}
```

**Output written to**: `ctx.outputs['filter-claimed']`

Expected shape:
```ts
{ claimedRows: Array<{ row_id, ...fields, _rowIndex: number }> }
```

---

### Step 7 — `normalize-fields`

**Type**: `storage`

**Condition**: `!!ctx.outputs?.['filter-claimed']?.claimedRows?.length`

**Purpose**: Apply field-level normalization to every claimed row before validation. Normalization rules:

| Field | Operation | Rationale |
|-------|-----------|-----------|
| `debit_account` | `trim()` + `toLowerCase()` | Removes surrounding whitespace; makes account comparison case-insensitive |
| `credit_account` | `trim()` + `toLowerCase()` | Same |
| `entity` | `trim()` | Removes surrounding whitespace; no case change — entity is a free-form label |

All other fields (`date`, `amount`, `row_id`, `_rowIndex`, etc.) are passed through unchanged.

```ts
{
  id: 'normalize-fields',
  type: 'storage',
  condition: (ctx) => !!ctx.outputs?.['filter-claimed']?.claimedRows?.length,
  input: (ctx) => {
    const rows = ctx.outputs?.['filter-claimed']?.claimedRows ?? [];
    return {
      normalizedRows: rows.map(r => ({
        ...r,
        debit_account:  (r.debit_account  || '').trim().toLowerCase(),
        credit_account: (r.credit_account || '').trim().toLowerCase(),
        entity:         (r.entity         || '').trim()
      }))
    };
  }
}
```

**Output written to**: `ctx.outputs['normalize-fields']`

Expected shape:
```ts
{ normalizedRows: Array<{ row_id, date, debit_account, credit_account, entity, amount, _rowIndex, ... }> }
```

Normalized values flow forward into `validate-rows` (validation) and `write-valid` (ledger writes) — the sheet always receives normalized data.

---

### Step 8 — `read-accounts`

**Type**: `storage`

**Condition**: `!!ctx.outputs?.['normalize-fields']?.normalizedRows?.length`

**Purpose**: Fetch the master account list so validation can confirm that `debit_account` and `credit_account` reference known accounts. Skipped if no normalized rows exist.

```ts
{
  id: 'read-accounts',
  type: 'storage',
  condition: (ctx) => !!ctx.outputs?.['normalize-fields']?.normalizedRows?.length,
  input: (ctx) => ({
    provider: 'sheets',
    operation: 'read',
    resource: ctx.state.config.sheetId,
    options: { range: ctx.state.config.ranges.accounts }
  })
}
```

**Output written to**: `ctx.outputs['read-accounts']`

Expected shape:
```ts
{ rows: Array<{ account_name: string, type: string }> }
```

---

### Step 9 — `validate-accounts`

**Type**: `storage`

**Condition**: `Array.isArray(ctx.outputs?.['read-accounts']?.rows)`

**Purpose**: Enforce accounts sheet integrity before any entry validation runs. Two rules are checked:

1. **`account_name` uniqueness** — duplicate names (compared after `trim().toLowerCase()`) indicate a misconfigured chart of accounts. Validation and account-existence checks would produce unpredictable results against a sheet with duplicate names.
2. **`type` validity** — each row's `type` must be exactly one of `asset`, `liability`, `income`, `expense`. Any other value is rejected; the engine does not have a defined behaviour for unknown types.

If either check fails, the step **throws an error** — the flow stops immediately and returns `{ ok: false }`. All downstream steps are skipped. No entries are validated or written.

Account names are normalized (`trim().toLowerCase()`) before the uniqueness check to catch duplicates caused by casing differences (`"Cash"` vs `"cash"`) or surrounding whitespace. Type values are normalized the same way before comparison.

```ts
{
  id: 'validate-accounts',
  type: 'storage',
  condition: (ctx) => Array.isArray(ctx.outputs?.['read-accounts']?.rows),
  input: (ctx) => {
    const rows = ctx.outputs?.['read-accounts']?.rows ?? [];
    const VALID_TYPES = new Set(['asset', 'liability', 'income', 'expense']);
    const errors = [];

    // Uniqueness check (case- and whitespace-insensitive)
    const seen = new Set();
    const duplicates = new Set();
    for (const r of rows) {
      const name = (r.account_name || '').trim().toLowerCase();
      if (!name) continue;
      if (seen.has(name)) {
        duplicates.add(name);
      } else {
        seen.add(name);
      }
    }
    if (duplicates.size > 0) {
      errors.push(`duplicate account_name values: ${[...duplicates].join(', ')}`);
    }

    // Type validity check
    const invalidTypeRows = rows.filter(r => !VALID_TYPES.has((r.type || '').trim().toLowerCase()));
    if (invalidTypeRows.length > 0) {
      const detail = invalidTypeRows.map(r => `"${r.account_name}": "${r.type}"`).join('; ');
      errors.push(`invalid type values — ${detail}`);
    }

    if (errors.length > 0) {
      throw new Error(`accounts sheet integrity check failed — ${errors.join(' | ')}`);
    }

    return { valid: true, accountCount: rows.length };
  }
}
```

**Output written to**: `ctx.outputs['validate-accounts']`

Expected shape (success only — throws on failure):
```ts
{ valid: true, accountCount: number }
```

**Failure format** (thrown error message):
```
accounts sheet integrity check failed — duplicate account_name values: cash | invalid type values — "Misc": "other"
```

---

### Step 10 — `validate-rows`

**Type**: `storage`

**Condition**: `!!ctx.outputs?.['normalize-fields']?.normalizedRows?.length`

**Purpose**: Apply all accounting validation rules to each normalized row. Produces two arrays: `valid` (entries ready for posting) and `invalid` (entries with error reasons). Generates a deterministic `reference_id` for valid entries using `row_id` instead of `_rowIndex`.

Account names from the `accounts` sheet are normalized with the same rules (`trim().toLowerCase()`) before comparison, so the lookup is consistent with the normalized entry fields.

**Validation Rules**:
- `date` must be present
- `date` must match `YYYY-MM-DD` format exactly (4-digit year, 2-digit month, 2-digit day)
- `date` must be a valid calendar date (month 1–12, day within the actual days of that month)
- `amount` must be present
- `amount` must consist of digits only, with at most one decimal point — no letters, commas, signs, or scientific notation (e.g. `"1k"`, `"1,000"`, `"1e3"` are rejected)
- `amount` must be greater than zero after parsing
- `debit_account` must be present
- `credit_account` must be present
- `debit_account` must not equal `credit_account` (no self-posting)
- `debit_account` must exist in the `accounts` sheet
- `credit_account` must exist in the `accounts` sheet

**`reference_id` generation** (deterministic, stable):
```
reference_id = `${date}-${amount}-${debit_account}-${credit_account}-${row_id}`
```

`debit_account` and `credit_account` in this formula are the **normalized** values (lowercased by `normalize-fields`). `amount` is the raw string as entered. `row_id` is used instead of `_rowIndex` so that `reference_id` remains identical across runs even if the row's position in the sheet changes.

```ts
{
  id: 'validate-rows',
  type: 'storage',
  condition: (ctx) => !!ctx.outputs?.['normalize-fields']?.normalizedRows?.length,
  input: (ctx) => {
    const rows = ctx.outputs?.['normalize-fields']?.normalizedRows ?? [];
    const accounts = (ctx.outputs?.['read-accounts']?.rows ?? [])
      .map(a => (a.account_name || '').trim().toLowerCase());

    const valid = [];
    const invalid = [];

    for (const r of rows) {
      const errors = [];

      // Date: must be present and a valid YYYY-MM-DD calendar date
      if (!r.date) {
        errors.push('missing_date');
      } else {
        const dateStr = String(r.date);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
          errors.push('invalid_date_format');
        } else {
          const [y, m, d] = dateStr.split('-').map(Number);
          const daysInMonth = new Date(y, m, 0).getDate();
          if (m < 1 || m > 12 || d < 1 || d > daysInMonth) {
            errors.push('invalid_date_format');
          }
        }
      }

      // Amount: digits only (optional decimal point), must parse to > 0
      const amtStr = String(r.amount || '').trim();
      if (!amtStr) {
        errors.push('invalid_amount');
      } else if (!/^\d+(\.\d+)?$/.test(amtStr)) {
        errors.push('invalid_amount');
      } else if (Number(amtStr) <= 0) {
        errors.push('invalid_amount');
      }

      if (!r.debit_account) errors.push('missing_debit');
      if (!r.credit_account) errors.push('missing_credit');
      if (r.debit_account === r.credit_account) errors.push('same_account');
      if (!accounts.includes(r.debit_account)) errors.push('invalid_debit_account');
      if (!accounts.includes(r.credit_account)) errors.push('invalid_credit_account');

      if (errors.length) {
        invalid.push({ ...r, error_reason: errors.join('|') });
      } else {
        const reference_id = `${r.date}-${r.amount}-${r.debit_account}-${r.credit_account}-${r.row_id}`;
        valid.push({ ...r, reference_id });
      }
    }

    return {
      valid,
      invalid,
      meta: {
        total: rows.length,
        valid_count: valid.length,
        invalid_count: invalid.length
      }
    };
  }
}
```

**Output written to**: `ctx.outputs['validate-rows']`

Expected shape:
```ts
{
  valid: Array<{ row_id, date, debit_account, credit_account, amount, entity, reference_id, _rowIndex, ... }>,
  invalid: Array<{ row_id, ...fields, _rowIndex: number, error_reason: string }>,
  meta: { total: number, valid_count: number, invalid_count: number }
}
```

---

### Step 11 — `read-existing-validated`

**Type**: `storage`

**Condition**: `!!ctx.outputs?.['validate-rows']?.valid?.length`

**Purpose**: Read all existing rows from `validated_entries` to collect the set of `reference_id` values already in the ledger. Skipped if there are no valid rows to check against.

```ts
{
  id: 'read-existing-validated',
  type: 'storage',
  condition: (ctx) => !!ctx.outputs?.['validate-rows']?.valid?.length,
  input: (ctx) => ({
    provider: 'sheets',
    operation: 'read',
    resource: ctx.state.config.sheetId,
    options: {
      range: ctx.state.config.ranges.validated,
      batchSize: ctx.state.config.batchSize ?? 5000
    }
  })
}
```

**Output written to**: `ctx.outputs['read-existing-validated']`

Expected shape:
```ts
{ rows: Array<{ date, debit_account, credit_account, amount, entity, reference_id }> }
```

> If `validated_entries` is empty (first-ever run), `rows` is `[]`. All valid rows are treated as new.

---

### Step 12 — `deduplicate-valid`

**Type**: `storage`

**Condition**: `!!ctx.outputs?.['validate-rows']?.valid?.length`

**Purpose**: Filter `validate-rows.valid` to exclude any entry whose `reference_id` already exists in `validated_entries`. Produces `newRows` — entries not yet in the ledger.

```ts
{
  id: 'deduplicate-valid',
  type: 'storage',
  condition: (ctx) => !!ctx.outputs?.['validate-rows']?.valid?.length,
  input: (ctx) => {
    const valid = ctx.outputs?.['validate-rows']?.valid ?? [];
    const existing = ctx.outputs?.['read-existing-validated']?.rows ?? [];
    const existingIds = new Set(existing.map(r => r.reference_id).filter(Boolean));

    return {
      newRows: valid.filter(r => !existingIds.has(r.reference_id))
    };
  }
}
```

**Output written to**: `ctx.outputs['deduplicate-valid']`

Expected shape:
```ts
{ newRows: Array<{ row_id, date, debit_account, credit_account, amount, entity, reference_id, _rowIndex, ... }> }
```

---

### Step 13 — `write-valid`

**Type**: `storage`

**Condition**: `!!ctx.outputs?.['deduplicate-valid']?.newRows?.length`

**Purpose**: Append only the deduplicated new entries to `validated_entries`. Rows with an existing `reference_id` are never written again.

**Columns written** (in order): `date`, `debit_account`, `credit_account`, `amount`, `entity`, `reference_id`, `run_id`

```ts
{
  id: 'write-valid',
  type: 'storage',
  condition: (ctx) => !!ctx.outputs?.['deduplicate-valid']?.newRows?.length,
  input: (ctx) => {
    const rows = ctx.outputs?.['deduplicate-valid']?.newRows ?? [];
    const BATCH_SIZE = ctx.state.config.batchSize ?? 5000;

    // run_id: use orchestrator-injected value if present; otherwise generate for this run.
    // Format: run-{ISO timestamp} — uniquely identifies this execution and encodes the time.
    const runId = ctx.state.runId ?? `run-${new Date().toISOString()}`;

    // Split into chunks — each chunk becomes one sequential write operation
    const operations = [];
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE);
      operations.push({
        provider: 'sheets',
        operation: 'write',
        resource: ctx.state.config.sheetId,
        data: chunk.map(r => [
          r.date,
          r.debit_account,
          r.credit_account,
          r.amount,
          r.entity,
          r.reference_id,
          runId
        ]),
        options: { range: ctx.state.config.ranges.validated }
      });
    }
    return operations;
  }
}
```

**Output written to**: `ctx.outputs['write-valid']`

---

### Step 14 — `re-read-validated-for-verify`

**Type**: `storage`

**Condition**: `!!ctx.outputs?.['deduplicate-valid']?.newRows?.length`

**Purpose**: Re-read `validated_entries` immediately after `write-valid` to capture the ledger's state post-write. Only runs if there were new rows to write — if `write-valid` was skipped, there is nothing to verify. The result is passed to `verify-write` for confirmation checking.

```ts
{
  id: 're-read-validated-for-verify',
  type: 'storage',
  condition: (ctx) => !!ctx.outputs?.['deduplicate-valid']?.newRows?.length,
  input: (ctx) => ({
    provider: 'sheets',
    operation: 'read',
    resource: ctx.state.config.sheetId,
    options: {
      range: ctx.state.config.ranges.validated,
      batchSize: ctx.state.config.batchSize ?? 5000
    }
  })
}
```

**Output written to**: `ctx.outputs['re-read-validated-for-verify']`

Expected shape:
```ts
{ rows: Array<{ date, debit_account, credit_account, amount, entity, reference_id }> }
```

---

### Step 15 — `verify-write`

**Type**: `storage`

**Condition**: `!!ctx.outputs?.['deduplicate-valid']?.newRows?.length`

**Purpose**: Confirm that every `reference_id` expected from `write-valid` is present in `validated_entries`. Produces `allWritten: boolean` and `missingIds: string[]`. `mark-processed` gates on `allWritten !== false` — if any expected entry is absent, `mark-processed` is blocked and raw rows remain `in_progress` for self-healing on the next run.

```ts
{
  id: 'verify-write',
  type: 'storage',
  condition: (ctx) => !!ctx.outputs?.['deduplicate-valid']?.newRows?.length,
  input: (ctx) => {
    const expected = ctx.outputs?.['deduplicate-valid']?.newRows ?? [];
    const written = ctx.outputs?.['re-read-validated-for-verify']?.rows ?? [];
    const writtenIds = new Set(written.map(r => r.reference_id).filter(Boolean));

    const missingIds = expected
      .map(r => r.reference_id)
      .filter(id => !writtenIds.has(id));

    return {
      allWritten: missingIds.length === 0,
      missingIds
    };
  }
}
```

**Output written to**: `ctx.outputs['verify-write']`

Expected shape:
```ts
{ allWritten: boolean, missingIds: string[] }
```

**Gate logic used by `mark-processed`**:
- `allWritten: true` → gate passes → `mark-processed` runs
- `allWritten: false` → gate blocks → `mark-processed` skipped → raw rows stay `in_progress`
- `verify-write` skipped (no new rows written) → `ctx.outputs['verify-write']` is `undefined` → `undefined !== false` is `true` → gate passes

---

### Step 16 — `re-read-raw-for-update`

**Type**: `storage`

**Condition**: `!!ctx.outputs?.['validate-rows']?.valid?.length || !!ctx.outputs?.['validate-rows']?.invalid?.length`

**Purpose**: Re-read `raw_entries` to obtain the sheet's current row positions immediately before issuing any updates. This fresh read reflects any insertions, deletions, or sorting that may have occurred after the initial `read-raw`. The result is used only for index remapping — not for re-processing entries.

```ts
{
  id: 're-read-raw-for-update',
  type: 'storage',
  condition: (ctx) => {
    const hasValid = !!ctx.outputs?.['validate-rows']?.valid?.length;
    const hasInvalid = !!ctx.outputs?.['validate-rows']?.invalid?.length;
    return hasValid || hasInvalid;
  },
  input: (ctx) => ({
    provider: 'sheets',
    operation: 'read',
    resource: ctx.state.config.sheetId,
    options: {
      range: ctx.state.config.ranges.raw,
      batchSize: ctx.state.config.batchSize ?? 5000
    }
  })
}
```

**Output written to**: `ctx.outputs['re-read-raw-for-update']`

Expected shape:
```ts
{ rows: Array<{ row_id, date, type, amount, debit_account, credit_account, entity, notes, status, error_reason }> }
```

---

### Step 17 — `remap-row-indices`

**Type**: `storage`

**Condition**: `Array.isArray(ctx.outputs?.['re-read-raw-for-update']?.rows)`

**Purpose**: Build a stable `row_id → current _rowIndex` map from the fresh sheet read. Apply this map to overwrite the `_rowIndex` on every valid and invalid row. The output arrays have the same entries as `validate-rows.valid` and `validate-rows.invalid`, but with `_rowIndex` reflecting the row's current sheet position rather than its position at the time of the initial read.

```ts
{
  id: 'remap-row-indices',
  type: 'storage',
  condition: (ctx) => Array.isArray(ctx.outputs?.['re-read-raw-for-update']?.rows),
  input: (ctx) => {
    const freshRows = ctx.outputs?.['re-read-raw-for-update']?.rows ?? [];

    // Build map: row_id → current position in sheet (header = row 1, data starts at row 2)
    const indexMap = {};
    for (let i = 0; i < freshRows.length; i++) {
      const rowId = freshRows[i].row_id;
      if (rowId) indexMap[rowId] = i + 2;
    }

    const valid = ctx.outputs?.['validate-rows']?.valid ?? [];
    const invalid = ctx.outputs?.['validate-rows']?.invalid ?? [];

    return {
      valid: valid.map(r => ({
        ...r,
        _rowIndex: indexMap[r.row_id] ?? r._rowIndex
      })),
      invalid: invalid.map(r => ({
        ...r,
        _rowIndex: indexMap[r.row_id] ?? r._rowIndex
      }))
    };
  }
}
```

**Output written to**: `ctx.outputs['remap-row-indices']`

Expected shape:
```ts
{
  valid: Array<{ row_id, ...fields, _rowIndex: number }>,   // _rowIndex = fresh position
  invalid: Array<{ row_id, ...fields, _rowIndex: number }>  // _rowIndex = fresh position
}
```

**Remapping logic**:
1. Iterate over the freshly read sheet rows, recording `row_id → arrayIndex + 2` for every row that has a non-falsy `row_id`.
2. For each valid and invalid row from `validate-rows`, replace `_rowIndex` with `indexMap[r.row_id]`.
3. If `row_id` is missing or not found in the fresh read, fall back to `r._rowIndex` (the position from `filter-claimed`). This fallback is **unsafe** — it exposes the same staleness risk as before the fix. Rows without `row_id` must be considered at-risk for incorrect updates.

---

### Step 18 — `mark-processed`

**Type**: `storage`

**Condition**: `ctx.outputs?.['verify-write']?.allWritten !== false && !!ctx.outputs?.['remap-row-indices']?.valid?.length`

**Purpose**: For each valid row — including duplicates — update `status` to `'processed'` and clear `error_reason` in `raw_entries` using the **fresh** `_rowIndex` from `remap-row-indices`. Gated on `verify-write.allWritten !== false` to ensure the ledger write was confirmed before any raw row is marked. A duplicate entry is still valid; marking it `processed` prevents it from re-entering the pipeline on the next run.

```ts
{
  id: 'mark-processed',
  type: 'storage',
  condition: (ctx) =>
    ctx.outputs?.['verify-write']?.allWritten !== false
    && !!ctx.outputs?.['remap-row-indices']?.valid?.length,
  input: (ctx) => {
    const rows = ctx.outputs?.['remap-row-indices']?.valid ?? [];
    return rows.map(r => ({
      provider: 'sheets',
      operation: 'update',
      resource: ctx.state.config.sheetId,
      data: ['processed', ''],
      options: { range: ctx.state.config.ranges.raw, rowIndex: r._rowIndex }
    }));
  }
}
```

**Output written to**: `ctx.outputs['mark-processed']`

> **Source**: `remap-row-indices.valid` — contains all valid rows (including duplicates) with fresh, stable `_rowIndex` values.

---

### Step 19 — `mark-failed`

**Type**: `storage`

**Condition**: `!!ctx.outputs?.['remap-row-indices']?.invalid?.length`

**Purpose**: For each invalid row, update `status` to `'failed'` and write the `error_reason` string back into `raw_entries` using the **fresh** `_rowIndex` from `remap-row-indices`.

```ts
{
  id: 'mark-failed',
  type: 'storage',
  condition: (ctx) => !!ctx.outputs?.['remap-row-indices']?.invalid?.length,
  input: (ctx) => {
    const rows = ctx.outputs?.['remap-row-indices']?.invalid ?? [];
    return rows.map(r => ({
      provider: 'sheets',
      operation: 'update',
      resource: ctx.state.config.sheetId,
      data: ['failed', r.error_reason],
      options: { range: ctx.state.config.ranges.raw, rowIndex: r._rowIndex }
    }));
  }
}
```

**Output written to**: `ctx.outputs['mark-failed']`

> **Source**: `remap-row-indices.invalid` — contains all invalid rows with fresh, stable `_rowIndex` values.

---

### Step 19 — `log-validation-metrics`

**Type**: `storage`

**Condition**: `!!ctx.outputs?.['validate-rows']?.meta`

**Purpose**: Append a single metrics row to `reconciliation_log` recording the counts from this run's validation pass. Runs unconditionally after `mark-failed` as long as `validate-rows` produced a `meta` object — i.e., it ran at all. Provides a persistent, queryable audit trail of validation volume per execution without modifying any existing sheet schema.

```ts
{
  id: 'log-validation-metrics',
  type: 'storage',
  condition: (ctx) => !!ctx.outputs?.['validate-rows']?.meta,
  input: (ctx) => {
    const m = ctx.outputs['validate-rows'].meta;
    return {
      provider: 'sheets',
      operation: 'write',
      resource: ctx.state.config.sheetId,
      data: [[
        Date.now(),
        'validation_metrics',
        'info',
        `total:${m.total}|valid:${m.valid_count}|invalid:${m.invalid_count}`
      ]],
      options: { range: ctx.state.config.ranges.reconciliation }
    };
  }
}
```

**Output written to**: `ctx.outputs['log-validation-metrics']`

Expected shape:
```ts
{ ok: true }
```

> The four columns written (`timestamp`, `issue_type`, `status`, `notes`) align with the existing `reconciliation_log` schema: `reference_id | issue_type | status | notes`. The `timestamp` (epoch ms) is written to the `reference_id` column — it serves as a unique identifier for this metrics row and distinguishes it from reconciliation entries (which use a `reference_id` from a validated entry).

---

## Guarantees

- `write-valid` always runs before `mark-processed`. A `write-valid` failure stops the flow — `mark-processed` never executes. "Marked but not written" cannot occur.
- `mark-processed` is gated on `verify-write.allWritten !== false`. If any expected ledger entry is missing after the write, `mark-processed` is skipped. Raw rows remain `in_progress` and self-heal on the next run via orphan recovery.
- "Written but not marked" is self-healing: on the next run, deduplication prevents re-writing, `verify-write` confirms the entries, and `mark-processed` runs to completion.
- Row updates always target the row's **current** sheet position, resolved immediately before writing.
- `row_id` is the stable identifier for a row across all runs. It does not change when the sheet is sorted, rows are inserted, or rows are deleted.
- `reference_id` is computed from `row_id` — it is stable across runs regardless of sheet structure changes.
- A `reference_id` is written to `validated_entries` at most once across all runs.
- Steps 13, 18, 19 are independent and each has its own condition guard.
- `validate-accounts` (step 9) runs before any entry validation. If the accounts sheet is invalid, the step throws and the flow fails immediately — no rows are validated, no ledger entries are written, no raw rows are marked.
- A row appears in exactly one of `valid` or `invalid` — never both.
- `mark-processed` and `mark-failed` may both run in the same execution if there are both valid and invalid rows.
- `mark-processed` covers all valid rows (including duplicates) to keep `raw_entries` clean.
- `write-valid` covers only `newRows` — entries not yet in the ledger.
- `mark-failed` has no dependency on `write-valid` or `verify-write` — invalid rows never touch the ledger and can be marked independently.
- All output access uses optional chaining — no step throws on missing prior output.
- Rows with a missing or empty `row_id` fall back to positional `_rowIndex` for updates. This fallback does not have the stability guarantee. Users must populate `row_id` for every row.
- `in_progress` is the new resting state for rows that are being processed. `pending` rows are only seen before their first claim.
- Orphaned `in_progress` rows (from a crashed run) re-enter the pipeline automatically on the next run without manual intervention.
