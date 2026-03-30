# Retention Policy

**Purpose**: Documents the data retention rules for append-only engine-owned sheets, which sheets are subject to pruning, the configuration model, and the safety guarantees that prevent loss of operationally critical data.

---

## Overview

Two sheets grow without bound under normal operation:

| Sheet | Growth rate | Retention mechanism |
|-------|-------------|---------------------|
| `snapshots_daily` | 1 row per account per run | `prune-snapshots` — removes rows for dates outside the window |
| `financials` | 1 row per run | `prune-financials` — removes oldest rows beyond the row limit |

Four sheets are **not** subject to retention pruning:

| Sheet | Reason |
|-------|--------|
| `raw_entries` | User-owned; engine only updates `status` and `error_reason` |
| `validated_entries` | Permanent ledger; required for delta computation correctness |
| `accounts` | User-managed chart of accounts; small and stable |
| `reconciliation_log` | Audit trail; user-managed resolution lifecycle |

`validated_entries` is specifically excluded because it is the source of truth for balance computation. Deleting entries would corrupt delta computation on the next run — `entry_count` watermarks would no longer correspond to valid row positions.

---

## Configuration

```ts
ctx.state.config.retentionDays  // number, default: 90
```

`retentionDays` is a single config key that controls both:
- The number of distinct snapshot **dates** to retain in `snapshots_daily`
- The number of P&L **rows** to retain in `financials`

Since each `generate-financials` run produces exactly one `financials` row and one snapshot date, `retentionDays = 90` retains approximately 90 runs of history in both sheets.

Using the same key for both is intentional: it ensures `snapshot_ref` joins remain valid across the full retention window. A `financials` row references its source snapshot via `snapshot_ref`. If both sheets are pruned to the same date range, every retained `financials` row has a corresponding set of rows in `snapshots_daily`.

---

## `snapshots_daily` Retention

### Rule

Keep the `retentionDays` most recent distinct snapshot dates. Delete all rows for any date outside that window.

### Trigger

`prune-snapshots` runs only after `write-snapshot` completes successfully in the same flow execution. If `write-snapshot` was skipped (today's snapshot already exists — same-day re-run), pruning is also skipped.

### Safety invariants

| Invariant | Mechanism |
|-----------|-----------|
| Most recent snapshot is never pruned | Today is always in `keepDates`; today's new rows were not in the pre-write read used for row index derivation |
| `entry_count` watermark is preserved | The most recent snapshot carries it; it is never a prune target |
| Prune is idempotent | Row indices derived from the pre-write read are stable; re-running after a partial prune converges to the correct state |

### Calculation

```
allDates   = uniqueDates(existingRows) + today
keepDates  = top retentionDays of allDates sorted descending
pruneRows  = existingRows where date ∉ keepDates
```

`existingRows` = rows read by `read-existing-snapshots` (before the write). Today's new rows are never in this set.

---

## `financials` Retention

### Rule

Keep the `retentionDays` most recent rows. Since `financials` is append-only and ordered, the oldest rows are at the top (lowest row indices).

### Trigger

`read-financials-for-prune` (Step 8) and `prune-financials` (Step 9) run only when `write-financials` executed in the same flow run.

### Safety invariants

| Invariant | Mechanism |
|-----------|-----------|
| Most recent row is never pruned | The new row is at the bottom; `prune-financials` only targets indices from the top |
| Prune is idempotent | `read-financials-for-prune` re-reads the sheet after the write; row count is always current |

### Calculation

```
rows       = read-financials-for-prune.rows    // full current sheet after write
deleteCount = rows.length - retentionDays
rowIndices  = [2, 3, ..., deleteCount + 1]     // oldest rows at the top
```

---

## `delete` Operation Contract

Both prune steps return a `delete` storage operation:

```ts
{
  provider: 'sheets',
  operation: 'delete',
  resource: sheetId,
  rowIndices: number[],   // 1-indexed sheet row numbers
  options: { range: ... }
}
```

The storage module **must** process `rowIndices` from highest to lowest (bottom to top). Deleting from the bottom first prevents row index shifts from invalidating subsequent deletions in the same batch.

When pruning is not needed (date count or row count within limit), the step returns `{ skipped: true, reason: string }` — no storage call is made.

---

## `snapshot_ref` Join Integrity

Each `financials` row references its source snapshot via `snapshot_ref = 'snapshot-{date}'`. This join is valid as long as the corresponding `snapshots_daily` rows exist.

When `retentionDays` is the same in both flows:
- `financials` retains the last N rows (one per run date)
- `snapshots_daily` retains the last N distinct dates (one per run date)

The retained sets are aligned. Every `financials` row within the window has a corresponding snapshot set. Rows pruned from `financials` have their corresponding snapshot rows pruned from `snapshots_daily` at the same time (or earlier — `compute-ledger-balances` runs before `generate-financials`).

---

## Skipped Steps Summary

| Step | Skipped when |
|------|-------------|
| `prune-snapshots` | `write-snapshot` did not run (same-day re-run or empty ledger) |
| `prune-snapshots` (no-op) | Distinct date count ≤ `retentionDays` |
| `read-financials-for-prune` | `write-financials` did not run |
| `prune-financials` | `read-financials-for-prune` returned no rows |
| `prune-financials` (no-op) | Row count ≤ `retentionDays` |

---

## Output Produced

| Sheet | Operation | Trigger |
|-------|-----------|---------|
| `snapshots_daily` | delete rows (dates outside retention window) | `write-snapshot` ran AND date count > `retentionDays` |
| `financials` | delete rows (oldest beyond retention limit) | `write-financials` ran AND row count > `retentionDays` |
