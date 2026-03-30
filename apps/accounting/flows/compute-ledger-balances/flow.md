# Flow: compute-ledger-balances

**Flow ID**: `compute-ledger-balances`

**Purpose**: Read all validated ledger entries, check them for structural corruption before computing, apply only entries added since the last snapshot as a delta on top of prior account balances, check whether a snapshot for today already exists, and write a dated snapshot to `snapshots_daily` — with a `snapshot_ref` traceability key and an `entry_count` watermark — only if none exists for the current date.

---

## Overview

```
read-existing-snapshots → check-snapshot-date → read-validated → check-validated-integrity → compute-balances → write-snapshot → prune-snapshots
```

---

## Delta Computation Strategy

### Problem with full recompute

The previous `compute-balances` step iterated over **all** rows in `validated_entries` on every run. For a ledger with thousands of entries, the cost grows linearly with total history — even when only a handful of new entries were added since the last run. The computation is redundant: the last snapshot already encodes the cumulative effect of every prior entry.

### Solution: apply only new entries as a delta

`validated_entries` is append-only. Every new entry is appended to the end; existing entries are never modified or reordered. This property allows delta computation:

```
final_balance[account] = prior_balance[account] + Σ (new entries only)
```

Where:
- `prior_balance` — the per-account balance map stored in the last snapshot
- "new entries" — rows appended to `validated_entries` after the last snapshot was taken

### Watermark: `entry_count`

To identify which entries are "new", the flow records the total number of `validated_entries` rows at snapshot time in a new `entry_count` column on `snapshots_daily`. All rows in a snapshot batch share the same `entry_count` value.

On the next run:
1. Read all `validated_entries` rows → `N` rows total
2. Read the last snapshot → extract `priorEntryCount` from any row's `entry_count` field
3. New entries = `rows.slice(priorEntryCount)` — the rows appended since the last snapshot
4. Start with `priorBalances` (the per-account balances from the last snapshot)
5. Apply only the new entries as deltas on top of `priorBalances`
6. Write the updated balances with `entry_count = N`

### Correctness

Full recompute and delta produce identical results because `validated_entries` is append-only and never reordered:

```
full:  balance = Σ rows[0..N-1]
delta: balance = Σ rows[0..priorEntryCount-1]  +  Σ rows[priorEntryCount..N-1]
               = priorBalance                   +  delta
```

The two expressions are equivalent. The integrity check (`check-validated-integrity`) enforces that no row has been deleted or duplicated, which is the precondition for this equivalence to hold.

### First run and backward compatibility

If `snapshots_daily` is empty (first-ever run), `priorEntryCount` defaults to `0` and `priorBalances` defaults to `{}`. The delta covers `rows.slice(0)` — all entries. This is identical to a full recompute.

If an older snapshot row lacks an `entry_count` value (written before this logic was introduced), `Number(row.entry_count) || 0` evaluates to `0` — same fallback, same full-recompute result. Backward compatibility is preserved without any migration.

### Step reordering

To make prior state available before computing, `read-existing-snapshots` and `check-snapshot-date` now run **before** `compute-balances`. `check-snapshot-date` is extended to extract `priorBalances` and `priorEntryCount` from the last snapshot in addition to deriving `today` and `alreadyExists`.

`compute-balances` also gains an early-exit condition: if `alreadyExists === true`, computation is skipped entirely — there is nothing to write, so there is no reason to compute.

---

## Snapshot Deduplication Strategy

### Problem

`write-snapshot` is an append operation. Running the flow more than once on the same calendar day appends a second set of rows with the same date. `generate-financials` selects only the latest snapshot date, so duplicate sets for the same day are silently ignored in computation — but they accumulate as dead rows in the sheet.

### Fix: Skip-if-today-exists

Before computing, the flow reads `snapshots_daily` and checks whether any row with today's ISO date already exists. If found, `compute-balances` and `write-snapshot` are both skipped. The date string resolved in `check-snapshot-date` is reused in `write-snapshot` to guarantee the check and the write operate on the same value.

### Why not overwrite

The storage module's `update` operation targets a row by `rowIndex`. Overwriting today's snapshot rows would require reading the sheet, finding which rows belong to today, recording their `rowIndex` values, and issuing one `update` per account. Since the delta computation produces the same result on any re-run of the same day (assuming no new entries were added after the first run), a skip is semantically equivalent to an overwrite.

### Partial write recovery

If `write-snapshot` appended some rows and then failed (partial write), today's date already appears in `snapshots_daily`. On the next run, `check-snapshot-date` detects the existing date and skips both computation and the write — the partial snapshot is not repaired automatically.

To recover: manually delete all rows in `snapshots_daily` where `date = today`, then re-run the flow.

---

## Fixed-Point Arithmetic

### Problem

JavaScript uses IEEE 754 double-precision floating point. Amounts like `0.10` have no exact binary representation:

```
Number("100.10") === 100.09999999999999  // true
0.1 + 0.2 === 0.30000000000000004        // true
```

In `compute-balances`, each entry's amount is parsed with `Number()` and added or subtracted from a running balance. Over thousands of entries, the rounding errors from each operation accumulate. A ledger with 50,000 entries could produce a balance that is several cents off from the true value — with no indication that anything is wrong.

### Solution: integer cents throughout

All monetary arithmetic uses integer cent values. One cent is the smallest unit; all amounts are exact integers at that granularity.

**Parsing amounts** — `toCents(str)` converts a validated amount string to integer cents using only string operations and integer arithmetic. No `parseFloat`, no `Number()` for the fractional part:

```ts
function toCents(amountStr) {
  const s = String(amountStr).trim();
  const dot = s.indexOf('.');
  if (dot === -1) return parseInt(s, 10) * 100;
  const whole = parseInt(s.slice(0, dot) || '0', 10);
  const frac  = s.slice(dot + 1).padEnd(2, '0').slice(0, 2);
  return whole * 100 + parseInt(frac, 10);
}
```

Examples: `"100.10"` → `10010`, `"1000"` → `100000`, `"99.9"` → `9990`. No floating point is involved.

**Seeding prior balances** — snapshot balances are stored as dollar amounts (e.g., `100.10`). Reading them back with `Math.round(Number(r.balance) * 100)` recovers the exact integer cent value. The floating point error in the stored float is always far smaller than 0.5 cents for any plausible monetary balance, so `Math.round` always rounds to the correct integer.

**Accumulation** — cent values are added and subtracted as integers. Integer arithmetic in JavaScript is exact for values within `Number.MAX_SAFE_INTEGER` (~9 quadrillion cents, or ~$90 trillion). No rounding errors accumulate.

**Writing back** — the final cent balance for each account is divided by `100` exactly once to produce a dollar amount for storage. One division introduces at most one rounding event per account per run — not per entry.

### Scope

Fixed-point arithmetic is applied in two steps: `check-snapshot-date` (prior balance seeding) and `compute-balances` (delta application). The `balance` column in `snapshots_daily` continues to store dollar amounts — no schema change is required. The `generate-financials` flow applies the same `toCents` pattern when reading snapshot balances for P&L computation.

---

## Batch Read Strategy

### Problem

`validated_entries` grows to ~100k rows over time. Reading the entire sheet on every run loads all 100k rows into memory, even though the delta task (`compute-balances`) then immediately discards all but the last few hundred via `rows.slice(priorEntryCount)`. Memory is consumed by rows that are never used.

### Solution: `startRow` partial read

`read-existing-snapshots` and `check-snapshot-date` now run **before** `read-validated`. This means `priorEntryCount` is known before the validated-entries read begins.

`read-validated` uses `priorEntryCount` to compute a `startRow`:

```
startRow = priorEntryCount + 2
          = (rows already snapshotted) + 1 (for 1-indexed sheet rows) + 1 (for header row)
```

The storage module uses `startRow` to construct a range that begins at that row — reading only the delta window. On a sheet with 100k rows and `priorEntryCount = 99800`, only 200 rows are fetched.

### `batchSize`

The `options` object also carries `batchSize` from `ctx.state.config.batchSize` (default `5000`). This instructs the storage provider to page through the range internally in chunks of at most `batchSize` rows. Even for the delta window, this caps the size of any single API response and prevents timeout on first-ever runs (where `priorEntryCount = 0` and all rows are new).

### First run

On first run, `priorEntryCount = 0` and `startRow = 2` — the read covers the entire sheet from the first data row. The `batchSize` paging hint limits individual API calls to `batchSize` rows. Correctness is identical to a full read.

### `compute-balances` simplification

Because `read-validated` already returns only new entries (starting at `priorEntryCount`), the `.slice(priorEntryCount)` operation previously in `compute-balances` is no longer needed. All rows in `read-validated.rows` are applied directly as deltas on top of `priorBalances`.

### `entry_count` in `write-snapshot`

`read-validated.rows.length` now equals the number of new entries, not the total. The total watermark for the next run is:

```
entry_count = priorEntryCount + read-validated.rows.length
```

---

## Retention Strategy

### Problem

`snapshots_daily` grows by one row per account per run. With ten accounts and daily execution, the sheet accumulates 3,650 rows per year. Over time this grows without bound, consuming sheet quota and slowing reads.

### Policy

Keep the **`retentionDays` most recent distinct snapshot dates**. All rows for any date outside that window are deleted. Default: `retentionDays = 90` (configurable via `ctx.state.config.retentionDays`).

A "distinct snapshot date" is a unique value in the `date` column. Each run writes one set of rows for the current date — so `retentionDays = 90` retains approximately 90 runs worth of history.

### Safety invariants

| Invariant | How enforced |
|-----------|-------------|
| Most recent snapshot is never pruned | `today` is always in `keepDates`; pruning only touches rows in `read-existing-snapshots` which were read before today's write |
| `entry_count` watermark is preserved | The most recent snapshot carries the watermark; it is never in the prune set |
| Pruning runs only after a successful write | `prune-snapshots` is conditioned on `!!ctx.outputs?.['write-snapshot']` |
| Re-run idempotency | If `write-snapshot` is skipped (today already exists), `prune-snapshots` is also skipped — no churn on same-day re-runs |

### `snapshot_ref` join integrity

`financials` rows reference `snapshots_daily` via `snapshot_ref`. To preserve join integrity within the retention window, both sheets should use the same `retentionDays` value. `generate-financials` prunes `financials` to the same limit. Rows older than the retention window are pruned from both sheets, so stale joins are not a concern within the live window.

### When pruning is skipped

| Condition | Behaviour |
|-----------|-----------|
| `write-snapshot` did not run (same-day re-run) | `prune-snapshots` is skipped |
| Unique date count ≤ `retentionDays` | Step returns `{ skipped: true }` — no storage call |
| No rows fall outside the retention window | Step returns `{ skipped: true }` — no storage call |

### `delete` operation contract

`prune-snapshots` returns a `delete` operation with `rowIndices` — the 1-indexed sheet row numbers of all rows to remove. The storage module is responsible for deleting these rows from bottom to top (highest index first) to prevent index shifting during deletion. The engine passes the descriptor to the storage module unchanged.

### Partial prune recovery

If the `delete` call partially succeeds (some rows removed, then failure), the surviving old rows remain in the sheet. On the next run, `prune-snapshots` will target those rows again via the same date-window logic. Pruning is idempotent — re-running after a partial failure produces the correct result without manual intervention.

---

## Recompute Mode

### Problem

By design, `compute-ledger-balances` skips computation when today's snapshot already exists (`alreadyExists = true`). This is correct for normal operation but blocks correction: if a snapshot contains incorrect data — due to a flow bug, a corrected entry in `validated_entries`, or manual repair — there is no way to regenerate it without the skip gate being overridden.

### Trigger

Set `ctx.state.config.recomputeFrom` to an ISO date string (`YYYY-MM-DD`). When present, the flow treats that date as the target for computation regardless of whether a snapshot for it already exists.

```ts
// ctx.state.config:
{
  recomputeFrom: '2026-03-20'   // recompute the snapshot for this specific date
}
```

### What changes in recompute mode

| Behaviour | Normal | Recompute |
|-----------|--------|-----------|
| `today` | `new Date()` wall clock | `recomputeFrom` config value |
| `alreadyExists` | `true` if date already in sheet | Always `false` — write proceeds unconditionally |
| Prior baseline | Latest snapshot by date | Latest-versioned snapshot for date < `recomputeFrom` |
| `read-validated` upper bound | Reads to end of sheet | Bounded to `targetEntryCount` from the existing snapshot (sealed range) |
| Old rows for target date | N/A | Preserved in sheet — new rows appended with fresh `run_id` |

### Sealed entry count

When recomputing a past date, the same ledger range that produced the original snapshot should be reprocessed. The original snapshot's `entry_count` watermark records exactly how many `validated_entries` rows existed when it was written. `check-snapshot-date` reads this value as `targetEntryCount` and passes it to `read-validated`, which uses it as `endRow` to bound the read.

If no prior snapshot exists for `recomputeFrom` (e.g., the sheet was cleared), `targetEntryCount` is `null` — `read-validated` reads to the current end of the sheet, producing a full rebuild.

### Version-aware prior selection

When multiple snapshot versions exist for a given date (original + recomputed), `check-snapshot-date` always picks the **latest `run_id`** for the prior date. `run_id` encodes an ISO timestamp — lexicographic max is the most recent execution. This ensures the prior baseline reflects the most recently corrected data, not a stale version.

### Auditability

Old snapshot rows for the recomputed date remain in `snapshots_daily` permanently. The new rows have a later `run_id`, which `check-snapshot-date` and `select-latest-snapshot` (in `generate-financials`) use to prefer the recomputed version. The original rows serve as an audit trail.

### Recomputing a date range

The flow runs once per invocation. To recompute a range of past dates (e.g., 2026-03-20 through 2026-03-24), run the flow once per date in ascending order. Each run's `entry_count` watermark in the recomputed snapshot serves as the prior baseline for the next date's recompute.

---

## Traceability

### `run_id`

Every row written to `snapshots_daily` carries a `run_id` column — a string identifying the flow execution that produced it.

**Format**: `` `run-${new Date().toISOString()}` `` — e.g., `run-2026-03-24T10:30:00.000Z`.

`run_id` encodes both a unique execution identifier and the wall-clock time the flow ran. It is generated once in `write-snapshot`'s `input` function and applied to all rows in that write batch — all account rows in a single snapshot write share the same `run_id`.

**Orchestrator injection**: If `ctx.state.runId` is set, that value is used instead of a freshly generated one. This allows an orchestrator to propagate a shared `run_id` across `validate-entries`, `compute-ledger-balances`, and `generate-financials`, making all three sheets traceable to the same parent execution.

**Backward compatibility**: Existing rows in `snapshots_daily` without a `run_id` column are unaffected. `check-snapshot-date` reads `priorBalances` and `priorEntryCount` from the latest snapshot rows — neither field requires `run_id`. `check-snapshot-integrity` (in `generate-financials`) does not validate `run_id`. Old rows pass all checks.

---

## Steps

---

### Step 1 — `read-existing-snapshots`

**Type**: `storage`

**Condition**: none (always runs)

**Purpose**: Read the current contents of `snapshots_daily`. Runs unconditionally — before `read-validated` — so that `check-snapshot-date` can extract `priorEntryCount` and `priorBalances` before the validated-entries read begins. This is what enables the targeted partial read in Step 3.

```ts
{
  id: 'read-existing-snapshots',
  type: 'storage',
  input: (ctx) => ({
    provider: 'sheets',
    operation: 'read',
    resource: ctx.state.config.sheetId,
    options: { range: ctx.state.config.ranges.snapshots }
  })
}
```

**Output written to**: `ctx.outputs['read-existing-snapshots']`

Expected shape:
```ts
{ rows: Array<{ date: string, account: string, balance: string, snapshot_ref: string, entry_count: string, run_id?: string }> }
```

> If `snapshots_daily` is empty (first-ever run), `rows` is `[]`. All prior-state values default to empty — `compute-balances` applies all entries, equivalent to a full recompute.

---

### Step 2 — `check-snapshot-date`

**Type**: `storage`

**Condition**: none (always runs)

**Purpose**: Determine the target date, check whether a snapshot for it already exists, extract the prior account balances and `entry_count` watermark, and (in recompute mode) extract the sealed `targetEntryCount` from the existing snapshot. Produces all state needed by `read-validated` before that step begins.

In normal mode, `today` is the current wall-clock date. In recompute mode (`ctx.state.config.recomputeFrom` is set), `today` is the configured recompute date and `alreadyExists` is forced to `false` — computation proceeds unconditionally.

Prior state is selected **version-aware**: among all snapshot rows for the prior date, only those with the latest `run_id` are used. ISO timestamp strings in `run_id` are lexicographically ordered — the latest is the most recently written version.

```ts
{
  id: 'check-snapshot-date',
  type: 'storage',
  input: (ctx) => {
    const existing = ctx.outputs?.['read-existing-snapshots']?.rows ?? [];

    // Recompute mode: use the configured date; otherwise use wall clock
    const recomputeFrom = ctx.state.config.recomputeFrom ?? null;
    const today = recomputeFrom ?? new Date().toISOString().split('T')[0];
    const forceRecompute = !!recomputeFrom;

    // In recompute mode alreadyExists is forced false — write always proceeds
    const alreadyExists = forceRecompute ? false : existing.some(r => r.date === today);

    // --- Prior snapshot selection (version-aware) ---
    // Prior rows = those strictly before today's target date
    const priorRows = existing.filter(r => r.date < today);
    const latestPriorDate = priorRows.reduce((max, r) => (r.date > max ? r.date : max), '');
    const rowsForPriorDate = priorRows.filter(r => r.date === latestPriorDate);

    // Among rows for the prior date, pick only the latest run_id (most recent version)
    const latestPriorRunId = rowsForPriorDate
      .reduce((max, r) => ((r.run_id ?? '') > max ? (r.run_id ?? '') : max), '');
    const latestPriorRows = latestPriorRunId
      ? rowsForPriorDate.filter(r => (r.run_id ?? '') === latestPriorRunId)
      : rowsForPriorDate;

    // Extract prior balances as integer cents
    const priorBalances = {};
    for (const r of latestPriorRows) {
      priorBalances[r.account] = Math.round(Number(r.balance || 0) * 100);
    }

    // Extract delta watermark — fall back to 0 if absent (full recompute)
    const priorEntryCount = latestPriorRows.length > 0
      ? (Number(latestPriorRows[0].entry_count) || 0)
      : 0;

    // --- Sealed entry count (recompute mode only) ---
    // Find the existing snapshot for the target date (if any) to recover its sealed entry_count.
    // This bounds the read to the same ledger range that produced the original snapshot.
    let targetEntryCount = null;
    if (forceRecompute) {
      const existingTargetRows = existing.filter(r => r.date === today);
      if (existingTargetRows.length > 0) {
        // Pick the latest-versioned snapshot for the target date
        const latestTargetRunId = existingTargetRows
          .reduce((max, r) => ((r.run_id ?? '') > max ? (r.run_id ?? '') : max), '');
        const latestTargetRows = latestTargetRunId
          ? existingTargetRows.filter(r => (r.run_id ?? '') === latestTargetRunId)
          : existingTargetRows;
        const rawCount = Number(latestTargetRows[0]?.entry_count);
        targetEntryCount = isFinite(rawCount) && rawCount > 0 ? rawCount : null;
      }
      // If null: no existing snapshot for this date → read to current sheet end (full rebuild)
    }

    return { today, alreadyExists, priorBalances, priorEntryCount, forceRecompute, targetEntryCount };
  }
}
```

**Output written to**: `ctx.outputs['check-snapshot-date']`

Expected shape:
```ts
{
  today: string,             // target date — wall clock or recomputeFrom
  alreadyExists: boolean,    // false in recompute mode; true if snapshot already written today in normal mode
  priorBalances: Record<string, number>,  // integer cents from the latest-versioned prior snapshot
  priorEntryCount: number,   // entry_count watermark from the prior snapshot; 0 if absent
  forceRecompute: boolean,   // true when recomputeFrom is set
  targetEntryCount: number | null  // sealed entry count from existing target snapshot; null = read to end
}
```

**Logic**:
- `today` — `recomputeFrom` if set; otherwise `new Date().toISOString().split('T')[0]`
- `alreadyExists` — forced `false` in recompute mode; otherwise `true` if any existing row matches `today`
- `priorBalances` — integer cent balance map from the **latest-versioned** snapshot for the date strictly before `today`; `{}` if none exists
- `priorEntryCount` — `entry_count` from the latest-versioned prior snapshot; `0` if absent (triggers full read)
- `forceRecompute` — signals downstream steps that recompute mode is active
- `targetEntryCount` — in recompute mode: `entry_count` from the latest-versioned existing snapshot for `today`; `null` if no such snapshot exists

---

### Step 3 — `read-validated`

**Type**: `storage`

**Condition**: `ctx.outputs?.['check-snapshot-date']?.alreadyExists !== true`

**Purpose**: Read only the validated entries in scope for this run. In normal mode, reads from `priorEntryCount + 2` to the end of the sheet (the delta since the last snapshot). In recompute mode, additionally bounds the read at `endRow = targetEntryCount + 1` — the sealed upper boundary from the existing snapshot — so the same ledger range is reprocessed.

`startRow = priorEntryCount + 2` — row 1 is the header; data row N occupies sheet row N+1. `endRow = targetEntryCount + 1` in recompute mode (absent in normal mode = read to end).

The `batchSize` hint instructs the storage provider to page through the range in chunks of at most `batchSize` rows per API call, preventing timeout on large windows.

```ts
{
  id: 'read-validated',
  type: 'storage',
  condition: (ctx) => ctx.outputs?.['check-snapshot-date']?.alreadyExists !== true,
  input: (ctx) => {
    const { priorEntryCount = 0, targetEntryCount = null } =
      ctx.outputs?.['check-snapshot-date'] ?? {};

    const startRow = priorEntryCount + 2; // +1 for 1-indexing, +1 for header row

    // In recompute mode, bound the read at the sealed entry count from the original snapshot.
    // endRow is the sheet row number of the last entry to read: entry #N is at sheet row N+1.
    // If targetEntryCount is null (no existing snapshot), read to end of sheet.
    const endRow = targetEntryCount != null ? targetEntryCount + 1 : undefined;

    return {
      provider: 'sheets',
      operation: 'read',
      resource: ctx.state.config.sheetId,
      options: {
        range: ctx.state.config.ranges.validated,
        startRow,
        ...(endRow != null ? { endRow } : {}),
        batchSize: ctx.state.config.batchSize ?? 5000
      }
    };
  }
}
```

**Output written to**: `ctx.outputs['read-validated']`

Expected shape:
```ts
{ rows: Array<{ date, debit_account, credit_account, amount, entity, reference_id }> }
```

> In normal mode, `rows` contains only entries added after the last snapshot — the delta. In recompute mode, `rows` contains entries in the range `[priorEntryCount+1, targetEntryCount]` — the exact window processed by the original snapshot. If `targetEntryCount` equals `priorEntryCount`, `rows` is `[]` (no entries in that window).

---

### Step 4 — `check-validated-integrity`

**Type**: `storage`

**Condition**: `!!ctx.outputs?.['read-validated']?.rows?.length`

**Purpose**: Inspect the new validated entries for signs of manual corruption before any balance computation runs. If any violation is found, the step **throws an error** — the flow stops and no snapshot is written.

This step validates only the new rows returned by `read-validated`. Old rows were already validated when originally written by `validate-entries` — re-checking them on every run is unnecessary and would require reading the full sheet.

`validated_entries` is engine-owned and append-only. Any row that violates the structural invariants established by `validate-entries` was either injected manually or produced by a bug in an earlier flow. Computing balances from a corrupted ledger would silently propagate incorrect figures into `snapshots_daily` and downstream financials.

**Checks performed**:

| Check | Condition | Violation |
|-------|-----------|-----------|
| Required fields | `reference_id`, `date`, `debit_account`, `credit_account`, `amount` all non-empty | Missing fields indicate a manually added row that bypassed the flow |
| `reference_id` uniqueness | No two rows in the new batch share the same `reference_id` | Duplicate within the new window indicates a copy-paste or injection |
| `amount` validity | Matches `/^\d+(\.\d+)?$/` and parses to > 0 | Manually altered amount |
| `date` validity | Matches `YYYY-MM-DD` and is a valid calendar date | Manually altered date |
| No self-posting | `debit_account !== credit_account` | Row violates double-entry rules |

All checks run over all new rows before returning — the error message contains all violations, not just the first.

```ts
{
  id: 'check-validated-integrity',
  type: 'storage',
  condition: (ctx) => !!ctx.outputs?.['read-validated']?.rows?.length,
  input: (ctx) => {
    const rows = ctx.outputs?.['read-validated']?.rows ?? [];
    const violations = [];

    // 1. Required field presence
    const missingFields = rows.filter(r =>
      !r.reference_id || !r.date || !r.debit_account || !r.credit_account || !r.amount
    );
    if (missingFields.length > 0) {
      violations.push(`${missingFields.length} row(s) missing required fields`);
    }

    // 2. reference_id uniqueness within the new batch
    const seen = new Set();
    const duplicates = new Set();
    for (const r of rows) {
      const id = r.reference_id;
      if (!id) continue;
      if (seen.has(id)) duplicates.add(id);
      else seen.add(id);
    }
    if (duplicates.size > 0) {
      violations.push(`duplicate reference_id values: ${[...duplicates].join(', ')}`);
    }

    // 3. Amount validity (positive decimal string)
    const invalidAmounts = rows.filter(r => {
      const amtStr = String(r.amount || '').trim();
      return !amtStr || !/^\d+(\.\d+)?$/.test(amtStr) || Number(amtStr) <= 0;
    });
    if (invalidAmounts.length > 0) {
      violations.push(`${invalidAmounts.length} row(s) with invalid amount`);
    }

    // 4. Date validity (ISO YYYY-MM-DD with calendar check)
    const invalidDates = rows.filter(r => {
      const dateStr = String(r.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return true;
      const [y, m, d] = dateStr.split('-').map(Number);
      const daysInMonth = new Date(y, m, 0).getDate();
      return m < 1 || m > 12 || d < 1 || d > daysInMonth;
    });
    if (invalidDates.length > 0) {
      violations.push(`${invalidDates.length} row(s) with invalid date`);
    }

    // 5. Self-posting check
    const selfPosting = rows.filter(r =>
      r.debit_account && r.credit_account && r.debit_account === r.credit_account
    );
    if (selfPosting.length > 0) {
      violations.push(`${selfPosting.length} self-posting row(s) (debit_account === credit_account)`);
    }

    if (violations.length > 0) {
      throw new Error(`validated_entries integrity check failed — ${violations.join(' | ')}`);
    }

    return { valid: true, rowCount: rows.length };
  }
}
```

**Output written to**: `ctx.outputs['check-validated-integrity']`

Expected shape (success only — throws on failure):
```ts
{ valid: true, rowCount: number }
```

---

### Step 5 — `compute-balances`

**Type**: `storage`

**Condition**: `!!ctx.outputs?.['read-validated']?.rows?.length && ctx.outputs?.['check-snapshot-date']?.alreadyExists !== true`

**Purpose**: Compute current account balances by applying new validated entries as integer cent deltas on top of prior snapshot cent balances, then converting to dollar amounts for storage.

Because `read-validated` already returns only entries added after the last snapshot (using `startRow`), no slice operation is needed — all rows in `read-validated.rows` are new entries. The starting point is `priorBalances` (in cents) from `check-snapshot-date`.

In double-entry accounting:
- The **debit account** receives a positive delta (`+amtCents`)
- The **credit account** receives a negative delta (`−amtCents`)

Amounts are parsed from their string representation using `toCents()` — a pure string-and-integer function that produces exact cent values with no floating point arithmetic. Accumulation is integer addition and subtraction, which is exact. Dollar amounts are produced from cents exactly once per account at return time via `cents / 100`.

If no prior snapshot exists (`priorBalances === {}`), the delta is applied to empty starting balances — equivalent to a full recompute.

The `alreadyExists !== true` condition also appears on `read-validated` — `compute-balances` inherits this gate via the `!!read-validated.rows.length` condition (no rows means no computation).

```ts
{
  id: 'compute-balances',
  type: 'storage',
  condition: (ctx) =>
    !!ctx.outputs?.['read-validated']?.rows?.length
    && ctx.outputs?.['check-snapshot-date']?.alreadyExists !== true,
  input: (ctx) => {
    const rows = ctx.outputs?.['read-validated']?.rows ?? [];
    const { priorBalances } = ctx.outputs?.['check-snapshot-date'] ?? {};

    // toCents: parse a validated amount string to integer cents without floating point.
    // Works directly on the string — no Number() on the fractional part.
    // Assumes at most 2 decimal places (standard accounting precision).
    function toCents(amountStr) {
      const s = String(amountStr).trim();
      const dot = s.indexOf('.');
      if (dot === -1) return parseInt(s, 10) * 100;
      const whole = parseInt(s.slice(0, dot) || '0', 10);
      const frac  = s.slice(dot + 1).padEnd(2, '0').slice(0, 2);
      return whole * 100 + parseInt(frac, 10);
    }

    // Seed cent balances from the prior snapshot (already in cents from check-snapshot-date)
    const balancesCents = {};
    for (const [acct, cents] of Object.entries(priorBalances ?? {})) {
      balancesCents[acct] = cents;
    }

    // Apply new entries as integer cent deltas — no floating point accumulation
    for (const r of rows) {
      const amtCents = toCents(r.amount);
      balancesCents[r.debit_account]  = (balancesCents[r.debit_account]  || 0) + amtCents;
      balancesCents[r.credit_account] = (balancesCents[r.credit_account] || 0) - amtCents;
    }

    // Convert back to dollar amounts exactly once per account before writing
    return {
      rows: Object.entries(balancesCents).map(([account, cents]) => ({
        account,
        balance: cents / 100
      }))
    };
  }
}
```

**Output written to**: `ctx.outputs['compute-balances']`

Expected shape:
```ts
{ rows: Array<{ account: string, balance: number }> }
```

---

### Step 6 — `write-snapshot`

**Type**: `storage`

**Condition**: `!!ctx.outputs?.['compute-balances']?.rows?.length && !!ctx.outputs?.['check-snapshot-date']?.today && ctx.outputs?.['check-snapshot-date']?.alreadyExists !== true`

**Purpose**: Append one row per account to `snapshots_daily`, tagged with `today`, a deterministic `snapshot_ref`, and the `entry_count` watermark. This step is **skipped** if today's date is already present in the sheet. When it runs, it is the only write to `snapshots_daily` for the current date.

`snapshot_ref` is `snapshot-{date}` — a stable, human-readable key that uniquely identifies this snapshot set and allows `financials` rows to join back to their source.

`entry_count` is the total number of rows in `validated_entries` at the time of this write. All rows in the batch carry the same value. On the next run, `check-snapshot-date` reads this value as the delta watermark to determine which entries are new.

**Columns written** (in order): `date`, `account`, `balance`, `snapshot_ref`, `entry_count`, `run_id`

```ts
{
  id: 'write-snapshot',
  type: 'storage',
  condition: (ctx) =>
    !!ctx.outputs?.['compute-balances']?.rows?.length
    && !!ctx.outputs?.['check-snapshot-date']?.today
    && ctx.outputs?.['check-snapshot-date']?.alreadyExists !== true,
  input: (ctx) => {
    const rows = ctx.outputs?.['compute-balances']?.rows ?? [];
    const date = ctx.outputs['check-snapshot-date'].today;
    const snapshotRef = `snapshot-${date}`;
    const priorEntryCount = ctx.outputs['check-snapshot-date'].priorEntryCount ?? 0;
    const entryCount = priorEntryCount + ctx.outputs['read-validated'].rows.length;

    // run_id: use orchestrator-injected value if present; otherwise generate for this run.
    // Format: run-{ISO timestamp} — uniquely identifies this execution and encodes the time.
    const runId = ctx.state.runId ?? `run-${new Date().toISOString()}`;

    return {
      provider: 'sheets',
      operation: 'write',
      resource: ctx.state.config.sheetId,
      data: rows.map(r => [date, r.account, r.balance, snapshotRef, entryCount, runId]),
      options: { range: ctx.state.config.ranges.snapshots }
    };
  }
}
```

**Output written to**: `ctx.outputs['write-snapshot']`

> **`entry_count` sourcing**: Computed as `priorEntryCount + read-validated.rows.length`. `priorEntryCount` is the watermark from the last snapshot (rows already accounted for). `read-validated.rows.length` is the count of new rows processed in this run. Their sum is the total entry count in `validated_entries` as of this write — the correct watermark for the next run.

> **Date sourcing**: `date` is read directly from `ctx.outputs['check-snapshot-date'].today` without a fallback. The condition `!!ctx.outputs?.['check-snapshot-date']?.today` explicitly guarantees this value is present before the step executes.

> **`snapshot_ref`**: Derived inline as `` `snapshot-${date}` ``. Every row in this write batch carries the same value — exact-match filter on `snapshot_ref` retrieves the full snapshot set.

> **`run_id`**: Generated once in this step as `` `run-${new Date().toISOString()}` ``, or taken from `ctx.state.runId` if an orchestrator injected a shared value. All rows in the snapshot batch carry the same `run_id`. When a common `run_id` is propagated across all three flows, this value links each snapshot row to the `generate-financials` run that consumed it and the `validate-entries` run that produced the ledger entries beneath it.

> **`alreadyExists !== true`**: Handles `alreadyExists: false` (no snapshot → write runs) and `alreadyExists: true` (snapshot exists → write skipped). The `compute-balances` condition already enforces this same gate, so `write-snapshot` cannot run when computation was skipped.

---

### Step 7 — `prune-snapshots`

**Type**: `storage`

**Condition**: `!!ctx.outputs?.['write-snapshot']`

**Purpose**: Remove snapshot rows for dates outside the configured retention window. Runs only when `write-snapshot` executed successfully this run — if today's snapshot already existed (same-day re-run), this step is skipped alongside `write-snapshot`. Uses `read-existing-snapshots.rows` (read before the write) to derive row indices without re-reading the sheet.

`retentionDays` controls how many distinct snapshot dates are retained. All rows for dates beyond the cutoff are deleted in a single `delete` call. Today's rows (just written) are always preserved — they are in `keepDates` as the most recent date and were not present in `read-existing-snapshots` (since `alreadyExists` was `false` when `write-snapshot` ran).

**Row index derivation**: `read-existing-snapshots.rows[i]` occupies sheet row `i + 2` (header is row 1). Since only rows from `read-existing-snapshots` are targeted (never the just-written rows at the end of the sheet), these indices are stable at prune time.

```ts
{
  id: 'prune-snapshots',
  type: 'storage',
  condition: (ctx) => !!ctx.outputs?.['write-snapshot'],
  input: (ctx) => {
    const retentionDays = ctx.state.config.retentionDays ?? 90;
    const existingRows = ctx.outputs['read-existing-snapshots'].rows ?? [];
    const today = ctx.outputs['check-snapshot-date'].today;

    // Collect all distinct dates: existing rows + today (just written, not in existingRows)
    // write-snapshot ran → alreadyExists was false → today is new
    const existingDates = [...new Set(existingRows.map(r => r.date))];
    const allDates = [...existingDates, today];
    allDates.sort((a, b) => b.localeCompare(a)); // descending — most recent first

    // Within retention window — nothing to do
    if (allDates.length <= retentionDays) {
      return {
        skipped: true,
        reason: `${allDates.length} distinct date(s) within retention window of ${retentionDays}`
      };
    }

    // Keep only the retentionDays most recent dates
    const keepDates = new Set(allDates.slice(0, retentionDays));

    // Find rows in existingRows that belong to prunable dates
    // today's rows are not in existingRows — they cannot be targeted here
    const rowsToDelete = existingRows
      .map((r, i) => ({ rowIndex: i + 2, date: r.date }))
      .filter(({ date }) => !keepDates.has(date));

    if (rowsToDelete.length === 0) {
      return {
        skipped: true,
        reason: 'no rows outside retention window in pre-write snapshot data'
      };
    }

    return {
      provider: 'sheets',
      operation: 'delete',
      resource: ctx.state.config.sheetId,
      rowIndices: rowsToDelete.map(r => r.rowIndex),
      options: { range: ctx.state.config.ranges.snapshots }
      // Storage module must delete rows from highest index to lowest to prevent index shift
    };
  }
}
```

**Output written to**: `ctx.outputs['prune-snapshots']`

Expected shape (pruning ran):
```ts
{ pruned: number, remaining: number }
```

Expected shape (pruning skipped):
```ts
{ skipped: true, reason: string }
```

---

## Guarantees

- `read-existing-snapshots` and `check-snapshot-date` run unconditionally — `priorEntryCount` is always available before `read-validated` executes.
- In recompute mode (`ctx.state.config.recomputeFrom` is set), `check-snapshot-date` overrides `today` and forces `alreadyExists = false`. `read-validated` bounds its read to `targetEntryCount` (the sealed count from the existing snapshot), ensuring the same ledger window is reprocessed. Old snapshot rows for the target date are preserved; new rows with a fresh `run_id` are appended.
- Prior baseline selection is version-aware: among multiple snapshot sets for the same prior date, `check-snapshot-date` selects only the rows with the latest `run_id`, ensuring corrections propagate correctly through chains of recomputes.
- `read-validated` reads only the delta window starting at `priorEntryCount + 2`. On a 100k-row sheet with 99,800 already snapshotted entries, only 200 rows are fetched. Memory usage scales with the size of the delta, not the total ledger.
- `check-validated-integrity` runs before balance computation and validates only new rows. Old rows were already checked when written by `validate-entries`.
- Delta computation produces the same result as a full recompute, provided `validated_entries` is append-only and entries are never reordered — a property the integrity check enforces via duplicate `reference_id` detection within the new batch.
- On first run or when `entry_count` is absent from the last snapshot, `priorEntryCount` defaults to `0` — `startRow = 2`, the entire sheet is read, equivalent to a full recompute.
- Both `read-validated` and `compute-balances` are skipped entirely when today's snapshot already exists — no read, no computation on re-runs of the same day.
- At most one set of snapshot rows is written per calendar date.
- The `date` value written to the sheet is the same string evaluated in `check-snapshot-date` — no clock drift between the check and the write.
- `snapshot_ref` is derived deterministically from `date` — `` `snapshot-${date}` ``. All rows in a given write batch carry the same value.
- `entry_count` is computed as `priorEntryCount + read-validated.rows.length` — the total number of entries in `validated_entries` as of this run. This is the correct watermark for the next run's `startRow` derivation.
- `financials` rows link back to their source snapshot set via `snapshot_ref` — exact-match filter on `snapshots_daily.snapshot_ref`.
- If `validated_entries` is empty (first-ever run, no entries yet), `read-validated` returns `[]`, and all steps from `check-validated-integrity` onward are skipped.
- No sheet formulas are used — all arithmetic happens in `compute-balances`.
- All monetary accumulation uses integer cent arithmetic. `toCents()` parses amount strings without floating point. `Math.round(float * 100)` recovers exact cents from stored dollar values. Each account's final balance is divided by `100` exactly once — one rounding event per account per run, not per entry.
- Partial write recovery requires manual deletion of the partial rows for the affected date.
- After a successful `write-snapshot`, `prune-snapshots` removes all snapshot rows for dates outside the `retentionDays` window. The most recent snapshot date (just written) is always preserved. If pruning is not needed (date count ≤ `retentionDays`), the step returns `{ skipped: true }` and no storage call is made.
- Every written row carries a `run_id` encoding the execution identity and timestamp. All rows in a snapshot batch share the same value. If `ctx.state.runId` is provided by an orchestrator, the same value appears in `validated_entries`, `snapshots_daily`, and `financials` — forming a traceable chain across all three sheets for that run.
