# Handler: accounting

**File**: `apps/accounting/handler/handler.md`

**Purpose**: Entry point for the accounting engine. Validates configuration, loads modules, builds the initial execution context, and runs the four accounting flows sequentially.

---

## Responsibilities

1. Validate config via `validateConfig()` — abort immediately if invalid
2. Build the `Modules` object (storage wired to Google Sheets)
3. Call `buildInitialContext()` to prepare `ctx.state`
4. Run flows sequentially:
   1. `validate-entries`
   2. `compute-ledger-balances`
   3. `trial-balance-check`
   4. `generate-financials`
5. Handle each `ExecutionResult` safely — log failures without crashing

---

## Config Validation

`validateConfig()` is the first operation in `runAccounting`. If it returns `ok: false`, the handler logs all validation errors and returns immediately — no modules are built, no context is constructed, no flows run.

### Function signature

```ts
type ConfigValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

function validateConfig(config: AccountingConfig): ConfigValidationResult
```

### Validation rules

| Field | Rule | Error message |
|-------|------|---------------|
| `config` | must not be null or undefined | `'config is missing'` |
| `config.sheetId` | must be a non-empty string | `'sheetId is missing or empty'` |
| `config.sheetId` | must not contain whitespace | `'sheetId must not contain whitespace'` |
| `config.ranges` | must not be null or undefined | `'config.ranges is missing'` |
| `config.ranges.raw` | must be a non-empty string | `'ranges.raw is missing or empty'` |
| `config.ranges.validated` | must be a non-empty string | `'ranges.validated is missing or empty'` |
| `config.ranges.accounts` | must be a non-empty string | `'ranges.accounts is missing or empty'` |
| `config.ranges.snapshots` | must be a non-empty string | `'ranges.snapshots is missing or empty'` |
| `config.ranges.financials` | must be a non-empty string | `'ranges.financials is missing or empty'` |
| `config.ranges.reconciliation` | must be a non-empty string | `'ranges.reconciliation is missing or empty'` |

All rules are evaluated independently. All violations are collected before returning — the caller sees every problem at once, not just the first one.

### Implementation

```ts
function validateConfig(config: AccountingConfig): ConfigValidationResult {
  const errors: string[] = [];

  if (config == null) {
    return { ok: false, errors: ['config is missing'] };
  }

  if (!config.sheetId || typeof config.sheetId !== 'string') {
    errors.push('sheetId is missing or empty');
  } else if (/\s/.test(config.sheetId)) {
    errors.push('sheetId must not contain whitespace');
  }

  if (config.ranges == null) {
    errors.push('config.ranges is missing');
  } else {
    const required = ['raw', 'validated', 'accounts', 'snapshots', 'financials', 'reconciliation'] as const;
    for (const key of required) {
      if (!config.ranges[key] || typeof config.ranges[key] !== 'string') {
        errors.push(`ranges.${key} is missing or empty`);
      }
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
```

### Behaviour

- If `config.ranges` is missing, the six range-key checks are skipped (they would all fail and the root error is sufficient). Only the `'config.ranges is missing'` error is collected in that case.
- `sheetId` whitespace check only runs if `sheetId` is otherwise present — it is not a second error on top of the missing-or-empty error.
- Validation is synchronous and has no side effects.

---

## Module Wiring

```ts
const modules: Modules = {
  storage: storageExecutor,   // sheets module executor
};
```

`communication` and `intelligence` are not included because no flow in v1 uses them.

---

## Context Construction

```ts
function buildInitialContext(config: AccountingConfig): ExecutionContext {
  return {
    state: {
      config: {
        sheetId: config.sheetId,
        ranges: {
          raw:            config.ranges.raw,
          validated:      config.ranges.validated,
          accounts:       config.ranges.accounts,
          snapshots:      config.ranges.snapshots,
          financials:     config.ranges.financials,
          reconciliation: config.ranges.reconciliation
        }
      }
    }
  };
}
```

`buildInitialContext` is only called after `validateConfig` returns `ok: true`. By that point all fields are guaranteed non-empty strings — no defensive fallbacks are needed inside the context builder.

---

## Execution Sequence

```ts
async function runAccounting(config: AccountingConfig): Promise<void> {
  // Step 0: Validate config — abort before touching any module or flow
  const validation = validateConfig(config);
  if (!validation.ok) {
    for (const err of validation.errors) {
      console.error(`[accounting] config error: ${err}`);
    }
    return;
  }

  const modules = buildModules();
  const ctx = buildInitialContext(config);

  // Flow 1: Validate raw entries
  const r1 = await runFlow(validateEntriesFlow, ctx, modules);
  if (!r1.ok) {
    console.error(`[accounting] validate-entries failed at step "${r1.failedStep}": ${r1.error}`);
    return;
  }

  // Flow 2: Compute ledger balances
  const r2 = await runFlow(computeLedgerBalancesFlow, ctx, modules);
  if (!r2.ok) {
    console.error(`[accounting] compute-ledger-balances failed at step "${r2.failedStep}": ${r2.error}`);
    return;
  }

  // Flow 3: Trial balance check
  const r3 = await runFlow(trialBalanceCheckFlow, ctx, modules);
  if (!r3.ok) {
    console.error(`[accounting] trial-balance-check failed at step "${r3.failedStep}": ${r3.error}`);
    return;
  }

  // Flow 4: Generate financials
  const r4 = await runFlow(generateFinancialsFlow, ctx, modules);
  if (!r4.ok) {
    console.error(`[accounting] generate-financials failed at step "${r4.failedStep}": ${r4.error}`);
    return;
  }

  console.log('[accounting] run complete');
}
```

---

## Error Handling Rules

- `validateConfig` is always the first call. A failed validation aborts before any module or flow is touched.
- All config errors are logged before returning — the caller sees every problem, not just the first.
- Each `runFlow()` result is checked immediately after the call.
- If a flow returns `ok: false`, the handler logs the failing step ID and error, then stops — subsequent flows do not run.
- The handler never throws. All errors are surfaced via logged messages and early returns.
- No try/catch is used inside flows or context builders.

---

## Trigger Modes

| Mode | Description |
|------|-------------|
| HTTP POST | `POST /run/accounting` — manual trigger |
| Cron | Scheduled nightly run (e.g., `0 23 * * *`) |
| CLI | Direct invocation for development and testing |

---

## Flow Execution Order

| Order | Flow ID | Depends On |
|-------|---------|------------|
| 1 | `validate-entries` | raw_entries (user input) |
| 2 | `compute-ledger-balances` | validated_entries (written by flow 1) |
| 3 | `trial-balance-check` | validated_entries (written by flow 1) |
| 4 | `generate-financials` | snapshots_daily (written by flow 2) |

---

## Context Sharing

Each flow receives the same base context (`ctx`) but maintains its own output namespace via `ctx.outputs`. Since the engine does not share output state across `runFlow()` calls, each flow starts with a clean `outputs` object. All inter-flow dependencies are mediated by Google Sheets.

---

## Imports (Structural Reference)

```ts
import { runFlow } from 'engine-module';
import type { Flow, ExecutionContext, Modules } from 'engine-module';

import { validateEntriesFlow }       from '../flows/validate-entries/flow';
import { computeLedgerBalancesFlow } from '../flows/compute-ledger-balances/flow';
import { trialBalanceCheckFlow }     from '../flows/trial-balance-check/flow';
import { generateFinancialsFlow }    from '../flows/generate-financials/flow';

import { storageExecutor } from 'storage-module';
```
