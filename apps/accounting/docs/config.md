# Config Reference

**Purpose**: Reference for all configuration values consumed by the accounting engine.

---

## Config Shape

```ts
type AccountingConfig = {
  sheetId: string;
  ranges: {
    raw:            string;  // 'raw_entries'
    validated:      string;  // 'validated_entries'
    accounts:       string;  // 'accounts'
    snapshots:      string;  // 'snapshots_daily'
    financials:     string;  // 'financials'
    reconciliation: string;  // 'reconciliation_log'
  };
};
```

---

## Fields

| Field | Default | Description |
|-------|---------|-------------|
| `sheetId` | (required) | Google Sheets document ID — the long alphanumeric string in the sheet URL |
| `ranges.raw` | `raw_entries` | Tab name for user-submitted journal entries |
| `ranges.validated` | `validated_entries` | Tab name for engine-validated ledger rows |
| `ranges.accounts` | `accounts` | Tab name for the chart of accounts |
| `ranges.snapshots` | `snapshots_daily` | Tab name for daily balance snapshots |
| `ranges.financials` | `financials` | Tab name for P&L records |
| `ranges.reconciliation` | `reconciliation_log` | Tab name for trial balance mismatch log |

---

## Injection Path

```
Handler → validateConfig(config) → buildInitialContext(config) → ctx.state.config → all flows
```

`validateConfig` runs before `buildInitialContext`. If validation fails, the handler aborts — `buildInitialContext` is never called and no flows run.

All steps access config as:

```ts
ctx.state.config.sheetId
ctx.state.config.ranges.<key>
```

---

## How It Is Loaded

Config is loaded once in the handler before any flow runs. The handler accepts an `AccountingConfig` object. The caller (server, cron, CLI) is responsible for assembling it from environment variables or a config file.

---

## Environment Variables (Recommended)

| Env Var | Maps To |
|---------|---------|
| `ACCOUNTING_SHEET_ID` | `config.sheetId` |
| `RANGE_RAW` | `config.ranges.raw` |
| `RANGE_VALIDATED` | `config.ranges.validated` |
| `RANGE_ACCOUNTS` | `config.ranges.accounts` |
| `RANGE_SNAPSHOTS` | `config.ranges.snapshots` |
| `RANGE_FINANCIALS` | `config.ranges.financials` |
| `RANGE_RECONCILIATION` | `config.ranges.reconciliation` |

---

## Validation Rules

The handler calls `validateConfig(config)` as its first operation. All of the following must hold or the engine will not start:

| Field | Rule | Error |
|-------|------|-------|
| `config` | not null or undefined | `'config is missing'` |
| `config.sheetId` | non-empty string | `'sheetId is missing or empty'` |
| `config.sheetId` | no whitespace characters | `'sheetId must not contain whitespace'` |
| `config.ranges` | not null or undefined | `'config.ranges is missing'` |
| `config.ranges.raw` | non-empty string | `'ranges.raw is missing or empty'` |
| `config.ranges.validated` | non-empty string | `'ranges.validated is missing or empty'` |
| `config.ranges.accounts` | non-empty string | `'ranges.accounts is missing or empty'` |
| `config.ranges.snapshots` | non-empty string | `'ranges.snapshots is missing or empty'` |
| `config.ranges.financials` | non-empty string | `'ranges.financials is missing or empty'` |
| `config.ranges.reconciliation` | non-empty string | `'ranges.reconciliation is missing or empty'` |

All rules are evaluated and all errors collected before returning. If `config.ranges` is null, the six range-key checks are skipped (the root error is sufficient).

On failure, the handler logs each error and returns without running any flow.

---

## Constraints

- `sheetId` must be the document ID, not a full URL.
- `sheetId` must not contain spaces or other whitespace — this is enforced by `validateConfig`.
- Range names are Google Sheets tab names — case-sensitive, must exactly match the tab names in the sheet.
- No flow reads `process.env` directly. Config is always sourced from `ctx.state.config`.
- The config object is constructed once and never mutated after construction.
