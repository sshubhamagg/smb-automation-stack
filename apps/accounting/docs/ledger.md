# Ledger Balances — Flow Documentation

**Flow ID**: `compute-ledger-balances`

**File**: `apps/accounting/flows/compute-ledger-balances/flow.md`

---

## Purpose

The `compute-ledger-balances` flow reads all validated journal entries, applies only the entries added since the last snapshot as a delta on top of prior account balances, and writes a dated snapshot to `snapshots_daily` — with a `snapshot_ref` traceability key and an `entry_count` watermark — only if no snapshot for today already exists.

This flow runs after `validate-entries` completes. Its output is consumed by `generate-financials`.

---

## Step Summary

| Step ID | Type | Condition | Purpose |
|---------|------|-----------|---------|
| `read-existing-snapshots` | storage | always | Read all rows from `snapshots_daily` to extract prior balances and entry watermark |
| `check-snapshot-date` | storage | always | Derive today's date; check if snapshot exists; extract `priorBalances` and `priorEntryCount` |
| `read-validated` | storage | today not already in sheet | Read only new validated entries starting at `priorEntryCount` (partial read) |
| `check-validated-integrity` | storage | new rows exist | Assert structural integrity of new `validated_entries` rows — throws on violation |
| `compute-balances` | storage | new rows exist AND today not already in sheet | Apply new entries as a delta on top of prior snapshot balances |
| `write-snapshot` | storage | balances computed AND `check-snapshot-date.today` present AND today not already in sheet | Append dated snapshot rows with `entry_count` watermark and `run_id` to `snapshots_daily` |
| `prune-snapshots` | storage | `write-snapshot` ran | Delete snapshot rows for dates outside the `retentionDays` window |

---

## Validated Entries Integrity Check

Before computing any balances, `check-validated-integrity` scans all rows in `validated_entries` for signs of manual corruption. `validated_entries` is engine-owned and append-only — any row that violates its structural invariants was either injected manually or produced by a flow bug. Computing balances from corrupt data would silently propagate incorrect figures downstream.

### Invalid state conditions

| Condition | Why it indicates corruption |
|-----------|----------------------------|
| Any row missing `reference_id`, `date`, `debit_account`, `credit_account`, or `amount` | Engine-written rows always have all fields populated; a missing field means the row was not written by the flow |
| Duplicate `reference_id` values | The engine generates unique deterministic IDs; a duplicate means a row was copy-pasted or the sheet was tampered with |
| `amount` does not match `/^\d+(\.\d+)?$/` or parses to ≤ 0 | The engine only writes validated positive decimals; any other format means the value was manually altered |
| `date` does not match `YYYY-MM-DD` or is not a valid calendar date | Same as above — engine-written dates are always valid ISO strings |
| `debit_account === credit_account` (self-posting) | The engine rejects self-posting entries; such a row was injected directly into the sheet |

If any violation is detected, `check-validated-integrity` throws and the flow aborts — no snapshot is written. All violations are collected before throwing so the error message shows the full picture.

### Recovery

1. Inspect `validated_entries` and correct or remove the offending rows.
2. Re-run `compute-ledger-balances`. The flow will pass if no violations remain.

The engine does not automatically repair `validated_entries`. Corrections must be made manually.

---

## Delta Computation

### Problem with full recompute

The previous design recomputed all account balances from scratch on every run — iterating over every row in `validated_entries` regardless of how many new entries had been added. For a ledger with thousands of entries and only a handful of new additions per day, this is wasteful: the result of processing the first N entries is already captured in the last snapshot.

### Core idea

`validated_entries` is append-only. Entries are never modified or reordered after being written. This makes delta computation safe:

```
final_balance[account] = prior_balance[account] + Σ (new entries only)
```

Where `prior_balance` is read from the most recent snapshot and "new entries" are those appended after that snapshot was taken.

### Watermark: `entry_count`

To identify which entries are new, each snapshot row now carries an `entry_count` column — the total number of rows in `validated_entries` at the time that snapshot was written. All rows in a snapshot batch share the same `entry_count` value.

On each run:
1. Read all `validated_entries` → `N` rows
2. Read last snapshot → extract `priorEntryCount` from `entry_count` column
3. New entries = `rows.slice(priorEntryCount)` — rows appended since the last snapshot
4. Start with `priorBalances` from the last snapshot rows
5. Apply each new entry as a delta
6. Write the resulting balances with `entry_count = N` as the new watermark

### Correctness argument

Full recompute and delta are mathematically equivalent given append-only ordering:

```
full:  balance = Σ rows[0..N-1]
delta: balance = Σ rows[0..priorEntryCount-1]  +  Σ rows[priorEntryCount..N-1]
               = priorBalance                   +  delta
```

The integrity check enforces the precondition: no duplicate `reference_id` values means no row was injected mid-list or replicated.

### Balance computation rules

In double-entry accounting, each transaction has a debit side and a credit side:

| Impact | Rule |
|--------|------|
| Debit account | `balance += amount` |
| Credit account | `balance -= amount` |

**Example** (3 prior entries already snapshotted, 2 new entries this run):

| Row | Debit Account | Credit Account | Amount | Status |
|-----|---------------|----------------|--------|--------|
| 1–3 | (various)     | (various)      | (various) | Already in prior snapshot |
| 4 | `Expenses` | `Cash` | 200 | **New — delta applied** |
| 5 | `Cash` | `Revenue` | 500 | **New — delta applied** |

Prior snapshot balances: `Cash: 600, Revenue: -1000, Expenses: 400`

Delta from rows 4–5:
- `Expenses`: +200 → 400 + 200 = **600**
- `Cash`: −200 +500 → 600 − 200 + 500 = **900**
- `Revenue`: −500 → −1000 − 500 = **−1500**

Result is identical to what a full recompute would produce over all 5 rows.

### First run and backward compatibility

If `snapshots_daily` is empty (first-ever run):
- `priorEntryCount` = `0`, `priorBalances` = `{}`
- Delta covers `rows.slice(0)` — all entries
- Equivalent to a full recompute

If an older snapshot row lacks an `entry_count` column (written before this logic was introduced):
- `Number(row.entry_count) || 0` evaluates to `0`
- Same fallback — full recompute is performed
- No migration needed for existing snapshot data

---

## Snapshot Deduplication Strategy

### Problem

`write-snapshot` is an append operation. Running the flow more than once on the same calendar day would append a second set of rows with the same date. `generate-financials` selects the latest snapshot date, so duplicate rows for the same day are ignored in computation — but they accumulate as dead rows in the sheet.

### Fix: Skip-if-today-exists

`read-existing-snapshots` and `check-snapshot-date` now run **before** `compute-balances`. If `check-snapshot-date` finds that today's snapshot already exists, both `compute-balances` and `write-snapshot` are skipped — computation is avoided entirely, not just the write.

```ts
const today = new Date().toISOString().split('T')[0];
const alreadyExists = existing.some(r => r.date === today);
```

| `alreadyExists` | `compute-balances` | `write-snapshot` |
|---|---|---|
| `false` | Runs | Runs — first run of the day |
| `true` | Skipped | Skipped — snapshot already exists |

### Date consistency

`write-snapshot` reads `today` directly from `ctx.outputs['check-snapshot-date'].today` — the same string used for the existence check. No clock drift is possible between the check and the write.

---

## Snapshot Output

When `write-snapshot` runs, one row per account is appended to `snapshots_daily`:

```
| date       | account   | balance | snapshot_ref         | entry_count | run_id                           |
|------------|-----------|---------|----------------------|-------------|----------------------------------|
| 2026-03-24 | Cash      | 900     | snapshot-2026-03-24  | 5           | run-2026-03-24T10:30:00.000Z     |
| 2026-03-24 | Revenue   | -1500   | snapshot-2026-03-24  | 5           | run-2026-03-24T10:30:00.000Z     |
| 2026-03-24 | Expenses  | 600     | snapshot-2026-03-24  | 5           | run-2026-03-24T10:30:00.000Z     |
```

All rows in a batch share the same `snapshot_ref`, `entry_count`, and `run_id`. On the next run, `entry_count` is read from any row of this batch to determine the delta watermark.

---

## Idempotency

| Scenario | Behavior |
|---|---|
| First run of the day | `alreadyExists: false` → both `compute-balances` and `write-snapshot` run → rows appended |
| Re-run on the same day | `alreadyExists: true` → both `compute-balances` and `write-snapshot` skipped → no duplicate rows, no wasted computation |
| Run on a new day | `alreadyExists: false` for the new date → delta computed from `priorEntryCount` of yesterday's snapshot → rows appended |
| `validated_entries` empty | All steps from `read-existing-snapshots` onward skipped — no write |
| No new entries since last snapshot | Delta is empty (`newEntries = []`); balances unchanged; snapshot still written for today's date |

---

## Partial Write Recovery

If `write-snapshot` appended some rows and then failed mid-write, today's date will be present in `snapshots_daily` (partially). On the next run, `check-snapshot-date` detects the existing date and skips both computation and the write — the partial snapshot is not repaired automatically.

To recover:
1. Manually delete all rows from `snapshots_daily` where `date = today`.
2. Re-run `compute-ledger-balances`.

The flow will then perform a fresh delta from yesterday's watermark and write a complete snapshot.

---

## Skipped Steps

| Step | Skipped when |
|------|--------------|
| `check-validated-integrity` | `validated_entries` is empty |
| `read-existing-snapshots` | `validated_entries` is empty |
| `check-snapshot-date` | `validated_entries` is empty |
| `compute-balances` | `validated_entries` is empty OR today's snapshot already exists |
| `write-snapshot` | `compute-balances` did not run OR `check-snapshot-date.today` is absent OR today's snapshot already exists |

> Note: if `check-validated-integrity` throws, the flow fails — it does not count as a skip. Subsequent steps are never reached.

---

## Output Produced

| Sheet | Operation | Trigger |
|-------|-----------|---------|
| `snapshots_daily` | append rows (one per account) | balances computed AND today not yet in sheet |
