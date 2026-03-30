# Recompute Process

**Purpose**: Documents how to correct past snapshot and financials data — when to use recompute mode, how it works, and how to execute it safely.

---

## When to Use

| Scenario | Action |
|----------|--------|
| A flow bug produced incorrect snapshot balances | Fix the bug, then recompute the affected dates |
| A `validated_entries` row was corrected or a reversal entry was appended | Recompute the affected snapshot date(s) |
| `snapshots_daily` rows were manually deleted or corrupted | Recompute from the last valid date forward |
| `financials` row is stale after a snapshot recompute | Regenerate the specific date's P&L |

**Note**: `validated_entries` is append-only. Corrections take the form of new reversal entries, not edits to existing rows. Recomputing a snapshot for a sealed past date reprocesses the same ledger range (by `entry_count`), so only logic fixes — not new entries — affect past date snapshots. New reversal entries are reflected in the current date's snapshot.

---

## Auditability

Recompute **appends** new rows. Old rows are **never deleted**. Every version of every snapshot or financials row is permanently preserved:

- `snapshots_daily`: multiple row sets for the same date, each with a distinct `run_id`
- `financials`: multiple rows for the same date, each with a distinct `run_id`

The **latest `run_id`** for a given date is the authoritative version. Flows always select the latest-versioned rows automatically via `run_id` lexicographic comparison.

---

## Step 1 — Recompute a Snapshot

Run `compute-ledger-balances` with `recomputeFrom` set to the target date:

```ts
ctx.state.config = {
  ...existingConfig,
  recomputeFrom: '2026-03-20'   // the date to recompute
}
```

**What happens:**

1. `check-snapshot-date` overrides `today = '2026-03-20'` and sets `alreadyExists = false`
2. The prior baseline is the latest-versioned snapshot for the date immediately before `2026-03-20`
3. `read-validated` reads entries in the range `[priorEntryCount+1, targetEntryCount]`:
   - `priorEntryCount` = watermark from the prior date's snapshot
   - `targetEntryCount` = entry count sealed in the **existing** `2026-03-20` snapshot; if none exists, reads to current end of sheet
4. Balances are computed from those entries as deltas on top of the prior baseline
5. New snapshot rows for `2026-03-20` are appended with a fresh `run_id` — the old rows remain

**After this run**, `snapshots_daily` contains two sets of rows for `2026-03-20`: the original (with the old `run_id`) and the recomputed (with the new `run_id`). All subsequent flow reads automatically use the recomputed version because it has the later `run_id`.

---

## Step 2 — Recompute a Date Range

The flow runs once per invocation and produces one snapshot date. To recompute multiple consecutive dates, run the flow once per date **in ascending order** (oldest first):

```
recomputeFrom = '2026-03-20' → run
recomputeFrom = '2026-03-21' → run
recomputeFrom = '2026-03-22' → run
```

Each run's recomputed snapshot for date D becomes the prior baseline for date D+1 on the next run. Because `check-snapshot-date` selects the latest-versioned prior snapshot, it automatically picks the recomputed version of the prior date.

If any date in the range had no original snapshot (e.g., the flow did not run that day), that date's `targetEntryCount` is `null` and `read-validated` reads to the current sheet end — the snapshot is built from all entries processed up to that moment.

---

## Step 3 — Regenerate Financials

After recomputing snapshots, run `generate-financials` with `recomputeDate` set:

```ts
ctx.state.config = {
  ...existingConfig,
  recomputeDate: '2026-03-20'   // generate P&L for this date
}
```

**What happens:**

1. `select-latest-snapshot` targets `2026-03-20` instead of the latest date
2. Among all snapshot rows for `2026-03-20`, only those with the latest `run_id` are selected (the recomputed version)
3. Revenue, expenses, and profit are recomputed from those rows
4. A new `financials` row is appended for `2026-03-20` with a fresh `run_id` — the old row remains

---

## Configuration Reference

| Key | Flow | Effect |
|-----|------|--------|
| `ctx.state.config.recomputeFrom` | `compute-ledger-balances` | Target date for snapshot recompute; overrides `today` and `alreadyExists` |
| `ctx.state.config.recomputeDate` | `generate-financials` | Target date for P&L regeneration; overrides the latest-date selection |

Both keys are optional. In their absence, flows run in normal mode.

---

## Determinism

Given identical `validated_entries` content and identical computation logic, recomputing the same date always produces the same balances. The result is deterministic because:

1. The entry range is sealed by `targetEntryCount` — the same rows are reprocessed
2. Balance computation is pure: `toCents()` and integer arithmetic produce exact results with no floating point variance
3. The prior baseline comes from the latest-versioned prior snapshot, which is stable once computed

If `validated_entries` was modified between the original run and the recompute (new reversal entries added), the results will differ — this is the intended correction behaviour. For past-date snapshots, only entries within `[priorEntryCount+1, targetEntryCount]` are applied, so entries added after the original sealed count do not affect past-date snapshots.

---

## No-Destructive Guarantee

Recompute never deletes or overwrites existing rows:

- `snapshots_daily`: append-only; old snapshot rows for the target date remain
- `financials`: append-only; old P&L rows for the target date remain
- `validated_entries`: not touched by these flows

The only state change is the addition of new rows. If a recompute produces incorrect results, the prior version is still in the sheet and can be identified by its older `run_id`.

---

## Querying Versions

To retrieve all versions of the 2026-03-20 snapshot and identify the authoritative one:

```
snapshots_daily WHERE date = '2026-03-20'
→ group by run_id
→ the row group with the lexicographically maximum run_id is authoritative
```

To retrieve the authoritative `financials` row for 2026-03-20:

```
financials WHERE date = '2026-03-20'
→ ORDER BY run_id DESC LIMIT 1
```

---

## Interaction with Retention

`prune-snapshots` deletes rows by **date**, not by `run_id`. All versions for a given date are pruned together when that date falls outside the retention window. Within the retention window, all versions are preserved.

If you need to retain specific audit versions beyond the retention window, manually copy those rows to a separate sheet before the next prune run.
