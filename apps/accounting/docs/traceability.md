# Traceability Model

**Purpose**: Documents the `run_id` traceability system — how flow executions are identified, how that identity is propagated across sheets, and how rows from different sheets can be linked back to a common originating run.

---

## Overview

Each flow execution that writes data stamps every row it produces with a `run_id` — a string that uniquely identifies that execution. Three sheets carry this field:

| Sheet | Written by | Column |
|-------|-----------|--------|
| `validated_entries` | `validate-entries` | G |
| `snapshots_daily` | `compute-ledger-balances` | F |
| `financials` | `generate-financials` | F |

---

## `run_id` Format

```
run-{ISO 8601 timestamp}
```

Example: `run-2026-03-24T10:30:00.000Z`

The value encodes both a unique identifier and the wall-clock execution time. No external ID generator is needed — `new Date().toISOString()` is sufficient.

---

## Generation Rules

Each write step generates `run_id` exactly once at the start of its `input` function:

```ts
const runId = ctx.state.runId ?? `run-${new Date().toISOString()}`;
```

| Source | Priority | When used |
|--------|----------|-----------|
| `ctx.state.runId` | High | Orchestrator injects a shared value |
| `` `run-${new Date().toISOString()}` `` | Fallback | No value injected — each flow run is independent |

The generated value is applied to all rows written in that step call. Within a single execution:
- All chunks of `write-valid` share the same `run_id`
- All account rows in `write-snapshot` share the same `run_id`
- The single row in `write-financials` carries that `run_id`

---

## Per-Flow Scope

### `validate-entries`

`run_id` is generated in `write-valid`. All validated entry rows written in that execution share the same value. If `write-valid` runs in chunks (batched write), all chunks use the same `run_id` — generated once before the loop.

### `compute-ledger-balances`

`run_id` is generated in `write-snapshot`. All snapshot rows in the batch (one per account) share the same value.

### `generate-financials`

`run_id` is generated in `write-financials`. The single P&L row carries it.

---

## Cross-Flow Traceability

When flows are triggered independently, each generates its own `run_id`. Rows can be traced within a sheet but not across sheets by `run_id` alone.

When an orchestrator triggers all three flows as a single pipeline, it can inject a shared `run_id` via `ctx.state.runId`. All three sheets then receive the same value, forming a traceable chain:

```
validated_entries.run_id
  → snapshots_daily.run_id    (snapshot computed from those entries)
    → financials.run_id       (P&L computed from that snapshot)
```

### Querying a run

To retrieve all rows produced by a specific orchestrated run:

| Sheet | Query |
|-------|-------|
| `validated_entries` | `WHERE run_id = 'run-2026-03-24T10:30:00.000Z'` |
| `snapshots_daily` | `WHERE run_id = 'run-2026-03-24T10:30:00.000Z'` |
| `financials` | `WHERE run_id = 'run-2026-03-24T10:30:00.000Z'` |

---

## Execution Timestamp

The `run_id` format encodes the execution timestamp directly. To recover it:

```ts
const ts = runId.replace(/^run-/, '');  // → '2026-03-24T10:30:00.000Z'
const date = new Date(ts);
```

No separate `execution_timestamp` column is needed — the timestamp is embedded in the `run_id` value.

---

## Backward Compatibility

Rows written before `run_id` was introduced have no value in that column. No integrity check requires `run_id`:

- `check-validated-integrity` checks `reference_id`, `date`, `debit_account`, `credit_account`, `amount` — not `run_id`
- `check-snapshot-integrity` checks `snapshot_ref`, `(date, account)` uniqueness, `balance`, `date`, `account` — not `run_id`

Old rows and new rows coexist in the same sheets without issue. Filtering by `run_id` on a mixed sheet returns only rows from runs that included the field.

---

## Scope Limitations

`run_id` identifies which execution wrote a row. It does not:

- Link `validated_entries` rows to the specific `raw_entries` rows that produced them — use `reference_id` for that
- Link `snapshots_daily` rows to the `validated_entries` rows that contributed — use `entry_count` watermark and `reference_id` for that
- Link `financials` rows to their source snapshot — use `snapshot_ref` for that

`run_id` is an execution-level tag. Row-level lineage is handled by `reference_id` and `snapshot_ref`.
