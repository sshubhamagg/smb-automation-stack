# Flow: generate-financials

**Flow ID**: `generate-financials`

**Purpose**: Read account balance snapshots, check them for structural corruption before computing, select only the latest snapshot date, classify each account by type using the master accounts list, compute total revenue, total expenses, and net profit from the latest balances only, then write a dated P&L row — with a `snapshot_ref` traceability key — to the `financials` sheet.

---

## Overview

```
read-snapshots → check-snapshot-integrity → read-accounts → validate-accounts → select-latest-snapshot → compute-financials → write-financials → read-financials-for-prune → prune-financials
```

---

## Snapshot Selection Strategy

### Problem

`snapshots_daily` is an append-only sheet. Each run of `compute-ledger-balances` adds one row per account for the current date. Over time the sheet accumulates rows across many dates:

```
| date       | account   | balance |
|------------|-----------|---------|
| 2026-03-22 | Cash      | 400     |
| 2026-03-22 | Revenue   | -800    |
| 2026-03-23 | Cash      | 500     |
| 2026-03-23 | Revenue   | -900    |
| 2026-03-24 | Cash      | 600     |
| 2026-03-24 | Revenue   | -1000   |
```

The original `compute-financials` step iterated over **all** rows and summed all balances. With three days of history this produces figures 3× too large. With 30 days, 30×.

### Fix: Select latest snapshot date before computing

A new step — `select-latest-snapshot` — runs after `read-snapshots` and before `compute-financials`. It:

1. Scans all snapshot rows and finds the **maximum `date` string**. ISO dates (`YYYY-MM-DD`) sort lexicographically, so string comparison is exact — no date parsing required.
2. Filters all rows to only those whose `date` matches the maximum.
3. Emits `{ latestDate, rows }` — the single-date slice used for all downstream computation.

`compute-financials` and `write-financials` both consume `select-latest-snapshot` output. The P&L record is tagged with `latestDate` (the snapshot date), not `new Date()` — so the financials row describes the period the data represents, not the clock time the flow ran.

---

## Fixed-Point Arithmetic

### Problem

Snapshot balances are stored as dollar amounts (e.g., `100.10`). Reading them with `Number(s.balance)` produces an IEEE 754 float that may not equal the true value:

```
Number("100.10") === 100.09999999999999  // true
```

Summing many such floats into `revenue` or `expenses` accumulates rounding errors. The computed P&L figures may differ from the mathematically correct result by several cents or more, with no visible indication of the discrepancy.

### Solution: `toCents` + integer summation

`compute-financials` converts each snapshot balance to integer cents before summing. Summation is performed entirely in integers (exact). Dollar amounts for `revenue`, `expenses`, and `profit` are produced by dividing the final cent totals by `100` — one division per P&L field, not one per snapshot row.

**`toCents(str)`** — a pure string-and-integer function defined locally in `compute-financials`:

```ts
function toCents(balanceStr) {
  const s = String(balanceStr).trim();
  const dot = s.indexOf('.');
  if (dot === -1) return parseInt(s, 10) * 100;
  const whole = parseInt(s.slice(0, dot) || '0', 10);
  const frac  = s.slice(dot + 1).padEnd(2, '0').slice(0, 2);
  return whole * 100 + parseInt(frac, 10);
}
```

**Reading stored floats**: snapshot balances may have been written as floating point values (e.g., `100.09999999999999`). `toCents` operates on the string representation returned by the sheet. If the storage provider returns the value as a float that has been serialized to a string, minor representation errors (e.g., `100.1` vs `100.09999...`) may appear. To handle this, balances are converted via `Math.round(Number(s.balance) * 100)` instead of `toCents` — `Math.round` eliminates the sub-cent float noise, which is always far smaller than 0.5 cents for any monetary value within the sheet's precision range.

**Profit**: computed as `profitCents = revenueCents - expensesCents` in integers, then divided by `100` once. This avoids `(revenue - expenses)` producing a float subtraction error.

### Scope

Fixed-point arithmetic is applied only in `compute-financials`. No other step in this flow performs monetary arithmetic. The `financials` sheet continues to receive dollar amounts — no schema change.

---

## Recompute Mode

### Trigger

Set `ctx.state.config.recomputeDate` to an ISO date string (`YYYY-MM-DD`). When present, `select-latest-snapshot` targets that specific date instead of the most recent date in `snapshots_daily`.

```ts
// ctx.state.config:
{
  recomputeDate: '2026-03-20'   // generate financials for this specific past date
}
```

Typical use: run `compute-ledger-balances` with `recomputeFrom = '2026-03-20'` first to produce a corrected snapshot, then run `generate-financials` with `recomputeDate = '2026-03-20'` to regenerate the corresponding P&L row.

### Version-aware snapshot selection

After a recompute, `snapshots_daily` contains multiple sets of rows for the target date — the original and one or more recomputed versions, each with a different `run_id`. `select-latest-snapshot` always picks the **latest `run_id`** for the selected date, so the most recently computed version is used automatically in both normal and recompute mode.

`run_id` values are ISO timestamp strings (`run-2026-03-20T10:30:00.000Z`). Lexicographic max is the most recent. This selection is applied to whatever date is active — the latest overall date in normal mode, or `recomputeDate` in recompute mode.

### Integrity check relaxation

`check-snapshot-integrity` originally flagged duplicate `(date, account)` pairs as corruption. After a recompute, multiple rows for the same `(date, account)` exist with different `run_id` values — these are legitimate versioned rows, not injected duplicates.

The integrity check is updated to allow `(date, account)` duplicates when the rows have distinct `run_id` values. The uniqueness invariant becomes `(date, account, run_id)`. Rows without a `run_id` (written before this field was introduced) are treated as `run_id = ''` — a single `(date, account, '')` entry is valid; two such entries remain a violation.

### Output

`write-financials` appends a new P&L row for the target date. Old `financials` rows for that date are preserved for audit. There is no deduplication of `financials` rows — the latest `run_id` is the authoritative version.

---

## Retention Strategy

### Problem

`financials` accumulates one row per `generate-financials` run. With daily execution, that is 365 rows per year — unbounded growth over time.

### Policy

Keep the **`retentionDays` most recent rows**. `financials` is append-only and ordered: the most recent row is always at the bottom. Retention trims from the top. Default: `retentionDays = 90` (configurable via `ctx.state.config.retentionDays`).

`retentionDays` is intentionally the same config key used in `compute-ledger-balances` for snapshot retention. When both flows use the same value, `snapshot_ref` joins remain valid within the live window: every `financials` row within the retention window has a corresponding set of rows in `snapshots_daily`, and vice versa.

### When pruning is skipped

| Condition | Behaviour |
|-----------|-----------|
| `write-financials` did not run | `read-financials-for-prune` and `prune-financials` are both skipped |
| Row count ≤ `retentionDays` after write | `prune-financials` returns `{ skipped: true }` — no storage call |

### `delete` operation contract

`prune-financials` returns a `delete` operation with `rowIndices` targeting the oldest rows (lowest sheet row numbers). The storage module deletes from highest index to lowest to prevent index shifting. For a top-trim this means deleting from the bottom of the delete set upward — the storage module handles this internally.

### Partial prune recovery

If the `delete` call partially succeeds, surviving old rows remain. On the next run, `prune-financials` re-reads `financials` via `read-financials-for-prune` and recalculates the target rows. Pruning is idempotent — re-running converges to the correct state.

---

## Traceability

### `run_id`

Every row written to `financials` carries a `run_id` column — a string identifying the flow execution that produced it.

**Format**: `` `run-${new Date().toISOString()}` `` — e.g., `run-2026-03-24T10:30:00.000Z`.

`run_id` encodes both a unique execution identifier and the wall-clock time the flow ran. It is generated once in `write-financials`'s `input` function.

**Orchestrator injection**: If `ctx.state.runId` is set, that value is used instead of a freshly generated one. When an orchestrator propagates a shared `run_id` to all three flows, the resulting chain is:

```
validated_entries.run_id  →  snapshots_daily.run_id  →  financials.run_id
```

All three sheets receive the same value, making it possible to trace a specific financials row back through the snapshot that produced it to the validated entries written in the same orchestrated run.

**Backward compatibility**: Existing rows in `financials` without a `run_id` column are unaffected. `check-snapshot-integrity` does not validate `run_id`. Old rows pass all checks.

---

## Steps

---

### Step 1 — `read-snapshots`

**Type**: `storage`

**Condition**: none (always runs)

**Purpose**: Read all rows from `snapshots_daily`. This includes the full historical record across all dates. The `select-latest-snapshot` step is responsible for restricting scope to the most recent date.

```ts
{
  id: 'read-snapshots',
  type: 'storage',
  input: (ctx) => ({
    provider: 'sheets',
    operation: 'read',
    resource: ctx.state.config.sheetId,
    options: { range: ctx.state.config.ranges.snapshots }
  })
}
```

**Output written to**: `ctx.outputs['read-snapshots']`

Expected shape:
```ts
{ rows: Array<{ date: string, account: string, balance: string, snapshot_ref: string }> }
```

---

### Step 2 — `check-snapshot-integrity`

**Type**: `storage`

**Condition**: `!!ctx.outputs?.['read-snapshots']?.rows?.length`

**Purpose**: Inspect all rows in `snapshots_daily` for structural corruption before any financial computation runs. If any violation is found, the step **throws an error** — the flow stops and no financials row is written.

`snapshots_daily` is engine-owned and append-only. Computing financials from a corrupted or tampered snapshot set would produce silently incorrect revenue and expense figures.

**Checks performed**:

| Check | Condition | Violation |
|-------|-----------|-----------|
| `snapshot_ref` consistency | Every row's `snapshot_ref` must equal `` `snapshot-${row.date}` `` exactly | Mismatch means `snapshot_ref` or `date` was manually altered |
| No duplicate `(date, account, run_id)` triples | Each `(account, run_id)` combination appears at most once per date | True duplicate — same account, same version, same date — indicates injection or copy-paste |
| `balance` is a valid number | `Number(row.balance)` must be finite | Non-numeric value indicates manual corruption |
| `date` is valid ISO format | Matches `YYYY-MM-DD` and is a valid calendar date | Manually altered date |
| `account` is non-empty | `account` field must be a non-empty string | Manually cleared account name |

Multiple rows for the same `(date, account)` are permitted when they carry **distinct `run_id` values** — these are versioned recompute rows, not duplicates. A `run_id` of `''` (absent field) is treated as a single valid version; two rows with the same `(date, account)` and both missing `run_id` are flagged as duplicates.

All checks run over all rows before returning — the error message contains all violations, not just the first.

```ts
{
  id: 'check-snapshot-integrity',
  type: 'storage',
  condition: (ctx) => !!ctx.outputs?.['read-snapshots']?.rows?.length,
  input: (ctx) => {
    const rows = ctx.outputs?.['read-snapshots']?.rows ?? [];
    const violations = [];

    // 1. snapshot_ref consistency: must equal `snapshot-{date}` exactly
    const refMismatches = rows.filter(r => (r.snapshot_ref || '') !== `snapshot-${r.date}`);
    if (refMismatches.length > 0) {
      violations.push(`${refMismatches.length} row(s) where snapshot_ref does not match snapshot-{date}`);
    }

    // 2. No duplicate (date, account, run_id) triples
    // Multiple (date, account) rows are allowed when run_id differs — those are recompute versions.
    // run_id absent → treated as '' for deduplication purposes.
    const tripleSeen = new Set();
    const duplicateTriples = new Set();
    for (const r of rows) {
      const key = `${r.date}|${r.account}|${r.run_id ?? ''}`;
      if (tripleSeen.has(key)) duplicateTriples.add(`${r.date}|${r.account}|${r.run_id ?? ''}`);
      else tripleSeen.add(key);
    }
    if (duplicateTriples.size > 0) {
      violations.push(`duplicate (date, account, run_id) triples: ${[...duplicateTriples].join('; ')}`);
    }

    // 3. Balance must be a valid finite number
    const invalidBalances = rows.filter(r => {
      const b = Number(r.balance);
      return r.balance === undefined || r.balance === null || String(r.balance).trim() === '' || !isFinite(b);
    });
    if (invalidBalances.length > 0) {
      violations.push(`${invalidBalances.length} row(s) with non-numeric balance`);
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

    // 5. Account name must be non-empty
    const missingAccount = rows.filter(r => !r.account || !String(r.account).trim());
    if (missingAccount.length > 0) {
      violations.push(`${missingAccount.length} row(s) with missing account name`);
    }

    if (violations.length > 0) {
      throw new Error(`snapshots_daily integrity check failed — ${violations.join(' | ')}`);
    }

    return { valid: true, rowCount: rows.length };
  }
}
```

**Output written to**: `ctx.outputs['check-snapshot-integrity']`

Expected shape (success only — throws on failure):
```ts
{ valid: true, rowCount: number }
```

---

### Step 3 — `read-accounts`

**Type**: `storage`

**Condition**: none (always runs)

**Purpose**: Read the master account list to obtain account type classifications (`asset`, `liability`, `income`, `expense`). These types determine which balances contribute to revenue vs. expenses in the P&L.

```ts
{
  id: 'read-accounts',
  type: 'storage',
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
{ rows: Array<{ account_name: string, type: 'asset' | 'liability' | 'income' | 'expense' }> }
```

---

### Step 4 — `validate-accounts`

**Type**: `storage`

**Condition**: `Array.isArray(ctx.outputs?.['read-accounts']?.rows)`

**Purpose**: Enforce accounts sheet integrity before financial computation begins. Two rules are checked:

1. **`account_name` uniqueness** — duplicate names cause the type lookup map in `compute-financials` to silently overwrite earlier entries, producing incorrect P&L classification.
2. **`type` validity** — each row's `type` must be one of `asset`, `liability`, `income`, `expense`. An unknown type is silently ignored by `compute-financials`, causing balances for that account to be omitted from the P&L without any signal.

If either check fails, the step **throws an error** — the flow stops immediately. No financial figures are computed or written.

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

---

### Step 5 — `select-latest-snapshot`

**Type**: `storage`

**Condition**: `!!ctx.outputs?.['read-snapshots']?.rows?.length`

**Purpose**: Determine the target date and select the authoritative snapshot rows for that date. In normal mode the target date is the maximum date in the sheet. In recompute mode (`ctx.state.config.recomputeDate` is set) the target date is the configured value. In both modes, among all rows for the target date, only those with the **latest `run_id`** are returned — this is the version-aware selection that ensures recomputed rows automatically supersede originals.

```ts
{
  id: 'select-latest-snapshot',
  type: 'storage',
  condition: (ctx) => !!ctx.outputs?.['read-snapshots']?.rows?.length,
  input: (ctx) => {
    const rows = ctx.outputs?.['read-snapshots']?.rows ?? [];

    // Recompute mode: target a specific date; normal mode: use the latest date
    const recomputeDate = ctx.state.config.recomputeDate ?? null;
    const latestDate = recomputeDate
      ?? rows.reduce((max, r) => (r.date > max ? r.date : max), '');

    // Among rows for the target date, pick only the latest run_id (most recent version)
    // run_id format: 'run-{ISO timestamp}' — lexicographic max is the most recent
    const rowsForDate = rows.filter(r => r.date === latestDate);
    const latestRunId = rowsForDate
      .reduce((max, r) => ((r.run_id ?? '') > max ? (r.run_id ?? '') : max), '');
    const latestRows = latestRunId
      ? rowsForDate.filter(r => (r.run_id ?? '') === latestRunId)
      : rowsForDate; // no run_id on any row — use all rows for the date (backward compat)

    return { latestDate, rows: latestRows };
  }
}
```

**Output written to**: `ctx.outputs['select-latest-snapshot']`

Expected shape:
```ts
{ latestDate: string, rows: Array<{ date: string, account: string, balance: string, snapshot_ref: string, run_id?: string }> }
```

**Selection logic**:
- `latestDate` — `ctx.state.config.recomputeDate` if set; otherwise the lexicographic max `date` across all snapshot rows
- `rows` — only the snapshot rows for `latestDate` that share the **latest `run_id`** for that date. Multiple recompute versions for the same date are narrowed to the most recent one. If no row has a `run_id` (all pre-`run_id` data), all rows for the date are returned for backward compatibility.
- If the target date has no snapshot rows (e.g., `recomputeDate` was set to a date not yet snapshotted), `rows` is `[]` and `compute-financials` is skipped.
- If the sheet is empty, this step is skipped (condition guards on `rows.length`).

---

### Step 6 — `compute-financials`

**Type**: `storage`

**Condition**: `!!ctx.outputs?.['select-latest-snapshot']?.rows?.length`

**Purpose**: Build a lookup map from account name to account type. Iterate over the **latest snapshot rows only**, summing balances for `income` accounts into `revenue` and `expense` accounts into `expenses`. Compute `profit = revenue - expenses`. All summation is done in integer cents to eliminate floating point accumulation errors.

```ts
{
  id: 'compute-financials',
  type: 'storage',
  condition: (ctx) => !!ctx.outputs?.['select-latest-snapshot']?.rows?.length,
  input: (ctx) => {
    const snapshots = ctx.outputs?.['select-latest-snapshot']?.rows ?? [];
    const accounts = ctx.outputs?.['read-accounts']?.rows ?? [];

    const map = {};
    for (const a of accounts) {
      map[a.account_name] = a.type;
    }

    // Convert a stored balance to integer cents.
    // Math.round eliminates sub-cent float representation noise from the stored value.
    function toCents(balanceVal) {
      return Math.round(Number(balanceVal || 0) * 100);
    }

    // Accumulate in integer cents — exact, no floating point errors
    let revenueCents = 0;
    let expensesCents = 0;

    for (const s of snapshots) {
      const type = map[s.account];
      const balanceCents = toCents(s.balance);

      if (type === 'income')  revenueCents  += balanceCents;
      if (type === 'expense') expensesCents += balanceCents;
    }

    // Divide by 100 once per P&L field — one rounding event per output value
    return {
      revenue:  revenueCents  / 100,
      expenses: expensesCents / 100,
      profit:   (revenueCents - expensesCents) / 100
    };
  }
}
```

**Output written to**: `ctx.outputs['compute-financials']`

Expected shape:
```ts
{ revenue: number, expenses: number, profit: number }
```

> **Source change**: `snapshots` is read from `select-latest-snapshot.rows`, not `read-snapshots.rows`. This is the critical fix — only one date's worth of balances is summed.

> **Precision**: all summation uses integer cents. `toCents` converts each balance with `Math.round(Number(val) * 100)` — `Math.round` corrects the sub-cent float noise that arises from IEEE 754 representation of values like `100.10`. The final division by `100` happens once per P&L field, not once per snapshot row.

---

### Step 7 — `write-financials`

**Type**: `storage`

**Condition**: `!!ctx.outputs?.['compute-financials'] && !!ctx.outputs?.['select-latest-snapshot']?.latestDate`

**Purpose**: Append a P&L row to the `financials` sheet. The `date` column is set to `latestDate` from `select-latest-snapshot` — the date of the snapshot the financials were derived from — not the current clock time. A `snapshot_ref` column (`` `snapshot-${date}` ``) is written alongside the P&L figures, forming an explicit link to the snapshot rows in `snapshots_daily` that produced this financial record.

**Columns written** (in order): `date`, `revenue`, `expenses`, `profit`, `snapshot_ref`, `run_id`

```ts
{
  id: 'write-financials',
  type: 'storage',
  condition: (ctx) =>
    !!ctx.outputs?.['compute-financials']
    && !!ctx.outputs?.['select-latest-snapshot']?.latestDate,
  input: (ctx) => {
    const f = ctx.outputs['compute-financials'];
    const date = ctx.outputs['select-latest-snapshot'].latestDate;
    const snapshotRef = `snapshot-${date}`;

    // run_id: use orchestrator-injected value if present; otherwise generate for this run.
    // Format: run-{ISO timestamp} — uniquely identifies this execution and encodes the time.
    const runId = ctx.state.runId ?? `run-${new Date().toISOString()}`;

    return {
      provider: 'sheets',
      operation: 'write',
      resource: ctx.state.config.sheetId,
      data: [[date, f.revenue, f.expenses, f.profit, snapshotRef, runId]],
      options: { range: ctx.state.config.ranges.financials }
    };
  }
}
```

**Output written to**: `ctx.outputs['write-financials']`

> **Date sourcing**: `date` is read directly from `ctx.outputs['select-latest-snapshot'].latestDate` without a fallback. The condition `!!ctx.outputs?.['select-latest-snapshot']?.latestDate` explicitly guarantees this value is present before the step executes — no fallback is needed or provided. The financials record is stamped with the period the data represents, not the execution clock.

> **`snapshot_ref`**: Derived inline as `` `snapshot-${date}` ``. This value matches the `snapshot_ref` written by `compute-ledger-balances` for the same date. The join `financials.snapshot_ref = snapshots_daily.snapshot_ref` retrieves the exact snapshot rows that produced this P&L record — no secondary lookup or date inference required.

> **`run_id`**: Generated once in this step as `` `run-${new Date().toISOString()}` ``, or taken from `ctx.state.runId` if an orchestrator injected a shared value. When a common `run_id` is propagated across all three flows, the `financials`, `snapshots_daily`, and `validated_entries` rows for the same pipeline run share identical `run_id` values.

> **Condition**: Compound — both `compute-financials` output and `select-latest-snapshot.latestDate` must be present. Either being absent or undefined prevents execution. No write occurs against undefined inputs.

---

### Step 8 — `read-financials-for-prune`

**Type**: `storage`

**Condition**: `!!ctx.outputs?.['write-financials']`

**Purpose**: Re-read `financials` after the write to obtain the current total row count (including the row just appended). Only runs when `write-financials` executed — if no P&L row was written this run, pruning is unnecessary. The result feeds `prune-financials` with the full current row set.

```ts
{
  id: 'read-financials-for-prune',
  type: 'storage',
  condition: (ctx) => !!ctx.outputs?.['write-financials'],
  input: (ctx) => ({
    provider: 'sheets',
    operation: 'read',
    resource: ctx.state.config.sheetId,
    options: {
      range: ctx.state.config.ranges.financials,
      batchSize: ctx.state.config.batchSize ?? 5000
    }
  })
}
```

**Output written to**: `ctx.outputs['read-financials-for-prune']`

Expected shape:
```ts
{ rows: Array<{ date: string, revenue: string, expenses: string, profit: string, snapshot_ref: string, run_id?: string }> }
```

---

### Step 9 — `prune-financials`

**Type**: `storage`

**Condition**: `!!ctx.outputs?.['read-financials-for-prune']?.rows?.length`

**Purpose**: Delete the oldest rows from `financials` so that only the `retentionDays` most recent rows remain. `financials` is append-only and ordered — the most recent row is always last. Pruning removes from the top (lowest row indices). The row just written in `write-financials` is always at the bottom and is never a deletion target.

**Row index derivation**: `read-financials-for-prune.rows[i]` occupies sheet row `i + 2` (header is row 1). The oldest rows are at indices 0, 1, 2, ... — corresponding to sheet rows 2, 3, 4, ....

```ts
{
  id: 'prune-financials',
  type: 'storage',
  condition: (ctx) => !!ctx.outputs?.['read-financials-for-prune']?.rows?.length,
  input: (ctx) => {
    const retentionRows = ctx.state.config.retentionDays ?? 90;
    const rows = ctx.outputs['read-financials-for-prune'].rows ?? [];

    // Within retention limit — nothing to do
    if (rows.length <= retentionRows) {
      return {
        skipped: true,
        reason: `${rows.length} row(s) within retention limit of ${retentionRows}`
      };
    }

    // Delete the oldest rows: array indices 0 through (rows.length - retentionRows - 1)
    // These map to sheet rows 2 through (rows.length - retentionRows + 1)
    const deleteCount = rows.length - retentionRows;
    const rowIndicesToDelete = Array.from({ length: deleteCount }, (_, i) => i + 2);

    return {
      provider: 'sheets',
      operation: 'delete',
      resource: ctx.state.config.sheetId,
      rowIndices: rowIndicesToDelete,
      options: { range: ctx.state.config.ranges.financials }
      // Storage module must delete rows from highest index to lowest to prevent index shift
    };
  }
}
```

**Output written to**: `ctx.outputs['prune-financials']`

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

- `check-snapshot-integrity` runs before any financial computation. If `snapshots_daily` contains any structural violation, the flow fails immediately — no P&L row is written.
- `validate-accounts` runs before financial computation. If the accounts sheet contains duplicate names or invalid types, the flow fails immediately.
- Only the most recent snapshot date contributes to financial computation — no double-counting of historical rows.
- `select-latest-snapshot` is the sole scope gate. `compute-financials` and `write-financials` consume its output exclusively.
- The `date` written to `financials` reflects the snapshot period, not the execution clock.
- `snapshot_ref` is derived deterministically from `latestDate` — `` `snapshot-${date}` ``. It is the explicit foreign key linking each `financials` row to the set of `snapshots_daily` rows that produced it.
- The join `financials.snapshot_ref = snapshots_daily.snapshot_ref` retrieves all snapshot rows for that date. To retrieve only the authoritative version, additionally filter on the `run_id` matching the value on the `financials` row.
- In recompute mode (`ctx.state.config.recomputeDate` is set), `select-latest-snapshot` targets the specified date and selects its latest-versioned rows. `write-financials` appends a new P&L row; old `financials` rows for that date are preserved for audit. The latest `run_id` is the authoritative version.
- `check-snapshot-integrity` allows multiple rows per `(date, account)` when they carry distinct `run_id` values — these are versioned recompute rows. The uniqueness invariant is `(date, account, run_id)`.
- `read-snapshots` and `read-accounts` run unconditionally and have no dependency on each other. (The engine runs them sequentially per the deterministic execution model.)
- `compute-financials` is skipped if the latest snapshot has no rows.
- `write-financials` is skipped if `compute-financials` did not run.
- Account types not classified as `income` or `expense` (`asset`, `liability`) do not contribute to the P&L computation.
- All arithmetic happens inside `compute-financials` — no formulas in the sheet.
- Revenue, expenses, and profit are computed from integer cent totals. `Math.round(Number(balance) * 100)` converts each stored balance to exact cents. Summation is integer arithmetic. Each P&L field is produced by a single division by `100` — at most one rounding event per output field regardless of how many accounts contribute.
- The financials sheet accumulates one row per run; it is an append-only log of P&L snapshots.
- Every written row carries a `run_id` encoding the execution identity and timestamp. If `ctx.state.runId` is provided by an orchestrator, the same value appears in `validated_entries`, `snapshots_daily`, and `financials` — forming a traceable chain across all three sheets for that run.
- After a successful `write-financials`, `read-financials-for-prune` re-reads the sheet and `prune-financials` deletes the oldest rows beyond the `retentionDays` limit. The row just written is always at the bottom and is never a deletion target. If row count ≤ `retentionDays`, `prune-financials` returns `{ skipped: true }` and no storage call is made.
- `snapshot_ref` join integrity is maintained within the retention window when `retentionDays` is the same value used by `compute-ledger-balances` — both sheets are pruned to the same date range.
