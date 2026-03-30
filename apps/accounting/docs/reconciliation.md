# Trial Balance Check — Flow Documentation

**Flow ID**: `trial-balance-check`

**File**: `apps/accounting/flows/trial-balance-check/flow.md`

---

## Purpose

The `trial-balance-check` flow reads all validated journal entries, scans for structurally corrupt rows, verifies the net sum of all account balances equals zero, and writes a diagnostic record to `reconciliation_log` only when the detected issue is new or has changed since the last logged entry — preventing log flooding on repeated runs.

---

## Step Summary

| Step ID | Type | Condition | Purpose |
|---------|------|-----------|---------|
| `read-validated` | storage | always | Read all rows from `validated_entries` |
| `check-balance` | storage | rows exist | Scan for corrupt entries; compute net balance sum |
| `read-reconciliation-log` | storage | mismatch === true | Read existing log to enable deduplication comparison |
| `check-duplicate` | storage | mismatch === true | Compare candidate notes against latest open entry; emit `shouldWrite`, `candidateNotes`, and `context` |
| `write-reconciliation` | storage | mismatch === true AND `shouldWrite === true` | Append diagnostic record only for new or changed issues |

---

## Deduplication Logic

### Problem

`write-reconciliation` is an append operation. Without deduplication, every run that detects a mismatch appends a new row — including repeated runs against the same unfixed issue. A ledger with a persistent net sum error produces one new log entry per run, flooding the log with identical records.

### Solution: compare before writing

Two steps run between `check-balance` and `write-reconciliation`:

**`read-reconciliation-log`** — reads the full `reconciliation_log` sheet. Only runs when a mismatch was detected (`mismatch === true`). A clean ledger never triggers this read.

**`check-duplicate`** — builds the `candidateNotes` string (the notes value that `write-reconciliation` would write), then inspects the existing log:

1. Filter `reconciliation_log` rows to those where `status === 'open'` (case-insensitive).
2. Take the **last** open entry — sheet order is append-only, so position reflects chronological order.
3. Compare `latestOpen.notes` against `candidateNotes`.

```
shouldWrite = !latestOpen || latestOpen.notes !== candidateNotes
```

### Write conditions

| State | `shouldWrite` | Action |
|-------|---------------|--------|
| No open entry in log | `true` | Write — first detection (or all prior entries resolved) |
| Open entry exists, notes differ | `true` | Write — issue has changed |
| Open entry exists, notes match | `false` | Skip — same issue already logged |

### What counts as "same issue"

Two detections are considered the same issue when their `notes` strings are identical:

| Notes value | Meaning |
|-------------|---------|
| `net_sum:-50` | Net balance is off by -50 |
| `corrupt_entries:ref-1,ref-2` | Two structurally corrupt rows |
| `net_sum:-50\|corrupt_entries:ref-1` | Both conditions present |

If the net sum changes from `-50` to `-100`, the notes differ → new entry written. If a new corrupt row appears, the `corrupt_entries` list differs → new entry written.

### Interaction with resolution

When a user sets `status = resolved` on an open entry, that entry no longer appears in the filtered `openEntries` list. If the same mismatch re-appears on the next run, `latestOpen` will be `null` (or point to a different open entry) → `shouldWrite = true` → a new log entry is written. A resolved entry never suppresses future detections.

---

## Original Bug

The previous `check-balance` loop was:

```ts
for (const r of rows) {
  const amt = Number(r.amount || 0);
  debit += amt;
  credit += amt;  // same value — accumulators always equal
}
return { mismatch: debit !== credit };  // always false
```

`debit` and `credit` were the same accumulator under two names. The mismatch flag was always `false`. The check never fired under any ledger condition — including direct sheet manipulation or data corruption.

---

## Corrected Logic

`check-balance` now performs two independent checks and combines them into a single `mismatch` flag.

### Check 1 — Entry-level corruption scan

Every row is tested for structural violations. A row is corrupt if any of the following are true:

| Condition | Interpretation |
|---|---|
| `!r.debit_account` | Debit side is blank — half the entry is missing |
| `!r.credit_account` | Credit side is blank — half the entry is missing |
| `Number(r.amount) <= 0` | Amount is zero, negative, or unparseable |
| `r.debit_account === r.credit_account` | Self-posting — same account on both sides |

These conditions are the exact rules `validate-entries` enforces. Any row in `validated_entries` that violates them was either directly injected into the sheet or produced by a bug in an earlier flow.

Corrupt rows are collected by `reference_id` into `corruptEntries` and **excluded from balance computation**. Exclusion is critical: a row where `debit_account === credit_account` would produce `+amt − amt = 0` for that account, masking the problem in the arithmetic.

### Check 2 — Net balance sum

The net balance sum is computed using account-level accumulation over clean rows only:

```ts
for each clean row:
  balances[debit_account]  += amount   // debit side: positive impact
  balances[credit_account] -= amount   // credit side: negative impact

netSum = Σ balances[account] for all accounts
```

This is the mathematically correct trial balance identity. In a valid double-entry ledger, every `+amount` added to a debit account is paired with an equal `−amount` on a credit account. The net sum across all accounts must be zero.

`netSum ≠ 0` means a debit or credit was recorded without its counterpart — a form of corruption that cannot be caught by the row-level scan alone (since the affected row may otherwise look structurally valid).

### Combined flag

```ts
mismatch = netSum !== 0 || corruptEntries.length > 0
```

Both conditions are independently surfaced in the `notes` field of the reconciliation log entry.

---

## What each check detects

| Scenario | Detected by |
|---|---|
| Row with empty `debit_account` injected into `validated_entries` | Corruption scan |
| Row with `debit_account === credit_account` bypassed validation | Corruption scan |
| Row with `amount = 0` or negative amount | Corruption scan |
| Account affected once (debit without credit or vice versa) via direct sheet edit | Net sum check |
| Amount asymmetrically altered after posting | Net sum check (if the alteration breaks the per-account pairing) |
| Clean, well-formed ledger | Neither — flow is a no-op |

---

## Reconciliation Log Entry

When `mismatch === true`, one row is appended to `reconciliation_log`:

| Field | Value |
|---|---|
| `reference_id` | `Date.now()` — Unix timestamp of detection |
| `issue_type` | `trial_balance_mismatch` |
| `status` | `open` |
| `notes` | Issue signature used for deduplication (see below) |
| `context` | Per-run debugging state — ledger size, corrupt count, affected accounts |

**`notes` format** (deduplication key — stable for the same structural issue):

| Failure | Notes value |
|---|---|
| Net sum off | `net_sum:-50` |
| Corrupt entries | `corrupt_entries:ref-id-1,ref-id-2` |
| Both | `net_sum:-50\|corrupt_entries:ref-id-1,ref-id-2` |

**`context` format** (per-run state — not used for deduplication):

| Segment | Example | Meaning |
|---|---|---|
| `ledger_entries:N` | `ledger_entries:47` | Total rows in `validated_entries` at detection |
| `corrupt_count:N` | `corrupt_count:2` | Number of structurally corrupt rows |
| `affected_accounts:...` | `affected_accounts:Cash:600,Revenue:-650` | Non-zero net balances by account (omitted when `netSum === 0`) |

Full example: `ledger_entries:47|corrupt_count:2|affected_accounts:Cash:600,Revenue:-650`

The `context` field is written at detection time. If the same issue persists across multiple runs without changes, no new row is written — so `context` reflects the ledger state at first detection, not subsequent runs.

---

## Resolution Process

1. Engine writes a `reconciliation_log` entry with `status = open`.
2. User reads the `notes` field to identify which check failed, then reads `context` for debugging detail:
   - `corrupt_entries:...` in `notes` → locate the listed `reference_id` values in `validated_entries` and inspect those rows
   - `net_sum:N` in `notes` → `affected_accounts` in `context` shows which accounts are out of balance; search for entries missing their counterpart
   - `ledger_entries:N` in `context` → confirms the ledger size at time of detection; useful if the count has since changed
3. User corrects the root cause (re-run `validate-entries` or manually repair the sheet).
4. User re-runs `trial-balance-check`. If it passes, update the `reconciliation_log` row to `status = resolved`.

---

## Skipped Steps

| Step | Skipped when |
|------|-------------|
| `check-balance` | `validated_entries` is empty |
| `read-reconciliation-log` | `check-balance` returned `mismatch = false` |
| `check-duplicate` | `check-balance` returned `mismatch = false` |
| `write-reconciliation` | `mismatch = false` OR `check-duplicate.shouldWrite = false` |

A clean, non-empty ledger produces no reads or writes beyond `check-balance`. The flow is a no-op.

A persistent unchanged mismatch produces one read (`read-reconciliation-log`) and one compute (`check-duplicate`) per run, but no write after the first detection.

---

## Idempotency

If the mismatch condition persists unchanged across runs, **no new entry is appended** — `check-duplicate` detects that the latest open entry already describes the same issue and sets `shouldWrite = false`.

A new entry is only written when the issue changes (different `notes`) or when all prior entries for the issue have been resolved.

| Scenario | Behavior |
|----------|----------|
| Same mismatch, multiple runs | One log entry total — no flooding |
| Mismatch changes (e.g. net sum shifts) | New entry written; prior entry remains open |
| User resolves entry, mismatch re-appears | New entry written — resolved entries do not suppress future detections |
| Mismatch clears (ledger corrected) | No write — `check-balance` returns `mismatch: false`, all downstream steps skipped |

---

## Output Produced

| Sheet | Operation | Trigger |
|---|---|---|
| `reconciliation_log` | append one row | mismatch detected |
