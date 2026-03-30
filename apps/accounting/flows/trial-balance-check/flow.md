# Flow: trial-balance-check

**Flow ID**: `trial-balance-check`

**Purpose**: Read all validated ledger entries, detect structurally corrupt entries that violate double-entry rules, verify that the net sum of all account balances is zero, and write a diagnostic record to `reconciliation_log` only if the detected issue is new or has changed since the last logged entry.

---

## Overview

```
read-validated → check-balance → read-reconciliation-log → check-duplicate → write-reconciliation (conditional)
```

---

## The Original Bug

The original `check-balance` step contained this loop:

```ts
for (const r of rows) {
  const amt = Number(r.amount || 0);
  debit += amt;
  credit += amt;   // ← same amt added to both accumulators
}
return { mismatch: debit !== credit };
```

`debit` and `credit` are incremented by the identical `amt` on every iteration. They cannot diverge. `mismatch` is always `false`. The check never fires, under any ledger condition.

## Corrected Logic

The fix combines two independent checks inside a single `check-balance` step:

### Check 1 — Entry-level corruption scan

Each row is inspected for structural violations that should not exist in `validated_entries` — conditions the `validate-entries` flow explicitly rejects. If any such row is found, it is a sign of direct sheet manipulation or a flow bug:

| Condition | Meaning |
|---|---|
| `!r.debit_account` | Debit account is missing |
| `!r.credit_account` | Credit account is missing |
| `Number(r.amount) <= 0` | Amount is zero, negative, or non-numeric |
| `r.debit_account === r.credit_account` | Self-posting — same account on both sides |

Corrupt rows are collected as `corruptEntries` (by `reference_id`) and **excluded from the balance computation**. This prevents a corrupt row from accidentally cancelling itself in the arithmetic, which would hide the problem.

### Check 2 — Net balance sum

The correct trial balance algorithm uses account-level accumulation over clean rows only — the same method as `compute-ledger-balances`:

```
for each clean row:
  balances[debit_account]  += amount
  balances[credit_account] -= amount

netSum = sum of all values in balances
```

In a correct double-entry ledger, every debit has an equal and opposite credit, so `netSum` is always zero. A non-zero result means at least one account was affected on one side without a matching counterpart — indicating data corruption that cannot be detected at the entry level.

### Combined mismatch flag

```ts
mismatch = netSum !== 0 || corruptEntries.length > 0
```

Both conditions are independently meaningful and are OR-ed into a single flag that gates `write-reconciliation`.

---

## Steps

---

### Step 1 — `read-validated`

**Type**: `storage`

**Condition**: none (always runs)

**Purpose**: Read all rows from the `validated_entries` sheet. The trial balance is computed against the full ledger — not just entries from the current run.

```ts
{
  id: 'read-validated',
  type: 'storage',
  input: (ctx) => ({
    provider: 'sheets',
    operation: 'read',
    resource: ctx.state.config.sheetId,
    options: { range: ctx.state.config.ranges.validated }
  })
}
```

**Output written to**: `ctx.outputs['read-validated']`

Expected shape:
```ts
{ rows: Array<{ date, debit_account, credit_account, amount, entity, reference_id }> }
```

---

### Step 2 — `check-balance`

**Type**: `storage`

**Condition**: `!!ctx.outputs?.['read-validated']?.rows?.length`

**Purpose**: Scan every row for structural corruption. Compute net account balances over the clean rows only. Return `mismatch`, `netSum`, `corruptEntries`, `balances`, and `ledgerEntryCount` — the last two carry the per-account state needed for debugging context.

```ts
{
  id: 'check-balance',
  type: 'storage',
  condition: (ctx) => !!ctx.outputs?.['read-validated']?.rows?.length,
  input: (ctx) => {
    const rows = ctx.outputs?.['read-validated']?.rows ?? [];

    const corruptEntries = [];
    const cleanRows = [];

    for (const r of rows) {
      const amt = Number(r.amount || 0);
      const isCorrupt =
        !r.debit_account ||
        !r.credit_account ||
        amt <= 0 ||
        r.debit_account === r.credit_account;

      if (isCorrupt) {
        corruptEntries.push(r.reference_id ?? 'unknown');
      } else {
        cleanRows.push({ ...r, amount: amt });
      }
    }

    // Net balance sum over clean rows — must equal 0 in a correct ledger
    const balances = {};
    for (const r of cleanRows) {
      balances[r.debit_account] = (balances[r.debit_account] || 0) + r.amount;
      balances[r.credit_account] = (balances[r.credit_account] || 0) - r.amount;
    }
    const netSum = Object.values(balances).reduce((sum, b) => sum + b, 0);

    return {
      mismatch: netSum !== 0 || corruptEntries.length > 0,
      netSum,
      corruptEntries,
      balances,
      ledgerEntryCount: rows.length
    };
  }
}
```

**Output written to**: `ctx.outputs['check-balance']`

Expected shape:
```ts
{
  mismatch: boolean,
  netSum: number,
  corruptEntries: string[],  // reference_ids of corrupt rows
  balances: Record<string, number>,  // per-account net balance (clean rows only)
  ledgerEntryCount: number           // total rows in validated_entries at time of check
}
```

---

### Step 3 — `read-reconciliation-log`

**Type**: `storage`

**Condition**: `ctx.outputs?.['check-balance']?.mismatch === true`

**Purpose**: Read the full contents of `reconciliation_log` when a mismatch has been detected. Only runs when a mismatch exists — no read is issued for a clean ledger. The result is passed to `check-duplicate` for deduplication comparison.

```ts
{
  id: 'read-reconciliation-log',
  type: 'storage',
  condition: (ctx) => ctx.outputs?.['check-balance']?.mismatch === true,
  input: (ctx) => ({
    provider: 'sheets',
    operation: 'read',
    resource: ctx.state.config.sheetId,
    options: { range: ctx.state.config.ranges.reconciliation }
  })
}
```

**Output written to**: `ctx.outputs['read-reconciliation-log']`

Expected shape:
```ts
{ rows: Array<{ reference_id, issue_type, status, notes }> }
```

> If `reconciliation_log` is empty (first-ever mismatch), `rows` is `[]`. `check-duplicate` handles this correctly — an empty log means no open entry exists.

---

### Step 4 — `check-duplicate`

**Type**: `storage`

**Condition**: `ctx.outputs?.['check-balance']?.mismatch === true`

**Purpose**: Build the `candidateNotes` string that `write-reconciliation` would write, then compare it against the `notes` field of the most recent `open` entry in `reconciliation_log`. Emits `{ shouldWrite, candidateNotes }`.

`shouldWrite` is `true` when:
- No `open` entry exists in the log — this is a first detection, or all prior entries have been resolved
- An `open` entry exists but its `notes` differ from `candidateNotes` — the mismatch has changed (e.g. a new corrupt row appeared, or the net sum shifted)

`shouldWrite` is `false` when the most recent `open` entry has the same `notes` as the current detection — the same issue is still present and already logged.

The "most recent open entry" is the **last row in the sheet** where `status === 'open'` (case-insensitive). Sheet order (append-only) reflects temporal order.

```ts
{
  id: 'check-duplicate',
  type: 'storage',
  condition: (ctx) => ctx.outputs?.['check-balance']?.mismatch === true,
  input: (ctx) => {
    const r = ctx.outputs?.['check-balance'];
    const issues = [];

    if (r.netSum !== 0) {
      issues.push(`net_sum:${r.netSum}`);
    }
    if (r.corruptEntries?.length) {
      issues.push(`corrupt_entries:${r.corruptEntries.join(',')}`);
    }
    const candidateNotes = issues.join('|');

    const existingRows = ctx.outputs?.['read-reconciliation-log']?.rows ?? [];
    const openEntries = existingRows.filter(row => (row.status || '').toLowerCase() === 'open');
    const latestOpen = openEntries.length > 0 ? openEntries[openEntries.length - 1] : null;

    const shouldWrite = !latestOpen || latestOpen.notes !== candidateNotes;

    // Build debugging context — separate from notes so deduplication is unaffected
    const affectedAccounts = Object.entries(r.balances ?? {})
      .filter(([, bal]) => bal !== 0)
      .map(([acct, bal]) => `${acct}:${bal}`)
      .join(',');
    const contextParts = [
      `ledger_entries:${r.ledgerEntryCount}`,
      `corrupt_count:${r.corruptEntries?.length ?? 0}`
    ];
    if (affectedAccounts) {
      contextParts.push(`affected_accounts:${affectedAccounts}`);
    }
    const context = contextParts.join('|');

    return {
      shouldWrite,
      candidateNotes,
      context,
      latestOpenNotes: latestOpen?.notes ?? null
    };
  }
}
```

**Output written to**: `ctx.outputs['check-duplicate']`

Expected shape:
```ts
{
  shouldWrite: boolean,
  candidateNotes: string,           // notes string this run would write — used for deduplication
  context: string,                  // per-run debugging state — not used for deduplication
  latestOpenNotes: string | null    // notes from the most recent open entry, or null
}
```

**Decision table**:

| Latest open entry | `candidateNotes` matches | `shouldWrite` | Reason |
|-------------------|--------------------------|---------------|--------|
| None | — | `true` | First detection (or all resolved) |
| Exists | No | `true` | Issue changed |
| Exists | Yes | `false` | Same issue already logged |

---

### Step 5 — `write-reconciliation`

**Type**: `storage`

**Condition**: `ctx.outputs?.['check-balance']?.mismatch === true && ctx.outputs?.['check-duplicate']?.shouldWrite === true`

**Purpose**: Append a diagnostic record to `reconciliation_log`. Only runs when the deduplication check confirms this is a new or changed issue. Reads `candidateNotes` from `check-duplicate` — no recomputation of the notes string.

**Columns written** (in order): `reference_id` (timestamp), `issue_type`, `status`, `notes`

```ts
{
  id: 'write-reconciliation',
  type: 'storage',
  condition: (ctx) =>
    ctx.outputs?.['check-balance']?.mismatch === true
    && ctx.outputs?.['check-duplicate']?.shouldWrite === true,
  input: (ctx) => ({
    provider: 'sheets',
    operation: 'write',
    resource: ctx.state.config.sheetId,
    data: [[
      Date.now(),
      'trial_balance_mismatch',
      'open',
      ctx.outputs['check-duplicate'].candidateNotes,
      ctx.outputs['check-duplicate'].context
    ]],
    options: { range: ctx.state.config.ranges.reconciliation }
  })
}
```

**Output written to**: `ctx.outputs['write-reconciliation']`

**Columns written** (in order): `reference_id`, `issue_type`, `status`, `notes`, `context`

**`notes` field format** (deduplication key — stable across runs for the same issue):

| Condition | Notes value |
|---|---|
| Net sum only | `net_sum:-50` |
| Corrupt entries only | `corrupt_entries:ref-id-1,ref-id-2` |
| Both | `net_sum:-50\|corrupt_entries:ref-id-1` |

**`context` field format** (per-run debugging state — not used for deduplication):

| Segment | Example | Meaning |
|---|---|---|
| `ledger_entries:N` | `ledger_entries:47` | Total rows in `validated_entries` at detection time |
| `corrupt_count:N` | `corrupt_count:2` | Number of structurally corrupt rows |
| `affected_accounts:...` | `affected_accounts:Cash:600,Revenue:-650` | Accounts with non-zero net balance (only present when `netSum !== 0`) |

Full example: `ledger_entries:47|corrupt_count:2|affected_accounts:Cash:600,Revenue:-650`

> `context` is always written on first detection and on every changed-issue write. It is not compared for deduplication — only `notes` is compared. Two runs with the same structural mismatch but different `ledger_entries` counts will still deduplicate correctly (same `notes`), but the `context` column of the original log entry reflects the state at first detection.

---

## Guarantees

- `write-reconciliation` only runs when `mismatch === true` — no false-positive log entries.
- `write-reconciliation` only runs when `check-duplicate.shouldWrite === true` — no duplicate entries for a persistent unchanged mismatch.
- A clean ledger (no corrupt rows, `netSum === 0`) produces no writes. The flow is a no-op.
- Corrupt rows are excluded from the net balance computation — a self-posting row cannot zero itself out to avoid detection.
- `netSum` is computed exclusively from rows that pass the entry-level scan.
- `corruptEntries` contains `reference_id` values; falls back to `'unknown'` if `reference_id` is absent on a corrupt row.
- If `validated_entries` is empty, `check-balance`, `read-reconciliation-log`, `check-duplicate`, and `write-reconciliation` are all skipped.
- The `reference_id` in the reconciliation log is a Unix timestamp (`Date.now()`), providing an audit trail of when each distinct issue was first detected.
- `candidateNotes` is computed once in `check-duplicate` and consumed directly by `write-reconciliation` — no duplication of the notes-building logic.
- `context` is computed in `check-duplicate` alongside `candidateNotes` but is not used for deduplication — only `notes` is compared. A run with the same structural mismatch but a different entry count still deduplicates correctly.
- `context` captures per-run state at detection time: total entry count, corrupt row count, and per-account net balances for non-zero accounts.
- This flow is read-only with respect to `validated_entries` — it never modifies ledger data.
- Resolving an issue (user sets `status = resolved`) causes the next detection of the same mismatch to write a new log entry — a resolved entry no longer counts as "already logged".
