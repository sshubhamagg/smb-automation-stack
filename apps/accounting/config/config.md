# Config: accounting

**File**: `apps/accounting/config/config.md`

**Purpose**: Defines the configuration structure for the accounting engine, how it is constructed, and how it is injected into the execution context.

---

## Config Structure

```ts
type AccountingConfig = {
  sheetId: string;
  ranges: {
    raw:            string;
    validated:      string;
    accounts:       string;
    snapshots:      string;
    financials:     string;
    reconciliation: string;
  };
};
```

| Field | Type | Description |
|-------|------|-------------|
| `sheetId` | `string` | Google Sheets document ID (from the URL) |
| `ranges.raw` | `string` | Sheet tab name for raw journal entries |
| `ranges.validated` | `string` | Sheet tab name for validated ledger entries |
| `ranges.accounts` | `string` | Sheet tab name for the chart of accounts |
| `ranges.snapshots` | `string` | Sheet tab name for daily balance snapshots |
| `ranges.financials` | `string` | Sheet tab name for P&L records |
| `ranges.reconciliation` | `string` | Sheet tab name for reconciliation log |

---

## Example Config

```ts
const config: AccountingConfig = {
  sheetId: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms',
  ranges: {
    raw:            'raw_entries',
    validated:      'validated_entries',
    accounts:       'accounts',
    snapshots:      'snapshots_daily',
    financials:     'financials',
    reconciliation: 'reconciliation_log'
  }
};
```

---

## Injection into `ctx.state`

The handler calls `buildInitialContext(config)` before any flow runs. This produces an `ExecutionContext` where `ctx.state.config` holds the full config object:

```ts
function buildInitialContext(config: AccountingConfig): ExecutionContext {
  return {
    state: {
      config: {
        sheetId: config.sheetId,
        ranges:  config.ranges
      }
    }
  };
}
```

All flow steps access config exclusively via:

```ts
ctx.state.config.sheetId
ctx.state.config.ranges.raw
ctx.state.config.ranges.validated
// etc.
```

No flow hard-codes a sheet ID or range name. All values come from `ctx.state.config`.

---

## Config Source

Config should be loaded from environment variables or a config file before the handler is called. The handler does not read environment variables directly — it accepts a typed `AccountingConfig` object.

Example env-based loader:

```ts
function loadConfig(): AccountingConfig {
  return {
    sheetId: process.env.ACCOUNTING_SHEET_ID ?? '',
    ranges: {
      raw:            process.env.RANGE_RAW            ?? 'raw_entries',
      validated:      process.env.RANGE_VALIDATED      ?? 'validated_entries',
      accounts:       process.env.RANGE_ACCOUNTS       ?? 'accounts',
      snapshots:      process.env.RANGE_SNAPSHOTS      ?? 'snapshots_daily',
      financials:     process.env.RANGE_FINANCIALS     ?? 'financials',
      reconciliation: process.env.RANGE_RECONCILIATION ?? 'reconciliation_log'
    }
  };
}
```

---

## Constraints

- `sheetId` must be a valid Google Sheets document ID (not a URL).
- Range names are Google Sheets tab names, not A1 notation ranges.
- The config object is never mutated after construction.
- Flows must never access `process.env` directly — config is always passed through `ctx.state.config`.
