# Generate Financials — Flow Documentation

**Flow ID**: `generate-financials`

**File**: `apps/accounting/flows/generate-financials/flow.md`

---

## Purpose

The `generate-financials` flow reads account balance snapshots, selects only the latest snapshot date, classifies each account by type using the chart of accounts, computes revenue, expenses, and net profit from those balances, then appends a dated P&L row to the `financials` sheet.

This is the final flow in the accounting pipeline. It depends on `snapshots_daily` being populated by `compute-ledger-balances`.

---

## Step Summary

| Step ID | Type | Condition | Purpose |
|---------|------|-----------|---------|
| `read-snapshots` | storage | always | Read all rows from `snapshots_daily` (full history) |
| `check-snapshot-integrity` | storage | snapshot rows exist | Assert structural integrity of `snapshots_daily` — throws on violation |
| `read-accounts` | storage | always | Read chart of accounts for type classification |
| `validate-accounts` | storage | accounts rows read | Assert `account_name` uniqueness and valid `type` — throws on failure |
| `select-latest-snapshot` | storage | snapshot rows exist | Find max date; filter rows to that date only |
| `compute-financials` | storage | latest snapshot rows exist | Compute revenue, expenses, profit from latest rows |
| `write-financials` | storage | compute-financials ran AND `select-latest-snapshot.latestDate` present | Append P&L row with `run_id` to `financials`, dated to snapshot period |
| `read-financials-for-prune` | storage | `write-financials` ran | Re-read `financials` to get current row count for prune calculation |
| `prune-financials` | storage | `read-financials-for-prune` returned rows | Delete oldest `financials` rows beyond the `retentionDays` limit |

---

## Snapshot Integrity Check

Before selecting the latest snapshot or computing financials, `check-snapshot-integrity` scans all rows in `snapshots_daily` for signs of manual corruption. `snapshots_daily` is engine-owned and append-only — computing financials from tampered data would produce silently incorrect P&L figures.

### Invalid state conditions

| Condition | Why it indicates corruption |
|-----------|----------------------------|
| `snapshot_ref` ≠ `` `snapshot-${row.date}` `` | The engine always writes a `snapshot_ref` derived from the row's own `date`; a mismatch means one of the two fields was manually altered |
| Duplicate `(date, account)` pair | Each account appears exactly once per snapshot run; a duplicate means a row was injected manually |
| `balance` is not a finite number | Engine-written balances are always numeric; a non-numeric value means the cell was manually edited |
| `date` is not a valid `YYYY-MM-DD` calendar date | Engine-written dates are always valid ISO strings |
| `account` is empty | Engine-written rows always include the account name |

If any violation is detected, `check-snapshot-integrity` throws and the flow aborts — no P&L row is written. All violations are collected before throwing.

### Recovery

1. Inspect `snapshots_daily` and correct or remove the offending rows.
2. Re-run `generate-financials`. The flow will pass if no violations remain.

---

## Snapshot Selection Logic

### Problem: summing all historical rows

`snapshots_daily` is an append-only sheet. Each run of `compute-ledger-balances` appends one row per account for that day's date. After 30 days there are 30 rows per account. The original `compute-financials` summed every row regardless of date, producing figures up to 30× inflated.

### Fix: `select-latest-snapshot`

A new step runs after `read-snapshots` and before `compute-financials`:

```ts
const latestDate = rows.reduce((max, r) => (r.date > max ? r.date : max), '');
return {
  latestDate,
  rows: rows.filter(r => r.date === latestDate)
};
```

**Why string comparison works**: ISO dates (`YYYY-MM-DD`) are lexicographically ordered. `'2026-03-24' > '2026-03-10'` evaluates `true` in a string comparison, so `reduce` over the `date` field finds the latest date without any date parsing.

**What it produces**: A filtered set of rows containing exactly one date — the most recent snapshot. Every account present in that snapshot appears exactly once.

`compute-financials` sources its `snapshots` from `select-latest-snapshot.rows`, not from `read-snapshots.rows`. This is the only code change needed to correct the computation.

### Date stamping

`write-financials` uses `select-latest-snapshot.latestDate` as the `date` column value — not `new Date()`. This means:

- The financials record is stamped with the **period the data represents**, not when the flow ran.
- Running the flow on 2026-03-25 using a 2026-03-24 snapshot writes `2026-03-24` to `financials`.
- Historical financials rows remain accurate even if re-generated at a later date.

---

## P&L Computation

The `compute-financials` step builds an account-type lookup map and classifies each latest-snapshot balance:

| Account Type | Contribution |
|---|---|
| `income` | balance added to `revenue` |
| `expense` | balance added to `expenses` |
| `asset` | ignored (balance sheet item) |
| `liability` | ignored (balance sheet item) |

**Formula**:
```
profit = revenue - expenses
```

---

## Example

Given `snapshots_daily` with three days of history:

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

**Before fix** — `compute-financials` summed all rows:
- `revenue` = −800 + −900 + −1000 = **−2700** ← incorrect (3× inflated)

**After fix** — `select-latest-snapshot` narrows to `2026-03-24` only:
- `latestDate` = `'2026-03-24'`
- `rows` = `[{ Cash, 600 }, { Revenue, -1000 }]`
- `revenue` = **−1000** ← correct

Given `accounts`:
```
| account_name | type    |
|--------------|---------|
| Revenue      | income  |
| Cash         | asset   |
```

Resulting P&L (2026-03-24 snapshot):
- `revenue` = −1000
- `expenses` = 0
- `profit` = −1000
- `snapshot_ref` = `snapshot-2026-03-24`

---

## Traceability Linkage

Each `financials` row is linked to the exact set of `snapshots_daily` rows that produced it via a shared `snapshot_ref` key.

### Key derivation

```
snapshot_ref = `snapshot-${latestDate}`
```

- `compute-ledger-balances` writes `snapshot_ref` to every row it appends to `snapshots_daily`
- `generate-financials` writes the same value to the corresponding `financials` row
- Both derive `snapshot_ref` from the same date string (`YYYY-MM-DD`) — no coordination needed

### Join

```
financials.snapshot_ref = snapshots_daily.snapshot_ref
```

Filter `snapshots_daily` where `snapshot_ref = 'snapshot-2026-03-24'` to retrieve the exact account balances that produced the P&L row with the same `snapshot_ref`.

### Properties

| Property | Value |
|----------|-------|
| Format | `snapshot-YYYY-MM-DD` |
| Determinism | Derived from `latestDate` — identical value on any re-run for the same snapshot date |
| Human-readable | `snapshot-2026-03-24` names the date it covers |
| No new storage | Written as a column in existing sheets — no additional tables |
| Uniqueness | One `snapshot_ref` per calendar date; at most one `financials` row per value under normal conditions |

---

## Financials Output

One row is appended to `financials` per run, dated to the latest snapshot:

```
| date       | revenue | expenses | profit | snapshot_ref        |
|------------|---------|----------|--------|---------------------|
| 2026-03-24 | -1000   | 0        | -1000  | snapshot-2026-03-24 |
```

---

## Skipped Steps

| Step | Skipped when |
|------|--------------|
| `check-snapshot-integrity` | `read-snapshots` returns no rows |
| `select-latest-snapshot` | `read-snapshots` returns no rows |
| `compute-financials` | `select-latest-snapshot.rows` is empty |
| `write-financials` | `compute-financials` did not run OR `select-latest-snapshot.latestDate` is absent |

> Note: if `check-snapshot-integrity` throws, the flow fails — it does not count as a skip. Subsequent steps are never reached.

---

## Idempotency Considerations

Running this flow multiple times on the same day appends multiple P&L rows to `financials`. Each run will produce identical figures (same latest snapshot), but duplicate rows accumulate. The handler should manage run frequency — once per day after `compute-ledger-balances` completes.

---

## Output Produced

| Sheet | Operation | Trigger |
|-------|-----------|---------|
| `financials` | append one row | latest snapshot exists and compute succeeded |
